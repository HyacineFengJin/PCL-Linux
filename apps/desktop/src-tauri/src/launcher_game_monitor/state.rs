//! One independent durable marker and lifetime lock per project. Reading state
//! never creates directories. A damaged/unknown marker is retained and returns an
//! error so admission can conservatively block launch and writes until repaired.
use super::process::{self, Identity};
use crate::launcher_local::filesystem::{
    optional_snapshot, revision, Dir, Scope, Snapshot, WriteLock,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    os::fd::{AsRawFd, FromRawFd},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
const NAME: &str = "active.json";
const LIMIT: u64 = 16 * 1024;
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Starting,
    Running,
    Exited,
    Failed,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Marker {
    schema_version: u32,
    project: PathBuf,
    root_id: String,
    root_path: PathBuf,
    log_path: PathBuf,
    monitor: Identity,
    game: Option<Identity>,
    phase: Phase,
    started_at: u64,
    exit_code: Option<i32>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatus {
    pub session_id: String,
    pub root_id: String,
    pub root_path: String,
    pub log_path: String,
    pub pid: Option<u32>,
    pub monitor_pid: u32,
    pub busy: bool,
    pub supervisor_running: bool,
    pub game_running: bool,
    pub phase: String,
    pub started_at: u64,
    pub exit_code: Option<i32>,
    pub revision: String,
}
fn parse(project: &Path, snapshot: &Snapshot) -> Result<Marker, String> {
    let marker: Marker = serde_json::from_slice(&snapshot.header)
        .map_err(|_| "游戏监控状态无效，已保留文件；暂停启动和文件操作")?;
    if marker.schema_version != 1
        || marker.project != project
        || marker.root_id.is_empty()
        || marker.root_id.len() > 128
        || marker.root_id.chars().any(char::is_control)
        || !marker.monitor.valid()
        || marker
            .game
            .as_ref()
            .is_some_and(|game| !game.valid() || game.pid == marker.monitor.pid)
        || matches!(marker.phase, Phase::Running | Phase::Exited) && marker.game.is_none()
    {
        return Err("游戏监控状态版本或身份不受支持，已保留文件".into());
    }
    validate_log_path(&marker.root_path, &marker.log_path)?;
    Ok(marker)
}
fn status(marker: &Marker, revision: String) -> Result<MonitorStatus, String> {
    let supervisor_running = process::alive(&marker.monitor)?;
    let game_running = marker
        .game
        .as_ref()
        .map(process::alive)
        .transpose()?
        .unwrap_or(false);
    Ok(MonitorStatus {
        session_id: process::session_id(&marker.monitor),
        root_id: marker.root_id.clone(),
        root_path: marker.root_path.display().to_string(),
        log_path: marker.log_path.display().to_string(),
        pid: marker.game.as_ref().map(|game| game.pid),
        monitor_pid: marker.monitor.pid,
        busy: supervisor_running || game_running,
        supervisor_running,
        game_running,
        phase: match marker.phase {
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Exited => "exited",
            Phase::Failed => "failed",
        }
        .into(),
        started_at: marker.started_at,
        exit_code: marker.exit_code,
        revision,
    })
}
pub fn read_status(project: &Path) -> Result<Option<MonitorStatus>, String> {
    let scope = Scope::open(project, "game-monitor")?;
    let Some(folder) = &scope.folder else {
        scope.recheck()?;
        return Ok(None);
    };
    let Some(snapshot) = optional_snapshot(folder, NAME, LIMIT)? else {
        scope.recheck()?;
        return Ok(None);
    };
    let marker = parse(project, &snapshot)?;
    let result = status(&marker, revision(&scope.path().join(NAME), &snapshot)?)?;
    scope.recheck()?;
    snapshot.recheck(folder, NAME)?;
    Ok(Some(result))
}
pub fn stop_monitor(project: &Path, expected_revision: &str) -> Result<(), String> {
    let scope = Scope::open(project, "game-monitor")?;
    let folder = scope.folder.as_ref().ok_or("没有可停止的独立游戏监控")?;
    let snapshot = Snapshot::open(folder, NAME, LIMIT)?;
    let marker = parse(project, &snapshot)?;
    if revision(&scope.path().join(NAME), &snapshot)? != expected_revision {
        return Err("游戏监控状态已变化，请刷新后停止".into());
    }
    scope.recheck()?;
    snapshot.recheck(folder, NAME)?;
    process::signal(
        marker.game.as_ref().ok_or("游戏尚未成功启动")?,
        libc::SIGKILL,
    )
}
pub(super) struct Session {
    scope: Scope,
    _lock: WriteLock,
    marker: Marker,
    snapshot: Option<Snapshot>,
}
impl Session {
    pub fn start(
        project: &Path,
        root_id: String,
        root_path: PathBuf,
        log_path: PathBuf,
    ) -> Result<Self, String> {
        let scope = Scope::create(project, "game-monitor")?;
        let folder = scope.folder.as_ref().unwrap();
        let lock = folder.lock(".monitor.lock")?;
        let snapshot = optional_snapshot(folder, NAME, LIMIT)?;
        if let Some(snapshot) = &snapshot {
            if status(&parse(project, snapshot)?, String::new())?.busy {
                return Err("该项目仍有独立监控的游戏，不能再次启动".into());
            }
        }
        let marker = Marker {
            schema_version: 1,
            project: project.to_owned(),
            root_id,
            root_path,
            log_path,
            monitor: process::identity(std::process::id())?.ok_or("监控进程身份不可用")?,
            game: None,
            phase: Phase::Starting,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            exit_code: None,
        };
        let mut session = Self {
            scope,
            _lock: lock,
            marker,
            snapshot,
        };
        session.save()?;
        Ok(session)
    }
    fn save(&mut self) -> Result<(), String> {
        self.scope.recheck()?;
        let folder = self.scope.folder.as_ref().unwrap();
        folder.replace(
            NAME,
            self.snapshot.as_ref(),
            &serde_json::to_vec(&self.marker).map_err(|_| "无法保存游戏监控状态")?,
            LIMIT,
        )?;
        self.scope.recheck()?;
        self.snapshot = Some(Snapshot::open(folder, NAME, LIMIT)?);
        Ok(())
    }
    pub fn spawned(&mut self, pid: u32) -> Result<(), String> {
        self.marker.game = Some(process::identity(pid)?.ok_or("游戏进程在确认前已结束")?);
        self.marker.phase = Phase::Running;
        self.save()
    }
    pub fn finished(&mut self, success: bool, exit_code: Option<i32>) -> Result<(), String> {
        self.marker.phase = if success {
            Phase::Exited
        } else {
            Phase::Failed
        };
        self.marker.exit_code = exit_code;
        self.save()
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if matches!(self.marker.phase, Phase::Starting | Phase::Running) {
            self.marker.phase = Phase::Failed;
            let _ = self.save();
        }
    }
}
pub(super) fn validate_log_path(root: &Path, path: &Path) -> Result<(), String> {
    if !root.is_absolute()
        || root.components().any(|part| {
            !matches!(
                part,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
    {
        return Err("游戏监控目录必须是捕获的绝对目录".into());
    }
    if path.parent() != Some(root.join(".pcl-linux/logs").as_path()) {
        return Err("游戏监控只能写入该游戏目录的启动日志".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("游戏日志文件名无效")?;
    crate::launcher_local::filesystem::component(name)?;
    if name.starts_with('.') || !name.ends_with(".log") {
        return Err("游戏日志文件类型无效".into());
    }
    Ok(())
}
/// Only captured-root launch logs can be opened. Existing regular logs are
/// appended; creation never overwrites a competing new file or follows links.
pub(super) fn open_launch_log(root: &Path, path: &Path) -> Result<File, String> {
    validate_log_path(root, path)?;
    let root = Dir::absolute(root)?;
    let owner = root.create(".pcl-linux")?;
    let folder = owner.create("logs")?;
    let name = std::ffi::CString::new(path.file_name().unwrap().as_encoded_bytes())
        .map_err(|_| "游戏日志文件名无效")?;
    // O_PATH pins an existing inode without opening a device/FIFO for I/O. Only
    // that verified regular inode is then reopened through our own /proc FD.
    let pin = unsafe {
        libc::openat(
            folder.0.as_raw_fd(),
            name.as_ptr(),
            libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    use std::os::unix::fs::MetadataExt;
    let fd = if pin >= 0 {
        let pinned = unsafe { File::from_raw_fd(pin) };
        let metadata = pinned.metadata().map_err(|_| "无法检查游戏日志")?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err("游戏日志不是当前用户独占的普通文件".into());
        }
        let proc_path = std::ffi::CString::new(format!("/proc/self/fd/{pin}")).unwrap();
        unsafe {
            libc::open(
                proc_path.as_ptr(),
                libc::O_WRONLY | libc::O_APPEND | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        }
    } else if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
        unsafe {
            libc::openat(
                folder.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_APPEND
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        }
    } else {
        return Err("无法检查游戏日志，已保留现有文件".into());
    };
    if fd < 0 {
        return Err("无法打开游戏日志，拒绝符号链接和特殊文件".into());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|_| "无法检查游戏日志")?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.len() > super::output::LOG_LIMIT
    {
        return Err("游戏日志不是当前用户独占的有限普通文件".into());
    }
    let current = folder
        .file(path.file_name().unwrap().to_str().unwrap())?
        .ok_or("游戏日志在打开后消失")?
        .metadata()
        .map_err(|_| "无法检查游戏日志")?;
    if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
        return Err("游戏日志在打开期间被替换，已保留文件".into());
    }
    if Dir::absolute(path.parent().unwrap())?.identity()? != folder.identity()? {
        return Err("游戏日志目录在打开时发生变化".into());
    }
    folder.sync()?;
    Ok(file)
}
