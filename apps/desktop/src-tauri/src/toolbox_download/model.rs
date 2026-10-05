use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub directory_token: String,
    pub url: String,
    pub file_name: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryView {
    pub token: String,
    pub directory: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPreview {
    pub token: String,
    pub url_display: String,
    pub file_name: String,
    pub directory: String,
    pub target: String,
    pub preferences_revision: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct DownloadProgress {
    /// connecting, downloading, verifying, committing, complete.
    pub phase: String,
    pub message: String,
    pub bytes_done: u64,
    /// 0 means unknown until EOF, not an expected integrity authority.
    pub bytes_total: u64,
    pub network_bytes: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct DownloadResult {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// SHA256 of the actual downloaded bytes. It is not a publisher signature
    /// or a preexisting expected hash, and does not authenticate the source.
    pub sha256: String,
    pub network_bytes: u64,
    pub warning: Option<String>,
}
pub type CommitGate<'a> = &'a mut dyn FnMut() -> Result<(), String>;
