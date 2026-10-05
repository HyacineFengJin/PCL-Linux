use super::*;
use reqwest::dns::Resolve;
use serde_json::json;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

struct Server {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(handler: impl Fn(&str) -> (u16, String) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = requests.clone();
        let done = stop.clone();
        let worker = thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(_) => break,
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while request.len() < 8192 && !request.windows(4).any(|value| value == b"\r\n\r\n")
                {
                    match socket.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(size) => request.extend_from_slice(&buffer[..size]),
                    }
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                captured.lock().unwrap().push(request.clone());
                let target = request
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/");
                let (status, body) = handler(target);
                let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/dns-json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes());
            }
        });
        Self {
            address,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn url(&self) -> String {
        format!("http://{}/", self.address)
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn reply(target: &str, ttl: u32) -> String {
    let url = reqwest::Url::parse(&format!("http://fixture{target}")).unwrap();
    let values: BTreeMap<_, _> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let kind: u16 = values["type"].parse().unwrap();
    let name = &values["name"];
    let address = if kind == 1 {
        "192.0.2.10"
    } else {
        "2001:db8::10"
    };
    json!({"Status":0,"TC":false,"Question":[{"name":format!("{name}."),"type":kind}],
        "Answer":[{"name":format!("{name}."),"type":kind,"TTL":ttl,"data":address}]})
    .to_string()
}
fn resolver(server: &Server, fallback: DnsFallback) -> doh::DohResolver {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    doh::DohResolver::fixture(
        client,
        format!("{}dns-query", server.url()),
        fallback,
        Ok(vec!["127.0.0.1:0".parse().unwrap()]),
    )
}

#[test]
fn custom_proxy_validation_rejects_credentials_and_never_exposes_endpoints_in_debug() {
    for endpoint in [
        "",
        "http://user:secret@host:80",
        "http://user@host",
        "http://host?token=secret",
        "http://host/#fragment",
        "http://host/path",
        "socks5://host:80",
        "javascript:proxy",
        "http://host\n",
    ] {
        let policy = Policy {
            proxy: ProxyPolicy::Custom(endpoint.into()),
            dns: DnsPolicy::System,
        };
        assert!(policy.validate().is_err());
        assert!(!format!("{policy:?}").contains(endpoint) || endpoint.is_empty());
    }
    assert!(Policy {
        proxy: ProxyPolicy::Custom("https://127.0.0.1:8080".into()),
        dns: DnsPolicy::System
    }
    .validate()
    .is_ok());
}

#[tokio::test]
async fn custom_proxy_routes_requests_and_each_factory_keeps_its_captured_endpoint() {
    let first = Server::new(|_| (200, "first".into()));
    let second = Server::new(|_| (200, "second".into()));
    let make = |server: &Server| {
        ClientFactory::new(Policy {
            proxy: ProxyPolicy::Custom(server.url()),
            dns: DnsPolicy::System,
        })
        .unwrap()
    };
    let first_factory = make(&first);
    let original = first_factory.async_client().build().unwrap();
    let second_factory = make(&second);
    let newer = second_factory.async_client().build().unwrap();
    assert_eq!(
        original
            .get("http://remote.invalid/one")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "first"
    );
    assert_eq!(
        newer
            .get("http://remote.invalid/two")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "second"
    );
    assert_eq!(
        original
            .get("http://remote.invalid/three")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "first"
    );
    assert_eq!((first.count(), second.count()), (2, 1));
    assert!(first.requests.lock().unwrap()[0].contains("http://remote.invalid/one"));
}

#[tokio::test]
async fn system_proxy_snapshot_honors_uppercase_precedence_and_no_proxy_without_mutating_environment(
) {
    let proxy = Server::new(|_| (200, "proxy".into()));
    let origin = Server::new(|_| (200, "direct".into()));
    let environment = BTreeMap::from([
        ("HTTP_PROXY", proxy.url()),
        ("http_proxy", "http://unreachable.invalid:9".into()),
        ("NO_PROXY", "bypass.invalid".into()),
    ]);
    let proxies = policy::ProxySnapshot::from_environment(&ProxyPolicy::System, |key| {
        environment.get(key).cloned()
    })
    .unwrap();
    let factory = ClientFactory::with_snapshot(Policy::default(), proxies).unwrap();
    let client = factory
        .async_client()
        .resolve("bypass.invalid", origin.address)
        .build()
        .unwrap();
    assert_eq!(
        client
            .get("http://remote.invalid/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "proxy"
    );
    assert_eq!(
        client
            .get(format!("http://bypass.invalid:{}/", origin.address.port()))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "direct"
    );
    assert_eq!((proxy.count(), origin.count()), (1, 1));
    assert!(factory.status().system_proxy_configured);
}

#[tokio::test]
async fn none_policy_ignores_proxy_environment_in_the_factory_snapshot() {
    let proxy = Server::new(|_| (200, "proxy".into()));
    let origin = Server::new(|_| (200, "direct".into()));
    let proxies =
        policy::ProxySnapshot::from_environment(&ProxyPolicy::None, |_| Some(proxy.url())).unwrap();
    let factory = ClientFactory::with_snapshot(
        Policy {
            proxy: ProxyPolicy::None,
            dns: DnsPolicy::System,
        },
        proxies,
    )
    .unwrap();
    let response = factory
        .async_client()
        .resolve("direct.invalid", origin.address)
        .build()
        .unwrap()
        .get(format!("http://direct.invalid:{}/", origin.address.port()))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(response, "direct");
    assert_eq!(proxy.count(), 0);
}

#[test]
fn invalid_system_environment_and_cgi_are_visible_and_redacted() {
    let proxy = policy::ProxySnapshot::from_environment(&ProxyPolicy::System, |key| match key {
        "ALL_PROXY" => Some("socks5://secret:password@host:1080".into()),
        _ => None,
    })
    .unwrap();
    assert!(!proxy.configured);
    let warning = proxy.warning.unwrap();
    assert!(!warning.contains("secret"));
    assert!(!warning.contains("password"));
    let cgi = policy::ProxySnapshot::from_environment(&ProxyPolicy::System, |key| match key {
        "REQUEST_METHOD" => Some("GET".into()),
        "ALL_PROXY" => Some("http://proxy.invalid".into()),
        _ => None,
    })
    .unwrap();
    assert!(!cgi.configured);
    assert!(cgi.warning.unwrap().contains("CGI"));
}

#[tokio::test]
async fn encrypted_dual_stack_answers_are_cached_with_their_ttl() {
    let server = Server::new(|target| (200, reply(target, 120)));
    let resolver = resolver(&server, DnsFallback::FailClosed);
    let first: Vec<_> = resolver
        .resolve("fixture.invalid".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert!(first.iter().any(SocketAddr::is_ipv4));
    assert!(first.iter().any(SocketAddr::is_ipv6));
    assert!(first.iter().all(|address| address.port() == 0));
    let second: Vec<_> = resolver
        .resolve("fixture.invalid".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert_eq!(first, second);
    assert_eq!(server.count(), 2);
    let stats = resolver.status();
    assert_eq!(stats.queries, 2);
    assert_eq!(stats.cache_hits, 1);
    assert_eq!(stats.fallbacks, 0);
    let requests = server.requests.lock().unwrap();
    assert!(requests.iter().all(|request| request
        .to_ascii_lowercase()
        .contains("accept: application/dns-json")));
    assert!(requests.iter().all(|request| request.contains("cd=false")));
}

#[tokio::test]
async fn zero_ttl_is_never_cached() {
    let server = Server::new(|target| (200, reply(target, 0)));
    let resolver = resolver(&server, DnsFallback::FailClosed);
    for _ in 0..2 {
        assert!(resolver
            .resolve("fixture.invalid".parse().unwrap())
            .await
            .is_ok());
    }
    assert_eq!(server.count(), 4);
    assert_eq!(resolver.status().cache_hits, 0);
}

#[tokio::test]
async fn failed_encrypted_resolution_obeys_explicit_fallback_policy_and_reports_it() {
    let server = Server::new(|_| (503, "private error body must not escape".into()));
    let closed = resolver(&server, DnsFallback::FailClosed);
    assert!(closed
        .resolve("fixture.invalid".parse().unwrap())
        .await
        .is_err());
    assert_eq!(closed.status().fallbacks, 0);
    assert_eq!(
        closed.status().last_failure.as_deref(),
        Some("doh_http_503")
    );
    let fallback = resolver(&server, DnsFallback::System);
    let addresses: Vec<_> = fallback
        .resolve("fixture.invalid".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert_eq!(
        addresses,
        vec!["127.0.0.1:0".parse::<SocketAddr>().unwrap()]
    );
    assert_eq!(fallback.status().fallbacks, 1);
    assert_eq!(fallback.status().failures, 1);
    assert!(!fallback.status().last_failure.unwrap().contains("private"));
}

#[tokio::test]
async fn malformed_truncated_and_oversized_responses_fail_instead_of_escaping_bounds() {
    for body in [
        "not JSON".to_owned(),
        "x".repeat(16 * 1024 + 1),
        json!({"Status":0,"TC":true,"Question":[{"name":"fixture.invalid.","type":1}]}).to_string(),
    ] {
        let server = Server::new(move |_| (200, body.clone()));
        let resolver = resolver(&server, DnsFallback::FailClosed);
        assert!(resolver
            .resolve("fixture.invalid".parse().unwrap())
            .await
            .is_err());
        assert_eq!(resolver.status().fallbacks, 0);
    }
}

#[test]
fn only_question_bound_addresses_and_cname_chain_ttls_are_accepted() {
    let answer = json!({"Status":0,"TC":false,"Question":[{"name":"fixture.invalid.","type":1}],"Answer":[
        {"name":"unrelated.invalid.","type":1,"TTL":30,"data":"192.0.2.66"},
        {"name":"fixture.invalid.","type":5,"TTL":7,"data":"alias.invalid."},
        {"name":"alias.invalid.","type":1,"TTL":120,"data":"192.0.2.10"}
    ]});
    let parsed =
        doh::parse_answer(&serde_json::to_vec(&answer).unwrap(), "fixture.invalid", 1).unwrap();
    assert_eq!(
        parsed.ips,
        vec!["192.0.2.10".parse::<std::net::IpAddr>().unwrap()]
    );
    assert_eq!(parsed.ttl, 7);
    let mut wrong = answer.clone();
    wrong["Question"][0]["name"] = "other.invalid.".into();
    assert!(doh::parse_answer(&serde_json::to_vec(&wrong).unwrap(), "fixture.invalid", 1).is_err());
    wrong = answer;
    wrong["Answer"][2]["data"] = "2001:db8::10".into();
    assert!(doh::parse_answer(&serde_json::to_vec(&wrong).unwrap(), "fixture.invalid", 1).is_err());
}

#[test]
fn cname_depth_and_answer_count_have_fixed_limits() {
    let records: Vec<_> = (0..10).map(|index| json!({"name":if index == 0 {"fixture.invalid".into()} else {format!("alias{index}.invalid")},
        "type":5,"TTL":120,"data":format!("alias{}.invalid",index + 1)})).collect();
    let answer = json!({"Status":0,"TC":false,"Question":[{"name":"fixture.invalid.","type":1}],"Answer":records});
    assert!(
        doh::parse_answer(&serde_json::to_vec(&answer).unwrap(), "fixture.invalid", 1).is_err()
    );
    let records: Vec<_> = (0..65)
        .map(|_| json!({"name":"fixture.invalid.","type":1,"TTL":10,"data":"192.0.2.10"}))
        .collect();
    let answer = json!({"Status":0,"TC":false,"Question":[{"name":"fixture.invalid.","type":1}],"Answer":records});
    assert!(
        doh::parse_answer(&serde_json::to_vec(&answer).unwrap(), "fixture.invalid", 1).is_err()
    );
}

#[tokio::test]
async fn a_healthy_address_family_can_connect_when_the_other_family_fails_visibly() {
    let server = Server::new(|target| {
        if target.contains("type=28") {
            (503, String::new())
        } else {
            (200, reply(target, 120))
        }
    });
    let resolver = resolver(&server, DnsFallback::System);
    let addresses: Vec<_> = resolver
        .resolve("fixture.invalid".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert_eq!(addresses.len(), 1);
    assert!(addresses[0].is_ipv4());
    assert_eq!(resolver.status().failures, 1);
    assert_eq!(resolver.status().fallbacks, 0);
}

#[tokio::test]
async fn localhost_never_leaves_the_local_resolver() {
    let server = Server::new(|_| panic!("localhost must not call DoH"));
    let resolver = resolver(&server, DnsFallback::FailClosed);
    let addresses: Vec<_> = resolver
        .resolve("localhost".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert_eq!(addresses.len(), 1);
    assert!(addresses[0].ip().is_loopback());
    assert_eq!(server.count(), 0);
}

#[tokio::test]
#[ignore = "manual external TLS/DoH probe; run only after explicit authorization"]
async fn cloudflare_tls_bootstrap_probe() {
    let proxies = policy::ProxySnapshot::capture(&ProxyPolicy::None).unwrap();
    let resolver = doh::DohResolver::new(&proxies, DnsFallback::FailClosed).unwrap();
    let addresses: Vec<_> = resolver
        .resolve("example.com".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert!(!addresses.is_empty());
    assert_eq!(resolver.status().fallbacks, 0);
    println!("Cloudflare verified HTTPS bootstrap: {} addresses; IPv4={}; IPv6={}; DoH requests={}; system fallback=0",
        addresses.len(), addresses.iter().any(SocketAddr::is_ipv4), addresses.iter().any(SocketAddr::is_ipv6), resolver.status().queries);
}

#[tokio::test]
async fn explicit_factory_resolution_uses_the_same_doh_cache_and_counters() {
    let server = Server::new(|target| (200, reply(target, 120)));
    let mut factory = ClientFactory::new(Policy {
        proxy: ProxyPolicy::None,
        dns: DnsPolicy::Doh {
            fallback: DnsFallback::FailClosed,
        },
    })
    .unwrap();
    factory.resolver = Some(Arc::new(resolver(&server, DnsFallback::FailClosed)));
    let first = factory.resolve_host("fixture.invalid").await.unwrap();
    assert!(first.iter().any(std::net::IpAddr::is_ipv4));
    assert!(first.iter().any(std::net::IpAddr::is_ipv6));
    assert_eq!(
        factory.resolve_host("fixture.invalid").await.unwrap(),
        first
    );
    assert_eq!(server.count(), 2);
    assert_eq!(factory.status().doh_queries, 2);
    assert_eq!(factory.status().doh_cache_hits, 1);
    assert!(!factory.uses_proxy());
    assert_eq!(
        factory.resolve_host("[::1]").await.unwrap(),
        vec!["::1".parse::<std::net::IpAddr>().unwrap()]
    );
    assert_eq!(server.count(), 2);
}

#[tokio::test]
async fn system_factory_literal_resolution_and_invalid_names_require_no_external_dns() {
    let factory = ClientFactory::new(Policy {
        proxy: ProxyPolicy::None,
        dns: DnsPolicy::System,
    })
    .unwrap();
    assert_eq!(
        factory.resolve_host("127.0.0.1").await.unwrap(),
        vec!["127.0.0.1".parse::<std::net::IpAddr>().unwrap()]
    );
    assert_eq!(
        factory.resolve_host("[::1]").await.unwrap(),
        vec!["::1".parse::<std::net::IpAddr>().unwrap()]
    );
    assert!(factory.resolve_host("bad/name").await.is_err());
    assert!(factory.resolve_host("invalid..name").await.is_err());
    assert_eq!(factory.status().doh_queries, 0);
}

#[tokio::test]
async fn positive_dns_cache_evicts_after_its_fixed_capacity() {
    let server = Server::new(|target| (200, reply(target, 120)));
    let resolver = resolver(&server, DnsFallback::FailClosed);
    for index in 0..257 {
        assert!(resolver
            .resolve(format!("cache{index}.invalid").parse().unwrap())
            .await
            .is_ok());
    }
    assert_eq!(server.count(), 514);
    assert!(resolver
        .resolve("cache256.invalid".parse().unwrap())
        .await
        .is_ok());
    assert_eq!(server.count(), 514);
    assert!(resolver
        .resolve("cache0.invalid".parse().unwrap())
        .await
        .is_ok());
    assert_eq!(server.count(), 516);
}

#[tokio::test]
async fn transport_timeout_is_bounded_and_does_not_silently_fall_back() {
    let server = Server::new(|target| {
        thread::sleep(Duration::from_millis(400));
        (200, reply(target, 120))
    });
    let resolver = resolver(&server, DnsFallback::FailClosed);
    let started = std::time::Instant::now();
    assert!(resolver
        .resolve("fixture.invalid".parse().unwrap())
        .await
        .is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(resolver.status().fallbacks, 0);
    assert!(resolver.status().last_failure.is_some());
}

#[tokio::test]
async fn timed_out_system_workers_keep_admission_until_the_read_only_worker_finishes() {
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let (release, wait) = std::sync::mpsc::channel();
    let result = doh::run_system_lookup(slots.clone(), Duration::from_millis(20), move || {
        wait.recv().unwrap();
        Ok(vec!["127.0.0.1:0".parse().unwrap()])
    })
    .await;
    assert_eq!(result.unwrap_err(), "system_dns_timeout");
    assert_eq!(slots.available_permits(), 0);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while slots.available_permits() == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(slots.available_permits(), 1);
}
