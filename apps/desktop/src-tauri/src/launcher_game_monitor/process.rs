//! Linux process identities and cancellation. A pidfd is opened before the
//! boot/start-time identity recheck; signalling that FD cannot target a reused PID.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    os::fd::{AsRawFd, FromRawFd},
    process::Child,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub pid: u32,
    pub start_time: u64,
    pub boot_id: String,
}
impl Identity {
    pub fn valid(&self) -> bool {
        self.pid > 0
            && self.pid <= i32::MAX as u32
            && self.start_time > 0
            && self.boot_id.len() == 36
            && self.boot_id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    }
}
/// Stable for one supervisor lifetime, including across marker phase changes.
/// The GUI can invalidate an older worker without exposing /proc identity data.
pub(super) fn session_id(identity: &Identity) -> String {
    let mut hash = Sha256::new();
    hash.update(identity.pid.to_be_bytes());
    hash.update(identity.start_time.to_be_bytes());
    hash.update(identity.boot_id.as_bytes());
    format!("{:x}", hash.finalize())
}
fn bounded(path: &str, limit: u64) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "无法读取监控进程身份")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取监控进程身份")?;
    if bytes.len() as u64 > limit {
        return Err("监控进程身份超过上限".into());
    }
    String::from_utf8(bytes).map_err(|_| "监控进程身份格式无效".into())
}
pub(super) fn identity(pid: u32) -> Result<Option<Identity>, String> {
    if pid == 0 {
        return Err("监控进程身份无效".into());
    }
    let boot_id = bounded("/proc/sys/kernel/random/boot_id", 128)?
        .trim()
        .to_owned();
    if !(Identity {
        pid,
        start_time: 1,
        boot_id: boot_id.clone(),
    })
    .valid()
    {
        return Err("系统启动身份无效".into());
    }
    let text = match bounded(&format!("/proc/{pid}/stat"), 64 * 1024) {
        Ok(text) => text,
        Err(_) if !std::path::Path::new(&format!("/proc/{pid}")).exists() => return Ok(None),
        Err(error) => return Err(error),
    };
    let close = text.rfind(')').ok_or("监控进程身份格式无效")?;
    let fields = text[close + 1..].split_whitespace().collect::<Vec<_>>();
    if matches!(fields.first().copied(), Some("Z" | "X")) {
        return Ok(None);
    }
    let start_time = fields
        .get(19)
        .ok_or("监控进程身份格式无效")?
        .parse::<u64>()
        .map_err(|_| "监控进程身份格式无效")?;
    Ok(Some(Identity {
        pid,
        start_time,
        boot_id,
    }))
}
pub(super) fn alive(expected: &Identity) -> Result<bool, String> {
    Ok(identity(expected.pid)?.as_ref() == Some(expected))
}
pub(super) fn signal(expected: &Identity, signal: i32) -> Result<(), String> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, expected.pid, 0) } as i32;
    if fd < 0 {
        return Err("无法安全连接游戏进程，请刷新进程状态".into());
    }
    let descriptor = unsafe { File::from_raw_fd(fd) };
    if !alive(expected)? {
        return Err("游戏进程身份已变化，未发送停止信号".into());
    }
    if unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            descriptor.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    } != 0
    {
        return Err("未能安全停止游戏进程，请刷新进程状态".into());
    }
    Ok(())
}
/// Only an unreaped owned child is used here: its PID cannot be reused while
/// killing the process group. Normal completed children never enter this path.
pub(super) fn kill_owned(child: &mut Child) {
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
/// Observe termination without reaping first. The unreaped leader reserves its
/// PID while remaining members of its owned process group are stopped; only
/// then is the exit status reaped. This avoids signalling a newly reused PGID.
pub(super) fn wait_owned(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    loop {
        let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id(),
                information.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            break;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err("游戏监控无法确认进程结束".into());
        }
    }
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    child.wait().map_err(|_| "游戏监控无法确认进程结束".into())
}
