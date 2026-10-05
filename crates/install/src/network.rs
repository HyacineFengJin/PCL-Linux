//! Installer HTTP lifetimes include queue admission and payload pacing.
//! A sibling failure stops outstanding transfers before scoped workers return;
//! metadata keeps its original unpaced client timeout and authority rules.
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
#[derive(Clone, Copy)]
enum TransferKind {
    Metadata,
    Artifact,
}
async fn wait_stopped(cancel: &AtomicBool, abort: Option<&AtomicBool>) {
    loop {
        if cancel.load(Ordering::Acquire)
            || abort.is_some_and(|abort| abort.load(Ordering::Acquire))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
impl Installer {
    pub(crate) fn transfer(
        &self,
        url: &Url,
        limit: u64,
        cancel: &AtomicBool,
        consume: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        self.transfer_inner(url, limit, cancel, None, TransferKind::Artifact, consume)
    }
    pub(crate) fn metadata_transfer(
        &self,
        url: &Url,
        limit: u64,
        cancel: &AtomicBool,
        consume: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        self.transfer_inner(url, limit, cancel, None, TransferKind::Metadata, consume)
    }
    pub(crate) fn transfer_with_abort(
        &self,
        url: &Url,
        limit: u64,
        cancel: &AtomicBool,
        abort: &AtomicBool,
        consume: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        self.transfer_inner(
            url,
            limit,
            cancel,
            Some(abort),
            TransferKind::Artifact,
            consume,
        )
    }
    fn transfer_inner(
        &self,
        url: &Url,
        limit: u64,
        cancel: &AtomicBool,
        abort: Option<&AtomicBool>,
        kind: TransferKind,
        mut consume: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        check(cancel)?;
        runtime().block_on(async {
            // Dropping the read future also drops its response and slot. The
            // synchronous caller can then clean its owned partial file before
            // the scoped worker joins; no detached network work survives.
            tokio::select! {
                biased;
                _ = wait_stopped(cancel, abort) => {
                    if cancel.load(Ordering::Acquire) {
                        Err("安装已取消".into())
                    } else {
                        Err("其他下载失败，传输已停止".into())
                    }
                },
                result = self.read_transfer(url, limit, cancel, kind, &mut consume) => result,
            }
        })
    }
    async fn read_transfer(
        &self,
        url: &Url,
        limit: u64,
        cancel: &AtomicBool,
        kind: TransferKind,
        consume: &mut impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let artifact = matches!(kind, TransferKind::Artifact);
        let _permit = if artifact {
            Some(self.downloads.acquire(cancel).await?)
        } else {
            None
        };
        let mut response = self.transfer_response(url, artifact).await?;
        if response.content_length().is_some_and(|size| size > limit) {
            return Err("下载文件超过允许的大小".into());
        }
        let mut bytes = 0u64;
        loop {
            let chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk())
                .await
                .map_err(|_| "官方下载数据读取超过60秒")?
                .map_err(network_error)?;
            let Some(chunk) = chunk else { break };
            check(cancel)?;
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .ok_or("下载文件大小超出范围")?;
            if bytes > limit {
                return Err("下载文件超过允许的大小".into());
            }
            if artifact {
                for slice in chunk.chunks(pcl_network::DOWNLOAD_SLICE_BYTES) {
                    self.downloads.throttle(slice.len() as u64, cancel).await?;
                    consume(slice)?;
                }
            } else {
                consume(&chunk)?;
            }
        }
        check(cancel)
    }
    async fn transfer_response(&self, url: &Url, artifact: bool) -> Result<reqwest::Response> {
        let mut current = url.clone();
        for _ in 0..6 {
            self.url(current.as_str())?;
            let mut request = self.client.get(current.clone());
            // Payload pacing must not consume the original 120s wall timeout.
            // Headers and stalled reads retain independent short deadlines.
            if artifact && self.downloads.policy().total_rate_limit_mib_per_second > 0 {
                request = request.timeout(Duration::from_secs(24 * 60 * 60));
            }
            let response = tokio::time::timeout(Duration::from_secs(60), request.send())
                .await
                .map_err(|_| "官方下载响应超过60秒")?
                .map_err(network_error)?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|header| header.to_str().ok())
                    .ok_or("官方下载重定向缺少地址")?;
                current = current.join(location).map_err(error)?;
                self.url(current.as_str())?;
                continue;
            }
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            return Ok(response);
        }
        Err("官方下载重定向次数过多".into())
    }
    pub(crate) fn head_size(&self, url: &Url, cancel: &AtomicBool) -> Result<u64> {
        self.url(url.as_str())?;
        check(cancel)?;
        runtime().block_on(async {
            tokio::select! {
                biased;
                _ = wait_stopped(cancel, None) => Err("安装已取消".into()),
                result = async {
                    let response = self.client.head(url.clone()).send().await.map_err(network_error)?;
                    if !response.status().is_success() {
                        return Err(format!("HTTP {}", response.status()));
                    }
                    let size = response.headers().get(reqwest::header::CONTENT_LENGTH)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.parse::<u64>().ok())
                        .ok_or("组件库未声明大小")?;
                    if size == 0 || size > 512 * 1024 * 1024 {
                        return Err("组件库大小无效或超过允许范围".into());
                    }
                    Ok(size)
                } => result,
            }
        })
    }
}
