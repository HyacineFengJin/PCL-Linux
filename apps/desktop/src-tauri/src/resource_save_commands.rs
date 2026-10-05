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
    path::PathBuf,
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
    last_directory: Option<PathBuf>,
}
struct Pending {
    token: String,
    plan: SavePlan,
    target: PathBuf,
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
        folder.join(suggested)
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
    match std::fs::symlink_metadata(&target) {
        Ok(_) => return Err("保存位置已存在文件，请换一个文件名；不会覆盖已有内容".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(format!("无法检查保存位置：{error}")),
    }
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
        target: target.clone(),
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
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let mut session = shared.resource_save.0.lock().unwrap();
    let pending = session.pending.as_ref().ok_or("请重新选择保存文件")?;
    if pending.token != token
        || pending.prepared.elapsed() > Duration::from_secs(600)
        || pending.preferences_revision != shared.launcher_preferences.snapshot().revision
    {
        return Err("保存确认已失效，请重新选择文件".into());
    }
    let task = shared.tasks.admit(
        tasks::TaskTarget {
            root_id: "launcher".into(),
            root_path: shared.project.display().to_string(),
            instance_id: None,
        },
        tasks::TaskKind::ResourceSave,
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
                let cancel = task.cancellation_token();
                let mut gate = || {
                    task.begin_finishing();
                    if cancel.load(Ordering::SeqCst) {
                        return Err("资源文件下载已取消".into());
                    }
                    Ok(())
                };
                tauri::async_runtime::block_on(save(
                    &worker.project,
                    &pending.target,
                    pending.plan.request,
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
                        pending.target.parent().map(PathBuf::from);
                    let warning = result.warning.clone();
                    task.finish(tasks::TaskOutcome::Complete {
                        result: serde_json::to_value(result).ok(),
                        message: "资源文件已保存".into(),
                        error: warning,
                    });
                }
                Err(error) => {
                    task.finish(if error == CANCELLED {
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
