//! Filesystem regressions for the actual scan/launch consumers. Scripted Java
//! only reports properties (and optionally mutates a fixture marker); no JVM or
//! game is launched. All test files belong to an ignored repository directory.
use super::*;
use crate::{java::JavaSelection, launch_options::LaunchOptions};
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture() -> tempfile::TempDir {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../work/core-content-scope-tests");
    fs::create_dir_all(&path).unwrap();
    let fixture = tempfile::tempdir_in(path.canonicalize().unwrap()).unwrap();
    let version = fixture.path().join("versions/Example");
    fs::create_dir_all(&version).unwrap();
    fs::write(
        version.join("Example.json"),
        br#"{
        "id":"Example","mainClass":"FixtureMain","javaVersion":{"majorVersion":21},
        "libraries":[],"arguments":{"jvm":[],"game":["--gameDir","${game_directory}"]}
    }"#,
    )
    .unwrap();
    fs::write(version.join("Example.jar"), b"fixture client").unwrap();
    fixture
}
fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}
fn java_fixture(root: &Path, change: &str) -> JavaSelection {
    let executable = root.join("java-fixture");
    fs::write(&executable, format!(
        "#!/bin/sh\nprintf 'probe\\n' >> {}\n{change}\nprintf 'java.specification.version = 21\\njava.vendor = Fixture\\nos.arch = {}\\n' >&2\n",
        quoted(&root.join("java-probes")), std::env::consts::ARCH
    )).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    JavaSelection::Manual {
        path: executable.display().to_string(),
    }
}
fn launch(root: &Path, java: &JavaSelection) -> Result<crate::LaunchPlan, String> {
    crate::build_launch_plan_with_options(
        root,
        root,
        "Example",
        "Player",
        14,
        java,
        &[],
        &LaunchOptions::default(),
    )
}

#[test]
fn shared_and_each_ordinary_marker_agree_between_scan_and_actual_launch_arguments() {
    for marker in std::iter::once(None).chain(ISOLATION_MARKERS.into_iter().map(Some)) {
        let fixture = fixture();
        let root = fixture.path().canonicalize().unwrap();
        let version = root.join("versions/Example");
        let expected = if marker.is_some() {
            version.clone()
        } else {
            root.clone()
        };
        if let Some(marker) = marker {
            if marker == "options.txt" {
                fs::write(version.join(marker), b"music:0.5").unwrap();
            } else {
                fs::create_dir(version.join(marker)).unwrap();
            }
        }
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::write(root.join("mods/shared.jar"), b"shared contents").unwrap();
        if marker == Some("mods") {
            fs::write(version.join("mods/example.jar"), b"isolated contents").unwrap();
        }
        let instance = crate::scan_instance(&root, "Example").unwrap().unwrap();
        assert_eq!(instance.isolated, marker.is_some());
        assert_eq!(
            instance.mod_count,
            usize::from(marker.is_none() || marker == Some("mods"))
        );
        let plan = launch(&root, &java_fixture(&root, "")).unwrap();
        assert_eq!(plan.game_dir, expected);
        assert!(plan
            .args
            .windows(2)
            .any(|args| args[0] == "--gameDir" && args[1] == expected.display().to_string()));
    }
}

#[test]
fn unsafe_markers_report_the_selected_error_before_java_or_native_preparation() {
    for marker in ISOLATION_MARKERS {
        for broken in [false, true] {
            let fixture = fixture();
            let root = fixture.path();
            let target = root.join(if broken { "missing" } else { "shared" });
            if !broken {
                fs::create_dir(&target).unwrap();
            }
            symlink(&target, root.join("versions/Example").join(marker)).unwrap();
            let java = java_fixture(root, "");
            let error = launch(root, &java).unwrap_err();
            assert!(error.contains(marker));
            assert!(error.contains("符号链接"));
            assert!(!root.join("java-probes").exists());
            assert!(!root.join(".pcl-linux").exists());
            assert!(crate::scan_instance(root, "Example")
                .unwrap_err()
                .contains(marker));
            let report = crate::scan_instances_report(root).unwrap();
            assert!(report.instances.is_empty());
            assert_eq!(report.issues[0].id, "Example");
            assert!(report.issues[0].message.contains(marker));
        }
    }
    let fixture = fixture();
    let path = fixture.path().join("versions/Example/config");
    let _socket = std::os::unix::net::UnixListener::bind(path).unwrap();
    assert!(inspect(fixture.path(), "Example")
        .unwrap_err()
        .contains("特殊文件"));
}

#[test]
fn marker_changes_during_java_probe_fail_instead_of_switching_game_data() {
    for isolated in [false, true] {
        let fixture = fixture();
        let root = fixture.path();
        let marker = root.join("versions/Example/options.txt");
        if isolated {
            fs::write(&marker, b"music:0.5").unwrap();
        }
        let change = if isolated {
            format!("rm -f -- {}", quoted(&marker))
        } else {
            format!(": > {}", quoted(&marker))
        };
        let error = launch(root, &java_fixture(root, &change)).unwrap_err();
        assert!(error.contains("准备期间变化"));
        assert!(root.join("java-probes").exists());
        assert_eq!(inspect(root, "Example").unwrap().is_isolated(), !isolated);
    }
}

#[test]
fn later_probe_errors_are_not_hidden_by_an_earlier_present_marker() {
    let error = automatic_scope(|name| match name {
        "mods" => Ok(MarkerState::Present),
        "config" => Err("fixture I/O failure".into()),
        _ => Ok(MarkerState::Missing),
    })
    .unwrap_err();
    assert_eq!(error, "fixture I/O failure");
    let fixture = fixture();
    fs::create_dir(fixture.path().join("versions/Example/mods")).unwrap();
    symlink(
        "missing",
        fixture.path().join("versions/Example/options.txt"),
    )
    .unwrap();
    assert!(inspect(fixture.path(), "Example")
        .unwrap_err()
        .contains("options.txt"));
}

#[test]
fn one_bad_instance_does_not_hide_a_good_selection_or_allow_unsafe_identifiers() {
    let fixture = fixture();
    let root = fixture.path();
    fs::create_dir(root.join("versions/Broken")).unwrap();
    fs::write(
        root.join("versions/Broken/Broken.json"),
        br#"{"id":"Broken"}"#,
    )
    .unwrap();
    symlink("missing", root.join("versions/Broken/config")).unwrap();
    let report = crate::scan_instances_report(root).unwrap();
    assert_eq!(report.instances.len(), 1);
    assert_eq!(report.instances[0].id, "Example");
    assert_eq!(report.issues[0].id, "Broken");
    assert!(crate::scan_instance(root, "Example").unwrap().is_some());
    assert!(crate::scan_instance(root, "Missing").unwrap().is_none());
    for id in ["../Example", "/Example", "..", "a\\b"] {
        assert!(crate::scan_instance(root, id).is_err());
        assert!(ContentScope::Shared.relative_base(id).is_err());
        assert!(inspect(root, id).is_err());
    }
}
