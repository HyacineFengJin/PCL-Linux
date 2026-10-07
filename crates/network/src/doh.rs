//! Cloudflare's documented HTTPS JSON endpoint supplies A/AAAA records. Direct
//! bootstrap resolves its TLS hostname with fixed published resolver IPs; it
//! never calls this resolver recursively. Proxy bootstrap uses ordinary system
//! DNS for the proxy itself, while the proxy owns destination name resolution.
//!
//! References: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
//! and https://developers.cloudflare.com/1.1.1.1/ip-addresses/ . JSON is a provider
//! schema, not an IETF wireformat protocol; malformed changes fail visibly.
use crate::{policy::ProxySnapshot, DnsFallback};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";
const RESOLVER_HOST: &str = "cloudflare-dns.com";
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_ANSWERS: usize = 64;
const MAX_CACHE_ENTRIES: usize = 256;
const MAX_TTL_SECONDS: u32 = 300;
const QUERY_TIMEOUT: Duration = Duration::from_secs(4);
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(2);
const SYSTEM_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(crate) struct DnsStats {
    pub queries: u64,
    pub cache_hits: u64,
    pub failures: u64,
    pub fallbacks: u64,
    pub last_failure: Option<String>,
}
#[derive(Default)]
struct Counters {
    queries: AtomicU64,
    cache_hits: AtomicU64,
    failures: AtomicU64,
    fallbacks: AtomicU64,
    last_failure: Mutex<Option<String>>,
}
struct CacheEntry {
    addresses: Vec<SocketAddr>,
    expires: Instant,
}
struct State {
    client: reqwest::Client,
    endpoint: String,
    fallback: DnsFallback,
    cache: Mutex<BTreeMap<String, CacheEntry>>,
    query_slots: Arc<Semaphore>,
    system_slots: Arc<Semaphore>,
    counters: Counters,
    #[cfg(test)]
    system_result: Option<Result<Vec<SocketAddr>, String>>,
}
pub(crate) struct DohResolver {
    state: Arc<State>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DohResolver {
    pub(crate) fn new(proxies: &ProxySnapshot, fallback: DnsFallback) -> Result<Self, String> {
        let addresses = [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)), 443),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 0, 0, 1)), 443),
            SocketAddr::new(
                IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111)),
                443,
            ),
            SocketAddr::new(
                IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1001)),
                443,
            ),
        ];
        // No custom resolver is attached to this private bootstrap client. TLS
        // still validates cloudflare-dns.com; fixed IPs only avoid bootstrap DNS.
        let client = proxies
            .async_builder(reqwest::Client::builder())
            .resolve_to_addrs(RESOLVER_HOST, &addresses)
            .https_only(true)
            .connect_timeout(Duration::from_secs(2))
            .timeout(QUERY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .user_agent("PCL-RH/0.2.0 DNS")
            .build()
            .map_err(|_| "无法初始化受验证 TLS 的 DoH 客户端")?;
        Ok(Self::from_client(client, ENDPOINT.into(), fallback))
    }
    fn from_client(client: reqwest::Client, endpoint: String, fallback: DnsFallback) -> Self {
        Self {
            state: Arc::new(State {
                client,
                endpoint,
                fallback,
                cache: Mutex::new(BTreeMap::new()),
                query_slots: Arc::new(Semaphore::new(32)),
                system_slots: Arc::new(Semaphore::new(8)),
                counters: Counters::default(),
                #[cfg(test)]
                system_result: None,
            }),
        }
    }
    pub(crate) fn status(&self) -> DnsStats {
        let stats = &self.state.counters;
        DnsStats {
            queries: stats.queries.load(Ordering::Relaxed),
            cache_hits: stats.cache_hits.load(Ordering::Relaxed),
            failures: stats.failures.load(Ordering::Relaxed),
            fallbacks: stats.fallbacks.load(Ordering::Relaxed),
            last_failure: lock(&stats.last_failure).clone(),
        }
    }
    pub(crate) async fn resolve_host(&self, hostname: &str) -> Result<Vec<IpAddr>, String> {
        self.state
            .lookup(hostname)
            .await
            .map(|addresses| addresses.into_iter().map(|address| address.ip()).collect())
    }
    #[cfg(test)]
    pub(crate) fn fixture(
        client: reqwest::Client,
        endpoint: String,
        fallback: DnsFallback,
        system_result: Result<Vec<SocketAddr>, String>,
    ) -> Self {
        let mut resolver = Self::from_client(client, endpoint, fallback);
        Arc::get_mut(&mut resolver.state).unwrap().system_result = Some(system_result);
        resolver
    }
}

impl Resolve for DohResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let state = self.state.clone();
        let hostname = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = state
                .lookup(&hostname)
                .await
                .map_err(std::io::Error::other)?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

