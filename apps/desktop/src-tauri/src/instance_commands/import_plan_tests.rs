//! Exercise the format boundary used by the real prepare/start commands.
use super::*;
use sha2::{Digest, Sha512};
use std::{
    fs,
    io::{Seek, SeekFrom, Write},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::{write::SimpleFileOptions, ZipWriter};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("work/mrpack-preview-2026-10-05/qa/command-fixtures")
            .join(format!(
                "{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(path.join("target")).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn target(&self) -> PathBuf {
        self.0.join("target")
    }
    fn mrpack(&self) -> PathBuf {
        // Deliberately use .zip: the native marker, not the chooser suffix,
        // decides whether the legacy writer may execute the archive.
        let path = self.0.join("generic.zip");
        let mut archive = ZipWriter::new(fs::File::create(&path).unwrap());
        let file = |path: &str, client: &str| {
            json!({"path":path,"hashes":{"sha1":"0".repeat(40),
                "sha512":format!("{:x}",Sha512::digest(b"mod"))},
                "env":{"client":client,"server":"unsupported"},
                "downloads":["https://cdn.modrinth.com/data/EXAMPLE1/mod.jar"],"fileSize":3})
        };
        let index = json!({"formatVersion":1,"game":"minecraft","versionId":"1.0",
            "name":"Example pack","files":[file("mods/required.jar","required"),
                file("mods/optional.jar","optional")],
            "dependencies":{"minecraft":"1.21.1","fabric-loader":"0.16.0"}});
        archive
            .start_file("modrinth.index.json", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(index.to_string().as_bytes()).unwrap();
        archive
            .start_file("overrides/config/example.txt", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"config").unwrap();
        archive.finish().unwrap();
        path
    }
    fn local_export(&self) -> PathBuf {
        let source = self.0.join("source");
        let version = source.join("versions/original");
        fs::create_dir_all(&version).unwrap();
        fs::write(
            version.join("original.json"),
            json!({"id":"original",
            "clientVersion":"1.20.1","mainClass":"net.minecraft.client.main.Main",
            "libraries":[],"arguments":{"game":[]}})
            .to_string(),
        )
        .unwrap();
        fs::write(version.join("original.jar"), b"generic game core").unwrap();
        let plan = crate::instance_export::prepare(
            &source,
            "original",
            crate::instance_export::ExportRequest {
                name: "Example local pack".into(),
                version: "1.0".into(),
                checks: Default::default(),
                excluded: Default::default(),
            },
        )
        .unwrap();
        // The producer correctly requires .zip. Rename its finished output to
        // verify that import dispatch still follows the content marker.
        let exported = self.0.join("local.zip");
        crate::instance_export::execute(plan, &exported, &AtomicBool::new(false), |_| {}).unwrap();
        let archive = self.0.join("local.mrpack");
        fs::rename(exported, &archive).unwrap();
        archive
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn native_marker_routes_mrpack_to_readonly_view_and_refuses_legacy_execution() {
    let fixture = Fixture::new();
    let source = fixture.mrpack();
    let original = fs::read(&source).unwrap();
    let plan = prepare_local_pack(&fixture.target(), &source, "Example imported", None).unwrap();
    let dto = serde_json::to_value(&plan).unwrap();
    assert_eq!(dto["format"], "modrinth");
    assert_eq!(dto["installable"], false);
    assert_eq!(dto["preview"]["required_files"], 1);
    assert_eq!(dto["preview"]["optional_files"], 1);
    assert_eq!(dto["preview"]["download_bytes"], 3);
    for field in ["root", "source", "source_snapshot", "root_key"] {
        assert!(dto.get(field).is_none());
    }
    assert!(!dto.to_string().contains("cdn.modrinth.com"));
    assert!(require_local_zip(&source)
        .unwrap_err()
        .contains("安装尚未开放"));
    assert_eq!(fs::read(&source).unwrap(), original);
    assert_eq!(fs::read_dir(fixture.target()).unwrap().count(), 0);
}

#[test]
fn optional_selection_rechecks_native_view_without_creating_an_instance() {
    let fixture = Fixture::new();
    let source = fixture.mrpack();
    let first = serde_json::to_value(
        prepare_local_pack(&fixture.target(), &source, "Example", None).unwrap(),
    )
    .unwrap();
    let selected = vec!["mods/optional.jar".into()];
    let next = serde_json::to_value(
        prepare_local_pack(&fixture.target(), &source, "Example", Some(&selected)).unwrap(),
    )
    .unwrap();
    assert_ne!(first["revision"], next["revision"]);
    assert_eq!(next["preview"]["download_bytes"], 6);
    assert_eq!(next["preview"]["excluded_files"], 0);
    assert_eq!(fs::read_dir(fixture.target()).unwrap().count(), 0);
}

#[test]
fn real_local_export_preserves_old_summary_and_execution_even_with_mrpack_suffix() {
    let fixture = Fixture::new();
    let source = fixture.local_export();
    require_local_zip(&source).unwrap();
    let original = fs::read(&source).unwrap();
    let LocalPackPlan::Zip(plan) =
        prepare_local_pack(&fixture.target(), &source, "Imported", None).unwrap()
    else {
        panic!("PCL marker must preserve its existing local import contract")
    };
    let dto = serde_json::to_value(&plan).unwrap();
    assert_eq!(dto["pack_name"], "Example local pack");
    assert!(dto.get("format").is_none());
    let paths = vec!["mods/optional.jar".into()];
    assert!(
        prepare_local_pack(&fixture.target(), &source, "Imported", Some(&paths))
            .err()
            .unwrap()
            .contains("不接受 mrpack")
    );
    instance_import::execute(plan, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(
        fs::read(fixture.target().join("versions/Imported/Imported.jar")).unwrap(),
        b"generic game core"
    );
    assert_eq!(fs::read(&source).unwrap(), original);
}

#[test]
fn recognition_keeps_large_legacy_archives_outside_mrpack_limits() {
    let fixture = Fixture::new();
    let source = fixture.local_export();
    let bytes = fs::read(&source).unwrap();
    // A sparse, legal gap before the central directory proves size routing
    // without generating or hashing half a gigabyte of fixture payload.
    let end = bytes.len() - 22;
    assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
    let central = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
    let moved = 513 * 1024 * 1024;
    let mut tail = bytes[central..].to_vec();
    let relative_end = end - central;
    tail[relative_end + 16..relative_end + 20].copy_from_slice(&(moved as u32).to_le_bytes());
    let mut file = fs::File::create(&source).unwrap();
    file.write_all(&bytes[..central]).unwrap();
    file.seek(SeekFrom::Start(moved)).unwrap();
    file.write_all(&tail).unwrap();
    file.sync_all().unwrap();
    drop(file);
    assert!(fs::metadata(&source).unwrap().len() > 512 * 1024 * 1024);
    assert!(!instance_import::mrpack::recognizes(&source).unwrap());
    require_local_zip(&source).unwrap();
    assert_eq!(fs::read_dir(fixture.target()).unwrap().count(), 0);
}
