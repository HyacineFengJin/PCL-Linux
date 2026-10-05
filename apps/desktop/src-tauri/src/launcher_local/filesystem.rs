//! Bounded FD-relative persistence for local statistics, diagnostics and entries.
//! Cooperative writers use separate flock names; optimistic snapshots catch
//! other editors, and changed publication bytes are retained for inspection.
use serde::{Deserialize, Serialize};
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

pub(crate) const MAX_ENTRIES: usize = 4096;
pub(crate) fn component(name: &str) -> Result<(), String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 255
        || name.contains(['/', '\0'])
        || name.chars().any(char::is_control)
    {
        Err("启动器本地文件文件名无效".into())
    } else {
        Ok(())
    }
}
fn cstring(name: &str) -> Result<CString, String> {
    component(name)?;
    CString::new(name).map_err(|_| "启动器本地文件文件名无效".into())
}
fn error(context: &str) -> String {
    format!("{context}：{}", std::io::Error::last_os_error())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Stamp {
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
    pub fn moved_matches(&self, other: &Self) -> bool {
        self.device == other.device
            && self.inode == other.inode
            && self.mode == other.mode
            && self.owner == other.owner
            && self.links == other.links
            && self.bytes == other.bytes
            && self.modified == other.modified
    }
}

pub(crate) struct Dir(pub File);
impl Dir {
    pub fn create_absolute(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("本地入口目录必须是绝对路径".into());
        }
        let mut dir = Self::absolute(Path::new("/"))?;
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = name.to_str().ok_or("本地入口目录必须是 UTF-8")?;
                    dir = match dir.optional(name)? {
                        Some(dir) => dir,
                        None => dir.create(name)?,
                    };
                }
                _ => return Err("本地入口目录不能含有相对路径跳转".into()),
            }
        }
        Ok(dir)
    }
    pub fn absolute(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("启动器本地文件路径必须是绝对路径".into());
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
                    dir = dir.child(name.to_str().ok_or("启动器本地文件路径必须是 UTF-8")?)?
                }
                _ => return Err("启动器本地文件路径不能包含相对路径跳转".into()),
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
            Err(error("无法打开启动器本地文件目录（不允许符号链接）"))
        }
    }
    pub fn child(&self, name: &str) -> Result<Self, String> {
        self.optional(name)?
            .ok_or_else(|| format!("启动器本地文件目录不存在：{name}"))
    }
    pub fn create(&self, name: &str) -> Result<Self, String> {
        let c = cstring(name)?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), c.as_ptr(), 0o700) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(error("无法创建启动器本地文件目录"));
        }
        let dir = self.child(name)?;
        if dir.0.metadata().map_err(|e| e.to_string())?.uid() != unsafe { libc::geteuid() } {
            return Err("启动器本地文件目录不属于当前用户".into());
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
    pub fn require_private(&self) -> Result<(), String> {
        let metadata = self.0.metadata().map_err(|_| "无法读取本地服务目录权限")?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            Err("本地服务目录必须由当前用户独占，已保留目录权限".into())
        } else {
            Ok(())
        }
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
                Err(error("无法读取启动器本地文件（不允许符号链接）"))
            };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !Stamp::of(&file.metadata().map_err(|e| e.to_string())?).safe() {
            return Err("只允许当前用户独占的普通启动器本地文件文件".into());
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
            return Err(error("无法扫描启动器本地文件目录"));
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(error("无法扫描启动器本地文件目录"));
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
                    return Err(error("启动器本地文件目录扫描失败"));
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }.to_bytes();
            if matches!(bytes, b"." | b"..") {
                continue;
            }
            names.push(
                std::str::from_utf8(bytes)
                    .map_err(|_| "启动器本地文件文件名必须是 UTF-8")?
                    .to_owned(),
            );
            if names.len() > MAX_ENTRIES {
                return Err("启动器本地文件目录最多允许 4096 个文件".into());
            }
        }
        names.sort();
        Ok(names)
    }
    pub fn sync(&self) -> Result<(), String> {
        self.0
            .sync_all()
            .map_err(|e| format!("启动器本地文件目录保存失败：{e}"))
    }
    pub fn lock(&self, name: &str) -> Result<WriteLock, String> {
        let c = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                c.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(error("无法打开本地服务锁"));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !Stamp::of(&file.metadata().map_err(|e| e.to_string())?).safe() {
            return Err("本地服务锁不是当前用户独占的普通文件".into());
        }
        if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("另一个本地服务写入任务正在运行".into());
        }
        Ok(WriteLock(file))
    }
    pub fn move_new(&self, name: &str, destination: &Dir) -> Result<(), String> {
        let c = cstring(name)?;
        if unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                self.0.as_raw_fd(),
                c.as_ptr(),
                destination.0.as_raw_fd(),
                c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            return Err(error("无法移动本地入口（目标必须不存在）"));
        }
        self.sync()?;
        destination.sync()
    }
    pub fn replace(
        &self,
        name: &str,
        expected: Option<&Snapshot>,
        bytes: &[u8],
        limit: u64,
    ) -> Result<(), String> {
        self.replace_checked(name, expected, bytes, limit, || {})
    }
    fn replace_checked(
        &self,
        name: &str,
        expected: Option<&Snapshot>,
        bytes: &[u8],
        limit: u64,
        after_exchange: impl FnOnce(),
    ) -> Result<(), String> {
        if bytes.len() as u64 > limit {
            return Err("本地服务文件超过安全上限".into());
        }
        let token = |snapshot: &Snapshot| (snapshot.stamp.clone(), snapshot.digest.clone());
        let fresh = optional_snapshot(self, name, limit)?;
        if fresh.as_ref().map(token) != expected.map(token) {
            return Err("本地服务文件已被外部修改，已保留原文件".into());
        }
        let temp = format!(
            ".local-stage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        self.write_new(&temp, bytes)?;
        let staged = Snapshot::open(self, &temp, limit)?;
        let from = cstring(&temp)?;
        let to = cstring(name)?;
        let flag = if expected.is_some() {
            libc::RENAME_EXCHANGE
        } else {
            libc::RENAME_NOREPLACE
        };
        if unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                self.0.as_raw_fd(),
                from.as_ptr(),
                self.0.as_raw_fd(),
                to.as_ptr(),
                flag,
            )
        } != 0
        {
            self.remove_owned(&temp, &staged, limit)?;
            return Err(error("无法原子保存本地服务文件"));
        }
        after_exchange();
        self.sync()?;
        let published = Snapshot::open(self, name, limit)?;
        if !published.stamp.moved_matches(&staged.stamp) || published.digest != staged.digest {
            // A writer may still hold the newly published inode. Keep the
            // displaced original instead of silently discarding its backup.
            return Err(format!(
                "本地服务保存期间新文件被修改，原暂存副本已保留：{temp}"
            ));
        }
        if let Some(expected) = expected {
            let displaced = Snapshot::open(self, &temp, limit)?;
            if !displaced.stamp.moved_matches(&expected.stamp)
                || displaced.digest != expected.digest
            {
                // Never destroy an editor's displaced bytes. Roll back only if
                // the visible destination is still exactly our new file.
                let published = Snapshot::open(self, name, limit)?;
                if published.stamp.moved_matches(&staged.stamp) && published.digest == staged.digest
                {
                    if unsafe {
                        libc::syscall(
                            libc::SYS_renameat2,
                            self.0.as_raw_fd(),
                            from.as_ptr(),
                            self.0.as_raw_fd(),
                            to.as_ptr(),
                            libc::RENAME_EXCHANGE,
                        )
                    } != 0
                    {
                        return Err(format!("本地服务保存发生冲突，两个文件均已保留：{temp}"));
                    }
                    self.sync()?;
                }
                return Err(format!("本地服务保存发生冲突，暂存文件已保留：{temp}"));
            }
            self.remove_owned(&temp, &displaced, limit)?;
        }
        Ok(())
    }
    fn remove_owned(&self, name: &str, expected: &Snapshot, limit: u64) -> Result<(), String> {
        let current = Snapshot::open(self, name, limit)?;
        if current.stamp != expected.stamp || current.digest != expected.digest {
            return Err("本地服务暂存文件发生变化，已保留".into());
        }
        let name = cstring(name)?;
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(error("无法清理已验证的本地服务暂存文件"));
        }
        self.sync()
    }
    pub fn write_new(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.write_new_mode(name, bytes, 0o600)
    }
    pub fn write_new_mode(&self, name: &str, bytes: &[u8], mode: u32) -> Result<(), String> {
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
            return Err(error("目标文件系统不支持匿名启动器本地文件暂存"));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes).map_err(|e| e.to_string())?;
        if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
            return Err(error("无法设置本地入口文件权限"));
        }
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
            return Err(error("无法发布启动器本地文件（目标文件必须不存在）"));
        }
        self.sync()
            .map_err(|e| format!("启动器本地文件已保存，但目录同步失败，请保留该文件：{e}"))
    }
}

