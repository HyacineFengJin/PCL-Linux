//! Cross-service content binding. Public scan/resource paths, actual ZIP export
//! and metadata export must select the same fixture bytes and refuse an unsafe
//! marker without falling back to the other directory's similarly named mod.
use super::*;
use std::io::Read;
use std::os::unix::fs::symlink;

struct ContentFixture {
    _fixture: Fixture,
    root: PathBuf,
    destination: PathBuf,
}
impl ContentFixture {
    fn new() -> Self {
        let fixture = Fixture::new();
        let root = fixture.0.join("scope-game");
        fs::create_dir_all(root.join("versions/Example")).unwrap();
        fs::write(
            root.join("versions/Example/Example.json"),
            br#"{
            "id":"Example","mainClass":"FixtureMain","clientVersion":"1.20.1","libraries":[]
        }"#,
        )
        .unwrap();
        fs::write(root.join("versions/Example/Example.jar"), b"client fixture").unwrap();
        let destination = fixture.0.join("export.zip");
        Self {
            _fixture: fixture,
            root,
            destination,
        }
    }
    fn request(&self) -> instance_export::ExportRequest {
        instance_export::ExportRequest {
            name: "Example".into(),
            version: "1.0".into(),
            checks: Default::default(),
            excluded: Default::default(),
        }
    }
    fn selected(&self, base: &Path) -> resource_ops::ResourceFile {
        resource_ops::ResourceFile {
            file_name: "example.jar".into(),
            fingerprint: resource_ops::fingerprint(&base.join("mods/example.jar")).unwrap(),
        }
    }
}

#[test]
fn shared_and_isolated_sources_match_resource_paths_metadata_and_exported_zip_contents() {
    for isolated in [false, true] {
        let fixture = ContentFixture::new();
        let version = fixture.root.join("versions/Example");
        if isolated {
            fs::write(version.join("options.txt"), b"music:0.5").unwrap();
        }
        let selected = if isolated {
            version.clone()
        } else {
            fixture.root.clone()
        };
        fs::create_dir_all(selected.join("mods")).unwrap();
        fs::write(
            selected.join("mods/example.jar"),
            b"selected fixture content",
        )
        .unwrap();
        let other = if isolated {
            fixture.root.clone()
        } else {
            version.clone()
        };
        // resourcepacks is not an automatic marker: a same-name file there
        // must not make scan silently select a different resource directory.
        fs::create_dir_all(other.join("resourcepacks")).unwrap();
        fs::write(other.join("resourcepacks/other.zip"), b"unselected content").unwrap();
        let scan = pcl_core::scan_instance(&fixture.root, "Example")
            .unwrap()
            .unwrap();
        assert_eq!(scan.isolated, isolated);
        for (kind, child) in [
            ("mods", "mods"),
            ("saves", "saves"),
            ("screenshots", "screenshots"),
            ("resourcepacks", "resourcepacks"),
            ("shaderpacks", "shaderpacks"),
            ("litematics", "schematics"),
            ("server", ""),
        ] {
            assert_eq!(
                ui_data::resource_dir(&fixture.root, "Example", kind).unwrap(),
                selected.join(child)
            );
        }
        let information = local_resource_info::prepare(
            &fixture.root,
            "Example",
            "mods",
            &[fixture.selected(&selected)],
            &AtomicBool::new(false),
        )
        .unwrap();
        information.rehash(&AtomicBool::new(false)).unwrap();
        let document: serde_json::Value = serde_json::from_slice(&information.bytes).unwrap();
        assert_eq!(
            document["files"][0]["sizeBytes"],
            b"selected fixture content".len()
        );
        let plan = instance_export::prepare(&fixture.root, "Example", fixture.request()).unwrap();
        instance_export::execute(plan, &fixture.destination, &AtomicBool::new(false), |_| {})
            .unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(&fixture.destination).unwrap()).unwrap();
        let mut manifest = Vec::new();
        zip.by_name("pcl-export.json")
            .unwrap()
            .read_to_end(&mut manifest)
            .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        assert_eq!(manifest["game"]["isolated"], isolated);
        let content_root = if isolated {
            ".minecraft/versions/Example"
        } else {
            ".minecraft"
        };
        assert_eq!(manifest["content_root"], content_root);
        let mut contents = Vec::new();
        zip.by_name(&format!("{content_root}/mods/example.jar"))
            .unwrap()
            .read_to_end(&mut contents)
            .unwrap();
        assert_eq!(contents, b"selected fixture content");
        assert!(!zip.file_names().any(|name| name.ends_with("other.zip")));
    }
}

#[test]
fn links_and_special_markers_fail_across_consumers_without_using_shared_contents() {
    for linked in [true, false] {
        let fixture = ContentFixture::new();
        fs::create_dir(fixture.root.join("mods")).unwrap();
        fs::write(
            fixture.root.join("mods/example.jar"),
            b"must remain unchanged",
        )
        .unwrap();
        let marker = fixture.root.join("versions/Example/config");
        if linked {
            symlink("missing", &marker).unwrap();
        } else {
            let name = std::ffi::CString::new(marker.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        }
        for error in [
            pcl_core::scan_instance(&fixture.root, "Example").unwrap_err(),
            ui_data::resource_dir(&fixture.root, "Example", "mods").unwrap_err(),
            instance_export::prepare(&fixture.root, "Example", fixture.request()).unwrap_err(),
            local_resource_info::prepare(
                &fixture.root,
                "Example",
                "mods",
                &[fixture.selected(&fixture.root)],
                &AtomicBool::new(false),
            )
            .err()
            .unwrap(),
        ] {
            assert!(error.contains("config"), "{error}");
            assert!(error.contains("符号链接或特殊文件"), "{error}");
        }
        assert_eq!(
            fs::read(fixture.root.join("mods/example.jar")).unwrap(),
            b"must remain unchanged"
        );
        assert!(!fixture.destination.exists());
        assert!(!fixture.root.join(".pcl-linux").exists());
    }
}

#[test]
fn added_marker_invalidates_prepared_zip_and_metadata_without_rebinding_the_source() {
    let fixture = ContentFixture::new();
    fs::create_dir(fixture.root.join("mods")).unwrap();
    fs::write(
        fixture.root.join("mods/example.jar"),
        b"original shared mod",
    )
    .unwrap();
    let information = local_resource_info::prepare(
        &fixture.root,
        "Example",
        "mods",
        &[fixture.selected(&fixture.root)],
        &AtomicBool::new(false),
    )
    .unwrap();
    let plan = instance_export::prepare(&fixture.root, "Example", fixture.request()).unwrap();
    fs::write(
        fixture.root.join("versions/Example/options.txt"),
        b"music:0.5",
    )
    .unwrap();
    assert!(information.check().is_err());
    assert!(
        instance_export::execute(plan, &fixture.destination, &AtomicBool::new(false), |_| {})
            .is_err()
    );
    assert!(!fixture.destination.exists());
    assert_eq!(
        fs::read(fixture.root.join("mods/example.jar")).unwrap(),
        b"original shared mod"
    );
}
