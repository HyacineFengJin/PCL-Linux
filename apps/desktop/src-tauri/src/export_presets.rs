//! Launcher-owned export choices, separate from the files being exported.
use crate::instance_export::ExportRequest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
};

const LIMIT: u64 = 64 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

struct PresetLock(File);
impl Drop for PresetLock {
    fn drop(&mut self) {
        // A Java probe can fork while this writer is finishing. Release the
        // shared lock description explicitly, even if a pre-exec child still
        // holds a copied descriptor; close alone is insufficient.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preset {
    schema_version: u32,
    root_id: String,
    root_path: String,
    instance_id: String,
    request: ExportRequest,
}

pub(crate) fn name(root_id: &str, id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(root_id.len().to_le_bytes());
    hash.update(root_id);
    hash.update(id);
    format!("{:x}.json", hash.finalize())
}
fn c(s: impl AsRef<std::ffi::OsStr>) -> Result<CString, String> {
    CString::new(s.as_ref().as_bytes()).map_err(|_| "配置路径无效".into())
}
fn open_dir(parent: &File, name: &CString) -> std::io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn directory(project: &Path, create: bool) -> Result<Option<File>, String> {
    if !project.is_absolute() {
        return Err("配置目录必须是绝对路径".into());
    }
    let mut dir = File::open("/").map_err(|e| e.to_string())?;
    for part in project.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(part) => {
                dir = open_dir(&dir, &c(part)?).map_err(|e| format!("无法访问配置目录：{e}"))?
            }
            _ => return Err("配置目录路径无效".into()),
        }
    }
    for part in [".pcl-rust", "export-presets"] {
        let part = c(part)?;
        if create {
            let rc = unsafe { libc::mkdirat(dir.as_raw_fd(), part.as_ptr(), 0o700) };
            if rc != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(format!(
                    "无法创建导出配置目录：{}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        match open_dir(&dir, &part) {
            Ok(next) => dir = next,
            Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("无法访问导出配置目录：{e}")),
        }
    }
    Ok(Some(dir))
}
fn read_at(dir: &File, filename: &CString) -> Result<Option<Preset>, String> {
    use std::os::fd::FromRawFd;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            filename.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        let e = std::io::Error::last_os_error();
        return if e.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(format!("无法读取导出配置：{e}"))
        };
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err("导出配置不是有效的普通文件或文件过大".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("导出配置文件过大".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "导出配置损坏或格式不受支持，原文件已保留".into())
}
fn check(preset: &Preset, root_id: &str, root: &Path, id: &str) -> Result<(), String> {
    if preset.schema_version != 1
        || preset.root_id != root_id
        || preset.root_path != root.to_string_lossy()
        || preset.instance_id != id
    {
        return Err("导出配置版本或所属实例不匹配，原文件已保留".into());
    }
    preset.request.validate()
}
pub fn read(
    project: &Path,
    root_id: &str,
    root: &Path,
    id: &str,
) -> Result<Option<ExportRequest>, String> {
    let Some(dir) = directory(project, false)? else {
        return Ok(None);
    };
    let Some(preset) = read_at(&dir, &c(name(root_id, id))?)? else {
        return Ok(None);
    };
    check(&preset, root_id, root, id)?;
    Ok(Some(preset.request))
}
fn lock_preset(dir: &File, root_id: &str, id: &str) -> Result<PresetLock, String> {
    let lockname = c(format!("{}.lock", name(root_id, id)))?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            lockname.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!(
            "无法锁定导出配置：{}",
            std::io::Error::last_os_error()
        ));
    }
    let lock = unsafe { File::from_raw_fd(fd) };
    if !lock.metadata().map_err(|e| e.to_string())?.is_file()
        || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err("导出配置正被另一个启动器使用".into());
    }
    Ok(PresetLock(lock))
}