impl State {
    async fn lookup(&self, hostname: &str) -> Result<Vec<SocketAddr>, String> {
        let literal = hostname
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(hostname);
        if let Ok(ip) = literal.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, 0)]);
        }
        let hostname = canonical_name(hostname)?;
        // RFC 6761 localhost is local-only. This bypass never sends its name to
        // Cloudflare and is separate from the user-selected failure fallback.
        if hostname == "localhost" || hostname.ends_with(".localhost") {
            return self.system_lookup(hostname).await;
        }
        if let Some(entry) = lock(&self.cache)
            .get(&hostname)
            .filter(|entry| entry.expires > Instant::now())
        {
            self.counters.cache_hits.fetch_add(1, Ordering::Relaxed);
            return Ok(entry.addresses.clone());
        }
        let result = self.encrypted_lookup(&hostname).await;
        match result {
            Ok((addresses, ttl)) => {
                if ttl > 0 {
                    let mut cache = lock(&self.cache);
                    let now = Instant::now();
                    cache.retain(|_, entry| entry.expires > now);
                    if cache.len() >= MAX_CACHE_ENTRIES && !cache.contains_key(&hostname) {
                        if let Some(oldest) = cache
                            .iter()
                            .min_by_key(|(_, entry)| entry.expires)
                            .map(|(name, _)| name.clone())
                        {
                            cache.remove(&oldest);
                        }
                    }
                    cache.insert(
                        hostname,
                        CacheEntry {
                            addresses: addresses.clone(),
                            expires: now + Duration::from_secs(ttl.min(MAX_TTL_SECONDS).into()),
                        },
                    );
                }
                Ok(addresses)
            }
            Err(error) => {
                self.counters.failures.fetch_add(1, Ordering::Relaxed);
                *lock(&self.counters.last_failure) = Some(error.clone());
                match self.fallback {
                    DnsFallback::FailClosed => Err(error),
                    DnsFallback::System => {
                        self.counters.fallbacks.fetch_add(1, Ordering::Relaxed);
                        self.system_lookup(hostname).await
                    }
                }
            }
        }
    }
    async fn encrypted_lookup(&self, hostname: &str) -> Result<(Vec<SocketAddr>, u32), String> {
        let _permit =
            tokio::time::timeout(ADMISSION_TIMEOUT, self.query_slots.clone().acquire_owned())
                .await
                .map_err(|_| "doh_busy")?
                .map_err(|_| "doh_unavailable")?;
        let (a, aaaa) = tokio::join!(self.query(hostname, 1), self.query(hostname, 28));
        let mut addresses = BTreeSet::new();
        let mut ttl = MAX_TTL_SECONDS;
        let mut error = None;
        for answer in [a, aaaa] {
            match answer {
                Ok(answer) if !answer.ips.is_empty() => {
                    ttl = ttl.min(answer.ttl);
                    addresses.extend(answer.ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
                }
                Ok(_) => {}
                Err(reason) => error = Some(reason),
            }
        }
        if addresses.is_empty() {
            return Err(error.unwrap_or_else(|| "doh_no_addresses".into()));
        }
        if let Some(error) = error {
            // A healthy family can still connect. Do not hide the other family's
            // failure, and retry it sooner than a long positive record TTL.
            self.counters.failures.fetch_add(1, Ordering::Relaxed);
            *lock(&self.counters.last_failure) = Some(error);
            ttl = ttl.min(30);
        }
        Ok((addresses.into_iter().take(MAX_ANSWERS).collect(), ttl))
    }
    async fn query(&self, hostname: &str, kind: u16) -> Result<AnswerSet, String> {
        self.counters.queries.fetch_add(1, Ordering::Relaxed);
        let request = async {
            let mut response = self
                .client
                .get(&self.endpoint)
                .header(reqwest::header::ACCEPT, "application/dns-json")
                .query(&[
                    ("name", hostname),
                    ("type", &kind.to_string()),
                    ("cd", "false"),
                ])
                .send()
                .await
                .map_err(|_| "doh_transport".to_string())?;
            if !response.status().is_success() {
                return Err(format!("doh_http_{}", response.status().as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
            {
                return Err("doh_response_too_large".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "doh_response_read")? {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err("doh_response_too_large".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            parse_answer(&bytes, hostname, kind)
        };
        tokio::time::timeout(QUERY_TIMEOUT, request)
            .await
            .map_err(|_| "doh_timeout".to_string())?
    }
    async fn system_lookup(&self, hostname: String) -> Result<Vec<SocketAddr>, String> {
        #[cfg(test)]
        if let Some(result) = &self.system_result {
            return result.clone();
        }
        bounded_system_lookup(hostname, self.system_slots.clone()).await
    }
}

/// Manual preflight resolution and DoH fallback have the same bounded system
/// worker ownership. Literal IP addresses need no DNS or external network.
pub(crate) async fn system_addresses(
    hostname: &str,
    slots: Arc<Semaphore>,
) -> Result<Vec<IpAddr>, String> {
    let literal = hostname
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(hostname);
    if let Ok(ip) = literal.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    bounded_system_lookup(canonical_name(hostname)?, slots)
        .await
        .map(|addresses| addresses.into_iter().map(|address| address.ip()).collect())
}

async fn bounded_system_lookup(
    hostname: String,
    slots: Arc<Semaphore>,
) -> Result<Vec<SocketAddr>, String> {
    run_system_lookup(slots, SYSTEM_TIMEOUT, move || {
        (hostname.as_str(), 0)
            .to_socket_addrs()
            .map(|addresses| addresses.take(MAX_ANSWERS).collect::<Vec<_>>())
            .map_err(|_| "system_dns_failed".to_string())
    })
    .await
}

pub(crate) async fn run_system_lookup(
    slots: Arc<Semaphore>,
    timeout: Duration,
    lookup: impl FnOnce() -> Result<Vec<SocketAddr>, String> + Send + 'static,
) -> Result<Vec<SocketAddr>, String> {
    let permit = tokio::time::timeout(ADMISSION_TIMEOUT, slots.acquire_owned())
        .await
        .map_err(|_| "system_dns_busy")?
        .map_err(|_| "system_dns_unavailable")?;
    let (sender, result) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("pcl-system-dns".into())
        .spawn(move || {
            // A timed-out OS lookup may continue inside libc. Its permit stays
            // with the worker until it finishes, bounding lingering workers. This
            // detached read-only worker is independent of reqwest's private Tokio
            // runtime, so dropping a blocking HTTP client cannot join a slow libc
            // resolver after the advertised timeout already returned.
            let _permit = permit;
            let _ = sender.send(lookup());
        })
        .map_err(|_| "system_dns_worker_failed")?;
    let addresses = tokio::time::timeout(timeout, result)
        .await
        .map_err(|_| "system_dns_timeout")?
        .map_err(|_| "system_dns_worker_failed")??;
    if addresses.is_empty() {
        return Err("system_dns_no_addresses".into());
    }
    Ok(addresses)
}

fn canonical_name(name: &str) -> Result<String, String> {
    let name = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
    if name.is_empty()
        || name.len() > 253
        || name.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        })
    {
        return Err("dns_invalid_name".into());
    }
    Ok(name)
}

#[derive(Deserialize)]
struct DnsReply {
    #[serde(rename = "Status")]
    status: u32,
    #[serde(rename = "TC")]
    truncated: bool,
    #[serde(rename = "Question")]
    question: Vec<Question>,
    #[serde(default, rename = "Answer")]
    answers: Vec<Record>,
}
#[derive(Deserialize)]
struct Question {
    name: String,
    #[serde(rename = "type")]
    kind: u16,
}
#[derive(Deserialize)]
struct Record {
    name: String,
    #[serde(rename = "type")]
    kind: u16,
    #[serde(rename = "TTL")]
    ttl: u32,
    data: String,
}
pub(crate) struct AnswerSet {
    pub ips: Vec<IpAddr>,
    pub ttl: u32,
}

pub(crate) fn parse_answer(bytes: &[u8], hostname: &str, kind: u16) -> Result<AnswerSet, String> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("doh_response_too_large".into());
    }
    let reply: DnsReply = serde_json::from_slice(bytes).map_err(|_| "doh_invalid_schema")?;
    if reply.status != 0 {
        return Err(format!("doh_dns_status_{}", reply.status));
    }
    if reply.truncated
        || reply.answers.len() > MAX_ANSWERS
        || reply.question.len() != 1
        || canonical_name(&reply.question[0].name)? != hostname
        || reply.question[0].kind != kind
    {
        return Err("doh_mismatched_or_truncated_answer".into());
    }
    let mut owners = BTreeSet::from([hostname.to_owned()]);
    let mut ttl = MAX_TTL_SECONDS;
    // Follow only answer CNAMEs reachable from the exact question. Unrelated
    // address records never become download/authentication connection targets.
    for _ in 0..8 {
        let mut changed = false;
        let previous = owners.clone();
        for record in reply.answers.iter().filter(|record| record.kind == 5) {
            if previous.contains(&canonical_name(&record.name)?) {
                ttl = ttl.min(record.ttl);
                changed |= owners.insert(canonical_name(&record.data)?);
            }
        }
        if !changed {
            break;
        }
    }
    for record in reply.answers.iter().filter(|record| record.kind == 5) {
        if owners.contains(&canonical_name(&record.name)?)
            && !owners.contains(&canonical_name(&record.data)?)
        {
            return Err("doh_cname_chain_too_deep".into());
        }
    }
    let mut ips = BTreeSet::new();
    for record in reply.answers.iter().filter(|record| record.kind == kind) {
        if !owners.contains(&canonical_name(&record.name)?) {
            continue;
        }
        let ip = record
            .data
            .parse::<IpAddr>()
            .map_err(|_| "doh_invalid_ip")?;
        if !matches!((kind, ip), (1, IpAddr::V4(_)) | (28, IpAddr::V6(_))) {
            return Err("doh_wrong_address_family".into());
        }
        ttl = ttl.min(record.ttl);
        ips.insert(ip);
    }
    Ok(AnswerSet {
        ips: ips.into_iter().collect(),
        ttl,
    })
}
