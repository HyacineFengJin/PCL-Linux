//! Native bookmark identity/metadata adapter. Network reads happen without a
//! store or application lock; committing rechecks the original view revision.
use crate::{
    launcher_favorites::{Change, View},
    Shared,
};
use std::sync::{atomic::Ordering, Arc};
use tauri::State;

#[tauri::command]
pub fn launcher_favorites_read(
    reload: Option<bool>,
    state: State<'_, Arc<Shared>>,
) -> Result<View, String> {
    if state.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    Ok(if reload.unwrap_or(false) {
        state.launcher_favorites.reload()
    } else {
        state.launcher_favorites.snapshot()
    })
}

#[tauri::command]
pub async fn launcher_favorites_patch(
    expected_revision: String,
    change: Change,
    state: State<'_, Arc<Shared>>,
) -> Result<View, String> {
    let shared = state.inner().clone();
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let current = shared.launcher_favorites.snapshot();
    if current.revision != expected_revision {
        return Err("收藏已变化，请重新读取后重试".into());
    }
    if let Some(warning) = current.warning {
        return Err(warning);
    }
    let ids = match &change {
        Change::Save { project_id, .. } => vec![project_id.clone()],
        Change::SaveMany { project_ids, .. } => project_ids.clone(),
        _ => Vec::new(),
    };
    let mut resolved = Vec::new();
    if !ids.is_empty() {
        crate::launcher_favorites::validate_projects(&ids)?;
        let mut missing = Vec::new();
        for id in &ids {
            if let Some(entry) = current.entries.iter().find(|entry| &entry.project_id == id) {
                resolved.push(entry.clone());
            } else {
                missing.push(id.clone());
            }
        }
        if missing.len() == 1 {
            resolved.push(crate::resource_details::project_for_favorite(&missing[0]).await?);
        } else if !missing.is_empty() {
            resolved.extend(crate::resource_details::projects_for_favorites(&missing).await?);
        }
    } else if matches!(change, Change::SaveMany { .. }) {
        return Err("一次请选择 1–128 个收藏项目".into());
    }
    // Closing and submission serialize only the short local commit, never the
    // provider request. Revisions prevent delayed network replies winning edits.
    let _operation = shared.operations.lock().unwrap();
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    shared
        .launcher_favorites
        .change(&expected_revision, change, resolved)
}
