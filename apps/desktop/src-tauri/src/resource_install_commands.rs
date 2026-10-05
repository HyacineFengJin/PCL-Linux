//! Desktop binding and task lifetime for Modrinth resource installation.
//!
//! The UI submits provider IDs, an exact file selection and a confirmation
//! revision. Network metadata, compatibility and file publication stay in the
//! planner/transfer/batch services. Read-only preparation releases operations;
//! start admits the single writer before any network work, so cancellation and
//! application shutdown own the entire request, download and cleanup lifetime.

use crate::{config::GameRoot, modrinth_install, resource_ops, tasks, Shared};
use pcl_install::InstallStep;
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::Ordering, sync::Arc};
use tauri::State;

type Result<T> = std::result::Result<T, String>;

/// Called under operations, before writer admission. Plans always address a
/// physical, non-reserved instance in the explicitly registered root.
pub(super) fn capture(shared: &Shared, root_id: Option<&str>, id: &str) -> Result<GameRoot> {
    crate::require_instance_job(shared)?;
    pcl_core::identifier(id)?;
    let root = shared.config.resolve(root_id)?;
    crate::ensure_instance_files_ready(shared, &root)?;
    let path = Path::new(&root.path);
    crate::instance_delete::ensure_name_available(path, id)?;
    crate::instance_reset::ensure_ready(path)?;
    resource_ops::ensure_ready(path)?;
    Ok(root)
}

pub(super) fn same_root(shared: &Shared, root: &GameRoot) -> Result<()> {
    if shared.config.resolve(Some(&root.id))?.path != root.path {
        return Err("资源安装目标目录已改变，请重新检查".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn resource_install_plan(
    root_id: Option<String>,
    id: String,
    request: modrinth_install::InstallRequest,
    state: State<'_, Arc<Shared>>,
) -> Result<modrinth_install::InstallPlan> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = {
            let _operation = shared.operations.lock().unwrap();
            capture(&shared, root_id.as_deref(), &id)?
        };
        // This confirmation read has no file writer. Start repeats the full
        // authoritative plan under its own admitted cancellation lifetime.
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let plan = tauri::async_runtime::block_on(modrinth_install::prepare(
            Path::new(&root.path),
            &shared.project,
            &root.id,
            &id,
            request,
            &cancel,
        ))?;
        modrinth_install::recheck_target(&plan, &cancel)?;
        let _operation = shared.operations.lock().unwrap();
        same_root(&shared, &root)?;
        capture(&shared, Some(&root.id), &id)?;
        Ok(plan)
    })
    .await
    .map_err(|_| "资源安装方案检查意外退出".to_string())?
}

#[tauri::command]
pub fn resource_install_start(
    root_id: Option<String>,
    id: String,
    request: modrinth_install::InstallRequest,
    revision: String,
    state: State<'_, Arc<Shared>>,
) -> Result<Value> {
    start_request(
        state.inner().clone(),
        root_id.as_deref(),
        id,
        request,
        revision,
    )
}

/// Native and integration callers share this admission path. Only the worker
/// owns the captured root and task; browsing a different root cannot retarget it.
pub(super) fn start_request(
    shared: Arc<Shared>,
    root_id: Option<&str>,
    id: String,
    request: modrinth_install::InstallRequest,
    revision: String,
) -> Result<Value> {
    let _operation = shared.operations.lock().unwrap();
    let root = capture(&shared, root_id, &id)?;
    if revision.is_empty() || revision.len() > 256 {
        return Err("缺少有效的资源安装方案，请重新检查".into());
    }
    let task = shared.tasks.admit(
        tasks::TaskTarget {
            root_id: root.id.clone(),
            root_path: root.path.clone(),
            instance_id: Some(id.clone()),
        },
        tasks::TaskKind::ResourceDownload,
    )?;
    let task_id = task.id().to_owned();
    shared.downloads.track(&task);
    let download_policy = pcl_network::download_snapshot();
    let worker = shared.clone();
    std::thread::Builder::new()
        .name(format!("pcl-resource-{task_id}"))
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                install_with_policy(
                    &worker,
                    &root,
                    &id,
                    request,
                    &revision,
                    &task,
                    download_policy,
                )
            }))
            .unwrap_or_else(|_| Err("资源安装意外退出，请检查未完成的资源安装恢复记录".into()));
            finish(task, result);
        })
        .map_err(|error| format!("无法启动资源安装任务：{error}"))?;
    Ok(json!({"id":task_id}))
}

