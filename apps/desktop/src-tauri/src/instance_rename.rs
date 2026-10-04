//! Physical instance rename and recovery of core files and dependent JSONs.
//!
//! # Entry points and ownership
//!
//! `prepare` reads a bound filesystem snapshot. `execute` rechecks it, stages
//! replacement JSONs, commits the physical files and then replays launcher
//! references. `recover_pending` resumes the same journal after interruption.
//! Callers retain the shared task writer admission until execution or recovery
//! returns. UI navigation must not change the captured project or game root.
//!
//! Only core JSONs are replaced. The JAR and entire instance directory move
//! without copying user content; saves, mods and configs keep their inodes.
//! Directory FDs and inode/hash snapshots bind names to the files we checked.
//! Unknown files, changed identities and conflicts are retained as errors.
//!
//! # Recovery boundary
//!
//! | Durable state | Recovery action |
//! | --- | --- |
//! | `Staging` | Remove registered replacements; original files are untouched. |
//! | `Prepared` | Locate any partial moves and restore the original files. |
//! | `FilesCommitted` | Keep the new files and finish launcher references. |
//! | `Finished` / `RolledBack` | Retry clearing the matching project marker. |
//!
//! A new directory name alone does **not** prove commit: a crash after its move
//! but before the `FilesCommitted` journal barrier still requires rollback.
//! After that barrier, reference updates can be partially applied; recovery
//! must finish them rather than restoring old files under new references.
//!
//! The game-root journal stores phase and originals. The project-wide marker in
//! `instance_rename_refs` blocks cooperating launcher writers even while another
//! game root is selected or this root is offline. Clear it only after a durable
//! terminal state. Fault-position and content-preservation tests live in
//! `instance_rename/tests.rs`.
use crate::instance_rename_refs::RenameReferences;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
const STORE: &str = "instance-renames";
const MAX_JSON: u64 = 8 * 1024 * 1024;
const MAX_JAR: u64 = 2 * 1024 * 1024 * 1024;
const MAX_INSTANCES: usize = 4096;
const MAX_FILES: usize = 100_000;
const MAX_DEPTH: usize = 64;
const MAX_JOURNAL: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_JSON: u64 = 64 * 1024 * 1024;
const READY: &str = "存在未完成的实例重命名，请先恢复后再操作或启动";
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DirKey {
    dev: u64,
    ino: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    size: u64,
    hash: String,
    dev: u64,
    ino: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}
impl Snapshot {
    fn stable_matches(&self, other: &Self) -> bool {
        self.size == other.size
            && self.hash == other.hash
            && self.dev == other.dev
            && self.ino == other.ino
    }
}

