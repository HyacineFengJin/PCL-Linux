//! Asset files are opened relative to pinned directory FDs. Source snapshots
//! own their FD until the caller finishes reading; publication never overwrites.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
};

pub(super) const MAX_ENTRIES: usize = 256;
pub(super) fn component(name: &str) -> Result<(), String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 255
        || name.contains(['/', '\\', '\0'])
        || name.chars().any(char::is_control)
    {
        Err("媒体文件名无效".into())
    } else {
        Ok(())
    }
}
fn cstring(name: &str) -> Result<CString, String> {
    component(name)?;
    CString::new(name).map_err(|_| "媒体文件名无效".into())
}
fn error(context: &str) -> String {
    format!("{context}：{}", std::io::Error::last_os_error())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Stamp {
    pub device: u64,
    pub inode: u64,
    mode: u32,
    owner: u32,
    links: u64,
    pub bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Stamp {
    pub fn of(m: &Metadata) -> Self {
        Self {
            device: m.dev(),
            inode: m.ino(),
            mode: m.mode(),
            owner: m.uid(),
            links: m.nlink(),
            bytes: m.len(),
            modified: (m.mtime(), m.mtime_nsec()),
            changed: (m.ctime(), m.ctime_nsec()),
        }
    }
    fn safe(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFREG
            && self.owner == unsafe { libc::geteuid() }
            && self.links == 1
    }
}

pub(super) struct Dir(pub File);
impl Dir {
    pub fn absolute(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("媒体路径必须是绝对路径".into());
        }
        let fd = unsafe {
            libc::open(
                c"/".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(error("无法打开根目录"));
        }
        let mut dir = Self(unsafe { File::from_raw_fd(fd) });
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    dir = dir.child(name.to_str().ok_or("媒体路径必须是 UTF-8")?)?
                }
                _ => return Err("媒体路径不能包含相对路径跳转".into()),
            }
        }
        Ok(dir)
    }
    pub fn optional(&self, name: &str) -> Result<Option<Self>, String> {
        let c = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd >= 0 {
            return Ok(Some(Self(unsafe { File::from_raw_fd(fd) })));
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error("无法打开媒体目录（不允许符号链接）"))
        }
    }
    pub fn child(&self, name: &str) -> Result<Self, String> {
        self.optional(name)?
            .ok_or_else(|| format!("媒体目录不存在：{name}"))
    }
    pub fn create(&self, name: &str) -> Result<Self, String> {
        let c = cstring(name)?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), c.as_ptr(), 0o700) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(error("无法创建媒体目录"));
        }
        let dir = self.child(name)?;
        if dir.0.metadata().map_err(|e| e.to_string())?.uid() != unsafe { libc::geteuid() } {
            return Err("媒体目录不属于当前用户".into());
        }
        self.sync()?;
        Ok(dir)
    }
    pub fn identity(&self) -> Result<(u64, u64), String> {
        self.0
            .metadata()
            .map(|m| (m.dev(), m.ino()))
            .map_err(|e| e.to_string())
    }
    pub fn file(&self, name: &str) -> Result<Option<File>, String> {
        let c = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(error("无法读取媒体（不允许符号链接）"))
            };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !Stamp::of(&file.metadata().map_err(|e| e.to_string())?).safe() {
            return Err("只允许当前用户独占的普通媒体文件".into());
        }
        Ok(Some(file))
    }
    pub fn names(&self) -> Result<Vec<String>, String> {
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(error("无法扫描媒体目录"));
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(error("无法扫描媒体目录"));
        }
        struct Stream(*mut libc::DIR);
        impl Drop for Stream {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let stream = Stream(stream);
        let mut names = Vec::new();
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let item = unsafe { libc::readdir(stream.0) };
            if item.is_null() {
                if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(error("媒体目录扫描失败"));
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }.to_bytes();
            if matches!(bytes, b"." | b"..") {
                continue;
            }
            names.push(
                std::str::from_utf8(bytes)
                    .map_err(|_| "媒体文件名必须是 UTF-8")?
                    .to_owned(),
            );
            if names.len() > MAX_ENTRIES {
                return Err("媒体目录最多允许 256 个文件".into());
            }
        }
        names.sort();
        Ok(names)
    }
    pub fn sync(&self) -> Result<(), String> {
        self.0
            .sync_all()
            .map_err(|e| format!("媒体目录保存失败：{e}"))
    }
    pub fn write_new(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let c = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDWR | libc::O_TMPFILE | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(error("目标文件系统不支持匿名媒体暂存"));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if unsafe {
            libc::linkat(
                file.as_raw_fd(),
                c"".as_ptr(),
                self.0.as_raw_fd(),
                c.as_ptr(),
                libc::AT_EMPTY_PATH,
            )
        } != 0
        {
            return Err(error("无法发布媒体（目标文件必须不存在）"));
        }
        self.sync()
            .map_err(|e| format!("媒体已保存，但目录同步失败，请保留该文件：{e}"))
    }
}

