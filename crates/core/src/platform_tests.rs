//! Explicit target fixtures run on every CI host; they never launch a real JVM
//! or treat a successful metadata check as evidence of desktop support.
use super::*;
use crate::rules::RuleContext;
use serde_json::json;

fn target(os: OperatingSystem, arch: Architecture) -> Platform {
    Platform { os, arch }
}

#[test]
fn modern_classifiers_select_exact_os_and_arch_even_without_arch_rules() {
    use Architecture::*;
    use OperatingSystem::*;
    let fixtures = [
        ("natives-linux", Linux, X86_64),
        ("linux-x86_64", Linux, X86_64),
        ("linux-aarch_64", Linux, Arm64),
        ("natives-linux-arm32", Linux, Arm32),
        ("natives-macos", MacOs, X86_64),
        ("natives-macos-patch", MacOs, X86_64),
        ("natives-macos-arm64", MacOs, Arm64),
        ("natives-windows", Windows, X86_64),
        ("natives-windows-x86", Windows, X86),
        ("natives-windows-arm64", Windows, Arm64),
    ];
    for (classifier, os, arch) in fixtures {
        let library = json!({"name":format!("org.example:native:1:{classifier}"),"rules":[{"action":"allow","os":{"name":os.minecraft_name()}}]});
        for host_os in [Linux, MacOs, Windows] {
            for host_arch in [X86, X86_64, Arm32, Arm64] {
                let platform = target(host_os, host_arch);
                let context = RuleContext {
                    platform,
                    release: "1".into(),
                    custom_resolution: false,
                };
                let expected = host_os == os && host_arch == arch;
                assert_eq!(
                    context.library_allowed(&library).unwrap(),
                    expected,
                    "{platform:?} {classifier}"
                );
                assert_eq!(
                    platform
                        .native_artifact(library["name"].as_str().unwrap())
                        .unwrap(),
                    expected
                );
            }
        }
    }
}

#[test]
fn classifiers_do_not_infer_target_from_artifact_names_and_do_not_guess_unknown_binaries() {
    let p = target(OperatingSystem::Windows, Architecture::X86_64);
    for name in [
        "example:linux-arm:1",
        "example:natives-linux:1:sources",
        "example:api:1",
    ] {
        assert!(p.library_matches(name).unwrap());
        assert!(!p.native_artifact(name).unwrap());
    }
    assert!(p
        .native_artifact("example:api:1:natives-linux-riscv64")
        .is_err());
    assert!(p
        .native_artifact("example:api:1:natives-windows-unknown")
        .is_err());
    assert!(p
        .native_artifact("example:api:1:natives-windows@jar")
        .unwrap());
}

#[test]
fn legacy_classifier_selects_host_os_expands_bits_and_refuses_x64_on_arm() {
    use Architecture::*;
    use OperatingSystem::*;
    let library = json!({"natives":{"linux":"natives-linux","windows":"natives-windows-${arch}","osx":"natives-osx"}});
    for (os, arch, expected) in [
        (Linux, X86_64, "natives-linux"),
        (Linux, X86, "natives-linux"),
        (Windows, X86_64, "natives-windows-64"),
        (Windows, X86, "natives-windows-32"),
        (MacOs, X86_64, "natives-osx"),
    ] {
        assert_eq!(
            target(os, arch)
                .legacy_native_classifier(&library)
                .unwrap()
                .as_deref(),
            Some(expected)
        );
    }
    for os in [Linux, Windows, MacOs] {
        assert!(target(os, Arm64)
            .legacy_native_classifier(&library)
            .is_err());
    }
    assert_eq!(
        target(Linux, X86_64)
            .legacy_native_classifier(&json!({}))
            .unwrap(),
        None
    );
}

#[test]
fn architecture_rules_do_not_match_x64_by_x86_prefix_and_keep_regex_errors() {
    for (arch, pattern, expected) in [
        (Architecture::X86, "x86", true),
        (Architecture::X86_64, "x86", false),
        (Architecture::X86_64, "amd64", true),
        (Architecture::Arm64, "arm64", true),
        (Architecture::X86_64, "x86.*", true),
    ] {
        let context = RuleContext {
            platform: target(OperatingSystem::Linux, arch),
            release: "6.8".into(),
            custom_resolution: false,
        };
        assert_eq!(
            context
                .allowed(&json!({"rules":[{"action":"allow","os":{"arch":pattern}}]}))
                .unwrap(),
            expected
        );
        assert!(context
            .allowed(&json!({"rules":[{"action":"allow","os":{"arch":"["}}]}))
            .is_err());
    }
}

