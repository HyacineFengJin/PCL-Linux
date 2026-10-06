//! Read-only Modrinth pack recognition and client output preview.
//!
//! Shared ZIP/FD primitives retain the PCL ZIP boundary. This separate parser
//! validates all archive bodies and builds a bounded effective client overlay;
//! it downloads nothing and creates no target directories. The public DTO is
//! never Deserialize/install authority. A revision binds native source bytes,
//! physical target, optional selection and final overlay for explicit recheck.
use super::{filesystem::Stamp, hash_file, name_ok, open_source, Dir, Key, Result, Snapshot};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    path::{Path, PathBuf},
};
#[path = "mrpack/archive.rs"]
mod archive;
#[path = "mrpack/manifest.rs"]
mod manifest;
use archive::{ArchiveScan, OverrideFile};
use manifest::{Client, Manifest};

const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_DECODED: u64 = 1024 * 1024 * 1024;
const MAX_ENTRY: u64 = 256 * 1024 * 1024;
const MAX_INDEX: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_PATH_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT: u64 = 8 * 1024 * 1024 * 1024;
const INDEX: &str = "modrinth.index.json";

#[derive(Clone, Serialize)]
pub struct MrpackPlan {
    pub revision: String,
    pub name: String,
    pub pack_name: String,
    pub pack_version: String,
    pub minecraft: String,
    pub file_count: usize,
    pub bytes: u64,
    pub reused_files: usize,
    pub warnings: Vec<String>,
    pub format: &'static str,
    pub installable: bool,
    pub preview: Preview,
    #[serde(skip)]
    binding: Binding,
}
#[derive(Clone, Serialize)]
pub struct Preview {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub dependencies: Vec<PreviewDependency>,
    pub files: Vec<PreviewFile>,
    pub required_files: usize,
    pub optional_files: usize,
    pub excluded_files: usize,
    pub download_bytes: u64,
    pub override_files: usize,
    pub override_bytes: u64,
    pub client_overrides: usize,
    pub shadowed_files: usize,
    pub blockers: Vec<String>,
}
#[derive(Clone, Serialize)]
pub struct PreviewDependency {
    pub id: String,
    pub version: String,
    pub supported: bool,
}
#[derive(Clone, Serialize)]
pub struct PreviewFile {
    pub path: String,
    pub size: u64,
    pub client: Client,
    pub selected: bool,
    pub overridden: bool,
}
#[derive(Clone, Serialize)]
struct Binding {
    root: PathBuf,
    root_key: Key,
    versions_key: Option<Key>,
    source: PathBuf,
    source_snapshot: Snapshot,
}
#[derive(Serialize)]
#[serde(tag = "origin", rename_all = "snake_case")]
enum Output {
    Remote {
        path: String,
        size: u64,
        sha1: String,
        sha512: String,
        downloads: Vec<String>,
    },
    Override(OverrideFile),
}
impl Output {
    fn size(&self) -> u64 {
        match self {
            Self::Remote { size, .. } => *size,
            Self::Override(f) => f.size,
        }
    }
}

fn source_file(source: &Path) -> Result<File> {
    let file = open_source(source)?;
    let stamp = Stamp::of(&file.metadata().map_err(super::error)?);
    if !stamp.regular() || stamp.size > MAX_ARCHIVE {
        return Err("mrpack 源必须是普通文件且不超过 512 MiB".into());
    }
    Ok(file)
}
fn source_snapshot(source: &Path) -> Result<Snapshot> {
    hash_file(source_file(source)?, MAX_ARCHIVE, None)
}
fn root_scope(root: &Path, name: &str) -> Result<(Key, Option<Key>)> {
    name_ok(name)?;
    let root = Dir::open(root)?;
    let versions = match root.stat("versions")? {
        None => None,
        Some(stamp) if stamp.directory() => Some(root.child("versions")?),
        Some(_) => return Err("versions 路径不是普通目录".into()),
    };
    if let Some(versions) = &versions {
        if versions.stat(name)?.is_some() {
            return Err("目标实例名称已存在，请使用其他名称".into());
        }
    }
    Ok((root.key()?, versions.as_ref().map(Dir::key).transpose()?))
}

