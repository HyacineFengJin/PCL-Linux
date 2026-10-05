//! Launcher-local services. These stores never resolve a game root, read an
//! account, or invoke a package manager. Commands decide when actual lifecycle
//! events occurred and authorize desktop changes; persistence failures remain
//! warnings after a game has already spawned successfully.
#[path = "launcher_local/diagnostics.rs"]
mod diagnostics;
#[path = "launcher_local/filesystem.rs"]
pub(crate) mod filesystem;
#[path = "launcher_local/shortcuts.rs"]
mod shortcuts;
#[path = "launcher_local/statistics.rs"]
mod statistics;
pub use diagnostics::*;
pub use shortcuts::*;
pub use statistics::*;
