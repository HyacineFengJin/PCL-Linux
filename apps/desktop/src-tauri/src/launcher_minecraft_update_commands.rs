//! IPC owns the closing/policy admission edge; neither command accepts a game
//! root, provider URL, channel identity or a claimed latest version from the UI.
use crate::{
    launcher_minecraft_updates::{Enabled, UpdatesView},
    Shared,
};
use std::sync::{atomic::Ordering, Arc};
use tauri::State;

fn enabled(shared: &Shared) -> Enabled {
    let prefs = shared.launcher_preferences.snapshot().preferences;
    Enabled {
        release: prefs.management.minecraft_release_notifications,
        snapshot: prefs.management.minecraft_snapshot_notifications,
    }
}
#[tauri::command]
pub async fn launcher_minecraft_updates_check(
    refresh: Option<bool>,
    state: State<'_, Arc<Shared>>,
) -> Result<UpdatesView, String> {
    let shared = state.inner().clone();
    let ticket = {
        let _operation = shared.operations.lock().unwrap();
        if shared.closing.load(Ordering::SeqCst) {
            return Ok(shared.minecraft_updates.closed_view());
        }
        shared
            .minecraft_updates
            .begin(enabled(&shared), pcl_network::snapshot())
    };
    let fetched = shared
        .minecraft_updates
        .fetch(&ticket, refresh.unwrap_or(false))
        .await;
    // A dropped IPC future may suppress the entire completion, which deliberately
    // leaves any previous pending receipt unread. No background toast is emitted.
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = shared.operations.lock().unwrap();
        shared.minecraft_updates.finish(
            &ticket,
            fetched,
            enabled(&shared),
            &pcl_network::snapshot(),
            shared.closing.load(Ordering::SeqCst),
        )
    })
    .await
    .map_err(|_| "Minecraft 更新提示检查任务意外退出".into())
}
#[tauri::command]
pub async fn launcher_minecraft_updates_ack(
    token: String,
    state: State<'_, Arc<Shared>>,
) -> Result<UpdatesView, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = shared.operations.lock().unwrap();
        shared.minecraft_updates.ack(
            &token,
            enabled(&shared),
            &pcl_network::snapshot(),
            shared.closing.load(Ordering::SeqCst),
        )
    })
    .await
    .map_err(|_| "Minecraft 更新提示确认任务意外退出".into())
}
