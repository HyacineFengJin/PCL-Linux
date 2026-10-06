//! Durable format dispatch for instance publication.
//!
//! Schema 1 retains its exact legacy ZIP fields and strict decoder. Schema 2
//! adds a named private builder root, owned as a subtree after its key has been
//! durably registered. Building never authorizes any write to game output.
use super::{error, DestinationDirectory, JournalFile, Key, Result, Target};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum State {
    Building,
    Staging,
    Prepared,
    Committed,
    Finished,
    RolledBack,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct BuildRegistration {
    pub key: Option<Key>,
}

/// Internal state is never deserialized directly. Version-specific wire DTOs
/// prevent new builder fields from being accepted by a schema 1 decoder.
#[derive(Clone, Debug)]
pub(super) struct Journal {
    pub schema: u32,
    pub build: Option<BuildRegistration>,
    pub operation_id: String,
    pub root: PathBuf,
    pub root_key: Key,
    pub operation_key: Key,
    pub name: String,
    pub state: State,
    pub files_key: Option<Key>,
    pub instance_key: Option<Key>,
    pub files: Vec<JournalFile>,
    pub targets: BTreeMap<String, Target>,
    pub destination_dirs: BTreeMap<String, DestinationDirectory>,
    pub instance_dirs: BTreeMap<String, Option<Key>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema1 {
    schema: u32,
    operation_id: String,
    root: PathBuf,
    root_key: Key,
    operation_key: Key,
    name: String,
    state: State,
    files_key: Option<Key>,
    instance_key: Option<Key>,
    files: Vec<JournalFile>,
    targets: BTreeMap<String, Target>,
    destination_dirs: BTreeMap<String, DestinationDirectory>,
    instance_dirs: BTreeMap<String, Option<Key>>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema2 {
    schema: u32,
    origin: Origin,
    build_key: Option<Key>,
    operation_id: String,
    root: PathBuf,
    root_key: Key,
    operation_key: Key,
    name: String,
    state: State,
    files_key: Option<Key>,
    instance_key: Option<Key>,
    files: Vec<JournalFile>,
    targets: BTreeMap<String, Target>,
    destination_dirs: BTreeMap<String, DestinationDirectory>,
    instance_dirs: BTreeMap<String, Option<Key>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Origin {
    Modpack,
}

impl From<Schema1> for Journal {
    fn from(j: Schema1) -> Self {
        Self {
            schema: j.schema,
            build: None,
            operation_id: j.operation_id,
            root: j.root,
            root_key: j.root_key,
            operation_key: j.operation_key,
            name: j.name,
            state: j.state,
            files_key: j.files_key,
            instance_key: j.instance_key,
            files: j.files,
            targets: j.targets,
            destination_dirs: j.destination_dirs,
            instance_dirs: j.instance_dirs,
        }
    }
}
impl From<Schema2> for Journal {
    fn from(j: Schema2) -> Self {
        Self {
            schema: j.schema,
            build: Some(BuildRegistration { key: j.build_key }),
            operation_id: j.operation_id,
            root: j.root,
            root_key: j.root_key,
            operation_key: j.operation_key,
            name: j.name,
            state: j.state,
            files_key: j.files_key,
            instance_key: j.instance_key,
            files: j.files,
            targets: j.targets,
            destination_dirs: j.destination_dirs,
            instance_dirs: j.instance_dirs,
        }
    }
}

pub(super) fn valid_format(j: &Journal) -> bool {
    match (j.schema, &j.build) {
        (1, None) => j.state != State::Building,
        (2, Some(build)) => {
            j.state == State::Building || j.state == State::RolledBack || build.key.is_some()
        }
        _ => false,
    }
}

pub(super) fn validate_building(j: &Journal) -> Result<()> {
    let instance = format!("versions/{}", j.name);
    if j.schema != 2
        || j.build.is_none()
        || !j.files.is_empty()
        || j.files_key.is_some()
        || j.instance_key.is_some()
        || !j.instance_dirs.is_empty()
        || j.targets.len() != 2
        || !matches!(j.targets.get(&instance), Some(Target::Absent))
        || !matches!(
            j.targets.get("versions"),
            Some(Target::Absent | Target::Directory(_))
        )
        || j.destination_dirs.len() != 1
        || j.destination_dirs.get("versions").is_none_or(|d| {
            d.created.is_some()
                || match j.targets.get("versions") {
                    Some(Target::Absent) => d.before.is_some(),
                    Some(Target::Directory(key)) => d.before.as_ref() != Some(key),
                    _ => true,
                }
        })
    {
        return Err("私有构建恢复记录无效，已保留文件供检查".into());
    }
    Ok(())
}

pub(super) fn decode(bytes: &[u8]) -> Result<Journal> {
    // Only inspect the version to choose a strict whole-document decoder; this
    // untyped read cannot authorize a path or silently discard future fields.
    let version = serde_json::from_slice::<serde_json::Value>(bytes)
        .map_err(|e| format!("导入恢复记录损坏，已保留暂存文件：{e}"))?
        .get("schema")
        .and_then(serde_json::Value::as_u64)
        .ok_or("导入恢复记录缺少版本，已保留文件")?;
    match version {
        1 => serde_json::from_slice::<Schema1>(bytes).map(Journal::from),
        2 => serde_json::from_slice::<Schema2>(bytes).map(Journal::from),
        _ => return Err("导入恢复记录版本不受支持，已保留文件".into()),
    }
    .map_err(|e| format!("导入恢复记录损坏，已保留暂存文件：{e}"))
}

pub(super) fn encode(j: &Journal) -> Result<Vec<u8>> {
    match (j.schema, &j.build) {
        (1, None) => serde_json::to_vec(&Schema1 {
            schema: j.schema,
            operation_id: j.operation_id.clone(),
            root: j.root.clone(),
            root_key: j.root_key.clone(),
            operation_key: j.operation_key.clone(),
            name: j.name.clone(),
            state: j.state,
            files_key: j.files_key.clone(),
            instance_key: j.instance_key.clone(),
            files: j.files.clone(),
            targets: j.targets.clone(),
            destination_dirs: j.destination_dirs.clone(),
            instance_dirs: j.instance_dirs.clone(),
        })
        .map_err(error),
        (2, Some(build)) => serde_json::to_vec(&Schema2 {
            schema: j.schema,
            origin: Origin::Modpack,
            build_key: build.key.clone(),
            operation_id: j.operation_id.clone(),
            root: j.root.clone(),
            root_key: j.root_key.clone(),
            operation_key: j.operation_key.clone(),
            name: j.name.clone(),
            state: j.state,
            files_key: j.files_key.clone(),
            instance_key: j.instance_key.clone(),
            files: j.files.clone(),
            targets: j.targets.clone(),
            destination_dirs: j.destination_dirs.clone(),
            instance_dirs: j.instance_dirs.clone(),
        })
        .map_err(error),
        _ => Err("无法保存不受支持的导入恢复格式".into()),
    }
}
