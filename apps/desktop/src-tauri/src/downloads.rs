use pcl_install::{InstallResult, Installer, Progress, VersionEntry};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
pub struct DownloadStatus {
    pub stage: String,
    pub phase: String,
    pub message: String,
    pub version: Option<String>,
    pub completed: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub network_bytes: u64,
    pub result: Option<InstallResult>,
}

impl Default for DownloadStatus {
    fn default() -> Self {
        Self {
            stage: "idle".into(),
            phase: "idle".into(),
            message: "选择一个版本开始安装".into(),
            version: None,
            completed: 0,
            total: 0,
            bytes_done: 0,
            bytes_total: 0,
            network_bytes: 0,
            result: None,
        }
    }
}

pub struct Downloads {
    status: Mutex<DownloadStatus>,
    cancel: AtomicBool,
    catalog: Mutex<Option<(Instant, Vec<VersionEntry>)>>,
}

impl Downloads {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(DownloadStatus::default()),
            cancel: AtomicBool::new(false),
            catalog: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> DownloadStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn active(&self) -> bool {
        matches!(
            self.status.lock().unwrap().stage.as_str(),
            "preparing" | "downloading"
        )
    }

    pub fn catalog(&self, refresh: bool) -> Result<Vec<VersionEntry>, String> {
        let mut cache = self.catalog.lock().unwrap();
        if let Some((time, entries)) = &*cache {
            if !refresh && time.elapsed() < Duration::from_secs(900) {
                return Ok(entries.clone());
            }
        }
        let entries = Installer::new()?.catalog()?;
        *cache = Some((Instant::now(), entries.clone()));
        Ok(entries)
    }

    pub fn start(
        self: &Arc<Self>,
        root: PathBuf,
        id: String,
        on_complete: impl FnOnce(&InstallResult) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        {
            let mut status = self.status.lock().unwrap();
            if matches!(status.stage.as_str(), "preparing" | "downloading") {
                return Err("已有安装任务，请等待完成或取消".into());
            }
            self.cancel.store(false, Ordering::SeqCst);
            *status = DownloadStatus {
                stage: "preparing".into(),
                phase: "metadata".into(),
                message: "正在获取版本信息…".into(),
                version: Some(id.clone()),
                ..Default::default()
            };
        }
        let downloads = self.clone();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Installer::new().and_then(|installer| {
                    installer.install(&root, &id, &downloads.cancel, |progress| {
                        downloads.progress(progress);
                    })
                })
            }))
            .unwrap_or_else(|_| Err("安装任务意外退出，请重试".into()));
            match result {
                Ok(result) => {
                    let message = match on_complete(&result) {
                        Ok(()) => format!("Minecraft {} 安装完成", result.id),
                        Err(error) => format!("安装完成，但自动选择版本失败：{error}"),
                    };
                    let mut status = downloads.status.lock().unwrap();
                    status.stage = "complete".into();
                    status.phase = "complete".into();
                    status.message = message;
                    status.result = Some(result);
                }
                Err(error) => {
                    let mut status = downloads.status.lock().unwrap();
                    let cancelled = downloads.cancel.load(Ordering::SeqCst);
                    status.stage = if cancelled { "cancelled" } else { "error" }.into();
                    status.message = if cancelled {
                        "安装已取消，已下载的完整文件可继续复用".into()
                    } else {
                        error
                    };
                }
            }
        });
        Ok(())
    }

    fn progress(&self, progress: Progress) {
        let mut status = self.status.lock().unwrap();
        status.phase = progress.stage.clone();
        status.stage = if progress.stage == "downloading" {
            "downloading"
        } else {
            "preparing"
        }
        .into();
        if !self.cancel.load(Ordering::SeqCst) {
            status.message = progress.message;
        }
        status.completed = progress.completed;
        status.total = progress.total;
        status.bytes_done = progress.bytes_done;
        status.bytes_total = progress.bytes_total;
        // Concurrent callbacks can arrive out of order; network transfer counters stay monotonic.
        status.network_bytes = status.network_bytes.max(progress.network_bytes);
    }

    pub fn cancel(&self) {
        let mut status = self.status.lock().unwrap();
        if matches!(status.stage.as_str(), "preparing" | "downloading") {
            self.cancel.store(true, Ordering::SeqCst);
            status.message = "正在取消安装…".into();
        }
    }
}
