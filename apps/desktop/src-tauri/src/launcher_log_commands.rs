//! Root binding and task lifetime for launch-log operations. Native choosers run
//! outside admission; every confirmed mutation re-resolves its captured root.
//! The service owns file identity/revisions and recoverable clear/restore.
use crate::{launcher_logs as logs, tasks, Shared};
use serde::Serialize;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::State;

fn context(
    shared: &Shared,
    root_id: Option<&str>,
) -> Result<(crate::GameRoot, Option<std::path::PathBuf>), String> {
    crate::launcher_monitor_runtime::refresh(shared)?;
    let root = shared.config.resolve(root_id)?;
    Ok((root, shared.log.lock().unwrap().clone()))
}

#[tauri::command]
pub async fn launcher_logs(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<Vec<logs::LogRow>, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = shared.operations.lock().unwrap();
        let (root, current) = context(&shared, root_id.as_deref())?;
        logs::list(Path::new(&root.path), current.as_deref())
    })
    .await
    .map_err(|_| "读取日志列表的任务意外退出".to_string())?
}

#[tauri::command]
pub async fn launcher_read_log(
    name: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<String, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = shared.operations.lock().unwrap();
        let (root, _) = context(&shared, root_id.as_deref())?;
        logs::read(Path::new(&root.path), &name, |text| {
            shared.accounts.redact(text.to_owned())
        })
    })
    .await
    .map_err(|_| "读取日志的任务意外退出".to_string())?
}

#[tauri::command]
pub async fn launcher_prepare_log_export(
    selection: logs::ExportSelection,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<logs::ExportPlan, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = shared.operations.lock().unwrap();
        let (root, current) = context(&shared, root_id.as_deref())?;
        logs::prepare_export(Path::new(&root.path), &selection, current.as_deref())
    })
    .await
    .map_err(|_| "检查日志导出的任务意外退出".to_string())?
}

fn admit(shared: &Arc<Shared>, root: &crate::GameRoot) -> Result<tasks::TaskHandle, String> {
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    if shared.status.lock().unwrap().stage == "preparing" {
        return Err("请等待游戏启动完成后操作日志".into());
    }
    let task = shared.tasks.admit(
        tasks::TaskTarget {
            root_id: root.id.clone(),
            root_path: root.path.clone(),
            instance_id: None,
        },
        tasks::TaskKind::LauncherLogs,
    )?;
    shared.downloads.track(&task);
    Ok(task)
}

async fn run<T: Serialize + Send + 'static>(
    shared: Arc<Shared>,
    root_id: Option<String>,
    expected_root: Option<String>,
    work: impl FnOnce(&Path, Option<&Path>, &AtomicBool) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = shared.operations.lock().unwrap();
        let (root, current) = context(&shared, root_id.as_deref())?;
        if expected_root.is_some_and(|path| path != root.path) {
            return Err("游戏目录位置已变化，请重新准备日志操作".into());
        }
        let task = admit(&shared, &root)?;
        drop(_admission);
        let cancel = task.cancellation_token();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            work(Path::new(&root.path), current.as_deref(), &cancel)
        }))
        .unwrap_or_else(|_| Err("日志操作意外退出；请重新检查恢复记录".into()));
        task.finish(match &result {
            Ok(value) => tasks::TaskOutcome::Complete {
                result: serde_json::to_value(value).ok(),
                message: "日志操作完成".into(),
                error: None,
            },
            Err(error) if error == "日志任务已取消" => {
                tasks::TaskOutcome::Failed(error.clone())
            }
            Err(error) => tasks::TaskOutcome::Error(error.clone()),
        });
        result
    })
    .await
    .map_err(|_| "日志操作任务意外退出".to_string())?
}

#[tauri::command]
pub async fn launcher_export_logs(
    selection: logs::ExportSelection,
    revision: String,
    root_id: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<Option<logs::ExportOutcome>, String> {
    let shared = state.inner().clone();
    let (root, current) = context(&shared, root_id.as_deref())?;
    let path = root.path.clone();
    let plan = tauri::async_runtime::spawn_blocking({
        let selection = selection.clone();
        move || logs::prepare_export(Path::new(&path), &selection, current.as_deref())
    })
    .await
    .map_err(|_| "检查导出日志的任务意外退出".to_string())??;
    if plan.revision != revision {
        return Err("日志已变化，请重新准备导出".into());
    }
    let choice = shared
        .desktop
        .choose_named_launcher_file(
            window,
            shared.project.clone(),
            match plan.format {
                logs::ExportFormat::Zip => "export_log_zip",
                logs::ExportFormat::Text => "export_log_text",
            },
            Some(plan.suggested_name),
        )
        .await?;
    if choice.status == "cancelled" {
        return Ok(None);
    }
    let destination = choice.paths.first().cloned().ok_or_else(|| {
        choice
            .message
            .unwrap_or_else(|| "未选择有效的导出位置".into())
    })?;
    let accounts = shared.accounts.clone();
    run(
        shared,
        Some(root.id),
        Some(root.path),
        move |root, current, cancel| {
            logs::execute_export(
                root,
                &selection,
                &revision,
                current,
                &destination,
                cancel,
                |text| accounts.redact(text.to_owned()),
            )
            .map(Some)
        },
    )
    .await
}

#[tauri::command]
pub async fn launcher_prepare_log_clear(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<logs::ClearPlan, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = shared.operations.lock().unwrap();
        let (root, current) = context(&shared, root_id.as_deref())?;
        logs::prepare_clear(Path::new(&root.path), current.as_deref())
    })
    .await
    .map_err(|_| "检查日志清理的任务意外退出".to_string())?
}

#[tauri::command]
pub async fn launcher_clear_logs(
    revision: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<logs::ClearOutcome, String> {
    run(
        state.inner().clone(),
        root_id,
        None,
        move |root, current, cancel| logs::execute_clear(root, &revision, current, cancel),
    )
    .await
}

#[tauri::command]
pub async fn launcher_log_recovery(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<Vec<logs::RecoveryRow>, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _admission = shared.operations.lock().unwrap();
        let (root, _) = context(&shared, root_id.as_deref())?;
        logs::list_recovery(Path::new(&root.path))
    })
    .await
    .map_err(|_| "读取日志恢复记录的任务意外退出".to_string())?
}

#[tauri::command]
pub async fn launcher_restore_logs(
    operation_id: String,
    revision: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<logs::RestoreOutcome, String> {
    run(
        state.inner().clone(),
        root_id,
        None,
        move |root, current, cancel| logs::restore(root, &operation_id, &revision, current, cancel),
    )
    .await
}