pub fn save(
    project: &Path,
    root_id: &str,
    root: &Path,
    id: &str,
    request: ExportRequest,
) -> Result<(), String> {
    request.validate()?;
    let dir = directory(project, true)?.ok_or("无法创建配置目录")?;
    let filename = c(name(root_id, id))?;
    let _lock = lock_preset(&dir, root_id, id)?;
    crate::instance_rename_refs::ensure_project_ready(project)?;
    if let Some(old) = read_at(&dir, &filename)? {
        check(&old, root_id, root, id)?;
    }
    let data = serde_json::to_vec_pretty(&Preset {
        schema_version: 1,
        root_id: root_id.into(),
        root_path: root.to_string_lossy().into_owned(),
        instance_id: id.into(),
        request,
    })
    .map_err(|e| e.to_string())?;
    if data.len() as u64 > LIMIT {
        return Err("导出配置内容过多".into());
    }
    let temporary = c(format!(
        ".preset-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!(
            "无法暂存导出配置：{}",
            std::io::Error::last_os_error()
        ));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("保存导出配置失败：{e}"))?;
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary.as_ptr(),
                dir.as_raw_fd(),
                filename.as_ptr(),
            )
        } != 0
        {
            return Err(format!(
                "发布导出配置失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        dir.sync_all().map_err(|e| format!("保存导出配置失败：{e}"))
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
    }
    result
}

pub(crate) fn rename_bytes(
    bytes: &[u8],
    root_id: &str,
    root: &Path,
    old: &str,
    new: &str,
) -> Result<Vec<u8>, String> {
    let mut preset: Preset = serde_json::from_slice(bytes)
        .map_err(|_| "导出配置损坏或格式不受支持，原文件已保留".to_string())?;
    check(&preset, root_id, root, old)?;
    preset.instance_id = new.into();
    let result = serde_json::to_vec_pretty(&preset).map_err(|error| error.to_string())?;
    if result.len() as u64 > LIMIT {
        return Err("导出配置内容过多".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../work/instance-ops-2026-10-04/preset-fixtures")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn request() -> ExportRequest {
            serde_json::from_value(
                serde_json::json!({"name":"Example","version":"1.0.0","checks":{},"excluded":{}}),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn preset_save_can_follow_owner_drop_while_duplicate_descriptor_stays_open() {
        let fixture = Fixture::new();
        let dir = directory(&fixture.0, true).unwrap().unwrap();
        let owner = lock_preset(&dir, "a", "Example").unwrap();
        let inherited = owner.0.try_clone().unwrap();
        assert!(save(
            &fixture.0,
            "a",
            Path::new("/game"),
            "Example",
            Fixture::request()
        )
        .is_err());
        drop(owner);
        save(
            &fixture.0,
            "a",
            Path::new("/game"),
            "Example",
            Fixture::request(),
        )
        .unwrap();
        assert_eq!(
            read(&fixture.0, "a", Path::new("/game"), "Example")
                .unwrap()
                .unwrap()
                .name,
            "Example"
        );
        drop(inherited);
    }
    #[test]
    fn scoped_presets_survive_restart_and_reject_retargeting() {
        let fixture = Fixture::new();
        assert!(read(&fixture.0, "a", Path::new("/game-a"), "Example")
            .unwrap()
            .is_none());
        save(
            &fixture.0,
            "a",
            Path::new("/game-a"),
            "Example",
            Fixture::request(),
        )
        .unwrap();
        assert_eq!(
            read(&fixture.0, "a", Path::new("/game-a"), "Example")
                .unwrap()
                .unwrap()
                .name,
            "Example"
        );
        assert!(read(&fixture.0, "b", Path::new("/game-b"), "Example")
            .unwrap()
            .is_none());
        assert!(read(&fixture.0, "a", Path::new("/other"), "Example").is_err());
        assert!(save(
            &fixture.0,
            "a",
            Path::new("/other"),
            "Example",
            Fixture::request()
        )
        .is_err());
        assert_eq!(
            read(&fixture.0, "a", Path::new("/game-a"), "Example")
                .unwrap()
                .unwrap()
                .name,
            "Example"
        );
    }
    #[test]
    fn malformed_preset_and_symlinked_storage_are_preserved() {
        let fixture = Fixture::new();
        save(
            &fixture.0,
            "a",
            Path::new("/game"),
            "Example",
            Fixture::request(),
        )
        .unwrap();
        let file = fixture
            .0
            .join(".pcl-rust/export-presets")
            .join(name("a", "Example"));
        fs::write(&file, b"malformed").unwrap();
        assert!(save(
            &fixture.0,
            "a",
            Path::new("/game"),
            "Example",
            Fixture::request()
        )
        .is_err());
        assert_eq!(fs::read(&file).unwrap(), b"malformed");
        let other = Fixture::new();
        std::os::unix::fs::symlink(&fixture.0, other.0.join(".pcl-rust")).unwrap();
        assert!(read(&other.0, "a", Path::new("/game"), "Example").is_err());
        assert!(save(
            &other.0,
            "a",
            Path::new("/game"),
            "Example",
            Fixture::request()
        )
        .is_err());
    }
}
