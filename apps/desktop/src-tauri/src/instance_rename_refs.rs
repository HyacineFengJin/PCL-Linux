//! Typed, replayable launcher reference migration for physical instance rename.
//! The game transaction owns the phase journal; this module owns no game data.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const SETTINGS_LIMIT: usize = 2 * 1024 * 1024;
const METADATA_LIMIT: usize = 8 * 1024 * 1024;
const PRESET_LIMIT: usize = 64 * 1024;
const RESOURCE_LIMIT: usize = 2 * 1024 * 1024;
const PAYLOAD_LIMIT: usize = 32 * 1024 * 1024;
const MAX_HISTORY: usize = 8192;
const MARKER: &str = "instance-rename-pending.json";
const PENDING_ERROR: &str = "存在未完成的实例重命名，请先恢复后再操作或启动";
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    device: u64,
    inode: u64,
}
impl Identity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stamp {
    identity: Identity,
    bytes: u64,
    mode: u32,
    links: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Stamp {
    fn of(metadata: &Metadata) -> Self {
        Self {
            identity: Identity::of(metadata),
            bytes: metadata.len(),
            mode: metadata.mode(),
            links: metadata.nlink(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
    fn moved_matches(&self, other: &Self) -> bool {
        self.identity == other.identity
            && self.bytes == other.bytes
            && self.mode == other.mode
            && self.links == other.links
            && self.modified == other.modified
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    stamp: Stamp,
    hash: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DiskSnapshot {
    directory: Option<Identity>,
    file: Option<Token>,
}
impl DiskSnapshot {
    pub(crate) fn file_exists(&self) -> bool {
        self.file.is_some()
    }
    pub(crate) fn compatible(&self, current: &Self) -> bool {
        self == current
            || (self.directory.is_none() && self.file.is_none() && current.file.is_none())
    }
}

struct Dir(File);
fn c(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "引用路径含有无效字符".into())
}
fn error(context: &str) -> String {
    format!("{context}：{}", std::io::Error::last_os_error())
}
fn id(value: &str) -> Result<(), String> {
    pcl_core::identifier(value)?;
    if value.len() > 255 || value.chars().any(char::is_control) {
        return Err("实例名称无效".into());
    }
    Ok(())
}
fn absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.as_os_str().len() > 4096
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        || path
            .to_str()
            .is_none_or(|text| text.chars().any(char::is_control))
    {
        return Err("引用迁移需要规范的绝对路径".into());
    }
    Ok(())
}
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn nonce() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

impl Dir {
    fn open(path: &Path) -> Result<Self, String> {
        absolute(path)?;
        let fd = unsafe {
            libc::open(
                c("/")?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(error("无法打开引用目录"));
        }
        let mut dir = Self(unsafe { File::from_raw_fd(fd) });
        for part in path.components() {
            if let Component::Normal(part) = part {
                dir = dir.child(part.to_str().ok_or("引用目录不是 UTF-8")?)?;
            }
        }
        Ok(dir)
    }
    fn identity(&self) -> Result<Identity, String> {
        self.0
            .metadata()
            .map(|metadata| Identity::of(&metadata))
            .map_err(|e| e.to_string())
    }
    fn child(&self, name: &str) -> Result<Self, String> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c(name)?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(error("无法打开引用目录（不允许符号链接）"));
        }
        Ok(Self(unsafe { File::from_raw_fd(fd) }))
    }
    fn optional(&self, name: &str) -> Result<Option<Self>, String> {
        if self.stat(name)?.is_none() {
            Ok(None)
        } else {
            self.child(name).map(Some)
        }
    }
    fn ensure(&self, name: &str) -> Result<Self, String> {
        if let Some(dir) = self.optional(name)? {
            return Ok(dir);
        }
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), c(name)?.as_ptr(), 0o700) } != 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(error("无法创建引用目录"));
        }
        self.sync()?;
        self.child(name)
    }
    fn stat(&self, name: &str) -> Result<Option<libc::stat>, String> {
        let mut stat = std::mem::MaybeUninit::uninit();
        if unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                c(name)?.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Ok(Some(unsafe { stat.assume_init() }));
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error("无法读取引用文件信息"))
        }
    }
    fn read(&self, name: &str, limit: usize) -> Result<Option<(Token, Vec<u8>)>, String> {
        let Some(expected) = self.stat(name)? else {
            return Ok(None);
        };
        if expected.st_mode & libc::S_IFMT != libc::S_IFREG || expected.st_nlink != 1 {
            return Err(
                "引用文件不是独立的普通文件（不允许符号链接或硬链接），原文件已保留".into(),
            );
        }
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c(name)?.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(error("无法读取引用文件"));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.len() > limit as u64
            || metadata.dev() != expected.st_dev
            || metadata.ino() != expected.st_ino
        {
            return Err("引用文件过大或读取期间已变化，原文件已保留".into());
        }
        let stamp = Stamp::of(&metadata);
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let final_stat = self.stat(name)?.ok_or("引用文件在读取期间消失")?;
        if bytes.len() > limit
            || Stamp::of(&file.metadata().map_err(|e| e.to_string())?) != stamp
            || final_stat.st_dev != stamp.identity.device
            || final_stat.st_ino != stamp.identity.inode
            || final_stat.st_size.max(0) as u64 != stamp.bytes
            || (final_stat.st_mtime, final_stat.st_mtime_nsec) != stamp.modified
            || (final_stat.st_ctime, final_stat.st_ctime_nsec) != stamp.changed
        {
            return Err("引用文件在读取期间已变化，原文件已保留".into());
        }
        Ok(Some((
            Token {
                stamp,
                hash: hash(&bytes),
            },
            bytes,
        )))
    }
    fn create(&self, name: &str) -> Result<File, String> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c(name)?.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if fd < 0 {
            return Err(error("无法创建引用暂存文件"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn sync(&self) -> Result<(), String> {
        self.0
            .sync_all()
            .map_err(|e| format!("引用目录同步失败：{e}"))
    }
    fn unlink(&self, name: &str) -> Result<(), String> {
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), c(name)?.as_ptr(), 0) } != 0 {
            return Err(error("无法删除引用文件"));
        }
        self.sync()
    }
    fn rename(&self, from: &str, to: &str, flags: u32) -> Result<(), String> {
        if unsafe {
            libc::renameat2(
                self.0.as_raw_fd(),
                c(from)?.as_ptr(),
                self.0.as_raw_fd(),
                c(to)?.as_ptr(),
                flags,
            )
        } != 0
        {
            return Err(error("无法原子迁移引用文件"));
        }
        Ok(())
    }
    fn names(&self) -> Result<Vec<String>, String> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c(".")?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(error("无法扫描资源历史"));
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = error("无法扫描资源历史");
            unsafe {
                libc::close(fd);
            }
            return Err(error);
        }
        struct Stream(*mut libc::DIR);
        impl Drop for Stream {
            fn drop(&mut self) {
                unsafe { libc::closedir(self.0) };
            }
        }
        let stream = Stream(stream);
        let mut names = Vec::new();
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(error("资源历史读取失败"));
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            names.push(
                std::str::from_utf8(bytes)
                    .map_err(|_| "资源历史名称无效")?
                    .into(),
            );
            if names.len() > MAX_HISTORY {
                return Err("历史资源记录过多，请先整理后再重命名".into());
            }
        }
        names.sort();
        Ok(names)
    }
    fn lock(&self, name: &str) -> Result<ReferenceLock, String> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c(name)?.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(error("无法打开引用写锁"));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err("引用写锁不是独立的普通文件".into());
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("另一个启动器正在修改引用资料，请稍后重试".into());
        }
        let guard = ReferenceLock(file);
        let stat = self.stat(name)?.ok_or("引用写锁已消失")?;
        if stat.st_dev != metadata.dev() || stat.st_ino != metadata.ino() {
            return Err("引用写锁已被外部替换".into());
        }
        Ok(guard)
    }
    fn update(
        &self,
        name: &str,
        before: Option<&Token>,
        after: Option<&[u8]>,
        limit: usize,
    ) -> Result<(), String> {
        let now = self.read(name, limit)?.map(|(token, _)| token);
        if now.as_ref() != before {
            return Err("引用文件已被外部修改，未覆盖原文件；重命名仍等待恢复".into());
        }
        let temporary = format!(".rename-reference-{}.tmp", nonce());
        if let Some(bytes) = after {
            if bytes.len() > limit {
                return Err("迁移后的引用文件过大".into());
            }
            let mut file = self.create(&temporary)?;
            let result = (|| {
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
                let staged = self.read(&temporary, limit)?.ok_or("引用暂存文件已消失")?.0;
                if staged.stamp != Stamp::of(&file.metadata().map_err(|e| e.to_string())?)
                    || staged.hash != hash(bytes)
                {
                    return Err("引用暂存文件已被外部修改，原文件已保留".into());
                }
                if self.read(name, limit)?.map(|(token, _)| token).as_ref() != before {
                    return Err("引用文件已被外部修改，未覆盖原文件".into());
                }
                if let Some(before) = before {
                    self.rename(&temporary, name, libc::RENAME_EXCHANGE)?;
                    let replaced = self
                        .read(&temporary, limit)?
                        .ok_or("被替换的引用文件已消失")?
                        .0;
                    let published = self.read(name, limit)?.ok_or("迁移后的引用文件已消失")?.0;
                    if !staged.stamp.moved_matches(&published.stamp)
                        || staged.hash != published.hash
                    {
                        return Err(format!("发布后的引用文件已被外部修改，旧资料已保留（{temporary}），请检查后恢复"));
                    }
                    if !before.stamp.moved_matches(&replaced.stamp) || before.hash != replaced.hash
                    {
                        if staged.stamp.moved_matches(&published.stamp)
                            && staged.hash == published.hash
                        {
                            self.rename(&temporary, name, libc::RENAME_EXCHANGE)?;
                            let _ = self.unlink(&temporary);
                            return Err("引用文件在替换期间被外部修改，已还原并保留原文件".into());
                        }
                        return Err(format!(
                            "引用文件并发冲突，已保留双方内容（{temporary}），请检查后恢复"
                        ));
                    }
                    self.unlink(&temporary)?;
                } else {
                    self.rename(&temporary, name, libc::RENAME_NOREPLACE)?;
                    let published = self.read(name, limit)?.ok_or("迁移后的引用文件已消失")?.0;
                    if !staged.stamp.moved_matches(&published.stamp)
                        || staged.hash != published.hash
                    {
                        return Err("发布后的引用文件已被外部修改，原文件已保留".into());
                    }
                }
                self.sync()
            })();
            if result.is_err() {
                // Only clean an owned staged replacement; a swapped-out file
                // may contain external user edits and must remain preserved.
                if self
                    .read(&temporary, limit)
                    .ok()
                    .flatten()
                    .is_some_and(|(token, data)| {
                        file.metadata()
                            .is_ok_and(|metadata| token.stamp.identity == Identity::of(&metadata))
                            && data == bytes
                    })
                {
                    let _ = self.unlink(&temporary);
                }
            }
            result
        } else if let Some(before) = before {
            self.rename(name, &temporary, libc::RENAME_NOREPLACE)?;
            let moved = self
                .read(&temporary, limit)?
                .ok_or("待删除引用文件已消失")?
                .0;
            if !before.stamp.moved_matches(&moved.stamp) || before.hash != moved.hash {
                self.rename(&temporary, name, libc::RENAME_NOREPLACE)?;
                return Err("引用文件在删除期间被外部修改，已保留原文件".into());
            }
            self.unlink(&temporary)
        } else {
            Ok(())
        }
    }
}

