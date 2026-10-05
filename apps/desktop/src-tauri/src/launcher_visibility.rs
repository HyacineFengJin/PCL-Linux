//! Own window visibility for one launch generation. A worker may restore only
//! the window it hid while its generation remains current. This prevents an old
//! worker's Drop from showing/focusing a window hidden by a newer game.
use crate::{
    launcher_monitor_runtime::{self, Generation},
    launcher_prefs::LaunchVisibility,
    Shared,
};
use std::sync::Arc;

pub struct VisibilityGuard {
    window: tauri::WebviewWindow,
    policy: LaunchVisibility,
    hidden: bool,
    shared: Arc<Shared>,
    generation: Generation,
}
impl VisibilityGuard {
    pub fn new(
        window: tauri::WebviewWindow,
        policy: LaunchVisibility,
        shared: Arc<Shared>,
        generation: Generation,
    ) -> Self {
        Self {
            window,
            policy,
            hidden: false,
            shared,
            generation,
        }
    }
    pub fn spawned(&mut self) -> Result<Option<tauri::Result<()>>, String> {
        let window = &self.window;
        let hidden = &mut self.hidden;
        let policy = self.policy;
        launcher_monitor_runtime::with_spawn_visibility(&self.shared, self.generation, || {
            if policy == LaunchVisibility::HideWhileGame {
                window.hide()?;
                *hidden = true;
            }
            Ok(())
        })
    }
    pub fn restore(&mut self) -> tauri::Result<()> {
        if !self.hidden {
            return Ok(());
        }
        let window = &self.window;
        let hidden = &mut self.hidden;
        launcher_monitor_runtime::with_current(&self.shared, self.generation, || {
            if window.is_visible()? {
                *hidden = false;
                return Ok(());
            }
            window.show()?;
            *hidden = false;
            window.unminimize()?;
            window.set_focus()
        })
        .unwrap_or(Ok(()))
    }
}
impl Drop for VisibilityGuard {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}
