use reqwest::{NoProxy, Proxy, Url};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "endpoint", rename_all = "snake_case")]
pub enum ProxyPolicy {
    None,
    #[default]
    System,
    Custom(String),
}
impl fmt::Debug for ProxyPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::None => "None",
            Self::System => "System",
            Self::Custom(_) => "Custom(<endpoint>)",
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DnsFallback {
    /// A failed encrypted lookup fails the request instead of issuing plain DNS.
    #[default]
    FailClosed,
    /// Plain system DNS may be used after a failed DoH lookup, visibly counted.
    System,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DnsPolicy {
    #[default]
    System,
    Doh {
        fallback: DnsFallback,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub proxy: ProxyPolicy,
    pub dns: DnsPolicy,
}
impl Policy {
    pub fn validate(&self) -> Result<(), String> {
        if let ProxyPolicy::Custom(endpoint) = &self.proxy {
            custom_endpoint(endpoint)?;
        }
        Ok(())
    }
}

fn custom_endpoint(endpoint: &str) -> Result<Url, String> {
    if endpoint.is_empty()
        || endpoint.len() > 2048
        || endpoint.trim() != endpoint
        || endpoint.chars().any(char::is_control)
    {
        return Err("自定义代理地址为空、过长或含有无效字符".into());
    }
    let url = Url::parse(endpoint).map_err(|_| "自定义代理地址不是有效的 HTTP 或 HTTPS URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("自定义代理只支持 HTTP/HTTPS 主机和端口，不支持认证、路径、参数或片段".into());
    }
    Ok(url)
}

/// Linux system mode reads the same environment keys and uppercase precedence
/// used by reqwest 0.12. Capturing them once makes a factory immutable. Raw
/// authenticated environment values are never part of Debug or status output.
#[derive(Clone, Default)]
pub(crate) struct ProxySnapshot {
    proxies: Vec<Proxy>,
    pub warning: Option<String>,
    pub configured: bool,
}
impl ProxySnapshot {
    pub fn with_warning(warning: String) -> Self {
        Self {
            warning: Some(warning),
            ..Self::default()
        }
    }
    pub fn capture(policy: &ProxyPolicy) -> Result<Self, String> {
        Self::from_environment(policy, |key| std::env::var(key).ok())
    }
    pub(crate) fn from_environment(
        policy: &ProxyPolicy,
        read: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        match policy {
            ProxyPolicy::None => Ok(Self::default()),
            ProxyPolicy::Custom(endpoint) => {
                let proxy =
                    Proxy::all(custom_endpoint(endpoint)?).map_err(|_| "无法配置自定义代理")?;
                Ok(Self {
                    proxies: vec![proxy],
                    warning: None,
                    configured: true,
                })
            }
            ProxyPolicy::System => {
                if read("REQUEST_METHOD").is_some() {
                    return Ok(Self {
                        warning: Some(
                            "当前进程具有 CGI 环境标记，按 reqwest 安全规则忽略系统代理环境变量"
                                .into(),
                        ),
                        ..Self::default()
                    });
                }
                let first = |upper, lower| read(upper).or_else(|| read(lower));
                let mut warnings = Vec::new();
                let mut endpoint = |raw: Option<String>, label: &str| -> Option<Url> {
                    let raw = raw.filter(|value| !value.is_empty())?;
                    if raw.len() > 2048 || raw.chars().any(char::is_control) {
                        warnings.push(format!("{label} 无效，已忽略该系统代理条目"));
                        return None;
                    }
                    let value = if raw.contains("://") {
                        raw
                    } else {
                        format!("http://{raw}")
                    };
                    match Url::parse(&value) {
                        Ok(url)
                            if matches!(url.scheme(), "http" | "https")
                                && url.host_str().is_some() =>
                        {
                            Some(url)
                        }
                        _ => {
                            warnings
                                .push(format!("{label} 协议或地址不受支持，已忽略该系统代理条目"));
                            None
                        }
                    }
                };
                let all = endpoint(first("ALL_PROXY", "all_proxy"), "ALL_PROXY");
                let http = endpoint(first("HTTP_PROXY", "http_proxy"), "HTTP_PROXY")
                    .or_else(|| all.clone());
                let https = endpoint(first("HTTPS_PROXY", "https_proxy"), "HTTPS_PROXY").or(all);
                let no_proxy = match first("NO_PROXY", "no_proxy") {
                    Some(raw) if raw.len() <= 16384 && !raw.chars().any(char::is_control) => {
                        NoProxy::from_string(&raw)
                    }
                    Some(_) => {
                        warnings.push("NO_PROXY 过长或无效，已忽略该绕过列表".into());
                        None
                    }
                    None => None,
                };
                let mut proxies = Vec::new();
                if let Some(url) = http {
                    proxies.push(
                        Proxy::http(url)
                            .map_err(|_| "无法配置 HTTP 系统代理")?
                            .no_proxy(no_proxy.clone()),
                    );
                }
                if let Some(url) = https {
                    proxies.push(
                        Proxy::https(url)
                            .map_err(|_| "无法配置 HTTPS 系统代理")?
                            .no_proxy(no_proxy),
                    );
                }
                Ok(Self {
                    configured: !proxies.is_empty(),
                    proxies,
                    warning: (!warnings.is_empty()).then(|| warnings.join("；")),
                })
            }
        }
    }
    pub fn async_builder(&self, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        self.proxies
            .iter()
            .cloned()
            .fold(builder.no_proxy(), |builder, proxy| builder.proxy(proxy))
    }
    pub fn blocking_builder(
        &self,
        builder: reqwest::blocking::ClientBuilder,
    ) -> reqwest::blocking::ClientBuilder {
        self.proxies
            .iter()
            .cloned()
            .fold(builder.no_proxy(), |builder, proxy| builder.proxy(proxy))
    }
}
