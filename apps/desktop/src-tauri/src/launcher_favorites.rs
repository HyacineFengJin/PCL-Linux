//! Community bookmarks belong to the launcher, not to an instance. The store
//! keeps provider identities and last confirmed display metadata; opening a
//! bookmark still reads current provider details. Defaults create no file.
//!
//! Every edit uses a view revision and the fixed document CAS engine. An
//! external edit or unsupported schema stays intact and blocks writes until an
//! explicit reload. Folder deletion never silently deletes its bookmarks.
use crate::launcher_document as io;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 4096;
const MAX_FOLDERS: usize = 128;
const MAX_BYTES: usize = 4 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub provider: String,
    pub project_id: String,
    pub folder_id: String,
    pub title: String,
    pub project_type: String,
    pub icon_url: Option<String>,
    pub summary: String,
}

impl Entry {
    pub fn validate(&self) -> Result<(), String> {
        crate::modrinth_install::provider::id(&self.project_id)?;
        if self.provider != "modrinth"
            || !matches!(
                self.project_type.as_str(),
                "mod" | "resourcepack" | "shader" | "modpack"
            )
            || self.title.is_empty()
            || self.title.len() > 1024
            || self.title.chars().any(char::is_control)
            || self.summary.len() > 8192
        {
            return Err("收藏资源信息无效或超过上限".into());
        }
        if let Some(value) = &self.icon_url {
            if value.len() > 4096
                || !reqwest::Url::parse(value).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str() == Some("cdn.modrinth.com")
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.port().is_none()
                        && url.fragment().is_none()
                })
            {
                return Err("收藏资源图标链接无效".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema_version: u32,
    folders: Vec<Folder>,
    entries: Vec<Entry>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            schema_version: 1,
            folders: vec![Folder {
                id: "default".into(),
                name: String::new(),
            }],
            entries: Vec::new(),
        }
    }
}
fn folder_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 128
        || value.chars().any(char::is_control)
    {
        Err("收藏夹名称不能为空，不能含控制字符或超过 128 字节".into())
    } else {
        Ok(())
    }
}
impl Document {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("不支持此收藏数据版本".into());
        }
        if self.folders.is_empty()
            || self.folders.len() > MAX_FOLDERS
            || self.entries.len() > MAX_ENTRIES
        {
            return Err("收藏夹数量或资源数量超过上限".into());
        }
        let mut folders = BTreeSet::new();
        let mut names = BTreeSet::new();
        for folder in &self.folders {
            if !folders.insert(folder.id.as_str())
                || folder.id.len() > 128
                || folder.id.is_empty()
                || !folder
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("收藏夹标识无效或重复".into());
            }
            if folder.id == "default" {
                if !folder.name.is_empty() {
                    return Err("默认收藏夹格式无效".into());
                }
            } else {
                folder_name(&folder.name)?;
                if !names.insert(&folder.name) {
                    return Err("收藏夹名称重复".into());
                }
            }
        }
        if !folders.contains("default") {
            return Err("收藏数据缺少默认收藏夹".into());
        }
        let mut projects = BTreeSet::new();
        for entry in &self.entries {
            entry.validate()?;
            if !folders.contains(entry.folder_id.as_str()) || !projects.insert(&entry.project_id) {
                return Err("收藏资源重复或所属收藏夹不存在".into());
            }
        }
        Ok(())
    }
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let value: Self =
            serde_json::from_slice(bytes).map_err(|error| format!("收藏数据无法读取：{error}"))?;
        value.validate()?;
        Ok(value)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub revision: String,
    pub folders: Vec<Folder>,
    pub entries: Vec<Entry>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "save")]
    Save {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
    },
    #[serde(rename = "save_many")]
    SaveMany {
        #[serde(rename = "projectIds")]
        project_ids: Vec<String>,
        #[serde(rename = "folderId")]
        folder_id: String,
    },
    #[serde(rename = "remove")]
    Remove {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    #[serde(rename = "create_folder")]
    CreateFolder { name: String },
    #[serde(rename = "rename_folder")]
    RenameFolder {
        #[serde(rename = "folderId")]
        folder_id: String,
        name: String,
    },
    #[serde(rename = "remove_folder")]
    RemoveFolder {
        #[serde(rename = "folderId")]
        folder_id: String,
    },
}
struct Stored {
    data: Document,
    disk: io::Snapshot,
    revision: String,
    warning: Option<String>,
}
pub struct FavoriteStore {
    project: Option<io::Directory>,
    path: PathBuf,
    inner: Mutex<Stored>,
}
fn nonce() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn retained(error: String) -> String {
    format!("{error}；原文件已保留，收藏暂为只读，请修复后重新读取")
}
impl FavoriteStore {
    pub fn load(path: &Path) -> Self {
        let mut data = Document::default();
        let mut disk = io::Snapshot::default();
        let mut warning = None;
        let project = match io::Directory::open_favorites(path) {
            Ok(project) => Some(project),
            Err(error) => {
                warning = Some(retained(error));
                None
            }
        };
        if let Some(project) = &project {
            match io::snapshot(project) {
                Ok((saved, bytes)) => {
                    disk = saved;
                    if let Some(bytes) = bytes {
                        match Document::parse(&bytes) {
                            Ok(value) => data = value,
                            Err(error) => warning = Some(retained(error)),
                        }
                    }
                }
                Err(error) => warning = Some(retained(error)),
            }
        }
        Self {
            project,
            path: path.into(),
            inner: Mutex::new(Stored {
                data,
                disk,
                revision: nonce(),
                warning,
            }),
        }
    }
    fn verify(&self, state: &mut Stored) -> Result<(), String> {
        if let Some(warning) = &state.warning {
            return Err(warning.clone());
        }
        let project = self.project.as_ref().ok_or("收藏项目目录不可用")?;
        if let Err(error) = io::verify(project, &self.path, &state.disk) {
            let error = retained(error);
            state.warning = Some(error.clone());
            return Err(error);
        }
        Ok(())
    }
    fn view(state: &Stored) -> View {
        View {
            revision: state.revision.clone(),
            folders: state.data.folders.clone(),
            entries: state.data.entries.clone(),
            warning: state.warning.clone(),
        }
    }
    pub fn snapshot(&self) -> View {
        let mut state = self.inner.lock().unwrap();
        let _ = self.verify(&mut state);
        Self::view(&state)
    }
    pub fn reload(&self) -> View {
        let mut state = self.inner.lock().unwrap();
        let result = (|| {
            let project = self.project.as_ref().ok_or("收藏项目目录不可用")?;
            if io::Directory::open_favorites(&self.path)?.identity()? != project.identity()? {
                return Err("收藏项目目录已被替换，请重新启动".into());
            }
            let (disk, bytes) = io::snapshot(project)?;
            let data = bytes
                .as_deref()
                .map(Document::parse)
                .transpose()?
                .unwrap_or_default();
            Ok::<_, String>((disk, data))
        })();
        match result {
            Ok((disk, data)) => {
                state.disk = disk;
                state.data = data;
                state.revision = nonce();
                state.warning = None;
            }
            Err(error) => state.warning = Some(retained(error)),
        }
        Self::view(&state)
    }
    /// `resolved` comes only from the native provider adapter or a previously
    /// confirmed entry. Renderer labels/URLs never grant bookmark authority.
    pub fn change(
        &self,
        expected: &str,
        change: Change,
        resolved: Vec<Entry>,
    ) -> Result<View, String> {
        let mut state = self.inner.lock().unwrap();
        if state.revision != expected {
            return Err("收藏已变化，请重新读取后重试".into());
        }
        self.verify(&mut state)?;
        let mut data = state.data.clone();
        match change {
            Change::Save {
                project_id,
                folder_id,
            } => {
                save_entries(&mut data, &[project_id], &folder_id, resolved)?;
            }
            Change::SaveMany {
                project_ids,
                folder_id,
            } => {
                save_entries(&mut data, &project_ids, &folder_id, resolved)?;
            }
            Change::Remove { project_id } => {
                crate::modrinth_install::provider::id(&project_id)?;
                data.entries.retain(|entry| entry.project_id != project_id);
            }
            Change::CreateFolder { name } => {
                folder_name(&name)?;
                data.folders.push(Folder {
                    id: format!("folder-{}", nonce()),
                    name,
                });
            }
            Change::RenameFolder { folder_id, name } => {
                if folder_id == "default" {
                    return Err("默认收藏夹不能改名".into());
                }
                folder_name(&name)?;
                data.folders
                    .iter_mut()
                    .find(|folder| folder.id == folder_id)
                    .ok_or("收藏夹不存在")?
                    .name = name;
            }
            Change::RemoveFolder { folder_id } => {
                if folder_id == "default" {
                    return Err("默认收藏夹不能删除".into());
                }
                if !data.folders.iter().any(|folder| folder.id == folder_id) {
                    return Err("收藏夹不存在".into());
                }
                if data
                    .entries
                    .iter()
                    .any(|entry| entry.folder_id == folder_id)
                {
                    return Err("请先移动或移除收藏夹内的资源".into());
                }
                data.folders.retain(|folder| folder.id != folder_id);
            }
        }
        data.validate()?;
        if data.folders == state.data.folders && data.entries == state.data.entries {
            return Ok(Self::view(&state));
        }
        let bytes = serde_json::to_vec_pretty(&data).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("收藏数据超过 4 MiB 上限".into());
        }
        let project = self.project.as_ref().ok_or("收藏项目目录不可用")?;
        // Own store mutex -> independent nonblocking document lock. Never hold
        // accounts/game settings locks while persisting community bookmarks.
        let dir = io::prepare_directory(project, &mut state.disk)?;
        let _lock = dir.write_lock()?;
        let result = io::persist(
            project,
            &self.path,
            &dir,
            &state.disk,
            &bytes,
            &format!(".resource-favorites-{}.tmp", nonce()),
            || Ok(()),
        );
        match result {
            Ok(disk) => {
                state.disk = disk;
                state.data = data;
                state.revision = nonce();
                Ok(Self::view(&state))
            }
            Err(error) => {
                let _ = self.verify(&mut state);
                Err(error)
            }
        }
    }
}

