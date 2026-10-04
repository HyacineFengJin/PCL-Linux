use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct Desktop {
    choosing: AtomicBool,
}

#[derive(Serialize)]
pub struct DirectoryChoice {
    status: &'static str,
    path: Option<String>,
    message: Option<String>,
}

impl DirectoryChoice {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: "unavailable",
            path: None,
            message: Some(message.into()),
        }
    }
}

struct ChoosingGuard(Arc<Desktop>);
impl Drop for ChoosingGuard {
    fn drop(&mut self) {
        self.0.choosing.store(false, Ordering::SeqCst);
    }
}

impl Desktop {
    pub async fn pick_root(
        self: &Arc<Self>,
        window: tauri::WebviewWindow,
        initial: PathBuf,
    ) -> Result<DirectoryChoice, String> {
        if self.choosing.swap(true, Ordering::SeqCst) {
            return Err("已有文件夹选择窗口，请先完成或取消选择".into());
        }
        let guard = ChoosingGuard(self.clone());
        #[cfg(target_os = "linux")]
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            return Ok(DirectoryChoice::unavailable(
                "无法连接桌面文件选择服务，请在桌面会话中运行启动器",
            ));
        }
        let picker = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("选择游戏文件夹");
        let picker = if initial.is_dir() {
            picker.set_directory(initial)
        } else {
            picker
        };
        let choice = tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            match picker.blocking_pick_folder() {
                None => DirectoryChoice {
                    status: "cancelled",
                    path: None,
                    message: None,
                },
                Some(file) => match file.into_path() {
                    Ok(path) if path.is_absolute() && path.is_dir() => match path.to_str() {
                        Some(path) => DirectoryChoice {
                            status: "selected",
                            path: Some(path.to_owned()),
                            message: None,
                        },
                        None => DirectoryChoice::unavailable("所选文件夹路径不是有效的 UTF-8"),
                    },
                    _ => DirectoryChoice::unavailable("所选位置不是可访问的本地文件夹"),
                },
            }
        })
        .await
        .unwrap_or_else(|_| DirectoryChoice::unavailable("桌面文件夹选择服务未能完成请求"));
        Ok(choice)
    }
}
