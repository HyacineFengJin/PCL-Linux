//! Declarative homepage data only. Callers invoke local reads after a user's
//! picker/mode/refresh action, never merely because settings were imported.
//! Remote networking is intentionally a separate caller responsibility: every
//! redirect must repeat URL/address validation and pin the checked DNS results.
use super::filesystem::{revision, source};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, path::Path};

const MAX_JSON_BYTES: u64 = 256 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Homepage {
    pub schema_version: u32,
    pub title: Option<String>,
    pub sections: Vec<HomepageSection>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HomepageSection {
    pub title: Option<String>,
    pub text: String,
    #[serde(default)]
    pub links: Vec<HomepageLink>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HomepageLink {
    pub label: String,
    pub url: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct HomepageRead {
    pub revision: String,
    pub page: Homepage,
}
#[derive(Clone, Debug, Serialize)]
pub struct RemoteLocation {
    pub url: String,
    pub host: String,
    pub port: u16,
}

pub fn parse_homepage(bytes: &[u8]) -> Result<Homepage, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("主页 JSON 必须在 256 KiB 内".into());
    }
    // Parser diagnostics can echo arbitrary unknown keys from a private file.
    // Keep all malformed-source errors generic and never return source bytes.
    let mut page: Homepage =
        serde_json::from_slice(bytes).map_err(|_| "主页文件不符合声明式 JSON 格式")?;
    if page.schema_version != 1 || page.sections.len() > 32 {
        return Err("主页格式版本必须为 1，且最多包含 32 个区块".into());
    }
    optional_title(&page.title)?;
    for section in &mut page.sections {
        optional_title(&section.title)?;
        if section.text.len() > 32 * 1024
            || section
                .text
                .chars()
                .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
            || section.links.len() > 16
        {
            return Err("主页区块文本过大或包含无效字符或过多链接".into());
        }
        for link in &mut section.links {
            if link.label.trim().is_empty()
                || link.label.chars().count() > 128
                || link.label.chars().any(char::is_control)
            {
                return Err("主页链接名称无效".into());
            }
            link.url = validated_url(&link.url, false)?.to_string();
        }
    }
    Ok(page)
}
fn optional_title(title: &Option<String>) -> Result<(), String> {
    if title
        .as_ref()
        .is_some_and(|s| s.chars().count() > 256 || s.chars().any(char::is_control))
    {
        Err("主页标题过长或含有控制字符".into())
    } else {
        Ok(())
    }
}

pub fn read_homepage(path: &Path) -> Result<HomepageRead, String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("主页文件名无效")?;
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".json")
        || ["account", "setting", "preference"]
            .iter()
            .any(|term| lower.contains(term))
    {
        return Err("请选择专用主页 JSON 文件，不能读取账号或设置文件".into());
    }
    let (parent, name, mut snapshot) = source(path, MAX_JSON_BYTES)?;
    let bytes = snapshot.bytes(&parent, &name)?;
    let page = parse_homepage(&bytes)?;
    Ok(HomepageRead {
        revision: revision(path, &snapshot)?,
        page,
    })
}

fn validated_url(text: &str, remote: bool) -> Result<Url, String> {
    if text.is_empty()
        || text.len() > 2048
        || text.trim() != text
        || text.chars().any(char::is_control)
        || text.contains('\\')
    {
        return Err("主页链接地址无效".into());
    }
    let url = Url::parse(text).map_err(|_| "主页链接地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || (remote && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(if remote {
            "远程主页仅允许无凭据的 HTTPS 地址"
        } else {
            "主页链接仅允许无凭据的 HTTP 或 HTTPS 地址"
        }
        .into());
    }
    Ok(url)
}

/// Shares the homepage parser's link policy with native link-opening commands.
/// It returns one canonical HTTP(S) URL, never a shell line or filesystem path.
pub fn validate_homepage_link(text: &str) -> Result<String, String> {
    validated_url(text, false).map(|url| url.to_string())
}
pub fn validate_homepage_url(text: &str) -> Result<RemoteLocation, String> {
    let mut url = validated_url(text, true)?;
    let host = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    if !host.contains('.') && host.parse::<IpAddr>().is_err()
        || host == "localhost"
        || [
            ".localhost",
            ".local",
            ".internal",
            ".lan",
            ".home",
            ".test",
            ".invalid",
            ".example",
        ]
        .iter()
        .any(|suffix| host.ends_with(suffix))
    {
        return Err("远程主页必须使用公开 HTTPS 主机".into());
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        validate_public_addresses(&[address])?;
        url.set_ip_host(address)
            .map_err(|_| "远程主页网络地址无效")?;
    } else {
        // The DNS pin key and actual URL host must be identical. Otherwise a
        // trailing dot can bypass a caller's resolver override after validation.
        url.set_host(Some(host)).map_err(|_| "远程主页主机名无效")?;
    }
    Ok(RemoteLocation {
        url: url.to_string(),
        host: host.to_owned(),
        port: url.port_or_known_default().unwrap_or(443),
    })
}
pub fn validate_public_addresses(addresses: &[IpAddr]) -> Result<(), String> {
    if addresses.is_empty() || addresses.len() > 64 || addresses.iter().any(|ip| !public(*ip)) {
        return Err("远程主页解析到非公开或无效的网络地址，已拒绝请求".into());
    }
    Ok(())
}
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && (b == 168 || b == 0 || b == 2)
                || a == 100 && (64..=127).contains(&b)
                || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let b = ip.octets();
            !ip.is_unspecified()
                && !ip.is_loopback()
                && b[0] & 0xfe != 0xfc
                && !(b[0] == 0xfe && b[1] & 0xc0 >= 0x80)
                && b[0] != 0xff
                && b[..4] != [0x20, 0x01, 0x0d, 0xb8]
                && b[0] != 0
        }
    }
}