fn save_entries(
    data: &mut Document,
    projects: &[String],
    folder: &str,
    resolved: Vec<Entry>,
) -> Result<(), String> {
    validate_projects(projects)?;
    let requested: BTreeSet<_> = projects.iter().map(String::as_str).collect();
    let confirmed: BTreeSet<_> = resolved
        .iter()
        .map(|entry| entry.project_id.as_str())
        .collect();
    if requested != confirmed || resolved.len() != projects.len() {
        return Err("收藏资源信息未完整确认，未保存任何项目".into());
    }
    for mut entry in resolved {
        entry.folder_id = folder.into();
        entry.validate()?;
        if let Some(current) = data
            .entries
            .iter_mut()
            .find(|current| current.project_id == entry.project_id)
        {
            *current = entry;
        } else {
            data.entries.push(entry);
        }
    }
    Ok(())
}

pub fn validate_projects(projects: &[String]) -> Result<(), String> {
    if projects.is_empty() || projects.len() > 128 {
        return Err("一次请选择 1–128 个收藏项目".into());
    }
    let mut seen = BTreeSet::new();
    for id in projects {
        crate::modrinth_install::provider::id(id)?;
        if !seen.insert(id) {
            return Err("收藏项目标识重复".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "launcher_favorites/tests.rs"]
mod tests;