fn install_with_policy(
    shared: &Shared,
    root: &GameRoot,
    id: &str,
    request: modrinth_install::InstallRequest,
    revision: &str,
    task: &tasks::TaskHandle,
    download_policy: Arc<pcl_network::DownloadScheduler>,
) -> Result<Value> {
    let cancel = task.cancellation_token();
    task.update(tasks::TaskProgress {
        stage: tasks::TaskStage::Preparing,
        phase: "resource-metadata".into(),
        message: "正在获取资源与必需前置信息…".into(),
        completed: 0,
        total: 0,
        bytes_done: 0,
        bytes_total: 0,
        network_bytes: 0,
        steps: steps(0, None),
    });
    let batch = tauri::async_runtime::block_on(modrinth_install::download_request_with_policy(
        Path::new(&root.path),
        &shared.project,
        &root.id,
        id,
        request,
        revision,
        download_policy,
        &cancel,
        |p| transfer_progress(task, p),
    ))?;
    let modrinth_install::VerifiedBatch {
        plan,
        files,
        network_bytes,
    } = batch;
    let mut files = files
        .into_iter()
        .map(|file| resource_ops::VerifiedImport {
            kind: file.kind,
            file_name: file.file_name,
            file: file.file,
            size: file.size,
            sha512: file.sha512,
        })
        .collect::<Vec<_>>();
    let mut staging = publication_progress(&plan, network_bytes);
    staging.phase = "resource-staging".into();
    staging.message = "下载已校验，正在暂存并复核资源文件…".into();
    task.update(staging);
    let mut commit = || {
        task.begin_finishing();
        if cancel.load(Ordering::SeqCst) {
            return Err(modrinth_install::CANCELLED.into());
        }
        // Batch staging is outside the inventory. Check before the publisher
        // creates target directories or changes resource files. Do not use the
        // combined batch guard here: it would reject this task's own journal.
        modrinth_install::recheck_target(&plan, &cancel)?;
        let _operation = shared.operations.lock().unwrap();
        same_root(shared, root)?;
        crate::ensure_instance_files_ready(shared, root)?;
        crate::instance_delete::ensure_name_available(Path::new(&root.path), id)?;
        crate::instance_reset::ensure_ready(Path::new(&root.path))?;
        resource_ops::ensure_local_resources_ready(Path::new(&root.path))?;
        task.update(publication_progress(&plan, network_bytes));
        Ok(())
    };
    let result = if files.is_empty() {
        // Reused resources still need the commit-time scope and compatibility
        // check, but must never create an empty batch or enable a disabled mod.
        commit()?;
        resource_ops::MutationResult {
            changed: 0,
            undo_id: None,
            message: "所需资源文件已存在并通过校验".into(),
        }
    } else {
        resource_ops::import_verified_batch(
            Path::new(&root.path),
            id,
            &mut files,
            &cancel,
            &mut commit,
            &mut |_, _| {},
        )?
    };
    let mut done = publication_progress(&plan, network_bytes);
    done.message = "资源文件已安装，暂存文件已清理".into();
    done.steps = steps(3, None);
    task.update(done);
    Ok(json!({
        "id":id,"changed":result.changed,
        "reused":plan.files.iter().filter(|file|file.reused).count(),
        "warnings":plan.warnings,"message":result.message,
    }))
}

fn steps(current: usize, progress: Option<f64>) -> Vec<InstallStep> {
    [
        ("resource-metadata", "获取资源与前置信息"),
        ("resource-download", "下载并校验文件"),
        ("resource-publish", "安装资源文件"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (id, label))| InstallStep {
        id: id.into(),
        label: label.into(),
        state: if index < current {
            "complete"
        } else if index == current {
            "running"
        } else {
            "pending"
        }
        .into(),
        progress: (index == current).then_some(progress).flatten(),
    })
    .collect()
}

fn transfer_progress(task: &tasks::TaskHandle, progress: modrinth_install::DownloadProgress) {
    let metadata = progress.phase == "metadata";
    let ratio = (progress.bytes_total > 0)
        .then(|| progress.bytes_done as f64 / progress.bytes_total as f64);
    task.update(tasks::TaskProgress {
        stage: if metadata {
            tasks::TaskStage::Preparing
        } else {
            tasks::TaskStage::Downloading
        },
        phase: format!("resource-{}", progress.phase),
        message: progress.message,
        completed: progress.completed,
        total: progress.total,
        bytes_done: progress.bytes_done,
        bytes_total: progress.bytes_total,
        network_bytes: progress.network_bytes,
        steps: if metadata {
            steps(0, None)
        } else {
            steps(1, ratio)
        },
    });
}

