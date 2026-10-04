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

pub struct ResourceChoice {
    pub status: &'static str,
    pub paths: Vec<PathBuf>,
    pub message: Option<String>,
}

impl ResourceChoice {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: "unavailable",
            paths: Vec::new(),
            message: Some(message.into()),
        }
    }
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
    pub async fn save_zip(
        self: &Arc<Self>,
        window: tauri::WebviewWindow,
        initial: PathBuf,
        suggested: String,
    ) -> Result<ResourceChoice, String> {
        if self.choosing.swap(true, Ordering::SeqCst) {
            return Err("已有文件选择窗口，请先完成或取消选择".into());
        }
        let guard = ChoosingGuard(self.clone());
        #[cfg(target_os = "linux")]
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            return Ok(ResourceChoice::unavailable(
                "无法连接桌面文件选择服务，请在桌面会话中运行启动器",
            ));
        }
        let picker = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导出实例")
            .add_filter("ZIP 压缩文件", &["zip"])
            .set_file_name(suggested);
        let picker = if initial.is_dir() {
            picker.set_directory(initial)
        } else {
            picker
        };
        Ok(tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            match picker.blocking_save_file() {
                None => ResourceChoice {
                    status: "cancelled",
                    paths: Vec::new(),
                    message: None,
                },
                Some(file) => match file.into_path() {
                    Ok(mut path) if path.is_absolute() && path.to_str().is_some() => {
                        if path.extension().is_none() {
                            path.set_extension("zip");
                        }
                        if path
                            .extension()
                            .and_then(|s| s.to_str())
                            .is_none_or(|s| !s.eq_ignore_ascii_case("zip"))
                        {
                            return ResourceChoice::unavailable("请使用 .zip 文件名保存导出结果");
                        }
                        ResourceChoice {
                            status: "selected",
                            paths: vec![path],
                            message: None,
                        }
                    }
                    _ => ResourceChoice::unavailable("所选位置不是可访问的本地文件路径"),
                },
            }
        })
        .await
        .unwrap_or_else(|_| ResourceChoice::unavailable("桌面保存窗口未能完成请求")))
    }

    pub async fn pick_resource_files(
        self: &Arc<Self>,
        window: tauri::WebviewWindow,
        initial: PathBuf,
        kind: &str,
    ) -> Result<ResourceChoice, String> {
        let (title, extensions) = match kind {
            "mods" => ("选择模组文件", vec!["jar", "disabled"]),
            "resourcepacks" => ("选择资源包文件", vec!["zip"]),
            "shaderpacks" => ("选择光影包文件", vec!["zip"]),
            _ => return Err("此资源类型暂不支持从文件安装".into()),
        };
        if self.choosing.swap(true, Ordering::SeqCst) {
            return Err("已有文件选择窗口，请先完成或取消选择".into());
        }
        let guard = ChoosingGuard(self.clone());
        #[cfg(target_os = "linux")]
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            return Ok(ResourceChoice::unavailable(
                "无法连接桌面文件选择服务，请在桌面会话中运行启动器",
            ));
        }
        let picker = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .add_filter("Minecraft 资源", &extensions);
        let picker = if initial.is_dir() {
            picker.set_directory(initial)
        } else {
            picker
        };
        Ok(tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            match picker.blocking_pick_files() {
                None => ResourceChoice {
                    status: "cancelled",
                    paths: Vec::new(),
                    message: None,
                },
                Some(files) => {
                    let mut paths = Vec::new();
                    for file in files {
                        match file.into_path() {
                            Ok(path)
                                if path.is_absolute()
                                    && path.is_file()
                                    && path.to_str().is_some() =>
                            {
                                paths.push(path);
                            }
                            _ => {
                                return ResourceChoice::unavailable(
                                    "所选位置包含不可访问的本地文件或无效路径",
                                )
                            }
                        }
                    }
                    ResourceChoice {
                        status: if paths.is_empty() {
                            "cancelled"
                        } else {
                            "selected"
                        },
                        paths,
                        message: None,
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| ResourceChoice::unavailable("桌面文件选择服务未能完成请求")))
    }

    pub async fn pick_root(
        self: &Arc<Self>,
        window: tauri::WebviewWindow,
        initial: PathBuf,
    ) -> Result<DirectoryChoice, String> {
        if self.choosing.swap(true, Ordering::SeqCst) {
            return Err("已有文件选择窗口，请先完成或取消选择".into());
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
