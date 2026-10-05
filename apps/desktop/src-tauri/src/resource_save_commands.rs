//! Save authority is derived before the chooser and again before transfer. The
//! frontend receives a short-lived confirmation token, never an arbitrary URL
//! or authority to retarget the write. No instance selection is involved.
use crate::{
    launcher_prefs::{DownloadFileName, QuickDownload},
    resource_save::*,
    tasks, Shared,
};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::State;

#[derive(Default)]
pub struct SaveSession(Mutex<Session>);
#[derive(Default)]
struct Session {
    generation: u64,
    pending: Option<Pending>,
    // This is session-only authority obtained from a real chooser. Importing
    // settings or enabling quick downloads cannot invent a target directory.
    last_directory: Option<Arc<CapturedSaveTarget>>,
}
struct Pending {
    token: String,
    plan: SavePlan,
    target: Arc<CapturedSaveTarget>,
    preferences_revision: String,
    prepared: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePreview {
    token: String,
    preferences_revision: String,
    plan: SavePlan,
    target: String,
}

/// Scope admission alone never grants new chooser authority: the original
/// captured target must still name the same directory when its turn begins.
pub(super) fn wait_target(
    task: &tasks::TaskHandle,
    target: &CapturedSaveTarget,
) -> Result<(), String> {
    task.wait_turn()?;
    if task.cancellation_token().load(Ordering::SeqCst) {
        return Err(tasks::CANCELLED.into());
    }
    target.recheck()
}

#[tauri::command]
pub async fn resource_save_prepare(
    request: SaveRequest,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<Option<SavePreview>, String> {
    let shared = state.inner().clone();
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let prefs = shared.launcher_preferences.snapshot();
    let (generation, previous) = {
        let mut session = shared.resource_save.0.lock().unwrap();
        session.generation = session.generation.wrapping_add(1);
        session.pending = None;
        (session.generation, session.last_directory.clone())
    };
    let plan = prepare(request, &AtomicBool::new(false)).await?;
    let suggested = suggested_filename(
        &plan,
        prefs.preferences.management.download_file_name == DownloadFileName::ProjectVersion,
    );
    let quick = prefs.preferences.management.quick_download == QuickDownload::LastFolder;
    let target = if let Some(folder) = previous.filter(|_| quick) {
        folder.recheck_directory()?;
        folder
            .path()
            .parent()
            .ok_or("保存位置缺少父目录")?
            .join(suggested)
    } else {
        let choice = shared
            .desktop
            .choose_resource_save(window, shared.project.clone(), suggested)
            .await?;
        if choice.status == "cancelled" {
            return Ok(None);
        }
        choice.paths.into_iter().next().ok_or_else(|| {
            choice
                .message
                .unwrap_or_else(|| "未选择有效的保存位置".into())
        })?
    };
    // Confirmation retains the actual directory, not just its displayed path.
    // A queued task must refuse a replaced chooser directory before networking.
    let captured = Arc::new(CapturedSaveTarget::capture(&shared.project, &target)?);
    if shared.closing.load(Ordering::SeqCst)
        || shared.launcher_preferences.snapshot().revision != prefs.revision
    {
        return Err("启动器设置已变化，请重新选择保存文件".into());
    }
    let mut session = shared.resource_save.0.lock().unwrap();
    if session.generation != generation {
        return Err("保存选择已被较新的请求替代".into());
    }
    let token = format!(
        "save-{}-{generation}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    session.pending = Some(Pending {
        token: token.clone(),
        plan: plan.clone(),
        target: captured,
        preferences_revision: prefs.revision.clone(),
        prepared: Instant::now(),
    });
    Ok(Some(SavePreview {
        token,
        preferences_revision: prefs.revision,
        plan,
        target: target.display().to_string(),
    }))
}

#[tauri::command]
pub fn resource_save_start(
    token: String,
    state: State<'_, Arc<Shared>>,
) -> Result<serde_json::Value, String> {
    let shared = state.inner().clone();
    let _operation = shared.operations.lock().unwrap();
    crate::require_network_submission(&shared)?;
    let mut session = shared.resource_save.0.lock().unwrap();
    let pending = session.pending.as_ref().ok_or("请重新选择保存文件")?;
    if pending.token != token
        || pending.prepared.elapsed() > Duration::from_secs(600)
        || pending.preferences_revision != shared.launcher_preferences.snapshot().revision
    {
        return Err("保存确认已失效，请重新选择文件".into());
    }
    pending.target.recheck()?;
    let task = shared.tasks.admit_queued(
        tasks::TaskTarget {
            root_id: "launcher".into(),
            root_path: pending
                .target
                .path()
                .parent()
                .ok_or("保存位置缺少父目录")?
                .display()
                .to_string(),
            instance_id: None,
        },
        tasks::TaskKind::ResourceSave,
        tasks::TaskScope::files(&[pending.target.path().to_path_buf()])?,
    )?;
    let pending = session.pending.take().unwrap();
    drop(session);
    let scheduler = pcl_network::download_snapshot();
    shared.downloads.track(&task);
    let task_id = task.id().to_string();
    let worker = shared.clone();
    std::thread::Builder::new()
        .name(format!("pcl-save-{task_id}"))
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                wait_target(&task, &pending.target)?;
                let cancel = task.cancellation_token();
                let mut gate = || {
                    task.begin_finishing();
                    if cancel.load(Ordering::SeqCst) {
                        return Err("资源文件下载已取消".into());
                    }
                    Ok(())
                };
                tauri::async_runtime::block_on(save_captured(
                    &pending.target,
                    pending.plan.request.clone(),
                    &pending.plan.revision,
                    scheduler,
                    &cancel,
                    |progress| {
                        task.update(tasks::TaskProgress {
                            stage: if progress.phase == "downloading" {
                                tasks::TaskStage::Downloading
                            } else {
                                tasks::TaskStage::Processing
                            },
                            phase: progress.phase,
                            message: progress.message,
                            completed: 0,
                            total: 1,
                            bytes_done: progress.bytes_done,
                            bytes_total: progress.bytes_total,
                            network_bytes: progress.network_bytes,
                            steps: Vec::new(),
                        });
                    },
                    &mut gate,
                ))
            }))
            .unwrap_or_else(|_| Err("资源文件保存意外退出，请检查保存目录".into()));
            match result {
                Ok(result) => {
                    worker.resource_save.0.lock().unwrap().last_directory =
                        Some(pending.target.clone());
                    drop(pending);
                    let warning = result.warning.clone();
                    task.finish(tasks::TaskOutcome::Complete {
                        result: serde_json::to_value(result).ok(),
                        message: "资源文件已保存".into(),
                        error: warning,
                    });
                }
                Err(error) => {
                    // Queued cancellation is terminal only after this worker
                    // releases its held chooser target and prepared plan.
                    drop(pending);
                    task.finish(if error == CANCELLED || error == tasks::CANCELLED {
                        tasks::TaskOutcome::Failed(error)
                    } else {
                        tasks::TaskOutcome::Error(error)
                    });
                }
            }
        })
        .map_err(|error| format!("无法启动文件保存任务：{error}"))?;
    Ok(serde_json::json!({"id": task_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, sync::mpsc, thread};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../work/multi-task-2026-10-05/services/fixtures")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            fs::create_dir_all(path.join("project")).unwrap();
            fs::create_dir_all(path.join("chosen")).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn capture(&self) -> Arc<CapturedSaveTarget> {
            Arc::new(
                CapturedSaveTarget::capture(
                    &self.0.join("project"),
                    &self.0.join("chosen/sample.jar"),
                )
                .unwrap(),
            )
        }
        fn blocker(&self, manager: &Arc<tasks::Tasks>) -> tasks::TaskHandle {
            let task = manager
                .admit_queued(
                    tasks::TaskTarget {
                        root_id: "fixture".into(),
                        root_path: self.0.join("chosen").display().to_string(),
                        instance_id: None,
                    },
                    tasks::TaskKind::Install,
                    tasks::TaskScope::root(&self.0.join("chosen")).unwrap(),
                )
                .unwrap();
            task.wait_turn().unwrap();
            task
        }
        fn save(
            &self,
            manager: &Arc<tasks::Tasks>,
            target: &CapturedSaveTarget,
        ) -> tasks::TaskHandle {
            manager
                .admit_queued(
                    tasks::TaskTarget {
                        root_id: "launcher".into(),
                        root_path: self.0.join("chosen").display().to_string(),
                        instance_id: None,
                    },
                    tasks::TaskKind::ResourceSave,
                    tasks::TaskScope::files(&[target.path().to_path_buf()]).unwrap(),
                )
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn complete(task: &tasks::TaskHandle) {
        task.finish(tasks::TaskOutcome::Complete {
            result: None,
            message: "fixture finished".into(),
            error: None,
        });
    }

    #[test]
    fn queued_save_refuses_replaced_parent_before_any_metadata_or_stage() {
        let fixture = Fixture::new();
        let manager = Arc::new(tasks::Tasks::new());
        let blocker = fixture.blocker(&manager);
        let target = fixture.capture();
        let task = fixture.save(&manager, &target);
        let id = task.id().to_owned();
        assert_eq!(
            manager.snapshot(&id).unwrap().stage,
            tasks::TaskStage::Queued
        );
        let (send, receive) = mpsc::channel();
        let worker = thread::spawn(move || {
            let result = wait_target(&task, &target);
            drop(target);
            task.finish(tasks::TaskOutcome::Error(result.clone().unwrap_err()));
            send.send(result).unwrap();
        });
        fs::rename(fixture.0.join("chosen"), fixture.0.join("original")).unwrap();
        fs::create_dir(fixture.0.join("chosen")).unwrap();
        fs::write(fixture.0.join("chosen/external.txt"), b"external").unwrap();
        complete(&blocker);
        assert!(receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err());
        worker.join().unwrap();
        assert_eq!(
            manager.wait_terminal(&id).unwrap().stage,
            tasks::TaskStage::Error
        );
        assert_eq!(fs::read_dir(fixture.0.join("original")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(fixture.0.join("chosen")).unwrap().count(), 1);
        assert_eq!(
            fs::read(fixture.0.join("chosen/external.txt")).unwrap(),
            b"external"
        );
        assert_eq!(fs::read_dir(fixture.0.join("project")).unwrap().count(), 0);
    }

    #[test]
    fn queued_cancel_closes_captured_save_authority_before_terminal_event() {
        let fixture = Fixture::new();
        let manager = Arc::new(tasks::Tasks::new());
        let blocker = fixture.blocker(&manager);
        let target = fixture.capture();
        let weak = Arc::downgrade(&target);
        let task = fixture.save(&manager, &target);
        let id = task.id().to_owned();
        let terminal = Arc::new(AtomicBool::new(false));
        let observed = terminal.clone();
        manager.set_listener(move |snapshot| {
            if snapshot.stage == tasks::TaskStage::Cancelled {
                assert!(
                    weak.upgrade().is_none(),
                    "chooser FD owner must close before terminal"
                );
                observed.store(true, Ordering::SeqCst);
            }
        });
        manager.cancel(&id).unwrap();
        assert!(!manager.snapshot(&id).unwrap().stage.is_terminal());
        let worker = thread::spawn(move || {
            let error = wait_target(&task, &target).unwrap_err();
            assert_eq!(error, tasks::CANCELLED);
            drop(target);
            task.finish(tasks::TaskOutcome::Failed(error));
        });
        worker.join().unwrap();
        assert_eq!(
            manager.wait_terminal(&id).unwrap().stage,
            tasks::TaskStage::Cancelled
        );
        assert!(terminal.load(Ordering::SeqCst));
        assert_eq!(manager.active_all().len(), 1);
        assert_eq!(fs::read_dir(fixture.0.join("chosen")).unwrap().count(), 0);
        complete(&blocker);
    }
}