fn publication_progress(
    plan: &modrinth_install::InstallPlan,
    network_bytes: u64,
) -> tasks::TaskProgress {
    tasks::TaskProgress {
        stage: tasks::TaskStage::Processing,
        phase: "resource-publish".into(),
        message: "文件已校验，正在提交资源文件…".into(),
        completed: plan.files.len() as u64,
        total: plan.files.len() as u64,
        bytes_done: plan.download_bytes,
        bytes_total: plan.download_bytes,
        network_bytes,
        steps: steps(2, None),
    }
}

fn finish(task: tasks::TaskHandle, result: Result<Value>) {
    match result {
        Ok(value) => {
            task.finish(tasks::TaskOutcome::Complete {
                message: "资源安装完成".into(),
                result: Some(value),
                error: None,
            });
        }
        Err(error) if error == modrinth_install::CANCELLED => {
            task.finish(tasks::TaskOutcome::Failed(error));
        }
        Err(error) => {
            // Cancelling a transfer is explicit. Hash/conflict/rollback errors
            // keep Error even if a cancellation request arrived at the same time.
            task.finish(tasks::TaskOutcome::Error(error));
        }
    }
}

#[tauri::command]
pub async fn resource_install_recover(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<resource_ops::MutationResult> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (root, task) = {
            let _operation = shared.operations.lock().unwrap();
            crate::require_instance_job(&shared)?;
            let root = shared.config.resolve(root_id.as_deref())?;
            crate::ensure_instance_files_ready(&shared, &root)?;
            crate::instance_reset::ensure_ready(Path::new(&root.path))?;
            resource_ops::ensure_local_resources_ready(Path::new(&root.path))?;
            let task = shared.tasks.admit(
                tasks::TaskTarget {
                    root_id: root.id.clone(),
                    root_path: root.path.clone(),
                    instance_id: None,
                },
                tasks::TaskKind::ResourceOperation,
            )?;
            task.begin_finishing();
            (root, task)
        };
        let result = resource_ops::recover_verified_batches(Path::new(&root.path));
        finish(
            task,
            result
                .as_ref()
                .map(|value| json!(value))
                .map_err(Clone::clone),
        );
        result
    })
    .await
    .map_err(|_| "资源安装恢复意外退出，恢复记录已保留".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admitted() -> (Arc<tasks::Tasks>, tasks::TaskHandle) {
        let tasks = Arc::new(tasks::Tasks::new());
        let handle = tasks
            .admit(
                tasks::TaskTarget {
                    root_id: "fixture-root".into(),
                    root_path: "/fixture".into(),
                    instance_id: Some("Example".into()),
                },
                tasks::TaskKind::ResourceDownload,
            )
            .unwrap();
        (tasks, handle)
    }

    #[test]
    fn metadata_failure_keeps_traffic_and_error_despite_accepted_cancel() {
        let (tasks, handle) = admitted();
        let id = handle.id().to_owned();
        transfer_progress(
            &handle,
            modrinth_install::DownloadProgress {
                phase: "metadata".into(),
                message: "checked".into(),
                completed: 0,
                total: 0,
                bytes_done: 0,
                bytes_total: 0,
                network_bytes: 4096,
            },
        );
        assert_eq!(
            tasks.snapshot(&id).unwrap().stage,
            tasks::TaskStage::Preparing
        );
        tasks.cancel(&id).unwrap();
        finish(handle, Err("Required dependency changed".into()));
        let result = tasks.wait_terminal(&id).unwrap();
        assert_eq!(result.stage, tasks::TaskStage::Error);
        assert_eq!(result.network_bytes, 4096);
        assert_eq!(result.error.as_deref(), Some("Required dependency changed"));
        assert!(tasks.active().is_none());
    }

    #[test]
    fn explicit_cancel_waits_for_worker_cleanup_then_releases_admission() {
        let (tasks, handle) = admitted();
        let id = handle.id().to_owned();
        tasks.cancel(&id).unwrap();
        assert!(tasks.active().is_some());
        finish(handle, Err(modrinth_install::CANCELLED.into()));
        let result = tasks.wait_terminal(&id).unwrap();
        assert_eq!(result.stage, tasks::TaskStage::Cancelled);
        assert!(result.error.is_none());
        assert!(result.message.contains("未完成文件已清理"));
        assert!(tasks.active().is_none());
    }
}