/// Recognition chooses a parser, not authority. It checks the bounded central
/// directory and stable held/path identities without trusting an extension.
pub fn recognizes(source: &Path) -> Result<bool> {
    // Dispatch retains the original PCL ZIP source bounds. The smaller mrpack
    // budget applies only after its root marker selects this parser.
    let file = open_source(source)?;
    let before = Stamp::of(&file.metadata().map_err(super::error)?);
    if !before.regular() || before.size > super::MAX_BYTES {
        return Err("导入文件类型无效或超过大小限制".into());
    }
    let mut zip = super::archive::checked_zip(file.try_clone().map_err(super::error)?)?;
    let mut index = false;
    let mut pcl = false;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|_| "ZIP 目录内容无效")?;
        if entry.name() == INDEX {
            if entry.is_dir() {
                return Err("mrpack 根清单不是普通文件".into());
            }
            index = true;
        }
        if entry.name() == "pcl-export.json" {
            pcl = true;
        }
    }
    if Stamp::of(&file.metadata().map_err(super::error)?) != before
        || Stamp::of(&open_source(source)?.metadata().map_err(super::error)?) != before
    {
        return Err(super::changed());
    }
    if index && pcl {
        return Err("ZIP 同时包含 PCL 与 Modrinth 根清单，格式有歧义".into());
    }
    Ok(index)
}

pub fn inspect(
    root: &Path,
    source: &Path,
    name: &str,
    optional_paths: Option<&[String]>,
) -> Result<MrpackPlan> {
    let (root_key, versions_key) = root_scope(root, name)?;
    let file = source_file(source)?;
    let before = hash_file(file.try_clone().map_err(super::error)?, MAX_ARCHIVE, None)?;
    let scan = archive::scan(file.try_clone().map_err(super::error)?)?;
    let manifest = manifest::parse(&scan.index)?;
    let optional = selection(&manifest, optional_paths)?;
    let binding = Binding {
        root: root.to_owned(),
        root_key,
        versions_key,
        source: source.to_owned(),
        source_snapshot: before.clone(),
    };
    let mut plan = build(name, manifest, scan, optional, binding)?;
    // The held descriptor and the current pathname must both retain the full
    // original stamp/hash. This permits read-only hard links while detecting
    // replacement or edits through any alias during decompression/planning.
    if hash_file(file, MAX_ARCHIVE, None)? != before {
        return Err(super::changed());
    }
    plan.recheck()?;
    plan.revision = format!(
        "mrpack-v1:{:x}",
        Sha256::digest(serde_json::to_vec(&plan.revision_facts()?).map_err(super::error)?)
    );
    Ok(plan)
}

fn selection(manifest: &Manifest, paths: Option<&[String]>) -> Result<BTreeSet<String>> {
    let paths = paths.unwrap_or(&[]);
    if paths.len() > MAX_ENTRIES {
        return Err("可选文件选择超过 10000 项限制".into());
    }
    let mut selected = BTreeSet::new();
    for path in paths {
        manifest::output_path(path)?;
        if !manifest
            .files
            .iter()
            .any(|f| &f.path == path && f.env.client == Client::Optional)
        {
            return Err("只能选择清单中声明为客户端可选的文件".into());
        }
        if !selected.insert(path.clone()) {
            return Err("可选文件选择包含重复路径".into());
        }
    }
    Ok(selected)
}

