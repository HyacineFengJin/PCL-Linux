//! Read-only instance/resource scope capture. File descriptors, complete SHA512
//! fingerprints and inheritance JSONs bind a plan to the actual target files.
use super::*;
use sha2::{Digest, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    fs::{self, Metadata},
    io::{Read, Seek, SeekFrom},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, PathBuf},
    sync::atomic::Ordering,
};

const KINDS: [&str; 3] = ["mods", "resourcepacks", "shaderpacks"];
const MAX_LOCAL_FILES: usize = 512;
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(super) struct Key {
    pub dev: u64,
    pub ino: u64,
}
impl Key {
    pub fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
        }
    }
}
pub(super) struct Dir(pub File);
fn c(name: &str) -> Result<CString> {
    CString::new(name).map_err(|_| "资源路径含无效字符".into())
}
fn error(message: &str) -> String {
    format!("{message}：{}", std::io::Error::last_os_error())
}
impl Dir {
    pub fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        {
            return Err("资源目标必须是规范绝对路径".into());
        }
        let fd = unsafe {
            libc::open(
                c("/")?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(error("无法打开资源目标目录"));
        }
        let mut directory = Self(unsafe { File::from_raw_fd(fd) });
        for part in path.components() {
            if let Component::Normal(part) = part {
                let name = CString::new(part.as_bytes()).map_err(|e| e.to_string())?;
                let fd = unsafe {
                    libc::openat(
                        directory.0.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(error("资源目录祖先已变化或含符号链接"));
                }
                directory = Self(unsafe { File::from_raw_fd(fd) });
            }
        }
        Ok(directory)
    }
    fn open_child(&self, name: &str, flags: i32) -> Result<File> {
        provider::file_name(name)?;
        #[repr(C)]
        struct OpenHow {
            flags: u64,
            mode: u64,
            resolve: u64,
        }
        let how = OpenHow {
            flags: (flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
            mode: 0,
            resolve: 0x01 | 0x02 | 0x04 | 0x08,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                self.0.as_raw_fd(),
                c(name)?.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            ) as i32
        };
        if fd < 0 {
            return Err(error("资源路径已变化、含链接或挂载点（需要Linux5.6以上）"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn child(&self, name: &str) -> Result<Self> {
        self.open_child(name, libc::O_RDONLY | libc::O_DIRECTORY)
            .map(Self)
    }
    pub fn regular(&self, name: &str) -> Result<File> {
        let file = self.open_child(name, libc::O_RDONLY | libc::O_NONBLOCK)?;
        let m = file.metadata().map_err(|e| e.to_string())?;
        if !m.is_file() || m.nlink() != 1 {
            return Err("资源必须是独立普通文件，原内容已保留".into());
        }
        Ok(file)
    }
    pub fn optional(&self, name: &str) -> Result<Option<Self>> {
        if self.stat(name)?.is_none() {
            Ok(None)
        } else {
            self.child(name).map(Some)
        }
    }
    pub fn ensure(&self, name: &str) -> Result<Self> {
        if let Some(dir) = self.optional(name)? {
            return Ok(dir);
        }
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), c(name)?.as_ptr(), 0o700) } != 0 {
            return Err(error("无法创建匿名网络暂存目录"));
        }
        self.0.sync_all().map_err(|e| e.to_string())?;
        self.child(name)
    }
    pub fn anonymous(&self) -> Result<File> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c(".")?.as_ptr(),
                libc::O_RDWR | libc::O_TMPFILE | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(error("文件系统不支持匿名资源暂存文件，资源目录未改动"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn key(&self) -> Result<Key> {
        self.0
            .metadata()
            .map(|m| Key::of(&m))
            .map_err(|e| e.to_string())
    }
    pub fn stat(&self, name: &str) -> Result<Option<libc::stat>> {
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
            Err(error("无法检查资源文件"))
        }
    }
    fn names(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(format!("/proc/self/fd/{}", self.0.as_raw_fd()))
            .map_err(|e| e.to_string())?
        {
            let name = entry
                .map_err(|e| e.to_string())?
                .file_name()
                .into_string()
                .map_err(|_| "资源目录含非UTF8名称")?;
            provider::file_name(&name)?;
            names.push(name);
            if names.len() > 4096 {
                return Err("资源目录条目超过安全上限".into());
            }
        }
        names.sort();
        Ok(names)
    }
}
pub(super) fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}
fn stamp(m: &Metadata) -> (u64, u64, u64, u32, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mode(),
        m.nlink(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
pub(super) fn fingerprint(file: &mut File, cancel: &AtomicBool) -> Result<(u64, String, String)> {
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_FILE_BYTES {
        return Err("资源文件不安全或超过大小限制".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut digest = Sha512::new();
    let mut count = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        cancelled(cancel)?;
        let len = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if len == 0 {
            break;
        }
        count += len as u64;
        if count > before.len() {
            return Err("资源文件读取期间变化".into());
        }
        digest.update(&buffer[..len]);
    }
    if count != before.len()
        || stamp(&file.metadata().map_err(|e| e.to_string())?) != stamp(&before)
    {
        return Err("资源文件读取期间变化".into());
    }
    let sha512 = format!("{:x}", digest.finalize());
    let token = serde_json::to_vec(&(stamp(&before), &sha512)).map_err(|e| e.to_string())?;
    Ok((count, sha512, format!("{:x}", Sha512::digest(token))))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct Profile {
    id: String,
    directory: Key,
    fingerprint: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct ResourceView {
    directory: Option<Key>,
    others: BTreeMap<String, (u64, u64, u32)>,
}
#[derive(Clone, Debug, Serialize)]
pub struct TargetSnapshot {
    pub root_id: String,
    pub instance_id: String,
    pub minecraft_version: String,
    pub loader: String,
    pub(super) root: PathBuf,
    pub(super) project: PathBuf,
    pub(super) root_key: Key,
    pub(super) project_key: Key,
    pub(super) compatibility: Compatibility,
    pub(super) local_files: Vec<LocalFile>,
    profiles: Vec<Profile>,
    isolated: bool,
    views: BTreeMap<String, ResourceView>,
}
fn profiles(root: &Dir, id: &str, cancel: &AtomicBool) -> Result<Vec<Profile>> {
    let versions = root.child("versions")?;
    let mut profiles = Vec::new();
    let mut next = Some(id.to_owned());
    let mut seen = BTreeSet::new();
    while let Some(id) = next {
        provider::file_name(&id)?;
        if !seen.insert(id.clone()) || seen.len() > 64 {
            return Err("实例继承存在循环或超过深度限制".into());
        }
        let instance = versions.child(&id)?;
        let mut file = instance.regular(&format!("{id}.json"))?;
        if file.metadata().map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
            return Err("实例JSON超过安全上限".into());
        }
        let (_, _, fingerprint) = fingerprint(&mut file, cancel)?;
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "实例JSON损坏")?;
        if !value.is_object() || value["id"].as_str() != Some(id.as_str()) {
            return Err("实例JSON标识与目录不符".into());
        }
        next = match value.get("inheritsFrom") {
            Some(v) => Some(v.as_str().ok_or("实例继承标识无效")?.into()),
            None => None,
        };
        profiles.push(Profile {
            id,
            directory: instance.key()?,
            fingerprint,
        });
    }
    Ok(profiles)
}
pub(super) fn capture(
    root: &Path,
    project: &Path,
    root_id: &str,
    id: &str,
    cancel: &AtomicBool,
) -> Result<TargetSnapshot> {
    cancelled(cancel)?;
    provider::file_name(id)?;
    if root_id.is_empty()
        || root_id.len() > 128
        || !root_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("游戏目录标识无效".into());
    }
    let root_path = root.canonicalize().map_err(|e| e.to_string())?;
    let project = project.canonicalize().map_err(|e| e.to_string())?;
    let root = Dir::open(&root_path)?;
    let project_dir = Dir::open(&project)?;
    let initial_profiles = profiles(&root, id, cancel)?;
    let instance = pcl_core::scan_instances(&root_path)?
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("未找到所选实例")?;
    if profiles(&root, id, cancel)? != initial_profiles {
        return Err("实例JSON在读取期间变化，请重新检查".into());
    }
    let loader = match instance.loader.split_whitespace().next().unwrap_or("") {
        "Fabric" => "fabric",
        "Quilt" => "quilt",
        "Forge" => "forge",
        "NeoForge" => "neoforge",
        "Vanilla" => "minecraft",
        _ => return Err("所选实例加载器暂不支持资源兼容性检查".into()),
    }
    .to_owned();
    let base = if instance.isolated {
        root.child("versions")?.child(id)?
    } else {
        Dir::open(&root_path)?
    };
    let mut local_files = Vec::new();
    let mut views = BTreeMap::new();
    let mut bytes = 0u64;
    for kind in KINDS {
        let dir = base.optional(kind)?;
        let mut view = ResourceView {
            directory: dir.as_ref().map(|d| d.key()).transpose()?,
            others: BTreeMap::new(),
        };
        if let Some(dir) = dir {
            for name in dir.names()? {
                cancelled(cancel)?;
                // Resource transaction stages are protected by writer admission and
                // are checked by that service's recovery guard, not user inventory.
                if name.starts_with(".pcl-resource-stage-") {
                    continue;
                }
                let stat = dir.stat(&name)?.ok_or("资源目录在读取期间变化")?;
                let eligible = if kind == "mods" {
                    name.ends_with(".jar") || name.ends_with(".jar.disabled")
                } else {
                    name.ends_with(".zip")
                };
                if eligible && stat.st_mode & libc::S_IFMT == libc::S_IFREG {
                    if local_files.len() >= MAX_LOCAL_FILES {
                        return Err("本地资源文件超过512项，请先减少文件后下载".into());
                    }
                    let mut file = dir.regular(&name)?;
                    let (size, sha512, fingerprint) = fingerprint(&mut file, cancel)?;
                    bytes = bytes.checked_add(size).ok_or("本地资源总大小过大")?;
                    if bytes > 16 * 1024 * 1024 * 1024 {
                        return Err("本地资源总大小超过兼容性检查上限".into());
                    }
                    let linked = dir.regular(&name)?.metadata().map_err(|e| e.to_string())?;
                    if Key::of(&linked) != Key::of(&file.metadata().map_err(|e| e.to_string())?) {
                        return Err("本地资源文件路径已被替换".into());
                    }
                    local_files.push(LocalFile {
                        kind: kind.into(),
                        file_name: name.clone(),
                        size,
                        sha512,
                        enabled: !name.ends_with(".disabled"),
                        fingerprint,
                    });
                } else {
                    view.others
                        .insert(name, (stat.st_dev, stat.st_ino, stat.st_mode));
                }
            }
        }
        views.insert(kind.into(), view);
    }
    let compatibility = Compatibility {
        minecraft_version: instance.minecraft_version.clone(),
        loader: loader.clone(),
        shader_engines: vec![],
    };
    let target = TargetSnapshot {
        root_id: root_id.into(),
        instance_id: id.into(),
        minecraft_version: instance.minecraft_version,
        loader,
        root: root_path,
        project,
        root_key: root.key()?,
        project_key: project_dir.key()?,
        compatibility,
        local_files,
        profiles: initial_profiles,
        isolated: instance.isolated,
        views,
    };
    if Dir::open(&target.root)?.key() != Ok(target.root_key.clone())
        || Dir::open(&target.project)?.key() != Ok(target.project_key.clone())
    {
        return Err("资源目标目录在检查期间被替换".into());
    }
    Ok(target)
}
pub(super) fn check(expected: &TargetSnapshot, cancel: &AtomicBool) -> Result<()> {
    let current = capture(
        &expected.root,
        &expected.project,
        &expected.root_id,
        &expected.instance_id,
        cancel,
    )?;
    let views_match = expected.views.iter().all(|(kind, old)| {
        current
            .views
            .get(kind)
            .is_some_and(|new| old.others == new.others && old.directory == new.directory)
    });
    if expected.root_key != current.root_key
        || expected.project_key != current.project_key
        || expected.compatibility != current.compatibility
        || expected.profiles != current.profiles
        || expected.isolated != current.isolated
        || expected.local_files != current.local_files
        || !views_match
    {
        return Err("目标实例、资源目录或已装文件已变化，请重新检查后下载".into());
    }
    Ok(())
}
pub(super) fn existing_name(target: &TargetSnapshot, kind: &str, name: &str) -> bool {
    target
        .local_files
        .iter()
        .any(|f| f.kind == kind && f.file_name == name)
        || target
            .views
            .get(kind)
            .is_some_and(|v| v.others.contains_key(name))
}
