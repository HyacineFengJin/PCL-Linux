//! Read-only cache reuse for isolated installs. Verified bytes are copied into
//! the destination; processor workspaces can never mutate source-cache inodes.
use super::*;
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::ffi::OsStrExt,
};

pub(crate) struct CacheSource {
    root: fs::File,
}
impl CacheSource {
    pub fn open(path: &Path) -> Result<Self> {
        let path = fs::canonicalize(path).map_err(error)?;
        let slash = std::ffi::CString::new("/").map_err(error)?;
        let fd = unsafe {
            libc::open(
                slash.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(error(std::io::Error::last_os_error()));
        }
        let mut root = unsafe { fs::File::from_raw_fd(fd) };
        for component in path.components() {
            match component {
                std::path::Component::RootDir => continue,
                std::path::Component::Normal(name) => {
                    let name = std::ffi::CString::new(name.as_bytes()).map_err(error)?;
                    let fd = unsafe {
                        libc::openat(
                            root.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                        )
                    };
                    if fd < 0 {
                        return Err(error(std::io::Error::last_os_error()));
                    }
                    root = unsafe { fs::File::from_raw_fd(fd) };
                }
                _ => return Err("缓存目录路径不安全".into()),
            }
        }
        Ok(Self { root })
    }
    fn file(&self, relative: &str) -> Result<Option<fs::File>> {
        if !(relative.starts_with("libraries/") || relative.starts_with("assets/"))
            || relative.contains(['\\', '\0'])
        {
            return Ok(None);
        }
        let parts: Vec<_> = Path::new(relative).components().collect();
        if parts.len() > 64
            || parts.len() < 2
            || parts
                .iter()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Ok(None);
        }
        let mut dir = self.root.try_clone().map_err(error)?;
        for (i, part) in parts.iter().enumerate() {
            let name = std::ffi::CString::new(part.as_os_str().as_bytes()).map_err(error)?;
            let last = i + 1 == parts.len();
            let fd = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY
                        | libc::O_CLOEXEC
                        | libc::O_NOFOLLOW
                        | libc::O_NONBLOCK
                        | if last { 0 } else { libc::O_DIRECTORY },
                )
            };
            // Missing, inaccessible or symlinked cache entries are misses. The
            // installer falls back to official verified downloads.
            if fd < 0 {
                return Ok(None);
            }
            let file = unsafe { fs::File::from_raw_fd(fd) };
            if last {
                return if file.metadata().map_err(error)?.is_file() {
                    Ok(Some(file))
                } else {
                    Ok(None)
                };
            }
            dir = file;
        }
        Ok(None)
    }
    #[cfg(test)]
    pub fn copy(&self, root: &Path, d: &Download, cancel: &AtomicBool) -> Result<bool> {
        self.copy_to(&InstallDir::legacy(root.into()), d, cancel)
    }
    pub fn copy_to(&self, root: &InstallDir, d: &Download, cancel: &AtomicBool) -> Result<bool> {
        check(cancel)?;
        let Some(mut source) = self.file(&d.relative)? else {
            return Ok(false);
        };
        if source.metadata().map_err(error)?.len() != d.size {
            return Ok(false);
        }
        let path = root.file(&d.relative)?;
        fs::create_dir_all(path.parent().ok_or("缓存目标路径无效")?).map_err(error)?;
        let path = root.file(&d.relative)?;
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(error)?;
        let result = (|| {
            let mut digest = Sha1::new();
            let mut total = 0u64;
            let mut buf = [0u8; 65536];
            loop {
                check(cancel)?;
                let n = source.read(&mut buf).map_err(error)?;
                if n == 0 {
                    break;
                }
                total = total.checked_add(n as u64).ok_or("缓存文件过大")?;
                if total > d.size {
                    return Ok(false);
                }
                digest.update(&buf[..n]);
                temp.write_all(&buf[..n]).map_err(error)?;
            }
            if total != d.size || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&d.hash)
            {
                return Ok(false);
            }
            check(cancel)?;
            temp.as_file().sync_all().map_err(error)?;
            root.file(&d.relative)?;
            Ok(true)
        })();
        match result {
            Ok(true) => {
                persist_download(temp, &path)?;
                Ok(true)
            }
            Ok(false) => temp
                .close()
                .map(|_| false)
                .map_err(|e| format!("取消清理失败：无法清理无效缓存副本：{e}")),
            Err(error) => Err(close_download(temp, error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt};
    fn fixture() -> tempfile::TempDir {
        let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let work = project.join("work/instance-reset-cache-tests");
        fs::create_dir_all(&work).unwrap();
        tempfile::tempdir_in(work).unwrap()
    }
    fn artifact() -> Download {
        Download {
            relative: "libraries/example.jar".into(),
            url: "unused".into(),
            hash: format!("{:x}", Sha1::digest(b"cache")),
            size: 5,
        }
    }
    #[test]
    fn verified_cache_is_copied_and_processor_edits_cannot_touch_source() {
        let source = fixture();
        let target = fixture();
        fs::create_dir(source.path().join("libraries")).unwrap();
        fs::write(source.path().join("libraries/example.jar"), b"cache").unwrap();
        let cache = CacheSource::open(source.path()).unwrap();
        assert!(cache
            .copy(target.path(), &artifact(), &AtomicBool::new(false))
            .unwrap());
        assert_ne!(
            fs::metadata(source.path().join("libraries/example.jar"))
                .unwrap()
                .ino(),
            fs::metadata(target.path().join("libraries/example.jar"))
                .unwrap()
                .ino()
        );
        fs::write(target.path().join("libraries/example.jar"), b"changed").unwrap();
        assert_eq!(
            fs::read(source.path().join("libraries/example.jar")).unwrap(),
            b"cache"
        );
    }
    #[test]
    fn invalid_symlinked_and_traversing_cache_inputs_are_misses() {
        let source = fixture();
        let target = fixture();
        let outside = fixture();
        fs::create_dir(source.path().join("libraries")).unwrap();
        fs::write(source.path().join("libraries/example.jar"), b"wrong").unwrap();
        fs::write(outside.path().join("example.jar"), b"cache").unwrap();
        let cache = CacheSource::open(source.path()).unwrap();
        assert!(!cache
            .copy(target.path(), &artifact(), &AtomicBool::new(false))
            .unwrap());
        assert!(fs::read_dir(target.path().join("libraries"))
            .unwrap()
            .next()
            .is_none());
        fs::remove_file(source.path().join("libraries/example.jar")).unwrap();
        symlink(
            outside.path().join("example.jar"),
            source.path().join("libraries/example.jar"),
        )
        .unwrap();
        assert!(!cache
            .copy(target.path(), &artifact(), &AtomicBool::new(false))
            .unwrap());
        assert!(cache.file("libraries/../example.jar").unwrap().is_none());
        fs::remove_file(source.path().join("libraries/example.jar")).unwrap();
        fs::remove_dir(source.path().join("libraries")).unwrap();
        symlink(outside.path(), source.path().join("libraries")).unwrap();
        assert!(!cache
            .copy(target.path(), &artifact(), &AtomicBool::new(false))
            .unwrap());
    }
    #[test]
    fn cancelled_cache_copy_has_no_destination_or_partial_file() {
        let source = fixture();
        let target = fixture();
        fs::create_dir(source.path().join("libraries")).unwrap();
        fs::write(source.path().join("libraries/example.jar"), b"cache").unwrap();
        let cache = CacheSource::open(source.path()).unwrap();
        assert!(cache
            .copy(target.path(), &artifact(), &AtomicBool::new(true))
            .is_err());
        assert!(!target.path().join("libraries").exists());
    }
}
