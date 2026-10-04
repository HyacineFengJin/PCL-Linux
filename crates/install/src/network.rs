use super::*;
use std::sync::OnceLock;

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("installer HTTP runtime")
    })
}
impl Installer {
    /// The entire HTTP operation stays inside the cancellable future, including
    /// DNS, TLS, response headers and stalled response bodies. Dropping it closes
    /// the transfer before the caller releases the writer admission.
    pub(crate) fn transfer(
        &self,
        url: &Url,
        limit: u64,
        cancel: &AtomicBool,
        mut consume: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        check(cancel)?;
        runtime().block_on(async {
            tokio::select! {
                biased;
                _ = async {
                    loop {
                        if cancel.load(Ordering::Relaxed) { break; }
                        tokio::time::sleep(Duration::from_millis(40)).await;
                    }
                } => Err("安装已取消".into()),
                result = async {
                    let mut current = url.clone();
                    let mut response = None;
                    for _ in 0..6 {
                        self.url(current.as_str())?;
                        let next = self.client.get(current.clone()).send().await.map_err(network_error)?;
                        if next.status().is_redirection() {
                            let location = next.headers().get(reqwest::header::LOCATION).and_then(|h| h.to_str().ok()).ok_or("官方下载重定向缺少地址")?;
                            current = current.join(location).map_err(error)?;
                            self.url(current.as_str())?;
                            continue;
                        }
                        if !next.status().is_success() { return Err(format!("HTTP {}", next.status())); }
                        response = Some(next);
                        break;
                    }
                    let mut response = response.ok_or("官方下载重定向次数过多")?;
                    if response.content_length().is_some_and(|size| size > limit) {
                        return Err("下载文件超过允许的大小".into());
                    }
                    let mut bytes = 0u64;
                    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                        check(cancel)?;
                        bytes = bytes.checked_add(chunk.len() as u64).ok_or("下载文件大小超出范围")?;
                        if bytes > limit { return Err("下载文件超过允许的大小".into()); }
                        consume(&chunk)?;
                    }
                    check(cancel)
                } => result,
            }
        })
    }
}
impl Installer {
    pub(crate) fn head_size(&self, url: &Url, cancel: &AtomicBool) -> Result<u64> {
        self.url(url.as_str())?;
        check(cancel)?;
        runtime().block_on(async {
            tokio::select! {
                _ = async { loop { if cancel.load(Ordering::Relaxed) { break; } tokio::time::sleep(Duration::from_millis(40)).await; } } => Err("安装已取消".into()),
                result = async {
                    let response = self.client.head(url.clone()).send().await.map_err(network_error)?;
                    if !response.status().is_success() { return Err(format!("HTTP {}", response.status())); }
                    let size = response.headers().get(reqwest::header::CONTENT_LENGTH).and_then(|s| s.to_str().ok()).and_then(|s| s.parse::<u64>().ok()).ok_or("组件库未声明大小")?;
                    if size == 0 || size > 512 * 1024 * 1024 { return Err("组件库大小无效或超过允许范围".into()); }
                    Ok(size)
                } => result,
            }
        })
    }
}
