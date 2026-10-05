//! Fixed Mojang manifest authority. Bound the complete representation before
//! parsing; closed errors never include response text, proxy URLs or queries.
use super::{Marker, NoticeChannel};
use serde::Deserialize;
use std::{collections::HashSet, future::Future, pin::Pin, sync::Arc, time::Duration};

pub(super) const API: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub(super) const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_VERSIONS: usize = 4096;
pub(super) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Heads {
    pub release: Option<Marker>,
    pub snapshot: Option<Marker>,
}
impl Heads {
    pub fn get(&self, channel: NoticeChannel) -> Option<&Marker> {
        match channel {
            NoticeChannel::Release => self.release.as_ref(),
            NoticeChannel::Snapshot => self.snapshot.as_ref(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Network,
    TooLarge,
    Protocol,
    Invalid,
    Cancelled,
    RateLimited(u64),
}
impl Failure {
    pub fn message(self) -> &'static str {
        match self {
            Self::TooLarge => "Minecraft 版本响应超过读取上限",
            Self::Protocol => "Minecraft 版本服务未返回完整且受支持的响应",
            Self::Invalid => "Minecraft 版本响应格式或版本身份无效",
            Self::RateLimited(_) => "Minecraft 版本服务暂时限制请求，请稍后重试",
            _ => "暂时无法检查 Minecraft 版本，请稍后重试",
        }
    }
}
pub(super) trait Provider: Send + Sync {
    fn fetch(&self) -> BoxFuture<'_, Result<Heads, Failure>>;
}
pub(super) struct Mojang {
    network: Arc<pcl_network::ClientFactory>,
    url: String,
}
impl Mojang {
    pub fn new(network: Arc<pcl_network::ClientFactory>) -> Self {
        Self {
            network,
            url: API.into(),
        }
    }
    #[cfg(test)]
    pub fn loopback(network: Arc<pcl_network::ClientFactory>, url: String) -> Self {
        assert!(reqwest::Url::parse(&url)
            .unwrap()
            .host_str()
            .unwrap()
            .parse::<std::net::IpAddr>()
            .unwrap()
            .is_loopback());
        Self { network, url }
    }
}
impl Provider for Mojang {
    fn fetch(&self) -> BoxFuture<'_, Result<Heads, Failure>> {
        Box::pin(async move {
            let client = self
                .network
                .async_client()
                .user_agent("PCL-Linux-Minecraft-update-hints")
                .https_only(self.url == API)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(20))
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .build()
                .map_err(|_| Failure::Network)?;
            let mut response = tokio::time::timeout(
                Duration::from_secs(10),
                client
                    .get(&self.url)
                    .header(reqwest::header::ACCEPT, "application/json")
                    .header(reqwest::header::ACCEPT_ENCODING, "identity")
                    .send(),
            )
            .await
            .map_err(|_| Failure::Network)?
            .map_err(|_| Failure::Network)?;
            if response.status().as_u16() == 429 {
                let retry = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .filter(|v| v.len() <= 8)
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(300)
                    .clamp(300, 3600);
                return Err(Failure::RateLimited(retry));
            }
            if response.status() != reqwest::StatusCode::OK
                || response
                    .headers()
                    .contains_key(reqwest::header::CONTENT_RANGE)
                || response
                    .headers()
                    .get_all(reqwest::header::CONTENT_ENCODING)
                    .iter()
                    .any(|v| {
                        v.to_str()
                            .ok()
                            .is_none_or(|v| !v.eq_ignore_ascii_case("identity"))
                    })
            {
                return Err(Failure::Protocol);
            }
            let expected = response.content_length();
            if expected.is_some_and(|n| n > MAX_BYTES as u64) {
                return Err(Failure::TooLarge);
            }
            let mut body = Vec::new();
            while let Some(chunk) = tokio::time::timeout(Duration::from_secs(10), response.chunk())
                .await
                .map_err(|_| Failure::Network)?
                .map_err(|_| Failure::Network)?
            {
                if body.len().saturating_add(chunk.len()) > MAX_BYTES {
                    return Err(Failure::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            if expected.is_some_and(|n| n != body.len() as u64) {
                return Err(Failure::Protocol);
            }
            parse(&body)
        })
    }
}

#[derive(Deserialize)]
struct Manifest {
    latest: Latest,
    versions: Vec<Version>,
}
#[derive(Deserialize)]
struct Latest {
    release: String,
    snapshot: String,
}
#[derive(Deserialize)]
struct Version {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "releaseTime")]
    release_time: String,
}
pub(super) fn parse(bytes: &[u8]) -> Result<Heads, Failure> {
    if bytes.len() > MAX_BYTES {
        return Err(Failure::TooLarge);
    }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| Failure::Invalid)?;
    if manifest.versions.is_empty()
        || manifest.versions.len() > MAX_VERSIONS
        || !super::valid_id(&manifest.latest.release)
        || !super::valid_id(&manifest.latest.snapshot)
    {
        return Err(Failure::Invalid);
    }
    let mut seen = HashSet::new();
    let mut heads = Heads {
        release: None,
        snapshot: None,
    };
    let mut latest_release = false;
    let mut latest_snapshot = false;
    for version in manifest.versions {
        if !super::valid_id(&version.id)
            || !seen.insert(version.id.clone())
            || !matches!(
                version.kind.as_str(),
                "release" | "snapshot" | "old_alpha" | "old_beta"
            )
        {
            return Err(Failure::Invalid);
        }
        let marker = Marker::new(version.id, &version.release_time).ok_or(Failure::Invalid)?;
        if marker.version_id == manifest.latest.release {
            if version.kind != "release" {
                return Err(Failure::Invalid);
            }
            latest_release = true;
        }
        if marker.version_id == manifest.latest.snapshot {
            // Mojang can publish a final release as both latest values. It is
            // valid authority, but cannot become a snapshot baseline/notice.
            if !matches!(version.kind.as_str(), "release" | "snapshot") {
                return Err(Failure::Invalid);
            }
            latest_snapshot = true;
        }
        let head = match version.kind.as_str() {
            "release" => &mut heads.release,
            "snapshot" => &mut heads.snapshot,
            _ => continue,
        };
        if head.as_ref().is_none_or(|old| marker.time() > old.time()) {
            *head = Some(marker);
        }
    }
    if !latest_release || !latest_snapshot {
        return Err(Failure::Invalid);
    }
    Ok(heads)
}