struct Dir {
    file: File,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn os_error(context: &str) -> String {
    format!("{context}：{}", std::io::Error::last_os_error())
}
fn name_ok(name: &str) -> Result<()> {
    pcl_core::identifier(name)?;
    if name.len() > 255 || name.chars().any(char::is_control) {
        return Err("文件名称无效".into());
    }
    Ok(())
}
fn c_name(name: &str) -> Result<CString> {
    name_ok(name)?;
    CString::new(name).map_err(err)
}
fn operation_id() -> String {
    format!(
        "n-{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
fn operation_ok(name: &str) -> bool {
    let Some(tail) = name.strip_prefix("n-") else {
        return false;
    };
    let parts: Vec<_> = tail.split('-').collect();
    name.len() <= 80
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("实例重命名已取消".into())
    } else {
        Ok(())
    }
}
impl Dir {
    fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err("游戏目录必须是绝对路径".into());
        }
        let slash = CString::new("/").map_err(err)?;
        let fd = unsafe {
            libc::open(
                slash.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(os_error("无法打开实例重命名目录"));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        for component in path.components() {
            match component {
                std::path::Component::RootDir => continue,
                std::path::Component::Normal(name) => {
                    let name = CString::new(name.as_bytes()).map_err(err)?;
                    let fd = unsafe {
                        libc::openat(
                            file.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                        )
                    };
                    if fd < 0 {
                        return Err(os_error("游戏目录祖先已变化或包含符号链接"));
                    }
                    file = unsafe { File::from_raw_fd(fd) };
                }
                _ => return Err("游戏目录路径包含不安全的分量".into()),
            }
        }
        Ok(Self { file })
    }
    fn child(&self, name: &str) -> Result<Self> {
        let name = c_name(name)?;
        #[repr(C)]
        struct OpenHow {
            flags: u64,
            mode: u64,
            resolve: u64,
        }
        let how = OpenHow {
            flags: (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
            mode: 0,
            resolve: 0x01 | 0x02 | 0x04 | 0x08,
        };
        // NO_XDEV also rejects bind mounts, so temporary-tree cleanup cannot
        // descend into a mounted user directory even on the same filesystem.
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                self.file.as_raw_fd(),
                name.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            ) as i32
        };
        if fd < 0 {
            return Err(os_error(
                "目录不存在、已变化、包含符号链接或跨挂载点（需要 Linux 5.6 以上）",
            ));
        }
        Ok(Self {
            file: unsafe { File::from_raw_fd(fd) },
        })
    }
    fn optional(&self, name: &str) -> Result<Option<Self>> {
        if self.stat(name)?.is_none() {
            Ok(None)
        } else {
            self.child(name).map(Some)
        }
    }
    fn create_dir(&self, name: &str) -> Result<Self> {
        let name_c = c_name(name)?;
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), 0o700) } != 0 {
            return Err(os_error("无法创建实例重命名目录"));
        }
        self.sync()?;
        self.child(name)
    }
    fn ensure(&self, name: &str) -> Result<Self> {
        match self.optional(name)? {
            Some(dir) => Ok(dir),
            None => self.create_dir(name),
        }
    }
    fn stat(&self, name: &str) -> Result<Option<libc::stat>> {
        let name = c_name(name)?;
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                st.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Ok(Some(unsafe { st.assume_init() }));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(err(error))
        }
    }
    fn regular(&self, name: &str) -> Result<File> {
        let name = c_name(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(os_error("无法读取核心文件"));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err("核心文件必须是独立普通文件，不能是符号链接或硬链接".into());
        }
        Ok(file)
    }
    fn create_file(&self, name: &str) -> Result<File> {
        let name = c_name(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if fd < 0 {
            return Err(os_error("无法创建暂存文件"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn anonymous_file(&self) -> Result<File> {
        // O_TMPFILE takes a directory name. Use the pinned directory itself so
        // neither a partial nor an unregistered completed copy has a pathname.
        let path = CString::new(".").map_err(err)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                path.as_ptr(),
                libc::O_RDWR | libc::O_TMPFILE | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(os_error(
                "此文件系统不支持安全的匿名核心暂存文件，原实例未改动",
            ));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn names(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(self.fd_path()).map_err(err)? {
            let name = entry
                .map_err(err)?
                .file_name()
                .into_string()
                .map_err(|_| "目录包含无效文件名")?;
            name_ok(&name)?;
            names.push(name);
            if names.len() > MAX_FILES {
                return Err("目录文件数量超过重命名安全上限".into());
            }
        }
        names.sort();
        Ok(names)
    }
    fn fd_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }
    fn key(&self) -> Result<DirKey> {
        let st = self.file.metadata().map_err(err)?;
        Ok(DirKey {
            dev: st.dev(),
            ino: st.ino(),
        })
    }
    fn sync(&self) -> Result<()> {
        self.file.sync_all().map_err(err)
    }
    fn unlink(&self, name: &str, directory: bool) -> Result<()> {
        let name = c_name(name)?;
        if unsafe {
            libc::unlinkat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(os_error("无法清理重命名暂存文件"));
        }
        self.sync()
    }
}

fn snapshot(mut file: File, limit: u64, cancel: Option<&AtomicBool>) -> Result<Snapshot> {
    let st = file.metadata().map_err(err)?;
    if !st.is_file() || st.len() > limit {
        return Err("核心文件类型无效或大小超过安全上限".into());
    }
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buf = [0u8; 65536];
    loop {
        if let Some(cancel) = cancel {
            check(cancel)?;
        }
        let n = file.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        size = size.checked_add(n as u64).ok_or("核心文件过大")?;
        if size > limit {
            return Err("核心文件大小超过安全上限".into());
        }
        digest.update(&buf[..n]);
    }
    let after = file.metadata().map_err(err)?;
    if size != st.len()
        || st.len() != after.len()
        || st.mtime() != after.mtime()
        || st.mtime_nsec() != after.mtime_nsec()
        || st.ctime() != after.ctime()
        || st.ctime_nsec() != after.ctime_nsec()
    {
        return Err("读取期间文件发生变化，请刷新后重试".into());
    }
    Ok(Snapshot {
        size,
        hash: format!("{:x}", digest.finalize()),
        dev: st.dev(),
        ino: st.ino(),
        mtime: st.mtime(),
        mtime_nsec: st.mtime_nsec(),
        ctime: st.ctime(),
        ctime_nsec: st.ctime_nsec(),
    })
}
fn read_json(dir: &Dir, name: &str) -> Result<(Value, Snapshot)> {
    let mut file = dir.regular(name)?;
    if file.metadata().map_err(err)?.len() > MAX_JSON {
        return Err("版本 JSON 超过安全上限".into());
    }
    let snap = snapshot(dir.regular(name)?, MAX_JSON, None)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    let data: Value =
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
            .map_err(err)?;
    if !data.is_object() || snap != snapshot(dir.regular(name)?, MAX_JSON, None)? {
        return Err("版本 JSON 无效或读取期间已变化".into());
    }
    Ok((data, snap))
}

/// Display fields cross the command boundary; private snapshots stay in Rust.
/// Execution rebuilds and checks the plan, never trusts a client-provided path.
#[derive(Clone, Debug, Serialize)]
pub struct RenamePlan {
    pub revision: String,
    pub id: String,
    pub new_name: String,
    pub minecraft: String,
    pub dependent_instances: Vec<String>,
    pub rename_jar: bool,
    #[serde(skip)]
    root: PathBuf,
    #[serde(skip)]
    root_key: DirKey,
    #[serde(skip)]
    versions_key: DirKey,
    #[serde(skip)]
    instance_key: DirKey,
    #[serde(skip)]
    files: Vec<PlannedFile>,
    #[serde(skip)]
    jar: Option<Snapshot>,
    #[serde(skip)]
    content_revision: String,
}
#[derive(Clone, Debug)]
struct PlannedFile {
    instance: String,
    dir_key: DirKey,
    original: Snapshot,
    bytes: Vec<u8>,
}
#[derive(Clone, Debug, Serialize)]
pub struct RenameProgress {
    pub phase: String,
    pub message: String,
    pub completed: u64,
    pub total: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum State {
    /// Replacement registration is in progress; no game files may have moved.
    Staging,
    /// Originals may be in either their live or backup names. Roll back on restart.
    Prepared,
    /// The physical layout is committed; launcher reference replay is required.
    FilesCommitted,
    /// References are synchronized; clearing the marker may still need a retry.
    Finished,
    /// Originals are restored and staging removed; marker cleanup may remain.
    RolledBack,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rewrite {
    instance: String,
    dir_key: DirKey,
    original: Snapshot,
    replacement: Option<Snapshot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: u32,
    operation_id: String,
    root: PathBuf,
    project: PathBuf,
    root_key: DirKey,
    project_key: DirKey,
    versions_key: DirKey,
    instance_key: DirKey,
    operation_key: DirKey,
    storage_key: DirKey,
    incoming_key: Option<DirKey>,
    backup_key: Option<DirKey>,
    id: String,
    new_name: String,
    minecraft: String,
    state: State,
    files: Vec<Rewrite>,
    jar: Option<Snapshot>,
    refs: RenameReferences,
    marker_cleared: bool,
    content_revision: String,
}
struct Profile {
    key: DirKey,
    snapshot: Snapshot,
    data: Value,
}
fn content_revision(dir: &Dir, old: &str, new: &str) -> Result<String> {
    let mut digest = Sha256::new();
    let mut count = 0usize;
    inspect_contents(dir, "", old, new, &mut digest, &mut count, 0)?;
    Ok(format!("{:x}", digest.finalize()))
}
fn inspect_contents(
    dir: &Dir,
    relative: &str,
    old: &str,
    new: &str,
    digest: &mut Sha256,
    count: &mut usize,
    depth: usize,
) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err("实例内容目录深度超过重命名安全上限".into());
    }
    let before = dir.file.metadata().map_err(err)?;
    digest.update(serde_json::to_vec(&(relative, dir.key()?, before.mode())).map_err(err)?);
    for name in dir.names()? {
        if relative.is_empty()
            && [
                format!("{old}.json"),
                format!("{old}.jar"),
                format!("{new}.json"),
                format!("{new}.jar"),
            ]
            .contains(&name)
        {
            continue;
        }
        *count += 1;
        if *count > MAX_FILES {
            return Err("实例内容数量超过重命名安全上限".into());
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let stat = dir.stat(&name)?.ok_or("检查期间实例内容已变化")?;
        match stat.st_mode&libc::S_IFMT {
            libc::S_IFDIR=>{
                let child=dir.child(&name)?; let key=child.key()?;
                inspect_contents(&child,&path,old,new,digest,count,depth+1)?;
                let current=dir.child(&name)?;
                if current.key()?!=key { return Err("检查期间实例内容目录已变化".into()); }
            }
            libc::S_IFREG=>digest.update(serde_json::to_vec(&(&path,stat.st_dev,stat.st_ino,stat.st_mode,stat.st_nlink,
                stat.st_size,stat.st_mtime,stat.st_mtime_nsec,stat.st_ctime,stat.st_ctime_nsec)).map_err(err)?),
            libc::S_IFLNK=>return Err(format!("实例内容 {path} 含符号链接，改名后可能改变隔离目录或路径绑定；请先处理链接后再重命名")),
            _=>return Err(format!("实例内容 {path} 含特殊文件，无法安全重命名")),
        }
    }
    let after = dir.file.metadata().map_err(err)?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err("检查期间实例内容已变化，请重新读取重命名计划".into());
    }
    Ok(())
}

fn new_name_ok(name: &str) -> Result<()> {
    name_ok(name)?;
    if name.len() > 120 || name.trim() != name || name.starts_with(".install-") {
        return Err("实例名称不能超过 120 字节、包含前后空格或以 .install- 开头".into());
    }
    Ok(())
}
fn minecraft(
    profiles: &BTreeMap<String, Profile>,
    id: &str,
    visiting: &mut BTreeSet<String>,
) -> Result<String> {
    if visiting.len() >= 64 || !visiting.insert(id.into()) {
        return Err("实例继承循环或深度超过安全上限".into());
    }
    let data = &profiles
        .get(id)
        .ok_or("继承的基础版本不存在，无法确定 Minecraft 版本")?
        .data;
    let game = data["arguments"]["game"].as_array().and_then(|args| {
        args.windows(2)
            .find(|p| p[0].as_str() == Some("--fml.mcVersion"))
            .and_then(|p| p[1].as_str())
    });
    let client = data["clientVersion"].as_str();
    if game.zip(client).is_some_and(|(a, b)| a != b) {
        return Err("Minecraft 原版版本信息冲突，无法安全重命名".into());
    }
    let value = if let Some(value) = game.or(client) {
        value.to_owned()
    } else if let Some(parent) = data.get("inheritsFrom") {
        minecraft(
            profiles,
            parent.as_str().ok_or("基础版本标识无效")?,
            visiting,
        )?
    } else if data["mainClass"].as_str() == Some("net.minecraft.client.main.Main") {
        id.to_owned()
    } else {
        return Err("实例缺少明确的 Minecraft 原版版本号，无法安全重命名".into());
    };
    name_ok(&value)?;
    Ok(value)
}
fn ambiguous(data: &Value, pointer: &str, old_dir: &str, old: &str) -> Option<String> {
    match data {
        Value::String(value) => {
            if matches!(pointer, "/id" | "/inheritsFrom" | "/jar" | "/clientVersion") {
                return None;
            }
            let jar = format!("{old}.jar");
            let relative = format!("versions/{old}/");
            let windows = format!("versions\\{old}\\");
            let local = !value.contains("://");
            let shared = value.contains("libraries/") || value.contains("libraries\\");
            if path_reference(value, old_dir)
                || (local && (value.contains(&relative) || value.contains(&windows)))
                || (local
                    && !shared
                    && (value == &jar
                        || path_reference(value, &format!("/{jar}"))
                        || path_reference(value, &format!("\\{jar}"))))
            {
                Some(pointer.to_owned())
            } else {
                None
            }
        }
        Value::Array(values) => values
            .iter()
            .enumerate()
            .find_map(|(i, v)| ambiguous(v, &format!("{pointer}/{i}"), old_dir, old)),
        Value::Object(values) => values.iter().find_map(|(k, v)| {
            ambiguous(
                v,
                &format!("{pointer}/{}", k.replace('~', "~0").replace('/', "~1")),
                old_dir,
                old,
            )
        }),
        _ => None,
    }
}
fn path_reference(value: &str, path: &str) -> bool {
    value.match_indices(path).any(|(start, _)| {
        value
            .get(start + path.len()..)
            .and_then(|tail| tail.chars().next())
            .is_none_or(|c| c.is_whitespace() || matches!(c, '/' | '\\' | ':' | ';' | '\"' | '\''))
    })
}
pub fn prepare(root: &Path, id: &str, new_name: &str) -> Result<RenamePlan> {
    prepare_bound(root, id, new_name, None)
}
fn prepare_bound(
    root: &Path,
    id: &str,
    new_name: &str,
    active: Option<&str>,
) -> Result<RenamePlan> {
    name_ok(id)?;
    new_name_ok(new_name)?;
    if id == new_name {
        return Err("新名称与当前实例名称相同".into());
    }
    ensure_ready_except(root, active)?;
    let path = root.canonicalize().map_err(err)?;
    let root_dir = Dir::open(&path)?;
    let versions = root_dir.child("versions")?;
    if versions.stat(new_name)?.is_some() {
        return Err("目标实例名称已被占用，请换一个名称".into());
    }
    let instance = versions.child(id)?;
    for extension in ["json", "jar"] {
        if instance.stat(&format!("{new_name}.{extension}"))?.is_some() {
            return Err(format!(
                "实例目录已有 {new_name}.{extension}，已保留该文件，请换一个名称"
            ));
        }
    }
    let names = versions.names()?;
    if names.len() > MAX_INSTANCES {
        return Err("版本数量超过重命名安全上限".into());
    }
    let mut profiles = BTreeMap::new();
    let mut digest = Sha256::new();
    let mut metadata_bytes = 0u64;
    let root_key = root_dir.key()?;
    let versions_key = versions.key()?;
    let instance_key = instance.key()?;
    let content_revision = content_revision(&instance, id, new_name)?;
    digest.update(&content_revision);
    digest
        .update(serde_json::to_vec(&(&path, &root_key, &versions_key, id, new_name)).map_err(err)?);
    for name in names {
        let dir = versions.child(&name)?;
        let key = dir.key()?;
        let filename = format!("{name}.json");
        if dir.stat(&filename)?.is_none() {
            digest.update(serde_json::to_vec(&(&name, &key)).map_err(err)?);
            continue;
        }
        let (data, snapshot) = read_json(&dir, &filename)?;
        metadata_bytes = metadata_bytes
            .checked_add(snapshot.size)
            .ok_or("版本 JSON 总大小过大")?;
        if metadata_bytes > MAX_TOTAL_JSON {
            return Err("版本 JSON 总大小超过 64 MiB 重命名安全上限".into());
        }
        if data["id"].as_str() != Some(name.as_str()) {
            return Err(format!(
                "版本 {name} 的 JSON 标识与目录不一致，无法安全重命名"
            ));
        }
        for field in ["inheritsFrom", "jar"] {
            if let Some(value) = data.get(field) {
                name_ok(value.as_str().ok_or("版本引用标识无效")?)?;
            }
        }
        if let Some(field) = ambiguous(
            &data,
            "",
            &path.join("versions").join(id).to_string_lossy(),
            id,
        ) {
            return Err(format!(
                "版本 {name} 的 JSON 字段 {field} 含无法确认的旧目录或 JAR 路径引用，请先手动处理"
            ));
        }
        digest.update(serde_json::to_vec(&(&name, &key, &snapshot)).map_err(err)?);
        profiles.insert(
            name,
            Profile {
                key,
                snapshot,
                data,
            },
        );
    }
    let selected = profiles.get(id).ok_or("实例缺少同名版本 JSON")?;
    let mut seen = BTreeSet::new();
    let mut current = id;
    loop {
        if seen.len() >= 64 || !seen.insert(current.to_owned()) {
            return Err("实例继承循环或深度超过安全上限".into());
        }
        let data = &profiles.get(current).ok_or("继承的基础版本不存在")?.data;
        match data["inheritsFrom"].as_str() {
            Some(parent) => current = parent,
            None => break,
        }
    }
    let mc = minecraft(&profiles, id, &mut BTreeSet::new())?;
    let jar_name = format!("{id}.jar");
    let jar = if instance.stat(&jar_name)?.is_some() {
        Some(snapshot(instance.regular(&jar_name)?, MAX_JAR, None)?)
    } else {
        None
    };
    if jar.is_none()
        && selected.data["jar"]
            .as_str()
            .is_none_or(|value| value == id)
        && selected.data.get("inheritsFrom").is_none()
    {
        return Err("实例缺少自己的 JAR，且没有外部或继承基础 JAR，无法安全重命名".into());
    }
    digest.update(serde_json::to_vec(&jar).map_err(err)?);
    let mut files = Vec::new();
    let mut dependent_instances = Vec::new();
    for (name, profile) in &profiles {
        let selected = name == id;
        let dependent = profile.data["inheritsFrom"].as_str() == Some(id)
            || profile.data["jar"].as_str() == Some(id);
        if !selected && !dependent {
            continue;
        }
        let mut next = profile.data.clone();
        if selected {
            next["id"] = new_name.into();
            next["clientVersion"] = mc.clone().into();
        }
        if next["inheritsFrom"].as_str() == Some(id) {
            next["inheritsFrom"] = new_name.into();
        }
        if next["jar"].as_str() == Some(id) {
            next["jar"] = new_name.into();
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(err)?;
        if bytes.len() as u64 > MAX_JSON {
            return Err("改名后的版本 JSON 超过安全上限".into());
        }
        files.push(PlannedFile {
            instance: name.clone(),
            dir_key: profile.key.clone(),
            original: profile.snapshot.clone(),
            bytes,
        });
        if !selected {
            dependent_instances.push(name.clone());
        }
    }
    // Stage the selected file first; journal validation requires exactly one.
    files.sort_by_key(|file| (file.instance != id, file.instance.clone()));
    for (name, profile) in &profiles {
        let dir = versions.child(name)?;
        if dir.key()? != profile.key
            || snapshot(dir.regular(&format!("{name}.json"))?, MAX_JSON, None)? != profile.snapshot
        {
            return Err("读取期间关联版本发生变化，请重新准备重命名计划".into());
        }
    }
    if root_dir.key()? != Dir::open(&path)?.key()?
        || versions.key()? != root_dir.child("versions")?.key()?
        || instance.key()? != versions.child(id)?.key()?
    {
        return Err("实例目录已变化，请重新读取重命名计划".into());
    }
    if let Some(jar) = &jar {
        if snapshot(instance.regular(&jar_name)?, MAX_JAR, None)? != *jar {
            return Err("读取期间实例 JAR 已变化".into());
        }
    }
    Ok(RenamePlan {
        revision: format!("rename-v1-{:x}", digest.finalize()),
        id: id.into(),
        new_name: new_name.into(),
        minecraft: mc,
        dependent_instances,
        rename_jar: jar.is_some(),
        root: path,
        root_key,
        versions_key,
        instance_key,
        files,
        jar,
        content_revision,
    })
}

fn storage(root: &Dir, create: bool) -> Result<Option<Dir>> {
    let pcl = if create {
        Some(root.ensure(".pcl-linux")?)
    } else {
        root.optional(".pcl-linux")?
    };
    match pcl {
        None => Ok(None),
        Some(pcl) => {
            if create {
                pcl.ensure(STORE).map(Some)
            } else {
                pcl.optional(STORE)
            }
        }
    }
}
fn lock(store: &Dir) -> Result<File> {
    let file = match store.stat(".lock")? {
        Some(_) => store.regular(".lock")?,
        None => store.create_file(".lock")?,
    };
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("其他进程正在重命名或恢复实例，请稍后重试".into());
    }
    Ok(file)
}
fn validate(j: &Journal, name: &str) -> Result<()> {
    if j.schema != 1
        || j.operation_id != name
        || !operation_ok(name)
        || !j.root.is_absolute()
        || !j.project.is_absolute()
        || name_ok(&j.id).is_err()
        || new_name_ok(&j.new_name).is_err()
        || j.id == j.new_name
        || j.files.is_empty()
        || j.files.len() > MAX_INSTANCES
        || j.files[0].instance != j.id
        || j.content_revision.len() != 64
        || !j.content_revision.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("实例重命名记录无效，已保留文件与备份".into());
    }
    j.refs.revision()?;
    j.refs
        .verify_binding(&j.project, &j.root, &j.id, &j.new_name)?;
    let mut names = BTreeSet::new();
    for file in &j.files {
        name_ok(&file.instance)?;
        if !names.insert(file.instance.clone()) || file.instance == j.new_name {
            return Err("重命名记录的版本列表无效".into());
        }
        for snapshot in std::iter::once(&file.original).chain(file.replacement.as_ref()) {
            valid_snapshot(snapshot, MAX_JSON)?;
        }
        if matches!(
            j.state,
            State::Prepared | State::FilesCommitted | State::Finished
        ) && file.replacement.is_none()
        {
            return Err("重命名替换快照缺失".into());
        }
    }
    if let Some(jar) = &j.jar {
        valid_snapshot(jar, MAX_JAR)?;
    }
    if matches!(
        j.state,
        State::Prepared | State::FilesCommitted | State::Finished
    ) && (j.incoming_key.is_none() || j.backup_key.is_none())
    {
        return Err("重命名暂存目录记录缺失".into());
    }
    Ok(())
}
fn valid_snapshot(snapshot: &Snapshot, limit: u64) -> Result<()> {
    if snapshot.size > limit
        || snapshot.hash.len() != 64
        || !snapshot.hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        Err("重命名文件快照无效".into())
    } else {
        Ok(())
    }
}
// Journals are persisted input, not trusted in-memory plans. Validate schema,
// identities and allowed names before deriving any recovery filesystem action.
fn read_journal(operation: &Dir, name: &str) -> Result<Journal> {
    let mut file = operation.regular("journal.json")?;
    if file.metadata().map_err(err)?.len() > MAX_JOURNAL {
        return Err("重命名记录超过安全上限".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_JOURNAL + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err("重命名记录超过安全上限".into());
    }
    let j: Journal =
        serde_json::from_slice(&bytes).map_err(|_| "重命名记录损坏，已保留原文件与备份")?;
    validate(&j, name)?;
    Ok(j)
}
fn write_journal(operation: &Dir, j: &Journal) -> Result<()> {
    validate(j, &j.operation_id)?;
    bound_operation(operation, j)?;
    let bytes = serde_json::to_vec(j).map_err(err)?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err("重命名记录超过安全上限".into());
    }
    let mut file = operation.anonymous_file()?;
    file.write_all(&bytes).map_err(err)?;
    file.sync_all().map_err(err)?;
    let pinned = CString::new(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(err)?;
    if operation.stat("journal.json")?.is_none() {
        let name = c_name("journal.json")?;
        if unsafe {
            libc::linkat(
                libc::AT_FDCWD,
                pinned.as_ptr(),
                operation.file.as_raw_fd(),
                name.as_ptr(),
                libc::AT_SYMLINK_FOLLOW,
            )
        } != 0
        {
            return Err(os_error("无法发布完整的初始重命名记录"));
        }
        return operation.sync();
    }
    operation.regular("journal.json")?;
    let name = format!("journal-{}.next", operation_id());
    let linked = c_name(&name)?;
    if unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            pinned.as_ptr(),
            operation.file.as_raw_fd(),
            linked.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    } != 0
    {
        return Err(os_error("无法暂存完整的重命名记录"));
    }
    let result = (|| {
        if operation.stat("journal.json")?.is_some() {
            operation.regular("journal.json")?;
        }
        let source = c_name(&name)?;
        let target = c_name("journal.json")?;
        if unsafe {
            libc::renameat(
                operation.file.as_raw_fd(),
                source.as_ptr(),
                operation.file.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(os_error("无法保存重命名记录"));
        }
        operation.sync()
    })();
    if let Err(error) = result {
        if operation.stat(&name)?.is_some() {
            operation
                .unlink(&name, false)
                .map_err(|cleanup| format!("取消清理失败：{cleanup}；原错误：{error}"))?;
        }
        return Err(error);
    }
    Ok(())
}
fn cleanup_journal_temps(operation: &Dir, j: &Journal) -> Result<()> {
    for name in operation.names()? {
        let Some(id) = name
            .strip_prefix("journal-")
            .and_then(|name| name.strip_suffix(".next"))
        else {
            continue;
        };
        if !operation_ok(id) {
            return Err("重命名记录目录含未知暂存文件，已保留内容".into());
        }
        let mut file = operation.regular(&name)?;
        if file.metadata().map_err(err)?.len() > MAX_JOURNAL {
            return Err("重命名暂存记录过大，已保留内容".into());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_JOURNAL + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() as u64 > MAX_JOURNAL {
            return Err("重命名暂存记录过大，已保留内容".into());
        }
        let next: Journal =
            serde_json::from_slice(&bytes).map_err(|_| "重命名暂存记录含未知内容，已保留文件")?;
        validate(&next, &j.operation_id)?;
        if next.root != j.root
            || next.project != j.project
            || next.id != j.id
            || next.new_name != j.new_name
            || next.operation_key != j.operation_key
            || next.root_key != j.root_key
            || next.storage_key != j.storage_key
            || next.refs.revision()? != j.refs.revision()?
        {
            return Err("重命名暂存记录范围不符，已保留文件".into());
        }
        operation.unlink(&name, false)?;
    }
    Ok(())
}
fn rename_new(source: &Dir, old: &str, target: &Dir, new: &str) -> Result<()> {
    let old = c_name(old)?;
    let new = c_name(new)?;
    if unsafe {
        libc::renameat2(
            source.file.as_raw_fd(),
            old.as_ptr(),
            target.file.as_raw_fd(),
            new.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(os_error("无法无覆盖重命名实例文件或目录"));
    }
    source.sync()?;
    target.sync()
}
fn bound_versions(root: &Dir, j: &Journal) -> Result<Dir> {
    if root.key()? != j.root_key || Dir::open(&j.root)?.key()? != j.root_key {
        return Err("游戏目录已变化，已保留重命名记录".into());
    }
    let versions = root.child("versions")?;
    if versions.key()? != j.versions_key {
        return Err("versions 目录已变化，已保留重命名记录".into());
    }
    Ok(versions)
}
fn bound_operation(operation: &Dir, j: &Journal) -> Result<()> {
    let root = Dir::open(&j.root)?;
    if root.key()? != j.root_key {
        return Err("重命名记录绑定的游戏目录已变化".into());
    }
    let store = storage(&root, false)?.ok_or("重命名记录目录已被移走")?;
    if store.key()? != j.storage_key
        || operation.key()? != j.operation_key
        || store.child(&j.operation_id)?.key()? != j.operation_key
    {
        return Err("重命名记录或暂存目录已被移走，已保留文件与备份".into());
    }
    Ok(())
}
fn selected(versions: &Dir, j: &Journal) -> Result<(Dir, bool)> {
    if let Some(old) = versions.optional(&j.id)? {
        if old.key()? == j.instance_key {
            if versions.stat(&j.new_name)?.is_some_and(|st| {
                st.st_dev == j.instance_key.dev && st.st_ino == j.instance_key.ino
            }) {
                return Err("原实例与目标实例目录身份冲突".into());
            }
            return Ok((old, false));
        }
    }
    if let Some(new) = versions.optional(&j.new_name)? {
        if new.key()? == j.instance_key {
            return Ok((new, true));
        }
    }
    Err("原实例或目标实例目录被外部修改，无法覆盖恢复".into())
}
fn profile_dir(versions: &Dir, j: &Journal, file: &Rewrite) -> Result<Dir> {
    let dir = if file.instance == j.id {
        selected(versions, j)?.0
    } else {
        versions.child(&file.instance)?
    };
    if dir.key()? != file.dir_key {
        return Err("关联版本目录已变化，已保留原始备份".into());
    }
    Ok(dir)
}
fn slot(index: usize) -> String {
    format!("json-{index:04}")
}
fn target_name(j: &Journal, file: &Rewrite) -> String {
    format!(
        "{}.json",
        if file.instance == j.id {
            &j.new_name
        } else {
            &file.instance
        }
    )
}
fn owned(operation: &Dir, name: &str, key: &Option<DirKey>) -> Result<Option<Dir>> {
    let child = operation.optional(name)?;
    if let Some(child) = &child {
        if let Some(key) = key {
            if child.key()? != *key {
                return Err("重命名暂存目录被外部替换".into());
            }
        } else if !child.names()?.is_empty() {
            return Err("重命名暂存目录含未知文件，已保留内容".into());
        }
    }
    Ok(child)
}
fn matches(dir: &Dir, name: &str, expected: &Snapshot, limit: u64) -> Result<bool> {
    if dir.stat(name)?.is_none() {
        return Ok(false);
    }
    Ok(expected.stable_matches(&snapshot(dir.regular(name)?, limit, None)?))
}

fn verify_owned_names(dir: &Dir, j: &Journal) -> Result<()> {
    let allowed: BTreeSet<_> = (0..j.files.len()).map(slot).collect();
    if dir.names()?.iter().any(|name| !allowed.contains(name)) {
        return Err("重命名暂存或备份目录含未知文件，已保留内容".into());
    }
    Ok(())
}
fn verify_project(j: &Journal, project: &Path) -> Result<()> {
    let path = project.canonicalize().map_err(err)?;
    if path != j.project || Dir::open(&path)?.key()? != j.project_key {
        return Err("绑定的应用资料目录已变化，已保留恢复记录".into());
    }
    Ok(())
}
fn rollback(root: &Dir, operation: &Dir, j: &Journal) -> Result<()> {
    bound_operation(operation, j)?;
    let versions = bound_versions(root, j)?;
    let (selected_dir, renamed) = selected(&versions, j)?;
    let backup = owned(operation, "backup", &j.backup_key)?.ok_or("重命名备份目录缺失")?;
    let incoming = owned(operation, "incoming", &j.incoming_key)?.ok_or("重命名替换目录缺失")?;
    verify_owned_names(&backup, j)?;
    verify_owned_names(&incoming, j)?;
    if !renamed && backup.names()?.is_empty() && incoming.names()?.len() == j.files.len() {
        let mut untouched = true;
        for (i, file) in j.files.iter().enumerate() {
            let dir = profile_dir(&versions, j, file)?;
            untouched &= matches(
                &dir,
                &format!("{}.json", file.instance),
                &file.original,
                MAX_JSON,
            )? && matches(
                &incoming,
                &slot(i),
                file.replacement.as_ref().ok_or("替换快照缺失")?,
                MAX_JSON,
            )?;
        }
        if let Some(jar) = &j.jar {
            untouched &= matches(&selected_dir, &format!("{}.jar", j.id), jar, MAX_JAR)?;
        }
        if untouched {
            return Ok(());
        }
    }
    let mut positions = Vec::new();
    for (i, file) in j.files.iter().enumerate() {
        let dir = profile_dir(&versions, j, file)?;
        let source = format!("{}.json", file.instance);
        let target = target_name(j, file);
        let item = slot(i);
        let replacement = file.replacement.as_ref().ok_or("重命名替换快照缺失")?;
        let original_here = matches(&dir, &source, &file.original, MAX_JSON)?;
        let original_backup = matches(&backup, &item, &file.original, MAX_JSON)?;
        let replacement_here = matches(&dir, &target, replacement, MAX_JSON)?;
        let replacement_incoming = matches(&incoming, &item, replacement, MAX_JSON)?;
        if original_here == original_backup
            || replacement_here == replacement_incoming
            || (dir.stat(&source)?.is_some()
                && !original_here
                && (source != target || !replacement_here))
            || (dir.stat(&target)?.is_some()
                && !replacement_here
                && (source != target || !original_here))
            || (backup.stat(&item)?.is_some() && !original_backup)
            || (incoming.stat(&item)?.is_some() && !replacement_incoming)
        {
            return Err("版本 JSON 或备份被外部修改，无法覆盖恢复；已保留原始备份".into());
        }
        positions.push((original_backup, replacement_here));
    }
    let mut jar_renamed = false;
    if let Some(expected) = &j.jar {
        let old = format!("{}.jar", j.id);
        let new = format!("{}.jar", j.new_name);
        let old_here = matches(&selected_dir, &old, expected, MAX_JAR)?;
        let new_here = matches(&selected_dir, &new, expected, MAX_JAR)?;
        if old_here == new_here
            || (selected_dir.stat(&old)?.is_some() && !old_here)
            || (selected_dir.stat(&new)?.is_some() && !new_here)
        {
            return Err("实例 JAR 被外部修改，无法覆盖恢复".into());
        }
        jar_renamed = new_here;
    }
    // Every file is checked before the first rollback mutation. A conflict never
    // causes a partial overwrite of newly created user files.
    if renamed {
        rename_new(&versions, &j.new_name, &versions, &j.id)?;
    }
    if jar_renamed {
        rename_new(
            &selected_dir,
            &format!("{}.jar", j.new_name),
            &selected_dir,
            &format!("{}.jar", j.id),
        )?;
    }
    for (i, (file, (original_backup, replacement_here))) in
        j.files.iter().zip(positions).enumerate().rev()
    {
        bound_operation(operation, j)?;
        let versions = bound_versions(root, j)?;
        let dir = profile_dir(&versions, j, file)?;
        let item = slot(i);
        let target = target_name(j, file);
        if replacement_here {
            if !matches(&dir, &target, file.replacement.as_ref().unwrap(), MAX_JSON)? {
                return Err("回滚期间替换 JSON 已变化".into());
            }
            rename_new(&dir, &target, &incoming, &item)?;
        }
        if original_backup {
            if !matches(&backup, &item, &file.original, MAX_JSON)? {
                return Err("回滚期间原始备份已变化".into());
            }
            rename_new(&backup, &item, &dir, &format!("{}.json", file.instance))?;
        }
    }
    let versions = bound_versions(root, j)?;
    for file in &j.files {
        let dir = profile_dir(&versions, j, file)?;
        if !matches(
            &dir,
            &format!("{}.json", file.instance),
            &file.original,
            MAX_JSON,
        )? {
            return Err("原始版本 JSON 恢复校验失败".into());
        }
    }
    Ok(())
}
fn clear_marker(operation: &Dir, j: &mut Journal) -> Result<()> {
    if j.marker_cleared {
        return Ok(());
    }
    match crate::instance_rename_refs::pending_operation(&j.project)? {
        Some(op) if op == j.operation_id => {
            j.refs.clear_pending(&j.project, &j.root, &j.operation_id)?
        }
        _ => {}
    }
    j.marker_cleared = true;
    write_journal(operation, j)
}
fn finish_rollback(operation: &Dir, j: &mut Journal) -> Result<()> {
    bound_operation(operation, j)?;
    cleanup_journal_temps(operation, j)?;
    if let Some(incoming) = owned(operation, "incoming", &j.incoming_key)? {
        verify_owned_names(&incoming, j)?;
        for name in incoming.names()? {
            let index = (0..j.files.len())
                .find(|i| slot(*i) == name)
                .ok_or("替换文件名无效")?;
            let expected = j.files[index]
                .replacement
                .as_ref()
                .ok_or("替换文件未登记，已保留内容")?;
            if !matches(&incoming, &name, expected, MAX_JSON)? {
                return Err("替换文件被外部修改，已保留内容".into());
            }
            incoming.unlink(&name, false)?;
        }
        operation.unlink("incoming", true)?;
    }
    if let Some(backup) = owned(operation, "backup", &j.backup_key)? {
        if !backup.names()?.is_empty() {
            return Err("回滚后的备份目录非空，已保留内容".into());
        }
        operation.unlink("backup", true)?;
    }
    j.state = State::RolledBack;
    write_journal(operation, j)?;
    clear_marker(operation, j)
}
fn verify_committed(root: &Dir, operation: &Dir, j: &Journal) -> Result<()> {
    bound_operation(operation, j)?;
    let versions = bound_versions(root, j)?;
    let (instance, renamed) = selected(&versions, j)?;
    if !renamed {
        return Err("已提交的实例目录尚未改名，已保留记录".into());
    }
    let backup = owned(operation, "backup", &j.backup_key)?.ok_or("重命名备份目录缺失")?;
    verify_owned_names(&backup, j)?;
    for (i, file) in j.files.iter().enumerate() {
        let dir = profile_dir(&versions, j, file)?;
        if !matches(
            &dir,
            &target_name(j, file),
            file.replacement.as_ref().ok_or("替换快照缺失")?,
            MAX_JSON,
        )? || !matches(&backup, &slot(i), &file.original, MAX_JSON)?
        {
            return Err("已提交的版本 JSON 或备份被外部修改，已保留记录".into());
        }
    }
    if let Some(jar) = &j.jar {
        if !matches(&instance, &format!("{}.jar", j.new_name), jar, MAX_JAR)? {
            return Err("已提交的实例 JAR 已变化".into());
        }
    }
    Ok(())
}
// This is also the recovery path for FilesCommitted: each reference accepts its
// captured before-state or intended after-state, so partial replay is repeatable.
fn finish_files(
    root: &Dir,
    operation: &Dir,
    j: &mut Journal,
    progress: &impl Fn(RenameProgress),
) -> Result<()> {
    verify_committed(root, operation, j)?;
    j.refs.mark_pending(&j.project, &j.root, &j.operation_id)?;
    progress(RenameProgress {
        phase: "references".into(),
        message: "正在同步实例资料与引用".into(),
        completed: progress_total(j) - 1,
        total: progress_total(j),
    });
    j.refs.apply(&j.project, &j.root)?;
    cleanup_journal_temps(operation, j)?;
    if let Some(incoming) = owned(operation, "incoming", &j.incoming_key)? {
        if !incoming.names()?.is_empty() {
            return Err("已提交的替换目录含未知文件".into());
        }
        operation.unlink("incoming", true)?;
    }
    j.state = State::Finished;
    write_journal(operation, j)?;
    clear_marker(operation, j)
}
fn progress_total(j: &Journal) -> u64 {
    (j.files.len() * 3 + usize::from(j.jar.is_some()) + 2) as u64
}
/// Reject nonterminal journals before launch or another filesystem writer.
/// The application must separately check the project-wide reference marker.
pub fn ensure_ready(root: &Path) -> Result<()> {
    ensure_ready_except(root, None)
}
fn ensure_ready_except(root: &Path, active: Option<&str>) -> Result<()> {
    let path = root.canonicalize().map_err(err)?;
    let root = Dir::open(&path)?;
    let Some(store) = storage(&root, false)? else {
        return Ok(());
    };
    for name in store.names()? {
        if name == ".lock" {
            store.regular(&name)?;
            continue;
        }
        if !operation_ok(&name) {
            return Err("实例重命名目录含未知记录，已保留文件".into());
        }
        let operation = store.child(&name)?;
        if operation.stat("journal.json")?.is_none() {
            return Err(READY.into());
        }
        let j = read_journal(&operation, &name)?;
        if j.root != path
            || j.root_key != root.key()?
            || j.operation_key != operation.key()?
            || j.storage_key != store.key()?
        {
            return Err("重命名记录与当前游戏目录不匹配".into());
        }
        if !matches!(j.state, State::Finished | State::RolledBack)
            && !(active == Some(name.as_str()) && j.state == State::Staging)
        {
            return Err(READY.into());
        }
    }
    Ok(())
}
/// Recover only transactions bound to these directory identities. Conflicts
/// preserve the journal and backups for inspection instead of overwriting them.
pub fn recover_pending(root: &Path, project: &Path) -> Result<Value> {
    let path = root.canonicalize().map_err(err)?;
    let root = Dir::open(&path)?;
    let Some(store) = storage(&root, false)? else {
        if crate::instance_rename_refs::pending_root(project)?.as_deref() == Some(path.as_path()) {
            return Err("存在未完成的实例重命名，但记录目录缺失；请先还原记录目录后恢复".into());
        }
        return Ok(json!({"recovered":0}));
    };
    let _lock = lock(&store)?;
    let mut recovered = 0usize;
    let mut renamed = Vec::new();
    for name in store.names()? {
        if name == ".lock" {
            continue;
        }
        if !operation_ok(&name) {
            return Err("重命名目录含未知记录".into());
        }
        let operation = store.child(&name)?;
        if operation.stat("journal.json")?.is_none() {
            if operation.names()?.is_empty() {
                store.unlink(&name, true)?;
                recovered += 1;
                continue;
            }
            return Err("未登记的重命名目录含有文件，已保留待检查内容".into());
        }
        let mut j = read_journal(&operation, &name)?;
        if j.root != path
            || j.root_key != root.key()?
            || j.operation_key != operation.key()?
            || j.storage_key != store.key()?
        {
            return Err("重命名记录与当前游戏目录不匹配".into());
        }
        verify_project(&j, project)?;
        let pending = !matches!(j.state, State::Finished | State::RolledBack) || !j.marker_cleared;
        let result = match j.state {
            State::Staging => finish_rollback(&operation, &mut j),
            State::Prepared => {
                rollback(&root, &operation, &j).and_then(|_| finish_rollback(&operation, &mut j))
            }
            State::FilesCommitted => finish_files(&root, &operation, &mut j, &|_| {}),
            State::Finished | State::RolledBack => clear_marker(&operation, &mut j),
        };
        result.map_err(|e| format!("取消清理失败：{e}"))?;
        if pending {
            recovered += 1;
            if j.state == State::Finished {
                renamed.push(json!({"old_id":j.id,"id":j.new_name}));
            }
        }
    }
    ensure_ready(&path)?;
    if crate::instance_rename_refs::pending_root(project)?.as_deref() == Some(path.as_path()) {
        return Err(
            "存在未完成的实例重命名，应用锁定标记缺少对应的可恢复文件记录；已保留标记".into(),
        );
    }
    Ok(json!({"recovered":recovered,"renamed":renamed,"message":"实例重命名恢复完成"}))
}
fn setup(
    root: &Dir,
    store: &Dir,
    project: &Path,
    plan: &RenamePlan,
    refs: RenameReferences,
) -> Result<(Dir, Journal)> {
    let project = project.canonicalize().map_err(err)?;
    let name = operation_id();
    let operation = store.create_dir(&name)?;
    let mut j = Journal {
        schema: 1,
        operation_id: name,
        root: plan.root.clone(),
        project: project.clone(),
        root_key: root.key()?,
        project_key: Dir::open(&project)?.key()?,
        versions_key: plan.versions_key.clone(),
        instance_key: plan.instance_key.clone(),
        operation_key: operation.key()?,
        storage_key: store.key()?,
        incoming_key: None,
        backup_key: None,
        id: plan.id.clone(),
        new_name: plan.new_name.clone(),
        minecraft: plan.minecraft.clone(),
        state: State::Staging,
        files: plan
            .files
            .iter()
            .map(|f| Rewrite {
                instance: f.instance.clone(),
                dir_key: f.dir_key.clone(),
                original: f.original.clone(),
                replacement: None,
            })
            .collect(),
        jar: plan.jar.clone(),
        refs,
        marker_cleared: false,
        content_revision: plan.content_revision.clone(),
    };
    if let Err(error) = write_journal(&operation, &j) {
        return match finish_rollback(&operation, &mut j) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("取消清理失败：{cleanup}；原错误：{error}")),
        };
    }
    let result = (|| {
        j.backup_key = Some(operation.create_dir("backup")?.key()?);
        write_journal(&operation, &j)?;
        j.incoming_key = Some(operation.create_dir("incoming")?.key()?);
        write_journal(&operation, &j)
    })();
    if let Err(error) = result {
        return match finish_rollback(&operation, &mut j) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("取消清理失败：{cleanup}；原错误：{error}")),
        };
    }
    Ok((operation, j))
}
fn stage_file(
    operation: &Dir,
    j: &mut Journal,
    index: usize,
    bytes: &[u8],
    cancel: &AtomicBool,
) -> Result<()> {
    check(cancel)?;
    let incoming = owned(operation, "incoming", &j.incoming_key)?.ok_or("替换目录缺失")?;
    let mut file = incoming.anonymous_file()?;
    for chunk in bytes.chunks(65536) {
        check(cancel)?;
        file.write_all(chunk).map_err(err)?;
    }
    file.sync_all().map_err(err)?;
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    j.files[index].replacement = Some(snapshot(
        file.try_clone().map_err(err)?,
        MAX_JSON,
        Some(cancel),
    )?);
    write_journal(operation, j)?;
    check(cancel)?;
    let source = CString::new(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(err)?;
    let name = c_name(&slot(index))?;
    if unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            source.as_ptr(),
            incoming.file.as_raw_fd(),
            name.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    } != 0
    {
        return Err(os_error("无法发布已登记的重命名 JSON 暂存文件"));
    }
    incoming.sync()
}
fn commit_files(
    root: &Dir,
    operation: &Dir,
    j: &mut Journal,
    changed: &impl Fn(usize) -> Result<()>,
) -> Result<()> {
    let result = (|| {
        let versions = bound_versions(root, j)?;
        let (instance, renamed) = selected(&versions, j)?;
        if renamed {
            return Err("实例目录在提交前已被改名".into());
        }
        if versions.stat(&j.new_name)?.is_some() {
            return Err("目标实例目录名称已被占用".into());
        }
        if content_revision(&instance, &j.id, &j.new_name)? != j.content_revision {
            return Err("实例内容或链接在提交前已变化，请重新读取重命名计划".into());
        }
        let backup = owned(operation, "backup", &j.backup_key)?.ok_or("备份目录缺失")?;
        let incoming = owned(operation, "incoming", &j.incoming_key)?.ok_or("替换目录缺失")?;
        if !backup.names()?.is_empty() || incoming.names()?.len() != j.files.len() {
            return Err("暂存目录与重命名计划不一致".into());
        }
        verify_owned_names(&incoming, j)?;
        for (i, file) in j.files.iter().enumerate() {
            bound_operation(operation, j)?;
            let dir = profile_dir(&versions, j, file)?;
            if snapshot(
                dir.regular(&format!("{}.json", file.instance))?,
                MAX_JSON,
                None,
            )? != file.original
                || !matches(
                    &incoming,
                    &slot(i),
                    file.replacement.as_ref().ok_or("替换文件未登记")?,
                    MAX_JSON,
                )?
            {
                return Err("核心或关联 JSON 已变化，请重新读取重命名计划".into());
            }
            if file.instance == j.id && dir.stat(&target_name(j, file))?.is_some() {
                return Err("目标 JSON 名称已被占用".into());
            }
        }
        if let Some(jar) = &j.jar {
            if snapshot(instance.regular(&format!("{}.jar", j.id))?, MAX_JAR, None)? != *jar
                || instance.stat(&format!("{}.jar", j.new_name))?.is_some()
            {
                return Err("实例 JAR 或目标文件名称已变化".into());
            }
        }
        let mut moved = 0usize;
        for (i, file) in j.files.iter().enumerate() {
            bound_operation(operation, j)?;
            let versions = bound_versions(root, j)?;
            let dir = profile_dir(&versions, j, file)?;
            if !matches(
                &dir,
                &format!("{}.json", file.instance),
                &file.original,
                MAX_JSON,
            )? {
                return Err("原始 JSON 在提交期间已变化".into());
            }
            rename_new(&dir, &format!("{}.json", file.instance), &backup, &slot(i))?;
            moved += 1;
            changed(moved)?;
            bound_operation(operation, j)?;
            if !matches(
                &incoming,
                &slot(i),
                file.replacement.as_ref().ok_or("替换快照缺失")?,
                MAX_JSON,
            )? {
                return Err("替换 JSON 在提交期间被外部修改，已保留文件".into());
            }
            rename_new(&incoming, &slot(i), &dir, &target_name(j, file))?;
            moved += 1;
            changed(moved)?;
        }
        if j.jar.is_some() {
            bound_operation(operation, j)?;
            if !matches(
                &instance,
                &format!("{}.jar", j.id),
                j.jar.as_ref().unwrap(),
                MAX_JAR,
            )? {
                return Err("实例 JAR 在提交期间被外部修改".into());
            }
            rename_new(
                &instance,
                &format!("{}.jar", j.id),
                &instance,
                &format!("{}.jar", j.new_name),
            )?;
            moved += 1;
            changed(moved)?;
        }
        let versions = bound_versions(root, j)?;
        bound_operation(operation, j)?;
        if content_revision(&instance, &j.id, &j.new_name)? != j.content_revision {
            return Err("实例内容或链接在目录改名前已变化，已停止提交".into());
        }
        rename_new(&versions, &j.id, &versions, &j.new_name)?;
        moved += 1;
        changed(moved)?;
        if content_revision(&instance, &j.id, &j.new_name)? != j.content_revision {
            return Err("实例内容或链接在文件提交期间已变化，已停止提交".into());
        }
        verify_committed(root, operation, j)?;
        j.state = State::FilesCommitted;
        if let Err(error) = write_journal(operation, j) {
            j.state = State::Prepared;
            if let Err(record) = write_journal(operation, j) {
                j.state = State::FilesCommitted;
                return Err(format!("取消清理失败：无法确认提交状态，已保留完整实例和原始备份：{record}；原错误：{error}"));
            }
            return Err(error);
        }
        Ok(())
    })();
    if let Err(error) = result {
        if j.state == State::FilesCommitted {
            return Err(error);
        }
        return match rollback(root, operation, j).and_then(|_| finish_rollback(operation, j)) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("取消清理失败：{cleanup}；原错误：{error}")),
        };
    }
    Ok(())
}
/// Run an already checked plan under caller-owned writer admission.
/// The `committing` callback closes task cancellation admission; the token is
/// checked once afterward to honor a cancellation that won just before it.
/// No token checks occur after the first move; failures follow journal recovery.
pub fn execute(
    root: &Path,
    project: &Path,
    plan: RenamePlan,
    refs: RenameReferences,
    cancel: &AtomicBool,
    progress: impl Fn(RenameProgress) + Send + Sync,
) -> Result<Value> {
    check(cancel)?;
    crate::instance_rename_refs::ensure_project_ready(project)?;
    let fresh = prepare(root, &plan.id, &plan.new_name)?;
    if fresh.root != plan.root || fresh.root_key != plan.root_key || fresh.revision != plan.revision
    {
        return Err("实例或关联版本已变化，请重新读取重命名计划".into());
    }
    refs.verify_before(project, &plan.root)?;
    refs.verify_binding(project, &plan.root, &plan.id, &plan.new_name)?;
    let root_dir = Dir::open(&plan.root)?;
    let store = storage(&root_dir, true)?.ok_or("记录目录缺失")?;
    let _lock = lock(&store)?;
    let (operation, mut j) = setup(&root_dir, &store, project, &plan, refs)?;
    let result = (|| {
        for (i, file) in plan.files.iter().enumerate() {
            stage_file(&operation, &mut j, i, &file.bytes, cancel)?;
            progress(RenameProgress {
                phase: "staging".into(),
                message: "正在准备实例与关联版本 JSON".into(),
                completed: (i + 1) as u64,
                total: progress_total(&j),
            });
        }
        let fresh = prepare_bound(&plan.root, &plan.id, &plan.new_name, Some(&j.operation_id))?;
        if fresh.revision != plan.revision {
            return Err("暂存期间实例或关联版本已变化，请重新读取重命名计划".into());
        }
        j.refs.verify_before(project, &plan.root)?;
        check(cancel)?;
        j.state = State::Prepared;
        write_journal(&operation, &j)?;
        j.refs.mark_pending(project, &plan.root, &j.operation_id)?;
        check(cancel)?;
        // The callback closes the task's cancellation admission atomically.
        // Recheck cancellations accepted just before that gate. Once the first
        // game mutation starts, no cancellation checks occur; errors rollback.
        let staged = j.files.len() as u64;
        let total = progress_total(&j);
        progress(RenameProgress {
            phase: "committing".into(),
            message: "正在重命名实例文件与目录".into(),
            completed: staged,
            total,
        });
        check(cancel)?;
        commit_files(&root_dir, &operation, &mut j, &|moved| {
            progress(RenameProgress {
                phase: "committing".into(),
                message: "正在重命名实例文件与目录".into(),
                completed: staged + moved as u64,
                total,
            });
            Ok(())
        })?;
        finish_files(&root_dir, &operation, &mut j, &progress)
            .map_err(|e| format!("取消清理失败：实例文件已改名，资料引用尚未完成：{e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        if matches!(j.state, State::Staging | State::Prepared) {
            let cleanup = if j.state == State::Prepared {
                rollback(&root_dir, &operation, &j)
                    .and_then(|_| finish_rollback(&operation, &mut j))
            } else {
                finish_rollback(&operation, &mut j)
            };
            return match cleanup {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("取消清理失败：{cleanup}；原错误：{error}")),
            };
        }
        return Err(error);
    }
    progress(RenameProgress {
        phase: "complete".into(),
        message: "实例重命名完成".into(),
        completed: progress_total(&j),
        total: progress_total(&j),
    });
    Ok(
        json!({"old_id":plan.id,"id":plan.new_name,"minecraft":plan.minecraft,"dependent_instances":plan.dependent_instances,"backup_id":j.operation_id,"message":"实例重命名完成，游戏内容已保留"}),
    )
}

#[cfg(test)]
mod tests;
