use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SaveRequest {
    pub project_id: String,
    pub version_id: String,
    /// An explicit exact filename from the official version, including when it
    /// is not the primary file. The service never chooses another file silently.
    pub file_name: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct SavePlan {
    pub request: SaveRequest,
    pub project_title: String,
    pub version_name: String,
    pub file_name: String,
    pub size: u64,
    pub sha512: String,
    /// Hash of the selected official metadata. No frontend URL grants authority.
    pub revision: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct SaveProgress {
    /// metadata, downloading, verifying, committing, complete.
    pub phase: String,
    pub message: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub network_bytes: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct SaveResult {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub sha512: String,
    pub network_bytes: u64,
    /// Publication succeeded; durability/path visibility trouble is reported
    /// without claiming the file was absent or deleting externally changed data.
    pub warning: Option<String>,
}
/// The task owner atomically closes cancellation admission before publication.
/// An error prevents publication; the service still checks the captured cancel
/// token once more immediately after the owner's gate.
pub type CommitGate<'a> = &'a mut dyn FnMut() -> Result<(), String>;