pub(super) struct Snapshot {
    pub file: File,
    pub stamp: Stamp,
    pub digest: String,
    pub header: Vec<u8>,
}
impl Snapshot {
    pub fn open(dir: &Dir, name: &str, max: u64) -> Result<Self, String> {
        let mut file = dir.file(name)?.ok_or("媒体文件不存在")?;
        let stamp = Stamp::of(&file.metadata().map_err(|e| e.to_string())?);
        if stamp.bytes == 0 || stamp.bytes > max {
            return Err("媒体文件为空或超过大小上限".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut count = 0u64;
        let mut header = Vec::new();
        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            count = count.checked_add(read as u64).ok_or("媒体文件过大")?;
            if count > max {
                return Err("媒体读取期间超过大小上限".into());
            }
            hash.update(&buffer[..read]);
            let keep = read.min((128 * 1024usize).saturating_sub(header.len()));
            header.extend_from_slice(&buffer[..keep]);
        }
        let snapshot = Self {
            file,
            stamp,
            digest: format!("{:x}", hash.finalize()),
            header,
        };
        if count != snapshot.stamp.bytes {
            return Err("媒体读取期间发生变化".into());
        }
        snapshot.recheck(dir, name)?;
        Ok(snapshot)
    }
    pub fn recheck(&self, dir: &Dir, name: &str) -> Result<(), String> {
        check_file(&self.file, &self.stamp, dir, name)
    }
    pub fn bytes(&mut self, dir: &Dir, name: &str) -> Result<Vec<u8>, String> {
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(self.stamp.bytes as usize);
        (&mut self.file)
            .take(self.stamp.bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        self.recheck(dir, name)?;
        if bytes.len() as u64 != self.stamp.bytes {
            return Err("媒体读取期间发生变化".into());
        }
        Ok(bytes)
    }
}
pub(super) fn check_file(file: &File, stamp: &Stamp, dir: &Dir, name: &str) -> Result<(), String> {
    let current = dir.file(name)?.ok_or("媒体文件已消失")?;
    if Stamp::of(&file.metadata().map_err(|e| e.to_string())?) != *stamp
        || Stamp::of(&current.metadata().map_err(|e| e.to_string())?) != *stamp
    {
        Err("媒体文件已变化，请刷新媒体列表".into())
    } else {
        Ok(())
    }
}
pub(super) fn source(path: &Path, max: u64) -> Result<(Dir, String, Snapshot), String> {
    let parent = Dir::absolute(path.parent().ok_or("文件路径无效")?)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("文件名必须是 UTF-8")?
        .to_owned();
    component(&name)?;
    let snapshot = Snapshot::open(&parent, &name, max)?;
    Ok((parent, name, snapshot))
}
pub(super) fn revision(path: &Path, snapshot: &Snapshot) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(path, &snapshot.stamp, &snapshot.digest))
                .map_err(|e| e.to_string())?
        )
    ))
}
pub(super) struct Scope {
    pub path: PathBuf,
    pub root: Dir,
    pub owner: Option<Dir>,
    pub folder: Option<Dir>,
    pub folder_name: &'static str,
}
impl Scope {
    pub fn open(project: &Path, folder_name: &'static str) -> Result<Self, String> {
        let root = Dir::absolute(project)?;
        let owner = root.optional(".pcl-rust")?;
        let folder = owner
            .as_ref()
            .map(|d| d.optional(folder_name))
            .transpose()?
            .flatten();
        Ok(Self {
            path: project.to_owned(),
            root,
            owner,
            folder,
            folder_name,
        })
    }
    pub fn path(&self) -> PathBuf {
        self.path.join(".pcl-rust").join(self.folder_name)
    }
    pub fn recheck(&self) -> Result<(), String> {
        let fresh = Self::open(&self.path, self.folder_name)?;
        if fresh.root.identity()? != self.root.identity()?
            || fresh.owner.as_ref().map(Dir::identity).transpose()?
                != self.owner.as_ref().map(Dir::identity).transpose()?
            || fresh.folder.as_ref().map(Dir::identity).transpose()?
                != self.folder.as_ref().map(Dir::identity).transpose()?
        {
            Err("媒体目录发生变化，请重新读取".into())
        } else {
            Ok(())
        }
    }
    pub fn create(project: &Path, folder_name: &'static str) -> Result<Self, String> {
        let root = Dir::absolute(project)?;
        let owner = root.create(".pcl-rust")?;
        let folder = owner.create(folder_name)?;
        let scope = Self {
            path: project.to_owned(),
            root,
            owner: Some(owner),
            folder: Some(folder),
            folder_name,
        };
        scope.recheck()?;
        Ok(scope)
    }
}
