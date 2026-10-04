//! FD-relative filesystem boundary for local instance imports.
//! Absolute ancestors are pinned without following symlinks. Inside a captured
//! root, openat2 also rejects mounts; all create/link/cleanup stays relative to
//! these FDs. Timestamps bind external inputs; owned hard links compare inode
//! and bytes because publication changes their ctime.
use super::{check, component, cstring, error, os_error, relative, Result, MAX_BYTES, MAX_FILES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
    sync::atomic::AtomicBool,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Key {
    pub(super) dev: u64,
    pub(super) ino: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Stamp {
    pub(super) key: Key,
    pub(super) mode: u32,
    pub(super) size: u64,
    pub(super) mtime: (i64, i64),
    pub(super) ctime: (i64, i64),
}
impl Stamp {
    pub(super) fn of(m: &Metadata) -> Self {
        Self {
            key: Key {
                dev: m.dev(),
                ino: m.ino(),
            },
            mode: m.mode(),
            size: m.len(),
            mtime: (m.mtime(), m.mtime_nsec()),
            ctime: (m.ctime(), m.ctime_nsec()),
        }
    }
    pub(super) fn stat(s: &libc::stat) -> Self {
        Self {
            key: Key {
                dev: s.st_dev,
                ino: s.st_ino,
            },
            mode: s.st_mode,
            size: s.st_size.max(0) as u64,
            mtime: (s.st_mtime, s.st_mtime_nsec),
            ctime: (s.st_ctime, s.st_ctime_nsec),
        }
    }
    pub(super) fn directory(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFDIR
    }
    pub(super) fn regular(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFREG
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
    pub(super) stamp: Stamp,
    pub(super) hash: String,
}
impl Snapshot {
    // Hard-link publication changes ctime. Identity and full content remain
    // mandatory for rollback; timestamps remain mandatory for external inputs.
    pub(super) fn owned_matches(&self, other: &Self) -> bool {
        self.stamp.key == other.stamp.key
            && self.stamp.size == other.stamp.size
            && self.stamp.mode == other.stamp.mode
            && self.hash == other.hash
    }
}
pub(super) struct Dir(pub(super) File);
impl Dir {
    pub(super) fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err("导入源和游戏目录必须是绝对路径".into());
        }
        let slash = cstring("/")?;
        let fd = unsafe {
            libc::open(
                slash.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(os_error("无法打开导入目录"));
        }
        let mut dir = Self(unsafe { File::from_raw_fd(fd) });
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    // Absolute ancestors may cross a legitimate mounted root. All
                    // descendants of the captured root use openat2 NO_XDEV below.
                    let name = CString::new(name.as_bytes()).map_err(error)?;
                    let fd = unsafe {
                        libc::openat(
                            dir.0.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                        )
                    };
                    if fd < 0 {
                        return Err(os_error("目录祖先已变化或包含符号链接"));
                    }
                    dir = Self(unsafe { File::from_raw_fd(fd) });
                }
                _ => return Err("目录路径不能包含相对路径跳转".into()),
            }
        }
        Ok(dir)
    }
    pub(super) fn duplicate(&self) -> Result<Self> {
        self.0.try_clone().map(Self).map_err(error)
    }
    pub(super) fn key(&self) -> Result<Key> {
        Ok(Stamp::of(&self.0.metadata().map_err(error)?).key)
    }
    pub(super) fn sync(&self) -> Result<()> {
        self.0.sync_all().map_err(error)
    }
    pub(super) fn open_at(&self, name: &str, directory: bool) -> Result<File> {
        component(name)?;
        let name = cstring(name)?;
        #[repr(C)]
        struct OpenHow {
            flags: u64,
            mode: u64,
            resolve: u64,
        }
        let how = OpenHow {
            flags: (libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if directory {
                    libc::O_DIRECTORY
                } else {
                    libc::O_NONBLOCK
                }) as u64,
            mode: 0,
            resolve: 0x01 | 0x02 | 0x04 | 0x08,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                self.0.as_raw_fd(),
                name.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            ) as i32
        };
        if fd < 0 {
            return Err(os_error(
                "路径不存在、包含链接或跨挂载点（需要 Linux 5.6 以上）",
            ));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !directory && !file.metadata().map_err(error)?.is_file() {
            return Err("导入只允许普通文件与目录".into());
        }
        Ok(file)
    }
    pub(super) fn child(&self, name: &str) -> Result<Self> {
        self.open_at(name, true).map(Self)
    }
    pub(super) fn regular(&self, name: &str) -> Result<File> {
        self.open_at(name, false)
    }
    pub(super) fn stat(&self, name: &str) -> Result<Option<Stamp>> {
        component(name)?;
        let name = cstring(name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            Ok(Some(Stamp::stat(&unsafe { stat.assume_init() })))
        } else {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(error(e))
            }
        }
    }
    pub(super) fn parent(&self, path: &str) -> Result<(Self, String)> {
        let parts = relative(path)?;
        let mut dir = self.duplicate()?;
        for part in &parts[..parts.len() - 1] {
            dir = dir.child(part)?;
        }
        Ok((dir, parts[parts.len() - 1].into()))
    }
    pub(super) fn optional_parent(&self, path: &str) -> Result<Option<(Self, String)>> {
        let parts = relative(path)?;
        let mut dir = self.duplicate()?;
        for part in &parts[..parts.len() - 1] {
            if dir.stat(part)?.is_none() {
                return Ok(None);
            }
            dir = dir.child(part)?;
        }
        Ok(Some((dir, parts[parts.len() - 1].into())))
    }
    pub(super) fn at(&self, path: &str) -> Result<Self> {
        let mut dir = self.duplicate()?;
        for part in relative(path)? {
            dir = dir.child(part)?;
        }
        Ok(dir)
    }
    pub(super) fn file(&self, path: &str) -> Result<File> {
        let (dir, name) = self.parent(path)?;
        dir.regular(&name)
    }
    pub(super) fn mkdir(&self, name: &str) -> Result<Self> {
        component(name)?;
        let n = cstring(name)?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), n.as_ptr(), 0o700) } != 0 {
            return Err(os_error("无法创建导入目录"));
        }
        self.sync()?;
        self.child(name)
    }
    pub(super) fn optional(&self, name: &str) -> Result<Option<Self>> {
        if self.stat(name)?.is_some() {
            self.child(name).map(Some)
        } else {
            Ok(None)
        }
    }
    pub(super) fn ensure(&self, name: &str) -> Result<Self> {
        match self.optional(name)? {
            Some(d) => Ok(d),
            None => self.mkdir(name),
        }
    }
    pub(super) fn anonymous(&self) -> Result<File> {
        let dot = cstring(".")?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDWR | libc::O_TMPFILE | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(os_error("文件系统不支持安全匿名导入暂存文件"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(super) fn create(&self, name: &str) -> Result<File> {
        component(name)?;
        let name = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(os_error("无法创建导入锁文件"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(super) fn unlink(&self, name: &str, directory: bool) -> Result<()> {
        component(name)?;
        let name = cstring(name)?;
        if unsafe {
            libc::unlinkat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(os_error("无法清理导入文件"));
        }
        self.sync()
    }
    pub(super) fn names(&self) -> Result<Vec<String>> {
        let dot = cstring(".")?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(os_error("无法读取导入目录"));
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe { libc::close(fd) };
            return Err(os_error("无法读取导入目录"));
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
            unsafe { *libc::__errno_location() = 0 };
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(os_error("读取导入目录失败"));
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = std::str::from_utf8(bytes)
                .map_err(|_| "目录包含无效 UTF-8 文件名")?
                .to_owned();
            component(&name)?;
            names.push(name);
            if names.len() > MAX_FILES * 4 {
                return Err("导入目录节点数量过多".into());
            }
        }
        names.sort();
        Ok(names)
    }
}

pub(super) fn hash_file(
    mut file: File,
    limit: u64,
    cancel: Option<&AtomicBool>,
) -> Result<Snapshot> {
    let before = Stamp::of(&file.metadata().map_err(error)?);
    if !before.regular() || before.size > limit {
        return Err("导入文件类型无效或超过大小限制".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if let Some(c) = cancel {
            check(c)?;
        }
        let n = file.read(&mut buffer).map_err(error)?;
        if n == 0 {
            break;
        }
        size = size
            .checked_add(n as u64)
            .filter(|s| *s <= limit)
            .ok_or("导入文件超过大小限制")?;
        hash.update(&buffer[..n]);
    }
    if size != before.size || Stamp::of(&file.metadata().map_err(error)?) != before {
        return Err(super::changed());
    }
    Ok(Snapshot {
        stamp: before,
        hash: format!("{:x}", hash.finalize()),
    })
}
pub(super) fn open_source(path: &Path) -> Result<File> {
    let parent = path.parent().ok_or("导入源路径无效")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("导入源文件名必须是 UTF-8")?;
    Dir::open(parent)?.regular(name)
}
pub(super) fn source_snapshot(path: &Path, cancel: Option<&AtomicBool>) -> Result<Snapshot> {
    hash_file(open_source(path)?, MAX_BYTES, cancel)
}
