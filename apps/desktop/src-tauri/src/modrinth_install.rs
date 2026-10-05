//! Modrinth installation preparation and verified network staging.
//!
//! Client input contains IDs and an optional exact file name. Every URL, hash,
//! size, resource kind and mandatory dependency is fetched from the official
//! provider again on submission. The planner is bounded and treats ambiguous
//! external dependencies, incompatible installed projects and multiple versions
//! of one project as explicit conflicts. It never enables a disabled local mod.
//!
//! Network staging owns anonymous O_TMPFILE descriptors. Cancellation drops the
//! request future (DNS/TLS/headers/body included) and those descriptors, so a
//! process crash cannot leave a partial named download. Publication belongs to
//! the resource transaction service: it must atomically commit the complete
//! verified batch across all resource kinds before writer admission is released.

#[path = "modrinth_install/plan.rs"]
mod plan;
#[path = "modrinth_install/provider.rs"]
pub(crate) mod provider;
#[path = "modrinth_install/target.rs"]
mod target;
#[path = "modrinth_install/transfer.rs"]
pub(crate) mod transfer;
#[path = "modrinth_install/updates.rs"]
mod updates;

use serde::{Deserialize, Serialize};
use std::{fs::File, path::Path, sync::atomic::AtomicBool};

pub use plan::InstallPlan;
pub use target::TargetSnapshot;
pub use transfer::{DownloadProgress, VerifiedBatch};
#[cfg(test)]
pub(crate) use updates::test_update_batch;
pub use updates::{
    check_updates, download_update_request_with_policy, prepare_update, recheck_update_target,
    UpdateCheck, UpdatePlan, VerifiedUpdateBatch,
};
type Result<T> = std::result::Result<T, String>;
pub const CANCELLED: &str = "资源下载已取消";
const MAX_PROJECTS: usize = 64;
const MAX_DEPTH: usize = 32;
const MAX_FILES: usize = 128;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallRequest {
    pub project_id: String,
    pub version_id: String,
    /// A non-primary runtime file is supported only by exact authoritative name.
    pub file_name: Option<String>,
}
impl InstallRequest {
    fn validate(&self) -> Result<()> {
        provider::id(&self.project_id)?;
        provider::id(&self.version_id)?;
        if let Some(name) = &self.file_name {
            provider::file_name(name)?;
        }
        Ok(())
    }
}

/// Only server-captured target facts enter compatibility checks. This type is
/// deliberately not Deserialize: callers cannot supply a loader/game version.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct Compatibility {
    pub minecraft_version: String,
    pub loader: String,
    pub shader_engines: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct LocalFile {
    pub kind: String,
    pub file_name: String,
    pub size: u64,
    pub sha512: String,
    pub enabled: bool,
    pub fingerprint: String,
    /// Resource panel v2 token, captured from the same verified descriptor.
    pub resource_fingerprint: String,
}

/// Prepare does local CPU/I/O and HTTP outside the application operations mutex.
/// Command admission must capture and recheck its root binding around this work.
pub async fn prepare(
    root: &Path,
    project: &Path,
    root_id: &str,
    instance_id: &str,
    request: InstallRequest,
    cancel: &AtomicBool,
) -> Result<InstallPlan> {
    request.validate()?;
    let target = target::capture(root, project, root_id, instance_id, cancel)?;
    let provider = provider::HttpProvider::new(cancel)?;
    plan::prepare(&provider, target, request, cancel).await
}

/// Native submission can capture the immutable scheduler before starting its
/// worker. Every dependency transfer shares this same submission snapshot.
pub async fn download_request_with_policy(
    root: &Path,
    project: &Path,
    root_id: &str,
    instance_id: &str,
    request: InstallRequest,
    revision: &str,
    scheduler: std::sync::Arc<pcl_network::DownloadScheduler>,
    cancel: &AtomicBool,
    on_plan: impl Fn(&InstallPlan),
    report: impl Fn(DownloadProgress),
) -> Result<VerifiedBatch> {
    request.validate()?;
    let target = target::capture(root, project, root_id, instance_id, cancel)?;
    let provider = provider::HttpProvider::new(cancel)?.with_download_policy(scheduler);
    let current = plan::prepare(&provider, target, request, cancel).await;
    // Publish metadata traffic even when the authoritative plan fails. Disk
    // inventory reads and reuse never contribute to this provider counter.
    report(DownloadProgress {
        phase: "metadata".into(),
        message: "官方资源与必需依赖检查结束".into(),
        completed: 0,
        total: 0,
        bytes_done: 0,
        bytes_total: 0,
        network_bytes: provider
            .network_bytes
            .load(std::sync::atomic::Ordering::Relaxed),
    });
    let current = current?;
    if current.revision != revision {
        return Err("资源文件或必需依赖已变化，请重新检查后下载".into());
    }
    // Presentation receives only the fresh, confirmed plan. The instance ID
    // remains the target identity even when its resource title is displayed.
    on_plan(&current);
    transfer::download(&provider, current, cancel, report).await
}

/// Network staging is anonymous, so cleanup is descriptor ownership. Named
/// resource publication and its persistent recovery journal are owned by the
/// atomic resource batch service, which consumes these descriptors.
pub fn recheck_target(plan: &InstallPlan, cancel: &AtomicBool) -> Result<()> {
    target::check(&plan.target, cancel)
}
#[cfg(test)]
#[path = "modrinth_install/download_policy_tests.rs"]
mod download_policy_tests;
#[cfg(test)]
#[path = "modrinth_install/tests.rs"]
mod tests;