#[test]
fn macos_rules_enable_first_thread_and_unknown_os_versions_do_not_match() {
    let p = target(OperatingSystem::MacOs, Architecture::Arm64);
    let mut context = RuleContext {
        platform: p,
        release: "14.6".into(),
        custom_resolution: true,
    };
    let entry = json!({"rules":[{"action":"allow","os":{"name":"osx","version":"^14\\."},"features":{"has_custom_resolution":true}}]});
    assert!(context.allowed(&entry).unwrap());
    context.release.clear();
    assert!(!context.allowed(&entry).unwrap());
    context.release = "14.6".into();
    context.custom_resolution = false;
    assert!(!context.allowed(&entry).unwrap());
    assert!(!context
        .allowed(&json!({"rules":[{"action":"allow"},{"action":"disallow","os":{"name":"osx"}}]}))
        .unwrap());
    let args = crate::expand(
        &[json!({"rules":[{"action":"allow","os":{"name":"osx"}}],"value":"-XstartOnFirstThread"})],
        &Default::default(),
        &context,
    )
    .unwrap();
    assert_eq!(args, ["-XstartOnFirstThread"]);
}

#[test]
fn java_paths_and_runtime_platform_keys_cover_native_layouts() {
    use Architecture::*;
    use OperatingSystem::*;
    for (os, arch, key) in [
        (Linux, X86_64, "linux"),
        (Linux, X86, "linux-i386"),
        (Windows, X86, "windows-x86"),
        (Windows, X86_64, "windows-x64"),
        (Windows, Arm64, "windows-arm64"),
        (MacOs, X86_64, "mac-os"),
        (MacOs, Arm64, "mac-os-arm64"),
    ] {
        assert_eq!(target(os, arch).mojang_java_platform(), Some(key));
    }
    assert_eq!(target(Linux, Arm64).mojang_java_platform(), None);
    assert_eq!(
        target(Windows, X86_64).java_paths(Path::new("runtime")),
        [Path::new("runtime/bin/java.exe").to_path_buf()]
    );
    let mac = target(MacOs, Arm64);
    assert!(mac
        .java_paths(Path::new("jdk"))
        .contains(&PathBuf::from("jdk/Contents/Home/bin/java")));
    assert!(mac
        .java_paths(Path::new("runtime"))
        .contains(&PathBuf::from("runtime/jre.bundle/Contents/Home/bin/java")));
    assert_eq!(mac.classpath_separator(), ":");
    assert_eq!(target(Windows, X86_64).classpath_separator(), ";");
}

#[test]
fn native_extraction_keeps_only_host_library_formats_and_honors_excludes() {
    use std::io::Write;
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../work/platform-tests");
    std::fs::create_dir_all(&base).unwrap();
    let fixture = tempfile::tempdir_in(base).unwrap();
    let archive = fixture.path().join("native.jar");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    for name in [
        "linux/x64/lib.so",
        "linux/x64/lib.so.1.2",
        "lib.so.sha1",
        "macos/arm64/lib.dylib",
        "macos/lib.jnilib",
        "win/x64/a.DLL",
        "a.dll.sha1",
        "META-INF/excluded.dll",
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"fixture").unwrap();
    }
    zip.finish().unwrap();
    for (os, expected) in [
        (OperatingSystem::Linux, vec!["lib.so", "lib.so.1.2"]),
        (OperatingSystem::MacOs, vec!["lib.dylib", "lib.jnilib"]),
        (OperatingSystem::Windows, vec!["a.DLL"]),
    ] {
        let output = fixture.path().join(os.minecraft_name());
        std::fs::create_dir(&output).unwrap();
        crate::extract_natives_for(
            &archive,
            &output,
            &[json!("META-INF/")],
            target(os, Architecture::X86_64),
        )
        .unwrap();
        let mut actual: Vec<_> = std::fs::read_dir(&output)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_str().unwrap().to_owned())
            .collect();
        actual.sort();
        assert_eq!(actual, expected);
        for name in expected {
            assert_eq!(std::fs::read(output.join(name)).unwrap(), b"fixture");
        }
    }
}

#[test]
fn windows_device_and_alias_components_are_rejected_without_banning_ordinary_names() {
    for name in [
        "CON",
        "con.txt",
        "LPT1.zip",
        "COM¹.jar",
        "NUL",
        "CONOUT$",
        "trailing.",
        "trailing ",
        "a:b",
        "a?b",
        "a\u{1}b",
    ] {
        assert!(windows_reserved_component(name), "{name}");
    }
    for name in ["Console", "a b", "a.jar", "COM10", "LPT0", "普通实例"] {
        assert!(!windows_reserved_component(name), "{name}");
    }
}

#[cfg(windows)]
#[test]
fn windows_safe_join_accepts_native_components_but_rejects_devices_ads_and_traversal() {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../work/platform-tests");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    assert!(crate::safe_join(
        root.path(),
        Path::new("versions").join("Example").join("mods")
    )
    .is_ok());
    for path in [
        "CON.txt",
        "versions/NUL",
        "versions/a:stream",
        "../outside",
        "x/../../outside",
        "C:/absolute",
        "trailing.",
    ] {
        assert!(crate::safe_join(root.path(), path).is_err(), "{path}");
    }
}

#[test]
fn host_detection_and_version_evidence_agree_with_compiled_target() {
    let p = Platform::current().unwrap();
    assert_eq!(
        p.arch.name(),
        Architecture::parse(std::env::consts::ARCH).unwrap().name()
    );
    assert!(!os_version().is_empty());
}