pub(crate) struct ReferenceLock(File);
impl Drop for ReferenceLock {
    fn drop(&mut self) {
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

fn app_directory(project: &Path, create: bool) -> Result<Option<Dir>, String> {
    let project = Dir::open(project)?;
    if create {
        project.ensure(".pcl-rust").map(Some)
    } else {
        project.optional(".pcl-rust")
    }
}

pub(crate) fn store_snapshot(
    project: &Path,
    filename: &str,
    limit: usize,
) -> Result<(DiskSnapshot, Option<Vec<u8>>), String> {
    if !matches!(filename, "settings.json" | "instance-metadata.json") {
        return Err("引用文件类型无效".into());
    }
    let Some(dir) = app_directory(project, false)? else {
        return Ok((DiskSnapshot::default(), None));
    };
    let identity = dir.identity()?;
    let value = dir.read(filename, limit)?;
    if app_directory(project, false)?
        .map(|dir| dir.identity())
        .transpose()?
        != Some(identity.clone())
    {
        return Err("引用资料目录已被外部替换".into());
    }
    Ok((
        DiskSnapshot {
            directory: Some(identity),
            file: value.as_ref().map(|(token, _)| token.clone()),
        },
        value.map(|(_, bytes)| bytes),
    ))
}

pub(crate) fn with_settings_lock<T>(
    project: &Path,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let dir = app_directory(project, true)?.ok_or("设置目录不可用")?;
    let _lock = dir.lock(".settings.lock")?;
    if app_directory(project, false)?
        .map(|dir| dir.identity())
        .transpose()?
        != Some(dir.identity()?)
    {
        return Err("设置目录在锁定期间已改变".into());
    }
    f()
}

pub(crate) fn backup_legacy_checked(
    project: &Path,
    bytes: &[u8],
    expected: &DiskSnapshot,
) -> Result<(), String> {
    let dir = app_directory(project, false)?.ok_or("设置目录不可用")?;
    let (now, current) = store_snapshot(project, "settings.json", SETTINGS_LIMIT)?;
    if !expected.compatible(&now) || current.as_deref() != Some(bytes) {
        return Err("旧设置在备份前已变化，原文件已保留".into());
    }
    let name = format!("settings.v1-backup-{}.json", nonce());
    let mut file = dir.create(&name)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    dir.sync()
}

pub(crate) fn write_store_checked(
    project: &Path,
    filename: &str,
    bytes: &[u8],
    expected: &DiskSnapshot,
    limit: usize,
) -> Result<DiskSnapshot, String> {
    if !matches!(filename, "settings.json" | "instance-metadata.json") {
        return Err("引用文件类型无效".into());
    }
    let dir = app_directory(project, true)?.ok_or("引用目录不可用")?;
    let (now, _) = store_snapshot(project, filename, limit)?;
    if now.directory != Some(dir.identity()?) {
        return Err("引用资料目录已被外部替换".into());
    }
    if !expected.compatible(&now) {
        return Err("设置文件已被外部修改，未覆盖原文件，请重新打开启动器".into());
    }
    let saved = dir.update(filename, now.file.as_ref(), Some(bytes), limit);
    let (disk, current) = store_snapshot(project, filename, limit)?;
    if disk.directory == Some(dir.identity()?) && current.as_deref() == Some(bytes) {
        Ok(disk)
    } else {
        saved?;
        Err("引用资料在保存期间已变化，原文件已保留".into())
    }
}

pub(crate) fn root_history_lock(root: &Path) -> Result<ReferenceLock, String> {
    Dir::open(root)?
        .ensure(".pcl-linux")?
        .lock(".resource-operations.lock")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Target {
    Settings,
    Metadata,
    PresetOld,
    PresetNew,
    ResourceJournal { operation_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Delta {
    target: Target,
    snapshot: DiskSnapshot,
    before: Option<String>,
    after: Option<String>,
    after_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameReferences {
    schema_version: u32,
    root_id: String,
    root_path: String,
    old_id: String,
    new_id: String,
    project_identity: Identity,
    root_identity: Identity,
    history_directory: Option<Identity>,
    history_ids: Vec<String>,
    changes: Vec<Delta>,
}

fn decoded(value: &Option<String>, limit: usize) -> Result<Option<Vec<u8>>, String> {
    value
        .as_ref()
        .map(|value| {
            if value.len() > (limit + 2) / 3 * 4 {
                return Err("重命名引用载荷过大".into());
            }
            let bytes = STANDARD
                .decode(value)
                .map_err(|_| "重命名引用载荷编码无效".to_string())?;
            if bytes.len() > limit {
                return Err("重命名引用载荷过大".into());
            }
            Ok(bytes)
        })
        .transpose()
}

fn history_directory(root: &Path) -> Result<Option<Dir>, String> {
    let Some(pcl) = Dir::open(root)?.optional(".pcl-linux")? else {
        return Ok(None);
    };
    pcl.optional("resource-operations")
}

fn preset_directory(project: &Path, create: bool) -> Result<Option<Dir>, String> {
    let Some(app) = app_directory(project, create)? else {
        return Ok(None);
    };
    if create {
        app.ensure("export-presets").map(Some)
    } else {
        app.optional("export-presets")
    }
}

struct Locks {
    _settings: ReferenceLock,
    _metadata: ReferenceLock,
    _presets: Vec<ReferenceLock>,
    _history: ReferenceLock,
}

impl RenameReferences {
    fn limit(target: &Target) -> usize {
        match target {
            Target::Settings => SETTINGS_LIMIT,
            Target::Metadata => METADATA_LIMIT,
            Target::PresetOld | Target::PresetNew => PRESET_LIMIT,
            Target::ResourceJournal { .. } => RESOURCE_LIMIT,
        }
    }
    fn locks(&self, project: &Path, root: &Path) -> Result<Locks, String> {
        let app = app_directory(project, true)?.ok_or("引用目录不可用")?;
        let settings = app.lock(".settings.lock")?;
        let metadata = app.lock(".instance-metadata.lock")?;
        let presets = preset_directory(project, true)?.ok_or("导出配置目录不可用")?;
        let mut names = [
            crate::export_presets::name(&self.root_id, &self.old_id),
            crate::export_presets::name(&self.root_id, &self.new_id),
        ];
        names.sort();
        let preset_locks = names
            .into_iter()
            .map(|name| presets.lock(&format!("{name}.lock")))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Locks {
            _settings: settings,
            _metadata: metadata,
            _presets: preset_locks,
            _history: root_history_lock(root)?,
        })
    }
    fn location(
        &self,
        project: &Path,
        root: &Path,
        target: &Target,
    ) -> Result<(Dir, String), String> {
        match target {
            Target::Settings => Ok((
                app_directory(project, false)?.ok_or("设置目录已消失")?,
                "settings.json".into(),
            )),
            Target::Metadata => Ok((
                app_directory(project, false)?.ok_or("实例资料目录已消失")?,
                "instance-metadata.json".into(),
            )),
            Target::PresetOld | Target::PresetNew => Ok((
                preset_directory(project, false)?.ok_or("导出配置目录已消失")?,
                crate::export_presets::name(
                    &self.root_id,
                    if *target == Target::PresetOld {
                        &self.old_id
                    } else {
                        &self.new_id
                    },
                ),
            )),
            Target::ResourceJournal { operation_id } => {
                if !crate::resource_ops::valid_operation_id(operation_id) {
                    return Err("资源历史标识无效".into());
                }
                Ok((
                    history_directory(root)?
                        .ok_or("资源历史目录已消失")?
                        .child(operation_id)?,
                    "journal.json".into(),
                ))
            }
        }
    }
    fn capture(
        &mut self,
        project: &Path,
        root: &Path,
        target: Target,
        after: Option<Vec<u8>>,
    ) -> Result<(), String> {
        let (dir, name) = self.location(project, root, &target)?;
        let current = dir.read(&name, Self::limit(&target))?;
        self.changes.push(Delta {
            target,
            snapshot: DiskSnapshot {
                directory: Some(dir.identity()?),
                file: current.as_ref().map(|(token, _)| token.clone()),
            },
            before: current.map(|(_, bytes)| STANDARD.encode(bytes)),
            after_hash: after.as_ref().map(|bytes| hash(bytes)),
            after: after.map(|bytes| STANDARD.encode(bytes)),
        });
        Ok(())
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.root_id.is_empty()
            || self.root_id.len() > 128
            || !self
                .root_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            || self.old_id == self.new_id
            || self.changes.len() > MAX_HISTORY + 4
            || self.history_ids.len() > MAX_HISTORY
        {
            return Err("重命名引用载荷范围无效".into());
        }
        id(&self.old_id)?;
        id(&self.new_id)?;
        absolute(Path::new(&self.root_path))?;
        if self.new_id.len() > 120
            || self.new_id.trim() != self.new_id
            || self.new_id.starts_with(".install-")
        {
            return Err("新的实例名称无效".into());
        }
        let mut seen = BTreeSet::new();
        let mut total = 0usize;
        let mut old_preset = None;
        for change in &self.changes {
            let key = serde_json::to_string(&change.target).map_err(|e| e.to_string())?;
            if !seen.insert(key) {
                return Err("重命名引用载荷含有重复目标".into());
            }
            let before = decoded(&change.before, Self::limit(&change.target))?;
            let after = decoded(&change.after, Self::limit(&change.target))?;
            total = total
                .checked_add(
                    before.as_ref().map_or(0, Vec::len) + after.as_ref().map_or(0, Vec::len),
                )
                .ok_or("重命名引用载荷过大")?;
            if total > PAYLOAD_LIMIT
                || before.as_ref().map(|bytes| hash(bytes))
                    != change
                        .snapshot
                        .file
                        .as_ref()
                        .map(|token| token.hash.clone())
                || after.as_ref().map(|bytes| hash(bytes)) != change.after_hash
                || change.snapshot.directory.is_none()
            {
                return Err("重命名引用载荷哈希或目录范围无效".into());
            }
            let expected = match (&change.target, before.as_deref()) {
                (Target::Settings, Some(bytes)) => Some(crate::config::rename_bytes(
                    bytes,
                    &self.root_id,
                    Path::new(&self.root_path),
                    &self.old_id,
                    &self.new_id,
                )?),
                (Target::Metadata, bytes) => Some(crate::instance_meta::rename_optional_bytes(
                    bytes,
                    &self.root_id,
                    Path::new(&self.root_path),
                    &self.old_id,
                    &self.new_id,
                )?),
                (Target::Settings, None) => None,
                (Target::PresetOld, bytes) => {
                    old_preset = bytes.map(Vec::from);
                    None
                }
                (Target::PresetNew, None) => continue,
                (Target::PresetNew, Some(_)) => return Err("目标实例已有导出配置，无法覆盖".into()),
                (Target::ResourceJournal { operation_id }, Some(bytes)) => {
                    if !crate::resource_ops::valid_operation_id(operation_id)
                        || !self.history_ids.contains(operation_id)
                    {
                        return Err("资源历史引用来源无效".into());
                    }
                    Some(
                        crate::resource_ops::rename_journal_bytes(
                            bytes,
                            operation_id,
                            &self.old_id,
                            &self.new_id,
                        )?
                        .unwrap_or_else(|| bytes.to_vec()),
                    )
                }
                (Target::ResourceJournal { .. }, None) => None,
            };
            if expected != after {
                return Err("重命名引用载荷包含非授权的内容变化".into());
            }
        }
        if !seen.contains("{\"type\":\"settings\"}")
            || !seen.contains("{\"type\":\"metadata\"}")
            || !seen.contains("{\"type\":\"preset_old\"}")
            || !seen.contains("{\"type\":\"preset_new\"}")
        {
            return Err("重命名引用载荷缺少必需目标".into());
        }
        let expected = old_preset
            .as_deref()
            .map(|bytes| {
                crate::export_presets::rename_bytes(
                    bytes,
                    &self.root_id,
                    Path::new(&self.root_path),
                    &self.old_id,
                    &self.new_id,
                )
            })
            .transpose()?;
        let new_preset = self
            .changes
            .iter()
            .find(|change| change.target == Target::PresetNew)
            .ok_or("引用载荷缺少导出配置目标")?;
        if decoded(&new_preset.after, PRESET_LIMIT)? != expected {
            return Err("导出配置迁移载荷来源无效".into());
        }
        if self
            .history_ids
            .iter()
            .any(|op| !crate::resource_ops::valid_operation_id(op))
            || self.history_ids.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err("资源历史列表无效".into());
        }
        if self
            .changes
            .iter()
            .filter(|change| matches!(change.target, Target::ResourceJournal { .. }))
            .count()
            != self.history_ids.len()
        {
            return Err("资源历史迁移载荷不完整".into());
        }
        Ok(())
    }
    pub fn revision(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_vec(self)
            .map(|bytes| hash(&bytes))
            .map_err(|e| e.to_string())
    }
    pub fn matches_scope(&self, root: &Path, old: &str, new: &str) -> Result<(), String> {
        self.validate()?;
        if Path::new(&self.root_path) != root || self.old_id != old || self.new_id != new {
            return Err("重命名引用与文件事务范围不符".into());
        }
        Ok(())
    }
    pub fn verify_binding(
        &self,
        project: &Path,
        root: &Path,
        old: &str,
        new: &str,
    ) -> Result<(), String> {
        self.matches_scope(root, old, new)?;
        if Dir::open(project)?.identity()? != self.project_identity
            || Dir::open(root)?.identity()? != self.root_identity
        {
            return Err("重命名引用与项目或游戏目录范围不符".into());
        }
        Ok(())
    }
    fn scope(&self, project: &Path, root: &Path) -> Result<(), String> {
        self.validate()?;
        if Path::new(&self.root_path) != root
            || Dir::open(project)?.identity()? != self.project_identity
            || Dir::open(root)?.identity()? != self.root_identity
        {
            return Err("重命名引用的项目或游戏目录已改变，原文件已保留".into());
        }
        let history = history_directory(root)?;
        if history.as_ref().map(Dir::identity).transpose()? != self.history_directory
            || history
                .map(|dir| dir.names())
                .transpose()?
                .unwrap_or_default()
                != self.history_ids
        {
            return Err("资源历史目录或记录列表已变化，重命名仍等待恢复".into());
        }
        Ok(())
    }
    fn check_changes(&self, project: &Path, root: &Path, allow_after: bool) -> Result<(), String> {
        for change in &self.changes {
            let (dir, name) = self.location(project, root, &change.target)?;
            if Some(dir.identity()?) != change.snapshot.directory {
                return Err("引用资料目录已被外部替换，原文件已保留".into());
            }
            let current = dir
                .read(&name, Self::limit(&change.target))?
                .map(|(token, _)| token);
            if current == change.snapshot.file {
                continue;
            }
            if allow_after
                && current.as_ref().map(|token| &token.hash) == change.after_hash.as_ref()
            {
                continue;
            }
            return Err("引用文件已被外部修改，未覆盖原文件；重命名仍等待恢复".into());
        }
        Ok(())
    }
    pub fn verify_before(&self, project: &Path, root: &Path) -> Result<(), String> {
        let _locks = self.locks(project, root)?;
        self.scope(project, root)?;
        self.check_changes(project, root, false)
    }
    pub fn apply(&self, project: &Path, root: &Path) -> Result<(), String> {
        let _locks = self.locks(project, root)?;
        self.scope(project, root)?;
        self.check_changes(project, root, true)?;
        // Create the new preset before deleting its source, so either side of
        // an interruption always retains a validated copy.
        let mut changes: Vec<_> = self.changes.iter().collect();
        changes.sort_by_key(|change| match change.target {
            Target::PresetNew => 0,
            Target::PresetOld => 2,
            _ => 1,
        });
        for change in changes {
            let (dir, name) = self.location(project, root, &change.target)?;
            let current = dir
                .read(&name, Self::limit(&change.target))?
                .map(|(token, _)| token);
            if current.as_ref().map(|token| &token.hash) == change.after_hash.as_ref() {
                continue;
            }
            if current != change.snapshot.file {
                return Err("引用文件已被外部修改，重命名仍等待恢复".into());
            }
            let after = decoded(&change.after, Self::limit(&change.target))?;
            dir.update(
                &name,
                current.as_ref(),
                after.as_deref(),
                Self::limit(&change.target),
            )?;
        }
        self.check_changes(project, root, true)
    }
    fn marker(&self, operation_id: &str, file_identity: Identity) -> Result<Pending, String> {
        if !valid_rename_operation(operation_id) {
            return Err("重命名事务标识无效".into());
        }
        Ok(Pending {
            schema_version: 1,
            root_path: self.root_path.clone(),
            root_id: self.root_id.clone(),
            root_identity: self.root_identity.clone(),
            project_identity: self.project_identity.clone(),
            file_identity,
            old_id: self.old_id.clone(),
            new_id: self.new_id.clone(),
            operation_id: operation_id.into(),
            revision: self.revision()?,
        })
    }
    pub fn mark_pending(
        &self,
        project: &Path,
        root: &Path,
        operation_id: &str,
    ) -> Result<(), String> {
        let _locks = self.locks(project, root)?;
        self.scope(project, root)?;
        let dir = app_directory(project, true)?.ok_or("引用目录不可用")?;
        let _lock = dir.lock(".instance-rename.lock")?;
        if let Some((token, current)) = dir.read(MARKER, PRESET_LIMIT)? {
            let marker = serde_json::to_vec(&self.marker(operation_id, token.stamp.identity)?)
                .map_err(|e| e.to_string())?;
            if current == marker {
                self.check_changes(project, root, true)?;
                return Ok(());
            }
            return Err("存在其他或已被外部修改的重命名标记，原文件已保留".into());
        }
        self.check_changes(project, root, false)?;
        let temporary = format!(".rename-reference-{}.tmp", nonce());
        let mut file = dir.create(&temporary)?;
        let identity = Identity::of(&file.metadata().map_err(|e| e.to_string())?);
        let result = (|| {
            let bytes = serde_json::to_vec(&self.marker(operation_id, identity.clone())?)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            let (token, staged) = dir
                .read(&temporary, PRESET_LIMIT)?
                .ok_or("重命名标记暂存文件已消失")?;
            if token.stamp.identity != identity || staged != bytes {
                return Err("重命名标记暂存文件已被外部修改，原文件已保留".into());
            }
            dir.rename(&temporary, MARKER, libc::RENAME_NOREPLACE)?;
            dir.sync()
        })();
        if result.is_err()
            && dir
                .stat(&temporary)
                .ok()
                .flatten()
                .is_some_and(|stat| stat.st_dev == identity.device && stat.st_ino == identity.inode)
        {
            let _ = dir.unlink(&temporary);
        }
        result
    }
    pub fn clear_pending(
        &self,
        project: &Path,
        root: &Path,
        operation_id: &str,
    ) -> Result<(), String> {
        self.scope(project, root)?;
        let dir = app_directory(project, false)?.ok_or("引用目录不可用")?;
        let _lock = dir.lock(".instance-rename.lock")?;
        let Some((token, current)) = dir.read(MARKER, PRESET_LIMIT)? else {
            return Ok(());
        };
        let expected =
            serde_json::to_vec(&self.marker(operation_id, token.stamp.identity.clone())?)
                .map_err(|e| e.to_string())?;
        if current != expected {
            return Err("重命名标记已被外部修改，原文件已保留".into());
        }
        dir.update(MARKER, Some(&token), None, PRESET_LIMIT)
    }
}

pub fn prepare(
    project: &Path,
    root_id: &str,
    root: &Path,
    old: &str,
    new: &str,
) -> Result<RenameReferences, String> {
    ensure_project_ready(project)?;
    id(old)?;
    id(new)?;
    let mut refs = RenameReferences {
        schema_version: 1,
        root_id: root_id.into(),
        root_path: root.to_str().ok_or("游戏目录不是 UTF-8")?.into(),
        old_id: old.into(),
        new_id: new.into(),
        project_identity: Dir::open(project)?.identity()?,
        root_identity: Dir::open(root)?.identity()?,
        history_directory: None,
        history_ids: vec![],
        changes: vec![],
    };
    let _locks = refs.locks(project, root)?;
    ensure_project_ready(project)?;
    for (target, name, transform) in [
        (
            Target::Settings,
            "settings.json",
            crate::config::rename_bytes
                as fn(&[u8], &str, &Path, &str, &str) -> Result<Vec<u8>, String>,
        ),
        (
            Target::Metadata,
            "instance-metadata.json",
            crate::instance_meta::rename_bytes,
        ),
    ] {
        let data = app_directory(project, false)?
            .ok_or("引用目录不可用")?
            .read(name, RenameReferences::limit(&target))?
            .map(|(_, bytes)| transform(&bytes, root_id, root, old, new))
            .transpose()?;
        let data = if target == Target::Metadata && data.is_none() {
            Some(crate::instance_meta::rename_optional_bytes(
                None, root_id, root, old, new,
            )?)
        } else {
            data
        };
        refs.capture(project, root, target, data)?;
    }
    let presets = preset_directory(project, false)?.ok_or("导出配置目录不可用")?;
    if presets
        .read(&crate::export_presets::name(root_id, new), PRESET_LIMIT)?
        .is_some()
    {
        return Err("目标名称已有导出配置，请选择其他名称".into());
    }
    let new_preset = presets
        .read(&crate::export_presets::name(root_id, old), PRESET_LIMIT)?
        .map(|(_, bytes)| crate::export_presets::rename_bytes(&bytes, root_id, root, old, new))
        .transpose()?;
    refs.capture(project, root, Target::PresetOld, None)?;
    refs.capture(project, root, Target::PresetNew, new_preset)?;
    if let Some(history) = history_directory(root)? {
        refs.history_directory = Some(history.identity()?);
        refs.history_ids = history.names()?;
        for operation in refs.history_ids.clone() {
            if !crate::resource_ops::valid_operation_id(&operation) {
                return Err("资源操作目录含有未知记录，原文件已保留".into());
            }
            let data = history
                .child(&operation)?
                .read("journal.json", RESOURCE_LIMIT)?
                .map(|(_, bytes)| {
                    crate::resource_ops::rename_journal_bytes(&bytes, &operation, old, new)
                        .map(|after| after.unwrap_or(bytes))
                })
                .transpose()?;
            refs.capture(
                project,
                root,
                Target::ResourceJournal {
                    operation_id: operation,
                },
                data,
            )?;
        }
    }
    refs.scope(project, root)?;
    refs.check_changes(project, root, false)?;
    Ok(refs)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    schema_version: u32,
    root_path: String,
    root_id: String,
    root_identity: Identity,
    project_identity: Identity,
    file_identity: Identity,
    old_id: String,
    new_id: String,
    operation_id: String,
    revision: String,
}
fn valid_rename_operation(value: &str) -> bool {
    value.len() <= 80
        && value.strip_prefix("n-").is_some_and(|tail| {
            let pieces: Vec<_> = tail.split('-').collect();
            pieces.len() == 3
                && pieces.iter().all(|piece| {
                    !piece.is_empty()
                        && piece
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                })
        })
}
pub fn pending_root(project: &Path) -> Result<Option<PathBuf>, String> {
    read_pending(project).map(|marker| marker.map(|marker| marker.root_path.into()))
}
pub fn pending_operation(project: &Path) -> Result<Option<String>, String> {
    read_pending(project).map(|marker| marker.map(|marker| marker.operation_id))
}
fn read_pending(project: &Path) -> Result<Option<Pending>, String> {
    let Some(dir) = app_directory(project, false)? else {
        return Ok(None);
    };
    let Some((token, bytes)) = dir.read(MARKER, PRESET_LIMIT)? else {
        return Ok(None);
    };
    let marker: Pending = serde_json::from_slice(&bytes)
        .map_err(|_| "重命名待恢复标记损坏或格式不受支持，原文件已保留".to_string())?;
    if marker.schema_version != 1
        || !valid_rename_operation(&marker.operation_id)
        || marker.revision.len() != 64
        || !marker.revision.bytes().all(|c| c.is_ascii_hexdigit())
        || marker.project_identity != Dir::open(project)?.identity()?
        || marker.file_identity != token.stamp.identity
        || marker.root_id.is_empty()
        || marker.root_id.len() > 128
        || !marker
            .root_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        || marker.old_id == marker.new_id
    {
        return Err("重命名待恢复标记范围或版本无效，原文件已保留".into());
    }
    id(&marker.old_id)?;
    id(&marker.new_id)?;
    absolute(Path::new(&marker.root_path))?;
    Ok(Some(marker))
}
pub fn ensure_project_ready(project: &Path) -> Result<(), String> {
    if pending_root(project)?.is_some() {
        Err(PENDING_ERROR.into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::ConfigStore,
        instance_meta::{Category, Icon, MetadataPatch, MetadataStore},
    };
    use serde_json::{json, Value};
    use std::{fs, sync::atomic::AtomicBool};

    struct Fixture {
        project: PathBuf,
        root: PathBuf,
        other: PathBuf,
    }
    impl Fixture {
        fn new(isolated: bool) -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../work/instance-rename-2026-10-04/refs-fixtures")
                .join(nonce());
            fs::create_dir_all(&path).unwrap();
            let project = path.canonicalize().unwrap();
            let root = project.join("game");
            let other = project.join("other-game");
            fs::create_dir_all(root.join("versions/Old")).unwrap();
            fs::create_dir_all(&other).unwrap();
            fs::write(
                root.join("versions/Old/Old.json"),
                br#"{"id":"Old","libraries":[]}"#,
            )
            .unwrap();
            fs::write(root.join("versions/Old/Old.jar"), b"fixture").unwrap();
            if isolated {
                fs::create_dir(root.join("versions/Old/mods")).unwrap();
            } else {
                fs::create_dir(root.join("mods")).unwrap();
            }
            fs::create_dir(project.join(".pcl-rust")).unwrap();
            let fixture = Self {
                project,
                root,
                other,
            };
            fixture.save_settings(json!({"schema_version":2,"active_root_id":"root-a","player":"FixturePlayer","memory_gib":10,
                "roots":[{"id":"root-a","name":"A","path":fixture.root,"selected":"Old","overrides":{"Old":12,"Unrelated":8}},
                {"id":"root-b","name":"B","path":fixture.other,"selected":"Old","overrides":{"Old":6}}]}));
            fixture
        }
        fn path(&self, name: &str) -> PathBuf {
            self.project.join(".pcl-rust").join(name)
        }
        fn save_settings(&self, value: Value) {
            fs::write(
                self.path("settings.json"),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }
        fn settings(&self) -> Value {
            serde_json::from_slice(&fs::read(self.path("settings.json")).unwrap()).unwrap()
        }
        fn refs(&self) -> RenameReferences {
            prepare(&self.project, "root-a", &self.root, "Old", "New").unwrap()
        }
        fn request() -> crate::instance_export::ExportRequest {
            serde_json::from_value(
                json!({"name":"Fixture Pack","version":"1.0.0","checks":{},"excluded":{}}),
            )
            .unwrap()
        }
        fn metadata(&self) -> MetadataStore {
            let store = MetadataStore::load(&self.project);
            let old = store.get("root-a", &self.root, "Old");
            store
                .patch(
                    "root-a",
                    &self.root,
                    "Old",
                    &old.revision,
                    MetadataPatch {
                        description: Some("Fixture description".into()),
                        favorite: Some(true),
                        icon: Some(Icon::Forge),
                        category: Some(Category::Forge),
                    },
                )
                .unwrap();
            store
        }
        fn undo(&self, isolated: bool) -> String {
            let folder = if isolated {
                self.root.join("versions/Old/mods")
            } else {
                self.root.join("mods")
            };
            let path = folder.join("fixture.jar");
            fs::write(&path, b"retained resource").unwrap();
            let selected = crate::resource_ops::ResourceFile {
                file_name: "fixture.jar".into(),
                fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
            };
            crate::resource_ops::remove(
                &self.root,
                "Old",
                "mods",
                &[selected],
                &AtomicBool::new(false),
                &mut || Ok(()),
                &mut |_, _| {},
            )
            .unwrap()
            .undo_id
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.project);
        }
    }

    #[test]
    fn selected_override_metadata_and_preset_move_without_other_state_changes() {
        let fixture = Fixture::new(true);
        let (config, warning) = ConfigStore::load(&fixture.project);
        assert!(warning.is_none());
        let metadata = fixture.metadata();
        let before = metadata.get("root-a", &fixture.root, "Old");
        crate::export_presets::save(
            &fixture.project,
            "root-a",
            &fixture.root,
            "Old",
            Fixture::request(),
        )
        .unwrap();
        let settings_before = fixture.settings();
        config.ensure_rename_snapshot().unwrap();
        metadata.ensure_rename_snapshot().unwrap();
        let refs = fixture.refs();
        let revision = refs.revision().unwrap();
        let decoded: RenameReferences =
            serde_json::from_slice(&serde_json::to_vec(&refs).unwrap()).unwrap();
        assert_eq!(decoded.revision().unwrap(), revision);
        refs.verify_before(&fixture.project, &fixture.root).unwrap();
        refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        refs.apply(&fixture.project, &fixture.root).unwrap();
        refs.apply(&fixture.project, &fixture.root).unwrap();
        refs.clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        config.refresh_after_rename().unwrap();
        metadata.refresh_after_rename().unwrap();
        let settings = fixture.settings();
        assert_eq!(settings["roots"][0]["selected"], "New");
        assert_eq!(settings["roots"][0]["overrides"]["New"], 12);
        assert!(settings["roots"][0]["overrides"].get("Old").is_none());
        assert_eq!(settings["roots"][0]["overrides"]["Unrelated"], 8);
        assert_eq!(settings["roots"][1], settings_before["roots"][1]);
        for field in ["player", "memory_gib", "active_root_id"] {
            assert_eq!(settings[field], settings_before[field]);
        }
        assert_eq!(config.snapshot().selected.as_deref(), Some("New"));
        let after = metadata.get("root-a", &fixture.root, "New");
        assert_eq!(after.metadata(), before.metadata());
        assert_ne!(after.revision, before.revision);
        assert_eq!(metadata.get("root-a", &fixture.root, "Old").description, "");
        assert!(
            crate::export_presets::read(&fixture.project, "root-a", &fixture.root, "Old")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            crate::export_presets::read(&fixture.project, "root-a", &fixture.root, "New")
                .unwrap()
                .unwrap(),
            Fixture::request()
        );
        assert!(!fixture.path(MARKER).exists());
    }

    #[test]
    fn historical_undo_remains_usable_after_isolated_and_global_rename() {
        for isolated in [true, false] {
            let fixture = Fixture::new(isolated);
            let undo = fixture.undo(isolated);
            let refs = fixture.refs();
            refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
                .unwrap();
            fs::rename(
                fixture.root.join("versions/Old"),
                fixture.root.join("versions/New"),
            )
            .unwrap();
            fs::remove_file(fixture.root.join("versions/New/Old.json")).unwrap();
            fs::write(
                fixture.root.join("versions/New/New.json"),
                br#"{"id":"New","libraries":[]}"#,
            )
            .unwrap();
            fs::rename(
                fixture.root.join("versions/New/Old.jar"),
                fixture.root.join("versions/New/New.jar"),
            )
            .unwrap();
            refs.apply(&fixture.project, &fixture.root).unwrap();
            refs.clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
                .unwrap();
            let journal_path = fixture
                .root
                .join(".pcl-linux/resource-operations")
                .join(&undo)
                .join("journal.json");
            let journal: Value = serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
            assert_eq!(journal["instance_id"], "New");
            assert_eq!(
                journal["resource_relative"],
                if isolated {
                    "versions/New/mods"
                } else {
                    "mods"
                }
            );
            assert_eq!(
                crate::resource_ops::removed(&fixture.root, "New", "mods").unwrap()[0].id,
                undo
            );
            crate::resource_ops::restore(
                &fixture.root,
                "New",
                "mods",
                &undo,
                &AtomicBool::new(false),
                &mut || Ok(()),
                &mut |_, _| {},
            )
            .unwrap();
            let restored = fixture.root.join(if isolated {
                "versions/New/mods/fixture.jar"
            } else {
                "mods/fixture.jar"
            });
            assert_eq!(fs::read(restored).unwrap(), b"retained resource");
        }
    }

    #[test]
    fn partial_replay_is_idempotent_and_external_user_updates_are_preserved() {
        let fixture = Fixture::new(true);
        fixture.metadata();
        let refs = fixture.refs();
        refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        let settings = refs
            .changes
            .iter()
            .find(|change| change.target == Target::Settings)
            .unwrap();
        let (dir, name) = refs
            .location(&fixture.project, &fixture.root, &settings.target)
            .unwrap();
        dir.update(
            &name,
            settings.snapshot.file.as_ref(),
            decoded(&settings.after, SETTINGS_LIMIT).unwrap().as_deref(),
            SETTINGS_LIMIT,
        )
        .unwrap();
        refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        let mut edited = fixture.settings();
        edited["memory_gib"] = json!(18);
        fixture.save_settings(edited.clone());
        assert!(refs.apply(&fixture.project, &fixture.root).is_err());
        assert_eq!(fixture.settings(), edited);
        assert!(fixture.path(MARKER).exists());
        // Restoring the exact prepared after state permits recovery to finish.
        fs::write(
            fixture.path("settings.json"),
            decoded(&settings.after, SETTINGS_LIMIT).unwrap().unwrap(),
        )
        .unwrap();
        refs.apply(&fixture.project, &fixture.root).unwrap();
        refs.clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
    }

    #[test]
    fn edits_between_verify_and_marker_are_rejected_before_commit() {
        let fixture = Fixture::new(true);
        let refs = fixture.refs();
        refs.verify_before(&fixture.project, &fixture.root).unwrap();
        let mut edited = fixture.settings();
        edited["player"] = json!("EditedPlayer");
        fixture.save_settings(edited.clone());
        assert!(refs
            .mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .is_err());
        assert!(!fixture.path(MARKER).exists());
        assert_eq!(fixture.settings(), edited);
    }

    #[test]
    fn pending_marker_blocks_all_reference_writers_and_survives_offline_root() {
        let fixture = Fixture::new(true);
        let (config, _) = ConfigStore::load(&fixture.project);
        let metadata = fixture.metadata();
        let refs = fixture.refs();
        refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        let original = fs::read(fixture.path("settings.json")).unwrap();
        let mut settings = config.snapshot();
        settings.memory_gib = 18;
        assert!(config.save(settings).unwrap_err().contains(PENDING_ERROR));
        let old = metadata.get("root-a", &fixture.root, "Old");
        assert!(metadata
            .patch(
                "root-a",
                &fixture.root,
                "Old",
                &old.revision,
                MetadataPatch {
                    description: Some("Blocked".into()),
                    ..MetadataPatch::default()
                }
            )
            .unwrap_err()
            .contains(PENDING_ERROR));
        assert!(crate::export_presets::save(
            &fixture.project,
            "root-a",
            &fixture.root,
            "Old",
            Fixture::request()
        )
        .unwrap_err()
        .contains(PENDING_ERROR));
        assert_eq!(fs::read(fixture.path("settings.json")).unwrap(), original);
        let offline = fixture.project.join("offline");
        fs::rename(&fixture.root, &offline).unwrap();
        assert_eq!(
            pending_root(&fixture.project).unwrap(),
            Some(fixture.root.clone())
        );
        assert_eq!(
            pending_operation(&fixture.project).unwrap().as_deref(),
            Some("n-123-456-1")
        );
        assert!(ensure_project_ready(&fixture.project)
            .unwrap_err()
            .contains(PENDING_ERROR));
        fs::rename(offline, &fixture.root).unwrap();
        refs.clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
    }

    #[test]
    fn target_override_saved_metadata_and_preset_collisions_are_preserved() {
        let fixture = Fixture::new(true);
        let mut settings = fixture.settings();
        settings["roots"][0]["overrides"]["New"] = json!(14);
        fixture.save_settings(settings.clone());
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
        assert_eq!(fixture.settings(), settings);
        settings["roots"][0]["overrides"]
            .as_object_mut()
            .unwrap()
            .remove("New");
        fixture.save_settings(settings);
        fs::write(
            fixture.path("instance-metadata.json"),
            serde_json::to_vec(&json!({"schema_version":1,"entries":[{
            "root_id":"root-a","root_path":fixture.root,"instance_id":"New","revision":3,
            "metadata":{"description":"Saved target description","favorite":false,"icon":"auto","category":"auto"}}]}))
            .unwrap(),
        )
        .unwrap();
        let original = fs::read(fixture.path("instance-metadata.json")).unwrap();
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
        assert_eq!(
            fs::read(fixture.path("instance-metadata.json")).unwrap(),
            original
        );
        fs::remove_file(fixture.path("instance-metadata.json")).unwrap();
        crate::export_presets::save(
            &fixture.project,
            "root-a",
            &fixture.root,
            "New",
            Fixture::request(),
        )
        .unwrap();
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
    }

    #[test]
    fn rename_back_preserves_metadata_and_invalidates_all_old_tokens() {
        for saved in [false, true] {
            let fixture = Fixture::new(true);
            let metadata = if saved {
                fixture.metadata()
            } else {
                MetadataStore::load(&fixture.project)
            };
            let initial_old = metadata.get("root-a", &fixture.root, "Old");
            let initial_target = metadata.get("root-a", &fixture.root, "New");
            let refs = fixture.refs();
            refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
                .unwrap();
            refs.apply(&fixture.project, &fixture.root).unwrap();
            refs.clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
                .unwrap();
            metadata.refresh_after_rename().unwrap();
            let cleared_old = metadata.get("root-a", &fixture.root, "Old");
            let moved = metadata.get("root-a", &fixture.root, "New");
            assert_eq!(moved.metadata(), initial_old.metadata());
            assert_ne!(initial_old.revision, cleared_old.revision);
            assert_ne!(initial_target.revision, moved.revision);
            assert!(metadata
                .patch(
                    "root-a",
                    &fixture.root,
                    "Old",
                    &initial_old.revision,
                    MetadataPatch {
                        description: Some("Stale write".into()),
                        ..Default::default()
                    }
                )
                .is_err());
            let back = prepare(&fixture.project, "root-a", &fixture.root, "New", "Old").unwrap();
            back.mark_pending(&fixture.project, &fixture.root, "n-123-456-2")
                .unwrap();
            back.apply(&fixture.project, &fixture.root).unwrap();
            back.clear_pending(&fixture.project, &fixture.root, "n-123-456-2")
                .unwrap();
            metadata.refresh_after_rename().unwrap();
            let returned = metadata.get("root-a", &fixture.root, "Old");
            assert_eq!(returned.metadata(), initial_old.metadata());
            assert_eq!(metadata.get("root-a", &fixture.root, "New").description, "");
            for token in [&initial_old.revision, &cleared_old.revision] {
                assert_ne!(*token, returned.revision);
                assert!(metadata
                    .patch(
                        "root-a",
                        &fixture.root,
                        "Old",
                        token,
                        MetadataPatch {
                            description: Some("Stale write".into()),
                            ..Default::default()
                        }
                    )
                    .is_err());
            }
            let data: Value =
                serde_json::from_slice(&fs::read(fixture.path("instance-metadata.json")).unwrap())
                    .unwrap();
            assert_eq!(data["entries"].as_array().unwrap().len(), 2);
            for entry in data["entries"].as_array().unwrap() {
                assert_eq!(entry["revision"], if saved { 3 } else { 2 });
            }
        }
    }

    #[test]
    fn default_target_generation_is_retained_and_advanced() {
        let fixture = Fixture::new(true);
        fs::write(
            fixture.path("instance-metadata.json"),
            serde_json::to_vec(&json!({"schema_version":1,"entries":[{
            "root_id":"root-a","root_path":fixture.root,"instance_id":"New","revision":7,
            "metadata":{"description":"","favorite":false,"icon":"auto","category":"auto"}}]}))
            .unwrap(),
        )
        .unwrap();
        let metadata = MetadataStore::load(&fixture.project);
        let target = metadata.get("root-a", &fixture.root, "New");
        let refs = fixture.refs();
        refs.apply(&fixture.project, &fixture.root).unwrap();
        metadata.refresh_after_rename().unwrap();
        assert_ne!(
            target.revision,
            metadata.get("root-a", &fixture.root, "New").revision
        );
        let data: Value =
            serde_json::from_slice(&fs::read(fixture.path("instance-metadata.json")).unwrap())
                .unwrap();
        let entries = data["entries"].as_array().unwrap();
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry["instance_id"] == "New")
                .unwrap()["revision"],
            8
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry["instance_id"] == "Old")
                .unwrap()["revision"],
            1
        );
    }

    #[test]
    fn metadata_generation_and_added_record_limits_refuse_without_writes() {
        let fixture = Fixture::new(true);
        let record = |id: &str, generation: u64| {
            json!({
            "root_id":"root-a","root_path":fixture.root,"instance_id":id,"revision":generation,
            "metadata":{"description":"","favorite":false,"icon":"auto","category":"auto"}})
        };
        for name in ["Old", "New"] {
            let bytes =
                serde_json::to_vec(&json!({"schema_version":1,"entries":[record(name,u64::MAX)]}))
                    .unwrap();
            fs::write(fixture.path("instance-metadata.json"), &bytes).unwrap();
            assert!(
                prepare(&fixture.project, "root-a", &fixture.root, "Old", "New")
                    .unwrap_err()
                    .contains("修订号已耗尽")
            );
            assert_eq!(
                fs::read(fixture.path("instance-metadata.json")).unwrap(),
                bytes
            );
        }
        let entries: Vec<_> = (0..4095)
            .map(|index| record(&format!("Fixture{index}"), 1))
            .collect();
        let bytes = serde_json::to_vec(&json!({"schema_version":1,"entries":entries})).unwrap();
        fs::write(fixture.path("instance-metadata.json"), &bytes).unwrap();
        assert!(
            prepare(&fixture.project, "root-a", &fixture.root, "Old", "New")
                .unwrap_err()
                .contains("4096")
        );
        assert_eq!(
            fs::read(fixture.path("instance-metadata.json")).unwrap(),
            bytes
        );
    }

    #[test]
    fn malformed_future_and_symlink_files_are_never_overwritten() {
        let fixture = Fixture::new(true);
        let mut future = fixture.settings();
        future["schema_version"] = json!(99);
        fixture.save_settings(future.clone());
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
        assert_eq!(fixture.settings(), future);
        let original = fixture.path("settings.json");
        fs::remove_file(&original).unwrap();
        let protected = fixture.project.join("protected");
        fs::write(&protected, b"protected content").unwrap();
        std::os::unix::fs::symlink(&protected, &original).unwrap();
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
        assert_eq!(fs::read(protected).unwrap(), b"protected content");
        let (config, warning) = ConfigStore::load(&fixture.project);
        assert!(warning.is_some());
        assert!(config.ensure_writable().is_err());
    }

    #[test]
    fn forged_payload_paths_hashes_and_unrelated_changes_are_refused() {
        let fixture = Fixture::new(true);
        let refs = fixture.refs();
        let mut forged = refs.clone();
        let change = forged
            .changes
            .iter_mut()
            .find(|change| change.target == Target::Settings)
            .unwrap();
        let mut settings: Value =
            serde_json::from_slice(&decoded(&change.after, SETTINGS_LIMIT).unwrap().unwrap())
                .unwrap();
        settings["memory_gib"] = json!(18);
        let bytes = serde_json::to_vec_pretty(&settings).unwrap();
        change.after_hash = Some(hash(&bytes));
        change.after = Some(STANDARD.encode(bytes));
        assert!(forged.revision().is_err());
        assert!(forged.apply(&fixture.project, &fixture.root).is_err());
        assert_eq!(fixture.settings()["memory_gib"], 10);
        assert!(refs
            .verify_binding(&fixture.project, &fixture.root, "Other", "New")
            .is_err());
        let mut value = serde_json::to_value(&refs).unwrap();
        value["changes"][0]["target"] = json!({"type":"arbitrary","path":"accounts.json"});
        assert!(serde_json::from_value::<RenameReferences>(value).is_err());
    }

    #[test]
    fn changed_marker_is_preserved_and_never_cleared_by_another_operation() {
        let fixture = Fixture::new(true);
        let refs = fixture.refs();
        refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        let original = fs::read(fixture.path(MARKER)).unwrap();
        assert!(refs
            .clear_pending(&fixture.project, &fixture.root, "n-123-456-2")
            .is_err());
        assert_eq!(fs::read(fixture.path(MARKER)).unwrap(), original);
        fs::write(fixture.path(MARKER), b"malformed marker").unwrap();
        assert!(pending_root(&fixture.project).is_err());
        assert!(ensure_project_ready(&fixture.project).is_err());
        assert!(refs
            .clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .is_err());
        assert_eq!(fs::read(fixture.path(MARKER)).unwrap(), b"malformed marker");
    }

    #[test]
    fn exact_content_marker_replacement_is_not_adopted_or_cleared() {
        let fixture = Fixture::new(true);
        let refs = fixture.refs();
        refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .unwrap();
        let bytes = fs::read(fixture.path(MARKER)).unwrap();
        fs::rename(fixture.path(MARKER), fixture.path("preserved-marker.json")).unwrap();
        fs::write(fixture.path(MARKER), &bytes).unwrap();
        assert!(pending_root(&fixture.project).is_err());
        assert!(refs
            .mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .is_err());
        assert!(refs
            .clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
            .is_err());
        assert_eq!(fs::read(fixture.path(MARKER)).unwrap(), bytes);
    }

    #[test]
    fn stale_cache_refuses_writes_and_refresh_never_adopts_missing_file_defaults() {
        let fixture = Fixture::new(true);
        let (config, _) = ConfigStore::load(&fixture.project);
        let metadata = fixture.metadata();
        let mut external = fixture.settings();
        external["memory_gib"] = json!(18);
        fixture.save_settings(external.clone());
        assert!(config.ensure_rename_snapshot().is_err());
        let mut edited = config.snapshot();
        edited.memory_gib = 20;
        assert!(config.save(edited).is_err());
        assert_eq!(fixture.settings(), external);
        fs::remove_file(fixture.path("settings.json")).unwrap();
        assert!(config.refresh_after_rename().is_err());
        assert_eq!(config.snapshot().memory_gib, 10);
        fs::remove_file(fixture.path("instance-metadata.json")).unwrap();
        assert!(metadata.refresh_after_rename().is_err());
        assert_eq!(
            metadata.get("root-a", &fixture.root, "Old").description,
            "Fixture description"
        );
    }

    #[test]
    fn settings_transport_revision_rejects_dtos_captured_before_rename_refresh() {
        for changed in [false, true] {
            let fixture = Fixture::new(true);
            if !changed {
                let mut settings = fixture.settings();
                settings["roots"][0]["selected"] = json!("Unrelated");
                settings["roots"][0]["overrides"]
                    .as_object_mut()
                    .unwrap()
                    .remove("Old");
                fixture.save_settings(settings);
            }
            let initial_bytes = fs::read(fixture.path("settings.json")).unwrap();
            let (config, warning) = ConfigStore::load(&fixture.project);
            assert!(warning.is_none());
            let mut stale = config.snapshot();
            let old_revision = stale.revision.clone();
            let refs = fixture.refs();
            refs.mark_pending(&fixture.project, &fixture.root, "n-123-456-1")
                .unwrap();
            refs.apply(&fixture.project, &fixture.root).unwrap();
            refs.clear_pending(&fixture.project, &fixture.root, "n-123-456-1")
                .unwrap();
            config.refresh_after_rename().unwrap();
            let after = config.snapshot();
            assert_ne!(after.revision, old_revision);
            let saved = fs::read(fixture.path("settings.json")).unwrap();
            if changed {
                assert_eq!(after.selected.as_deref(), Some("New"));
                assert_eq!(after.overrides.get("New"), Some(&12));
                assert!(!after.overrides.contains_key("Old"));
            } else {
                assert_eq!(saved, initial_bytes);
            }
            stale.memory_gib = 18;
            assert!(config.save(stale).unwrap_err().contains("设置已更新"));
            assert_eq!(fs::read(fixture.path("settings.json")).unwrap(), saved);
            assert_eq!(config.snapshot(), after);
            let mut fresh = after.clone();
            fresh.memory_gib = 16;
            config.save(fresh).unwrap();
            assert_eq!(config.snapshot().memory_gib, 16);
            assert_ne!(config.snapshot().revision, after.revision);
            assert!(config.save(after).is_err());
            assert!(fixture.settings().get("revision").is_none());
        }
    }

    #[test]
    fn unsupported_or_pending_resource_journals_block_migration() {
        let fixture = Fixture::new(true);
        let undo = fixture.undo(true);
        let path = fixture
            .root
            .join(".pcl-linux/resource-operations")
            .join(&undo)
            .join("journal.json");
        let mut data: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        data["state"] = json!("prepared");
        let bytes = serde_json::to_vec(&data).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        data["state"] = json!("committed");
        data["version"] = json!(99);
        let bytes = serde_json::to_vec(&data).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(prepare(&fixture.project, "root-a", &fixture.root, "Old", "New").is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
