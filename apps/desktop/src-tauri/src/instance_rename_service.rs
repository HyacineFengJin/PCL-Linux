//! Application orchestration for instance rename.
//!
//! `main` owns command admission and the worker lifetime. This module joins the
//! physical transaction (`instance_rename`), launcher references
//! (`instance_rename_refs`) and in-memory stores without depending on Tauri.
//! Filesystem recovery decisions remain in the transaction module.
//!
//! Preparation runs under `Shared.operations`. Execution runs after writer
//! admission, with that mutex released: callbacks and the final cache refresh
//! must be able to acquire their own locks. The task stays admitted until the
//! caller records the result, including cleanup or cache refresh failures.

use crate::{
    config::GameRoot, instance_rename, instance_rename_refs, instance_reset, resource_ops, tasks,
    Shared,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

/// These three values describe one checked operation; the client receives only
/// the display plan and combined revision, never the replayable references.
pub(super) struct CheckedRename {
    pub plan: instance_rename::RenamePlan,
    pub references: instance_rename_refs::RenameReferences,
    pub revision: String,
}

pub(super) fn prepare(
    shared: &Shared,
    root: &GameRoot,
    id: &str,
    new_name: &str,
) -> Result<CheckedRename, String> {
    let path = Path::new(&root.path);
    crate::instance_import::ensure_ready(path)?;
    crate::instance_delete::ensure_ready(path)?;
    crate::instance_delete::ensure_name_available(path, id)?;
    crate::instance_delete::ensure_name_available(path, new_name)?;
    instance_rename_refs::ensure_project_ready(&shared.project)?;
    resource_ops::ensure_ready(path)?;
    instance_reset::ensure_ready(path)?;
    shared.config.ensure_rename_snapshot()?;
    shared.instance_metadata.ensure_rename_snapshot()?;
    let plan = instance_rename::prepare(path, id, new_name)?;
    let references = instance_rename_refs::prepare(&shared.project, &root.id, path, id, new_name)?;
    let mut hash = Sha256::new();
    // File and launcher-store revisions cover different data. Include both and
    // the registry ID so a confirmation cannot be reused for another root.
    for value in [&root.id, &plan.revision, &references.revision()?] {
        hash.update(value.len().to_le_bytes());
        hash.update(value.as_bytes());
    }
    Ok(CheckedRename {
        plan,
        references,
        revision: format!("rename:{:x}", hash.finalize()),
    })
}

/// Reload only after a completed transaction or successful recovery. Refreshing
/// during a partially applied reference migration could expose mixed old/new
/// selections. Attempt both stores even if the first one fails, so each retains
/// its own write-blocking error and can report it on the next bootstrap.
fn refresh_references(shared: &Shared) -> Result<(), String> {
    let _operation = shared.operations.lock().unwrap();
    let config = shared.config.refresh_after_rename();
    let metadata = shared.instance_metadata.refresh_after_rename();
    config.and(metadata)
}

fn report_progress(task: &tasks::TaskHandle, progress: instance_rename::RenameProgress) {
    if progress.phase == "committing" {
        task.begin_finishing();
    }
    let current = match progress.phase.as_str() {
        "committing" => 1,
        "references" => 2,
        "complete" => 3,
        _ => 0,
    };
    let steps = [
        ("rename_check", "检查实例名称与引用"),
        ("rename_files", "重命名实例文件"),
        ("rename_references", "同步实例资料与引用"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (id, label))| pcl_install::InstallStep {
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
        progress: None,
    })
    .collect();
    task.update(tasks::TaskProgress {
        stage: tasks::TaskStage::Processing,
        phase: progress.phase,
        message: progress.message,
        completed: progress.completed,
        total: progress.total,
        bytes_done: 0,
        bytes_total: 0,
        network_bytes: 0,
        steps,
    });
}

pub(super) fn execute(
    shared: &Shared,
    root: &GameRoot,
    checked: CheckedRename,
    task: &tasks::TaskHandle,
) -> Result<Value, String> {
    let cancel = task.cancellation_token();
    let committing = AtomicBool::new(false);
    let mut result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        instance_rename::execute(
            Path::new(&root.path),
            &shared.project,
            checked.plan,
            checked.references,
            &cancel,
            |progress| {
                if progress.phase == "committing" {
                    committing.store(true, Ordering::SeqCst);
                }
                report_progress(task, progress);
            },
        )
    }))
    .unwrap_or_else(|_| Err("取消清理失败：改名任务意外退出，请恢复未完成的重命名后重试".into()));
    if result.is_ok() {
        if let Err(error) = refresh_references(shared) {
            result = Err(format!("取消清理失败：实例资料重新读取失败：{error}"));
        }
    }
    if committing.load(Ordering::SeqCst) {
        // Task outcomes classify ordinary failures as Cancelled when a token
        // was accepted. Once commit starts, failures must stay visible as Error;
        // only the exact cancellation observed before the first move is exempt.
        result = result.map_err(|error| {
            if error.starts_with("取消清理失败：") || error == "实例重命名已取消" {
                error
            } else {
                format!("取消清理失败：实例重命名未完成：{error}")
            }
        });
    }
    result
}

pub(super) fn recover(shared: &Shared, root: &GameRoot) -> Result<Value, String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        instance_rename::recover_pending(Path::new(&root.path), &shared.project)
    }))
    .unwrap_or_else(|_| Err("恢复改名任务意外退出，原文件和备份已保留".into()));
    let report = result?;
    refresh_references(shared).map_err(|error| format!("恢复后重新读取实例资料失败：{error}"))?;
    Ok(report)
}
