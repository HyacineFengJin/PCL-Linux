//! Read-only fontconfig discovery, with independent output/deadline bounds.
//! The command is a fixed trusted executable, never a user-entered shell line.
use std::{
    collections::BTreeSet,
    io::Read,
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_FAMILIES: usize = 4096;
pub fn discover_font_families() -> Result<Vec<String>, String> {
    discover(Path::new("/usr/bin/fc-list"), Duration::from_secs(3))
}

fn discover(executable: &Path, timeout: Duration) -> Result<Vec<String>, String> {
    let mut command = Command::new(executable);
    command
        .arg("--format=%{family}\n")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|_| "无法运行 fontconfig，请安装系统字体工具")?;
    let mut child = ProbeChild {
        group: child.id() as i32,
        child: Some(child),
    };
    let mut stdout = child
        .child
        .as_mut()
        .unwrap()
        .stdout
        .take()
        .ok_or("无法读取 fontconfig 输出")?;
    let mut stderr = child
        .child
        .as_mut()
        .unwrap()
        .stderr
        .take()
        .ok_or("无法读取 fontconfig 错误输出")?;
    nonblocking(&stdout)?;
    nonblocking(&stderr)?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let deadline = Instant::now() + timeout;
    let status = loop {
        drain(&mut stdout, &mut output, MAX_OUTPUT, deadline)?;
        drain(&mut stderr, &mut errors, 64 * 1024, deadline)?;
        match child.child.as_mut().unwrap().try_wait() {
            Ok(Some(status)) => {
                drain(&mut stdout, &mut output, MAX_OUTPUT, deadline)?;
                drain(&mut stderr, &mut errors, 64 * 1024, deadline)?;
                break status;
            }
            Err(_) => return Err("无法等待 fontconfig 任务".into()),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return Err("fontconfig 字体扫描超时，请检查系统字体配置".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Nonblocking pipes never wait for a descendant to close a copied writer.
    // Stop the process group, then drop both pipes before returning font data.
    child.stop();
    if !status.success() {
        return Err("fontconfig 无法完成字体扫描".into());
    }
    families(&output)
}
fn nonblocking(file: &impl AsRawFd) -> Result<(), String> {
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err("无法设置 fontconfig 输出读取方式".into())
    } else {
        Ok(())
    }
}
fn drain(
    reader: &mut impl Read,
    bytes: &mut Vec<u8>,
    limit: usize,
    deadline: Instant,
) -> Result<(), String> {
    let mut buffer = [0u8; 8192];
    loop {
        if Instant::now() >= deadline {
            return Err("fontconfig 字体扫描超时，请检查系统字体配置".into());
        }
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(length) => {
                if bytes.len() + length > limit {
                    return Err("fontconfig 输出超过安全上限".into());
                }
                bytes.extend_from_slice(&buffer[..length]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err("无法读取 fontconfig 输出".into()),
        }
    }
}

struct ProbeChild {
    group: i32,
    child: Option<Child>,
}
impl ProbeChild {
    fn stop(&mut self) {
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            // A killed process normally reaps immediately. Keep a rare kernel
            // I/O stall out of the caller while retaining one explicit reaper.
            let until = Instant::now() + Duration::from_secs(1);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) if Instant::now() < until => thread::sleep(Duration::from_millis(10)),
                    Ok(None) => {
                        thread::spawn(move || {
                            let _ = child.wait();
                        });
                        break;
                    }
                }
            }
        }
    }
}
impl Drop for ProbeChild {
    fn drop(&mut self) {
        if self.child.is_some() {
            self.stop();
        }
    }
}

fn families(bytes: &[u8]) -> Result<Vec<String>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "fontconfig 输出不是有效 UTF-8")?;
    let mut families = BTreeSet::new();
    for family in text.lines().flat_map(|line| line.split(',')) {
        let family = family.trim();
        if family.is_empty() {
            continue;
        }
        if family.chars().count() > 128
            || family.chars().any(char::is_control)
            || family.contains([';', '{', '}', '<', '>', '\\'])
        {
            return Err("fontconfig 输出包含无效字体名称".into());
        }
        families.insert(family.to_owned());
        if families.len() > MAX_FAMILIES {
            return Err("字体数量超过 4096 个上限".into());
        }
    }
    Ok(families.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Script(std::path::PathBuf);
    impl Script {
        fn new(body: &str) -> Self {
            let folder = std::env::current_dir()
                .unwrap()
                .join("fixtures")
                .join(format!(
                    "fonts-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(&folder).unwrap();
            let path = folder.join("fake-fontconfig");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Script {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0.parent().unwrap());
        }
    }
    #[test]
    fn font_families_are_bounded_deduplicated_and_utf8() {
        assert_eq!(
            families("字体 A,Family B\nFamily B\n".as_bytes()).unwrap(),
            vec!["Family B", "字体 A"]
        );
        assert!(families(b"invalid\xff").is_err());
        assert!(families(b"Family;injection").is_err());
    }
    #[test]
    fn failing_or_timed_out_probe_returns_no_partial_list() {
        let failed = Script::new("printf 'Partial Font\\n'; exit 1");
        assert!(discover(&failed.0, Duration::from_millis(200)).is_err());
        let slow = Script::new("sleep 30");
        let started = Instant::now();
        assert!(discover(&slow.0, Duration::from_millis(60)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn descendant_pipe_holders_are_stopped_even_when_leader_exits() {
        let script = Script::new("sleep 30 &\nprintf 'Family A\\n'\nexit 0");
        let started = Instant::now();
        assert_eq!(
            discover(&script.0, Duration::from_millis(200)).unwrap(),
            vec!["Family A"]
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn probe_output_is_bounded_before_parsing_names() {
        let script = Script::new("head -c 1048577 /dev/zero");
        let error = discover(&script.0, Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("超过安全上限"));
    }
}
