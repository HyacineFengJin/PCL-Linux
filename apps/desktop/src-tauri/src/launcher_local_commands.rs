//! Commands bind desktop changes to a prepared revision and recheck idle
//! admission after confirmation. XDG configuration is parsed as data; no shell
//! expansion is executed and a missing desktop is not guessed as ~/Desktop.
use crate::{launcher_local::*, Shared};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};
use tauri::State;

pub fn xdg_paths() -> Result<XdgPaths, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("系统没有提供有效的主目录")?;
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".local/share"));
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    let desktop = (|| {
        let mut bytes = Vec::new();
        std::fs::File::open(config.join("user-dirs.dirs"))
            .ok()?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 16 * 1024 {
            return None;
        }
        let text = std::str::from_utf8(&bytes).ok()?;
        parse_desktop(text, &home)
    })();
    Ok(XdgPaths {
        applications: data.join("applications"),
        desktop,
    })
}
fn parse_desktop(text: &str, home: &Path) -> Option<PathBuf> {
    let value = text
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("XDG_DESKTOP_DIR="))?;
    let value = value.strip_prefix('"')?.strip_suffix('"')?;
    // Expansion is allowed only for the unescaped leading variable in the
    // source. Decoding first would accidentally expand a literal \$HOME.
    let expand_home = value.starts_with("$HOME/");
    let mut decoded = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next()?;
            if !matches!(escaped, '\\' | '"' | '$' | '`') {
                return None;
            }
            // Escaped dollars/backticks are literal path text, not evaluation.
            decoded.push(escaped);
        } else if ch == '`' || ch.is_control() {
            return None;
        } else {
            decoded.push(ch);
        }
    }
    let path = if expand_home {
        home.join(decoded.strip_prefix("$HOME/")?)
    } else if decoded == "$HOME" {
        return None;
    } else {
        PathBuf::from(decoded)
    };
    // Setting desktop to HOME disables the desktop in xdg-user-dirs.
    (path.is_absolute()
        && path != home
        && !path
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir)))
    .then_some(path)
}
fn admission(s: &Shared, withdrawing: bool) -> Result<(), String> {
    if withdrawing {
        crate::launcher_monitor_runtime::require_idle(s)?;
    }
    if s.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭".into());
    }
    if withdrawing
        && (s.tasks.active().is_some()
            || s.launcher_updates.busy()
            || matches!(
                s.status.lock().unwrap().stage.as_str(),
                "preparing" | "running"
            )
            || matches!(
                s.accounts.snapshot().stage.as_str(),
                "preparing" | "waiting"
            ))
    {
        return Err("请先结束文件任务、游戏和微软登录，再移除启动器入口".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn launcher_statistics(state: State<'_, Arc<Shared>>) -> Result<StatsView, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.launcher_local.stats.load())
        .await
        .map_err(|_| "启动统计读取任务意外退出".to_string())?
}
#[tauri::command]
pub async fn launcher_shortcut_plan(
    target: Option<ShortcutTarget>,
    state: State<'_, Arc<Shared>>,
) -> Result<ShortcutPlan, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        admission(&s, target.is_none())?;
        if let Some(target) = target {
            s.launcher_local.shortcuts.prepare_create(target)
        } else {
            let mut plan = s.launcher_local.shortcuts.prepare_withdraw()?;
            if s.launcher_updates
                .service
                .snapshot()
                .current
                .install_channel
                == crate::launcher_updates::InstallChannel::PackageManaged
            {
                plan.warnings.push(PACKAGE_UNINSTALL_UNSUPPORTED.into());
            }
            Ok(plan)
        }
    })
    .await
    .map_err(|_| "读取启动器入口的任务意外退出".to_string())?
}
#[tauri::command]
pub async fn launcher_shortcut_apply(
    target: Option<ShortcutTarget>,
    revision: String,
    state: State<'_, Arc<Shared>>,
) -> Result<ShortcutOutcome, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        admission(&s, target.is_none())?;
        if let Some(target) = target {
            s.launcher_local.shortcuts.create(target, &revision)
        } else {
            s.launcher_local.shortcuts.withdraw(&revision)
        }
    })
    .await
    .map_err(|_| "修改启动器入口的任务意外退出".to_string())?
}
#[tauri::command]
pub async fn launcher_shortcut_recovery(
    state: State<'_, Arc<Shared>>,
) -> Result<Vec<ShortcutRecovery>, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.launcher_local.shortcuts.recovery())
        .await
        .map_err(|_| "读取入口恢复记录的任务意外退出".to_string())?
}
#[tauri::command]
pub async fn launcher_shortcut_restore(
    operation_id: String,
    revision: String,
    state: State<'_, Arc<Shared>>,
) -> Result<ShortcutOutcome, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        admission(&s, false)?;
        s.launcher_local.shortcuts.restore(&operation_id, &revision)
    })
    .await
    .map_err(|_| "恢复启动器入口的任务意外退出".to_string())?
}

#[tauri::command]
pub fn launcher_finish_using(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<(), String> {
    let _operation = state.operations.lock().unwrap();
    admission(&state, true)?;
    state.closing.store(true, Ordering::SeqCst);
    if window.close().is_err() {
        state.closing.store(false, Ordering::SeqCst);
        return Err("无法关闭启动器，请手动关闭窗口".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_configuration_is_data_and_home_disables_it() {
        let home = Path::new("/example/home");
        assert_eq!(
            parse_desktop("XDG_DESKTOP_DIR=\"$HOME/桌面\"", home),
            Some(home.join("桌面"))
        );
        assert_eq!(
            parse_desktop("XDG_DESKTOP_DIR=\"/data/My Desktop\"", home),
            Some(PathBuf::from("/data/My Desktop"))
        );
        for text in [
            "XDG_DESKTOP_DIR=\"$HOME\"",
            "XDG_DESKTOP_DIR=\"/example/home\"",
            "XDG_DESKTOP_DIR=\"`echo /tmp`\"",
            "XDG_DESKTOP_DIR=\"../Desktop\"",
            "XDG_DESKTOP_DIR=\"$OTHER/Desktop\"",
            "XDG_DESKTOP_DIR=\"\\$HOME/Desktop\"",
            "XDG_DESKTOP_DIR=\"$HOME/../other\"",
        ] {
            assert!(parse_desktop(text, home).is_none(), "{text}");
        }
    }
}
