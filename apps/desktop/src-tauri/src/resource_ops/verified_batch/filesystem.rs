//! Linux FD boundary for verified batches. Download inputs stay anonymous;
//! destination copies become named only after their inode/hash is durable.
//! NO_XDEV rejects bind mounts as well as another filesystem inside the root.
use super::{check, error, Result, MAX_FILES, MAX_FILE_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
    sync::atomic::AtomicBool,
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::resource_ops) struct Key {
    pub(in crate::resource_ops) dev: u64,
    pub(in crate::resource_ops) ino: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::resource_ops) struct Owned {
    pub(in crate::resource_ops) key: Key,
    pub(in crate::resource_ops) size: u64,
    pub(in crate::resource_ops) sha512: String,
    pub(in crate::resource_ops) mode: u32,
}
pub(in crate::resource_ops) struct Dir(File);
fn c(name: &str) -> Result<CString> {
    super::super::safe_name(name)?;
    CString::new(name).map_err(error)
}
fn io(context: &str) -> String {
    format!("{context}：{}", std::io::Error::last_os_error())
}
pub(in crate::resource_ops) fn key_file(file: &File) -> Result<Key> {
    let m = file.metadata().map_err(error)?;
    Ok(Key {
        dev: m.dev(),
        ino: m.ino(),
    })
}
pub(in crate::resource_ops) fn anonymous_source(file: &File) -> Result<()> {
    let m = file.metadata().map_err(error)?;
    if !m.is_file() || m.nlink() != 0 {
        return Err("资源下载来源必须是匿名普通文件描述符".into());
    }
    Ok(())
}
impl Dir {
    pub(in crate::resource_ops) fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err("游戏目录必须是绝对路径".into());
        }
        let slash = CString::new("/").map_err(error)?;
        let fd = unsafe {
            libc::open(
                slash.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(io("无法打开资源批次目录"));
        }
        let mut dir = Self(unsafe { File::from_raw_fd(fd) });
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(part) => {
                    let name = CString::new(part.as_bytes()).map_err(error)?;
                    // Root ancestors may themselves be legitimate mount points.
                    let fd = unsafe {
                        libc::openat(
                            dir.0.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                        )
                    };
                    if fd < 0 {
                        return Err(io("游戏目录祖先包含链接或已经变化"));
                    }
                    dir = Self(unsafe { File::from_raw_fd(fd) });
                }
                _ => return Err("游戏目录不能包含相对路径跳转".into()),
            }
        }
        Ok(dir)
    }
    pub(in crate::resource_ops) fn key(&self) -> Result<Key> {
        key_file(&self.0)
    }
    fn duplicate(&self) -> Result<Self> {
        self.0.try_clone().map(Self).map_err(error)
    }
    pub(in crate::resource_ops) fn sync(&self) -> Result<()> {
        self.0.sync_all().map_err(error)
    }
    fn open_at(&self, name: &str, directory: bool) -> Result<File> {
        #[repr(C)]
        struct OpenHow {
            flags: u64,
            mode: u64,
            resolve: u64,
        }
        let name = c(name)?;
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
            return Err(io(
                "资源路径不存在、包含链接或跨挂载点（需要 Linux 5.6 以上）",
            ));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !directory && !file.metadata().map_err(error)?.is_file() {
            return Err("资源文件不是普通文件".into());
        }
        Ok(file)
    }
    pub(in crate::resource_ops) fn child(&self, name: &str) -> Result<Self> {
        self.open_at(name, true).map(Self)
    }
    pub(in crate::resource_ops) fn regular(&self, name: &str) -> Result<File> {
        self.open_at(name, false)
    }
    pub(in crate::resource_ops) fn stat(&self, name: &str) -> Result<Option<libc::stat>> {
        let name = c(name)?;
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
            return Ok(Some(unsafe { stat.assume_init() }));
        }
        let e = std::io::Error::last_os_error();
        if e.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error(e))
        }
    }
    pub(in crate::resource_ops) fn optional(&self, name: &str) -> Result<Option<Self>> {
        if self.stat(name)?.is_some() {
            self.child(name).map(Some)
        } else {
            Ok(None)
        }
    }
    pub(in crate::resource_ops) fn optional_at(&self, path: &str) -> Result<Option<Self>> {
        let mut dir = self.duplicate()?;
        for part in path.split('/') {
            let Some(child) = dir.optional(part)? else {
                return Ok(None);
            };
            dir = child;
        }
        Ok(Some(dir))
    }
    pub(in crate::resource_ops) fn parent(&self, path: &str) -> Result<(Self, String)> {
        let parts: Vec<_> = path.split('/').collect();
        if parts.is_empty() {
            return Err("资源路径无效".into());
        }
        let mut dir = self.duplicate()?;
        for part in &parts[..parts.len() - 1] {
            dir = dir.child(part)?;
        }
        super::super::safe_name(parts[parts.len() - 1])?;
        Ok((dir, parts[parts.len() - 1].into()))
    }
    pub(in crate::resource_ops) fn mkdir(&self, name: &str) -> Result<Self> {
        let name_c = c(name)?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), name_c.as_ptr(), 0o700) } != 0 {
            return Err(io("无法创建资源批次目录"));
        }
        self.sync()?;
        self.child(name)
    }
    pub(in crate::resource_ops) fn ensure(&self, name: &str) -> Result<Self> {
        match self.optional(name)? {
            Some(dir) => Ok(dir),
            None => self.mkdir(name),
        }
    }
    pub(in crate::resource_ops) fn absent(&self, name: &str) -> Result<()> {
        if self.stat(name)?.is_some() {
            Err(format!("已有同名或禁用状态的资源文件，拒绝覆盖：{name}"))
        } else {
            Ok(())
        }
    }
    pub(in crate::resource_ops) fn anonymous(&self) -> Result<File> {
        let dot = CString::new(".").map_err(error)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDWR | libc::O_TMPFILE | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io("文件系统不支持安全匿名资源暂存文件"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub(in crate::resource_ops) fn link_anonymous(&self, file: &File, name: &str) -> Result<()> {
        let empty = CString::new("").map_err(error)?;
        let name = c(name)?;
        if unsafe {
            libc::linkat(
                file.as_raw_fd(),
                empty.as_ptr(),
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::AT_EMPTY_PATH,
            )
        } != 0
        {
            return Err(io("无法发布已登记的匿名资源文件"));
        }
        self.sync()
    }
    pub(in crate::resource_ops) fn link(
        &self,
        name: &str,
        target: &Dir,
        target_name: &str,
    ) -> Result<()> {
        let name = c(name)?;
        let target_name = c(target_name)?;
        if unsafe {
            libc::linkat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                target.0.as_raw_fd(),
                target_name.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(io("目标资源已存在或无法发布"));
        }
        target.sync()
    }
    pub(in crate::resource_ops) fn move_directory(
        &self,
        name: &str,
        target: &Dir,
        target_name: &str,
    ) -> Result<()> {
        let name = c(name)?;
        let target_name = c(target_name)?;
        if unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                self.0.as_raw_fd(),
                name.as_ptr(),
                target.0.as_raw_fd(),
                target_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            return Err(io("目标资源目录已存在或无法发布"));
        }
        target.sync()?;
        self.sync()
    }
    pub(in crate::resource_ops) fn replace_journal(
        &self,
        source: &str,
        target: &str,
    ) -> Result<()> {
        let source = c(source)?;
        let target = c(target)?;
        if unsafe {
            libc::renameat(
                self.0.as_raw_fd(),
                source.as_ptr(),
                self.0.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(io("无法保存资源批次状态"));
        }
        self.sync()
    }
    pub(in crate::resource_ops) fn unlink(&self, name: &str, directory: bool) -> Result<()> {
        let name = c(name)?;
        if unsafe {
            libc::unlinkat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        } != 0
        {
            return Err(io("无法清理资源批次文件"));
        }
        self.sync()
    }
    pub(in crate::resource_ops) fn names(&self) -> Result<Vec<String>> {
        self.names_with_limit(MAX_FILES * 4 + 8)
    }
    pub(in crate::resource_ops) fn names_with_limit(&self, limit: usize) -> Result<Vec<String>> {
        // A fresh open file description avoids dup/readdir sharing seek state.
        let dot = CString::new(".").map_err(error)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io("无法读取资源批次目录"));
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe { libc::close(fd) };
            return Err(io("无法读取资源批次目录"));
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
            let e = unsafe { libc::readdir(stream.0) };
            if e.is_null() {
                if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(io("读取资源批次目录失败"));
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*e).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            let name = std::str::from_utf8(name)
                .map_err(|_| "资源批次目录包含无效文件名")?
                .to_owned();
            super::super::safe_name(&name)?;
            names.push(name);
            if names.len() > limit {
                return Err("资源批次目录节点数量过多".into());
            }
        }
        names.sort();
        Ok(names)
    }
}
pub(in crate::resource_ops) fn verify_file(
    file: &mut File,
    expected_key: Option<&Key>,
    size: u64,
    hash: &str,
    cancel: Option<&AtomicBool>,
) -> Result<Owned> {
    let token = super::super::token_for(file)?;
    let m = file.metadata().map_err(error)?;
    let key = Key {
        dev: m.dev(),
        ino: m.ino(),
    };
    if !m.is_file()
        || m.len() != size
        || size > MAX_FILE_BYTES
        || expected_key.is_some_and(|k| *k != key)
    {
        return Err("资源文件大小或 inode 已变化".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut digest = Sha512::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if let Some(c) = cancel {
            check(c)?;
        }
        let n = file.read(&mut buffer).map_err(error)?;
        if n == 0 {
            break;
        }
        count = count
            .checked_add(n as u64)
            .filter(|n| *n <= size)
            .ok_or("资源文件实际大小超过声明")?;
        digest.update(&buffer[..n]);
    }
    let sha512 = format!("{:x}", digest.finalize());
    if count != size || sha512 != hash || super::super::token_for(file)? != token {
        return Err("资源文件 SHA512 校验失败或读取期间已经变化".into());
    }
    Ok(Owned {
        key,
        size,
        sha512,
        mode: m.mode(),
    })
}
pub(in crate::resource_ops) fn verify_named(dir: &Dir, name: &str, owned: &Owned) -> Result<()> {
    let mut file = dir.regular(name)?;
    let before = super::super::token_for(&file)?;
    let now = verify_file(&mut file, Some(&owned.key), owned.size, &owned.sha512, None)?;
    if now.mode != owned.mode || super::super::token_for(&dir.regular(name)?)? != before {
        return Err("待恢复资源文件的路径或权限已经变化".into());
    }
    Ok(())
}
