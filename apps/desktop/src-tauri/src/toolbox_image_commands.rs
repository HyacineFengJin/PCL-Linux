//! Tauri boundaries authorize native source/destination choices. Bulk PNG work
//! occurs off the UI thread; no operation mutex spans a chooser or image decode.
use crate::{
    toolbox_images::{
        self,
        publish::{self, ExportOutcome},
        RenderedImage, SkinSource,
    },
    Shared,
};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::State;
#[tauri::command]
pub async fn toolbox_skin_pick(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<Option<SkinSource>, String> {
    let shared = state.inner().clone();
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let generation = shared.toolbox_images.begin_choice()?;
    let choice = shared
        .desktop
        .choose_launcher_file(window, shared.project.clone(), "skin_file")
        .await?;
    if choice.status == "cancelled" {
        return Ok(None);
    }
    let source = choice.paths.into_iter().next().ok_or_else(|| {
        choice
            .message
            .unwrap_or_else(|| "未选择有效的 PNG 皮肤".into())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        if shared.closing.load(Ordering::SeqCst) {
            return Err("启动器正在关闭".into());
        }
        shared.toolbox_images.select(&source, generation).map(Some)
    })
    .await
    .map_err(|_| "皮肤读取任务意外退出".to_string())?
}
#[tauri::command]
pub async fn toolbox_avatar_render(
    source_id: String,
    size: u32,
    state: State<'_, Arc<Shared>>,
) -> Result<RenderedImage, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.toolbox_images.render(&source_id, size))
        .await
        .map_err(|_| "头像生成任务意外退出".to_string())?
}
async fn target(
    window: tauri::WebviewWindow,
    shared: &Arc<Shared>,
) -> Result<Option<PathBuf>, String> {
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let choice = shared
        .desktop
        .choose_launcher_file(window, shared.project.clone(), "export_tool_image")
        .await?;
    if choice.status == "cancelled" {
        return Ok(None);
    }
    choice.paths.into_iter().next().map(Some).ok_or_else(|| {
        choice
            .message
            .unwrap_or_else(|| "未选择有效的 PNG 保存位置".into())
    })
}
#[tauri::command]
pub async fn toolbox_avatar_export(
    source_id: String,
    size: u32,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<ExportOutcome, String> {
    let shared = state.inner().clone();
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let source = source_id.clone();
    let worker = shared.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        worker.toolbox_images.avatar_png(&source, size)
    })
    .await
    .map_err(|_| "头像生成任务意外退出".to_string())??;
    let Some(path) = target(window, &shared).await? else {
        return Ok(ExportOutcome::cancelled());
    };
    tauri::async_runtime::spawn_blocking(move || {
        publish::publish_new(&path, &bytes, "png", 1, || {
            let guard = shared.operations.lock().unwrap();
            if shared.closing.load(Ordering::SeqCst) {
                return Err("启动器正在关闭".into());
            }
            let source = shared.toolbox_images.authorize_export(&source_id)?;
            Ok((guard, source))
        })
    })
    .await
    .map_err(|_| "头像导出任务意外退出".to_string())?
}
#[tauri::command]
pub async fn toolbox_png_export(
    png_base64: String,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<ExportOutcome, String> {
    let shared = state.inner().clone();
    if shared.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        toolbox_images::sanitize_canvas_png(&png_base64)
    })
    .await
    .map_err(|_| "图片检查任务意外退出".to_string())??;
    let Some(path) = target(window, &shared).await? else {
        return Ok(ExportOutcome::cancelled());
    };
    tauri::async_runtime::spawn_blocking(move || {
        publish::publish_new(&path, &bytes, "png", 1, || {
            let guard = shared.operations.lock().unwrap();
            if shared.closing.load(Ordering::SeqCst) {
                return Err("启动器正在关闭".into());
            }
            Ok(guard)
        })
    })
    .await
    .map_err(|_| "PNG 导出任务意外退出".to_string())?
}
