//! Keep clipboard text inside WebKit. Its native editing commands preserve
//! input events, undo history and the platform's password-field restrictions.
use serde::Deserialize;
use webkit2gtk::WebViewExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditAction {
    Copy,
    Cut,
    Paste,
    SelectAll,
}

#[tauri::command]
pub fn launcher_edit(action: EditAction, window: tauri::WebviewWindow) -> Result<(), String> {
    let command = match action {
        EditAction::Copy => "Copy",
        EditAction::Cut => "Cut",
        EditAction::Paste => "Paste",
        EditAction::SelectAll => "SelectAll",
    };
    window
        .with_webview(move |webview| webview.inner().execute_editing_command(command))
        .map_err(|_| "无法执行文本编辑操作".into())
}
