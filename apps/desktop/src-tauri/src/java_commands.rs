//! Desktop adapters for Java discovery and the existing native file chooser.
//! Process validation and configuration admission belong to `java_service`.

use crate::{config::Settings, java_service, Shared};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
pub(super) struct AddResult {
    status: &'static str,
    settings: Option<Settings>,
    message: Option<String>,
}

#[tauri::command]
pub async fn java_catalog(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<pcl_core::java::JavaCatalog, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || java_service::catalog(&shared, root_id.as_deref()))
        .await
        .map_err(|_| "读取 Java 列表的任务未能完成".to_string())?
}

#[tauri::command]
pub async fn java_add(
    revision: String,
    root_id: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<AddResult, String> {
    let shared = state.inner().clone();
    let request = shared.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        java_service::registration_context(&request, root_id.as_deref(), &revision)
    })
    .await
    .map_err(|_| "检查 Java 添加请求的任务未能完成".to_string())??;
    let choice = shared
        .desktop
        .pick_java(window, context.initial_directory.clone())
        .await?;
    if choice.status != "selected" {
        return Ok(AddResult {
            status: choice.status,
            settings: None,
            message: choice.message,
        });
    }
    let path = choice
        .paths
        .into_iter()
        .next()
        .ok_or("未选择 Java 可执行文件")?;
    let settings = tauri::async_runtime::spawn_blocking(move || {
        java_service::register(&shared, &path, &context)
    })
    .await
    .map_err(|_| "检查 Java 可执行文件的任务未能完成".to_string())??;
    Ok(AddResult {
        status: "selected",
        settings: Some(settings),
        message: None,
    })
}