pub(crate) struct WriteLock(File);
impl Drop for WriteLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
pub(crate) fn optional_snapshot(
    dir: &Dir,
    name: &str,
    max: u64,
) -> Result<Option<Snapshot>, String> {
    match dir.file(name)? {
        None => Ok(None),
        Some(file) => {
            drop(file);
            Snapshot::open(dir, name, max).map(Some)
        }
    }
}

pub(crate) struct Snapshot {
    pub file: File,
    pub stamp: Stamp,
    pub digest: String,
    pub header: Vec<u8>,
}
impl Snapshot {
    pub fn open(dir: &Dir, name: &str, max: u64) -> Result<Self, String> {
        let mut file = dir.file(name)?.ok_or("启动器本地文件文件不存在")?;
        let stamp = Stamp::of(&file.metadata().map_err(|e| e.to_string())?);
        if stamp.bytes == 0 || stamp.bytes > max {
            return Err("启动器本地文件文件为空或超过大小上限".into());
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
            count = count
                .checked_add(read as u64)
                .ok_or("启动器本地文件文件过大")?;
            if count > max {
                return Err("启动器本地文件读取期间超过大小上限".into());
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
            return Err("启动器本地文件读取期间发生变化".into());
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
            return Err("启动器本地文件读取期间发生变化".into());
        }
        Ok(bytes)
    }
}
pub(crate) fn check_file(file: &File, stamp: &Stamp, dir: &Dir, name: &str) -> Result<(), String> {
    let current = dir.file(name)?.ok_or("启动器本地文件文件已消失")?;
    if Stamp::of(&file.metadata().map_err(|e| e.to_string())?) != *stamp
        || Stamp::of(&current.metadata().map_err(|e| e.to_string())?) != *stamp
    {
        Err("启动器本地文件文件已变化，请刷新启动器本地文件列表".into())
    } else {
        Ok(())
    }
}
pub(crate) fn revision(path: &Path, snapshot: &Snapshot) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(path, &snapshot.stamp, &snapshot.digest))
                .map_err(|e| e.to_string())?
        )
    ))
}
pub(crate) struct Scope {
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
        if let Some(folder) = &folder {
            folder.require_private()?;
        }
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
            Err("启动器本地文件目录发生变化，请重新读取".into())
        } else {
            Ok(())
        }
    }
    pub fn create(project: &Path, folder_name: &'static str) -> Result<Self, String> {
        let root = Dir::absolute(project)?;
        let owner = root.create(".pcl-rust")?;
        let folder = owner.create(folder_name)?;
        folder.require_private()?;
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

#[cfg(test)]
pub(crate) fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find(|path| {
            path.join("crates/core/Cargo.toml").is_file()
                && path.join("apps/desktop/src-tauri/Cargo.toml").is_file()
        })
        .expect("test workspace root")
        .join("work/launcher-service-fixtures")
        .join(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = fixture_path(&format!(
                "local-fs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn exchange_retains_live_edits_to_displaced_original_and_rolls_back() {
        let f = Fixture::new();
        let dir = Dir::absolute(&f.0).unwrap();
        dir.write_new("value.json", b"original").unwrap();
        let expected = Snapshot::open(&dir, "value.json", 1024).unwrap();
        let mut editor = std::fs::OpenOptions::new()
            .write(true)
            .open(f.0.join("value.json"))
            .unwrap();
        let result = dir.replace_checked("value.json", Some(&expected), b"published", 1024, || {
            editor.set_len(0).unwrap();
            editor.write_all(b"editor-owned change").unwrap();
            editor.sync_all().unwrap();
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(f.0.join("value.json")).unwrap(),
            b"editor-owned change"
        );
        let temp = dir
            .names()
            .unwrap()
            .into_iter()
            .find(|name| name.starts_with(".local-stage-"))
            .unwrap();
        assert_eq!(std::fs::read(f.0.join(temp)).unwrap(), b"published");
    }
    #[test]
    fn exchange_retains_original_when_new_publication_is_edited() {
        let f = Fixture::new();
        let dir = Dir::absolute(&f.0).unwrap();
        dir.write_new("value.json", b"original").unwrap();
        let expected = Snapshot::open(&dir, "value.json", 1024).unwrap();
        let result = dir.replace_checked("value.json", Some(&expected), b"published", 1024, || {
            std::fs::write(f.0.join("value.json"), b"keep published edit").unwrap();
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(f.0.join("value.json")).unwrap(),
            b"keep published edit"
        );
        let temp = dir
            .names()
            .unwrap()
            .into_iter()
            .find(|name| name.starts_with(".local-stage-"))
            .unwrap();
        assert_eq!(std::fs::read(f.0.join(temp)).unwrap(), b"original");
    }
    #[test]
    fn local_lock_unlocks_explicitly_even_with_an_open_duplicate() {
        let f = Fixture::new();
        let dir = Dir::absolute(&f.0).unwrap();
        let guard = dir.lock(".lock").unwrap();
        let duplicate = guard.0.try_clone().unwrap();
        assert!(dir.lock(".lock").is_err());
        drop(guard);
        let _fresh = dir.lock(".lock").unwrap();
        drop(duplicate);
    }
}
