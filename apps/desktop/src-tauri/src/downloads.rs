use crate::tasks::{TaskHandle, TaskKind, TaskOutcome, TaskProgress, TaskStage, TaskTarget, Tasks};
use pcl_install::{InstallResult, Installer, Progress, VersionEntry};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
pub struct DownloadStatus {
    pub task_id: Option<String>,
    pub root_id: Option<String>,
    pub root_path: Option<String>,
    pub stage: String,
    pub phase: String,
    pub message: String,
    pub version: Option<String>,
    pub progress: f64,
    pub completed: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub network_bytes: u64,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub can_cancel: bool,
}

impl Default for DownloadStatus {
    fn default() -> Self {
        Self {
            task_id: None,
            root_id: None,
            root_path: None,
            stage: "idle".into(),
            phase: "idle".into(),
            message: "选择一个版本开始安装".into(),
            version: None,
            progress: 0.0,
            completed: 0,
            total: 0,
            bytes_done: 0,
            bytes_total: 0,
            network_bytes: 0,
            result: None,
            error: None,
            can_cancel: false,
        }
    }
}

pub struct Downloads {
    tasks: Arc<Tasks>,
    current: Mutex<Option<String>>,
    catalog: Mutex<Option<(Instant, Vec<VersionEntry>)>>,
}

impl Downloads {
    pub fn new(tasks: Arc<Tasks>) -> Self {
        Self {
            tasks,
            current: Mutex::new(None),
            catalog: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> DownloadStatus {
        let current = self.current.lock().unwrap().clone();
        let Some(snapshot) = current.and_then(|id| self.tasks.snapshot(&id)) else {
            return DownloadStatus::default();
        };
        DownloadStatus {
            task_id: Some(snapshot.id),
            root_id: Some(snapshot.root_id),
            root_path: Some(snapshot.root_path),
            stage: snapshot.stage.as_str().into(),
            phase: snapshot.phase,
            message: snapshot.message,
            version: snapshot.instance_id,
            progress: snapshot.progress,
            completed: snapshot.completed,
            total: snapshot.total,
            bytes_done: snapshot.bytes_done,
            bytes_total: snapshot.bytes_total,
            network_bytes: snapshot.network_bytes,
            result: snapshot.result,
            error: snapshot.error,
            can_cancel: snapshot.can_cancel,
        }
    }

    #[cfg(test)]
    pub fn active(&self) -> bool {
        self.tasks.active().is_some()
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
        root_id: String,
        id: String,
        on_complete: impl FnOnce(&InstallResult) -> Result<(), String> + Send + 'static,
    ) -> Result<String, String> {
        if !root.is_absolute() {
            return Err("游戏目录需要使用绝对路径，请先在设置中修改".into());
        }
        pcl_core::identifier(&id)?;
        // Admission and the busy check share one service lock. No terminal task
        // can be mistaken for an occupied writer between these two decisions.
        let task = self.tasks.admit(
            TaskTarget {
                root_id,
                root_path: root.to_string_lossy().into_owned(),
                instance_id: Some(id.clone()),
            },
            TaskKind::Install,
        )?;
        let task_id = task.id().to_owned();
        *self.current.lock().unwrap() = Some(task_id.clone());
        // The admission listener may have read the legacy projection before its
        // latest ID was assigned. Publish it once more after committing that ID.
        task.publish();
        let downloads = self.clone();
        std::thread::Builder::new()
            .name(format!("pcl-install-{task_id}"))
            .spawn(move || {
                let cancel = task.cancellation_token();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Installer::new().and_then(|installer| {
                        installer.install(&root, &id, &cancel, |progress| {
                            downloads.progress(&task, progress);
                        })
                    })
                }))
                .unwrap_or_else(|_| Err("安装任务意外退出，请重试".into()));
                match result {
                    Ok(result) => {
                        // The install has committed. Keep its writer lease while
                        // persisting the selection, and retain success if that fails.
                        task.begin_finishing();
                        let selection =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                on_complete(&result)
                            }))
                            .unwrap_or_else(|_| Err("自动选择版本的任务意外退出".into()));
                        let (message, error) = match selection {
                            Ok(()) => (format!("Minecraft {} 安装完成", result.id), None),
                            Err(error) => (
                                format!("安装完成，但自动选择版本失败：{error}"),
                                Some(error),
                            ),
                        };
                        task.finish(TaskOutcome::Complete {
                            result: Some(
                                serde_json::to_value(result)
                                    .expect("InstallResult contains only JSON-compatible fields"),
                            ),
                            message,
                            error,
                        });
                    }
                    Err(error) => {
                        task.finish(TaskOutcome::Failed(error));
                    }
                }
            })
            .map_err(|error| format!("无法启动安装任务：{error}"))?;
        Ok(task_id)
    }

    fn progress(&self, task: &TaskHandle, progress: Progress) {
        let stage = match progress.stage.as_str() {
            "downloading" => TaskStage::Downloading,
            "processing" | "installing" | "complete" => TaskStage::Processing,
            _ => TaskStage::Preparing,
        };
        let (phase, message) = if progress.stage == "complete" {
            ("installing".into(), "正在保存安装结果…".into())
        } else {
            (progress.stage, progress.message)
        };
        task.update(TaskProgress {
            stage,
            phase,
            message,
            completed: progress.completed,
            total: progress.total,
            bytes_done: progress.bytes_done,
            bytes_total: progress.bytes_total,
            network_bytes: progress.network_bytes,
        });
    }

    pub fn cancel(&self) {
        let current = self.current.lock().unwrap().clone();
        if let Some(id) = current {
            let _ = self.tasks.cancel(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_projection_tracks_task_scope_cancellation_and_processing() {
        let tasks = Arc::new(Tasks::new());
        let downloads = Downloads::new(tasks.clone());
        downloads.cancel();
        assert_eq!(downloads.snapshot().stage, "idle");
        let task = tasks
            .admit(
                TaskTarget {
                    root_id: "fixture-root".into(),
                    root_path: format!("{}/work/task-tests/root", env!("CARGO_MANIFEST_DIR")),
                    instance_id: Some("fixture-version".into()),
                },
                TaskKind::Install,
            )
            .unwrap();
        *downloads.current.lock().unwrap() = Some(task.id().into());
        downloads.progress(
            &task,
            Progress {
                stage: "installing".into(),
                message: "安装".into(),
                completed: 2,
                total: 2,
                bytes_done: 100,
                bytes_total: 100,
                network_bytes: 20,
            },
        );
        let status = downloads.snapshot();
        assert_eq!(status.task_id.as_deref(), Some(task.id()));
        assert_eq!(status.root_id.as_deref(), Some("fixture-root"));
        assert_eq!(status.version.as_deref(), Some("fixture-version"));
        assert_eq!(status.stage, "processing");
        assert_eq!(status.phase, "installing");
        assert_eq!(status.network_bytes, 20);
        tasks.cancel(task.id()).unwrap();
        assert_eq!(downloads.snapshot().message, "正在取消安装…");
        assert!(downloads.active());
        task.finish(TaskOutcome::Failed("取消".into()));
        assert!(!downloads.active());
        assert_eq!(downloads.snapshot().stage, "cancelled");
        downloads.cancel();
        assert_eq!(
            downloads.snapshot().message,
            "安装已取消，已下载的完整文件可继续复用"
        );
    }
}