fn build(
    name: &str,
    manifest: Manifest,
    scan: ArchiveScan,
    optional: BTreeSet<String>,
    binding: Binding,
) -> Result<MrpackPlan> {
    let (dependencies, mut blockers) = manifest::dependencies(&manifest.dependencies);
    let mut files = Vec::new();
    let mut outputs = BTreeMap::new();
    let mut required_files = 0;
    let mut optional_files = 0;
    let mut excluded_files = 0;
    let mut mirrors = BTreeMap::new();
    for file in &manifest.files {
        let selected = match file.env.client {
            Client::Required => {
                required_files += 1;
                true
            }
            Client::Optional => {
                optional_files += 1;
                optional.contains(&file.path)
            }
            Client::Unsupported => false,
        };
        if !selected {
            excluded_files += 1;
        } else {
            outputs.insert(
                file.path.clone(),
                Output::Remote {
                    path: file.path.clone(),
                    size: file.file_size,
                    sha1: file.hashes["sha1"].clone(),
                    sha512: file.hashes["sha512"].clone(),
                    downloads: file.downloads.clone(),
                },
            );
            mirrors.insert(file.path.clone(), file.has_supported_mirror());
        }
        files.push(PreviewFile {
            path: file.path.clone(),
            size: file.file_size,
            client: file.env.client,
            selected,
            overridden: false,
        });
    }
    let mut shadowed_files = 0;
    for override_file in scan.common.into_values().chain(scan.client.into_values()) {
        if outputs
            .insert(override_file.path.clone(), Output::Override(override_file))
            .is_some()
        {
            shadowed_files += 1;
        }
    }
    archive::validate_outputs(&outputs.keys().cloned().collect(), &scan.directories)?;
    let mut download_bytes = 0u64;
    let mut override_bytes = 0u64;
    let mut override_files = 0;
    let mut client_overrides = 0;
    let mut bytes = 0u64;
    for (path, output) in &outputs {
        if path == &format!("{name}.jar") || path == &format!("{name}.json") {
            return Err("mrpack 输出与目标实例核心文件名冲突".into());
        }
        bytes = bytes
            .checked_add(output.size())
            .filter(|n| *n <= MAX_OUTPUT)
            .ok_or("mrpack 有效客户端输出超过 8 GiB 限制")?;
        match output {
            Output::Remote { size, .. } => {
                download_bytes += size;
                if !mirrors[path] {
                    blockers.push(format!("文件 {path} 没有受支持的 HTTPS 下载镜像"));
                }
            }
            Output::Override(file) => {
                override_files += 1;
                override_bytes += file.size;
                if file.client {
                    client_overrides += 1;
                }
            }
        }
    }
    for file in &mut files {
        file.overridden = matches!(outputs.get(&file.path), Some(Output::Override(_)));
    }
    let mut warnings = vec!["此计划仅用于本地预览；未连接网络，尚未核实游戏和加载器版本".into()];
    if scan.server_files > 0 {
        warnings.push(format!(
            "忽略 {} 个 server-overrides 文件；客户端不应用该层",
            scan.server_files
        ));
    }
    if scan.ignored_files > 0 {
        warnings.push(format!(
            "忽略 {} 个覆盖层以外的归档文件",
            scan.ignored_files
        ));
    }
    let minecraft = manifest.dependencies["minecraft"].clone();
    let mut plan = MrpackPlan {
        revision: String::new(),
        name: name.into(),
        pack_name: manifest.name,
        pack_version: manifest.version_id,
        minecraft,
        file_count: outputs.len(),
        bytes,
        reused_files: 0,
        warnings,
        format: "modrinth",
        installable: false,
        preview: Preview {
            summary: manifest.summary,
            dependencies,
            files,
            required_files,
            optional_files,
            excluded_files,
            download_bytes,
            override_files,
            override_bytes,
            client_overrides,
            shadowed_files,
            blockers,
        },
        binding,
    };
    // Source hash already binds all declarations/overlays, including excluded
    // server data. The derived output/selection digest makes precedence and
    // optional authorization explicit without retaining decompressed bodies.
    plan.revision = format!(
        "overlay:{:x}",
        Sha256::digest(serde_json::to_vec(&(optional, outputs)).map_err(super::error)?)
    );
    Ok(plan)
}
impl MrpackPlan {
    pub fn recheck(&self) -> Result<()> {
        let (root_key, versions_key) = root_scope(&self.binding.root, &self.name)?;
        if root_key != self.binding.root_key
            || versions_key != self.binding.versions_key
            || source_snapshot(&self.binding.source)? != self.binding.source_snapshot
        {
            return Err(super::changed());
        }
        Ok(())
    }
    fn revision_facts(&self) -> Result<impl Serialize + '_> {
        Ok((&self.binding, &self.revision, &self.name, &self.preview))
    }
}

#[cfg(test)]
#[path = "mrpack/tests.rs"]
mod tests;
