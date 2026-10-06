//! Explicit processor selection must never become automatic discovery. These
//! fixtures provide a working project runtime so a fallback would be observable
//! without relying on, changing, or executing a machine's installed Java.
use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Fixture {
    root: tempfile::TempDir,
    workspace: PathBuf,
    fallback: PathBuf,
    fallback_marker: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let fallback = root.path().join("runtime-compatible/bin/java");
        let fallback_marker = root.path().join("fallback-probed");
        write_script(&fallback, &version_script(21, &fallback_marker), true);
        Self {
            root,
            workspace,
            fallback,
            fallback_marker,
        }
    }
    fn installer(&self) -> Installer {
        Installer::new().unwrap().with_project(self.root.path())
    }
    fn selected(&self) -> PathBuf {
        self.root.path().join("selected-java")
    }
}
fn shell_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}
fn version_script(major: u32, marker: &Path) -> String {
    format!(
        "if [ \"$1\" != '-version' ]; then exit 64; fi\nprintf 'probed\\n' >> {}\nprintf 'openjdk version \"{major}.0.1\"\\n' >&2\n",
        shell_path(marker)
    )
}
fn write_script(path: &Path, body: &str, executable: bool) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
    )
    .unwrap();
}

#[test]
fn fixed_java_rejects_older_and_newer_majors_without_discovery() {
    for major in [17, 22] {
        let f = Fixture::new();
        let selected = f.selected();
        write_script(
            &selected,
            &version_script(major, &f.root.path().join("selected-probed")),
            true,
        );
        let error = f
            .installer()
            .with_java(&selected)
            .installer_java(21, &f.workspace, &AtomicBool::new(false))
            .unwrap_err();
        assert!(error.contains("此组件需要 Java 21"), "{error}");
        assert!(error.contains(&format!("指定的是 Java {major}")), "{error}");
        assert!(!f.fallback_marker.exists(), "fixed selection fell back");
    }
}

#[test]
fn fixed_java_missing_or_failed_probe_never_uses_compatible_fallback() {
    for failure in [
        "missing",
        "dangling",
        "not-executable",
        "exit",
        "unrecognized",
    ] {
        let f = Fixture::new();
        let selected = f.selected();
        match failure {
            "missing" => {}
            "dangling" => symlink("missing-target", &selected).unwrap(),
            "not-executable" => write_script(&selected, "exit 0\n", false),
            "exit" => write_script(&selected, "exit 42\n", true),
            "unrecognized" => write_script(&selected, "printf 'not java\\n' >&2\n", true),
            _ => unreachable!(),
        }
        let error = f
            .installer()
            .with_java(&selected)
            .installer_java(21, &f.workspace, &AtomicBool::new(false))
            .unwrap_err();
        assert!(error.contains("指定的 Java 不可用"), "{failure}: {error}");
        assert!(!f.fallback_marker.exists(), "{failure} fell back");
    }
}

#[test]
fn auto_java_still_discovers_the_compatible_project_runtime() {
    let f = Fixture::new();
    let selected = f
        .installer()
        .installer_java(21, &f.workspace, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(selected, fs::canonicalize(&f.fallback).unwrap());
    assert_eq!(fs::read(&f.fallback_marker).unwrap(), b"probed\n");
}

#[test]
fn repeated_fixed_selection_reprobes_a_replaced_or_removed_path() {
    let f = Fixture::new();
    let selected = f.selected();
    let marker = f.root.path().join("selected-probed");
    write_script(&selected, &version_script(21, &marker), true);
    let installer = f.installer().with_java(&selected);
    assert_eq!(
        installer
            .installer_java(21, &f.workspace, &AtomicBool::new(false))
            .unwrap(),
        fs::canonicalize(&selected).unwrap()
    );
    // Each selection resolves/probes again. This does not assert inode pinning
    // between a selection and the later processors in that same batch.
    let replacement = f.root.path().join("replacement-java");
    write_script(&replacement, &version_script(17, &marker), true);
    fs::rename(&replacement, &selected).unwrap();
    assert!(installer
        .installer_java(21, &f.workspace, &AtomicBool::new(false))
        .unwrap_err()
        .contains("指定的是 Java 17"));
    fs::remove_file(&selected).unwrap();
    assert!(installer
        .installer_java(21, &f.workspace, &AtomicBool::new(false))
        .unwrap_err()
        .contains("指定的 Java 不可用"));
    assert!(!f.fallback_marker.exists());
}

#[test]
fn pre_cancelled_fixed_selection_does_not_probe_or_discover() {
    let f = Fixture::new();
    let selected = f.selected();
    let marker = f.root.path().join("selected-probed");
    write_script(&selected, &version_script(21, &marker), true);
    assert_eq!(
        f.installer()
            .with_java(&selected)
            .installer_java(21, &f.workspace, &AtomicBool::new(true))
            .unwrap_err(),
        "安装已取消"
    );
    assert!(!marker.exists());
    assert!(!f.fallback_marker.exists());
}

#[test]
fn cancelled_fixed_probe_kills_and_reaps_its_child_without_fallback() {
    let f = Fixture::new();
    let selected = f.selected();
    let pid_file = f.root.path().join("probe-pid");
    write_script(
        &selected,
        &format!(
            "printf '%s\\n' \"$$\" > {}\nexec /bin/sleep 60\n",
            shell_path(&pid_file)
        ),
        true,
    );
    let cancelled = AtomicBool::new(false);
    let started = Instant::now();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !pid_file.exists() && started.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(10));
            }
            cancelled.store(true, Ordering::Relaxed);
        });
        assert_eq!(
            f.installer()
                .with_java(&selected)
                .installer_java(21, &f.workspace, &cancelled)
                .unwrap_err(),
            "安装已取消"
        );
    });
    assert!(started.elapsed() < Duration::from_secs(4));
    let pid: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert!(!f.fallback_marker.exists());
    assert!(fs::read_dir(&f.workspace).unwrap().next().is_none());
}
