use super::*;
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .find(|p| p.join("crates/core/Cargo.toml").is_file())
            .unwrap();
        let path = repo
            .join("work/launcher-local-actions-2026-10-05")
            .join(format!(
                "resource-info-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(path.join("versions/Example")).unwrap();
        fs::write(
            path.join("versions/Example/Example.json"),
            br#"{"id":"Example"}"#,
        )
        .unwrap();
        fs::create_dir(path.join("mods")).unwrap();
        Self(path)
    }
    fn jar(&self, name: &str) -> ResourceFile {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(
            br#"{"name":"Actual project","version":"2.0","description":"Selected file metadata"}"#,
        )
        .unwrap();
        let path = self.0.join("mods").join(name);
        fs::write(&path, zip.finish().unwrap().into_inner()).unwrap();
        ResourceFile {
            file_name: name.into(),
            fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
        }
    }
    fn archive(&self, kind: &str, name: &str, entries: &[(&str, &[u8])]) -> ResourceFile {
        fs::create_dir_all(self.0.join(kind)).unwrap();
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (entry, bytes) in entries {
            archive
                .start_file(*entry, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(bytes).unwrap();
        }
        let path = self.0.join(kind).join(name);
        fs::write(&path, archive.finish().unwrap().into_inner()).unwrap();
        ResourceFile {
            file_name: name.into(),
            fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn selected_metadata_preserves_filename_disabled_state_without_paths_or_payloads() {
    let f = Fixture::new();
    let selected = f.jar("actual.jar.disabled");
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    let document: serde_json::Value = serde_json::from_slice(&plan.bytes).unwrap();
    let row = &document["files"][0];
    assert_eq!(row["fileName"], "actual.jar.disabled");
    assert_eq!(row["name"], "Actual project");
    assert_eq!(row["version"], "2.0");
    assert_eq!(row["enabled"], false);
    assert!(row.get("path").is_none());
    assert!(row.get("icon").is_none());
    assert!(plan.warning.is_none());
    plan.rehash(&AtomicBool::new(false)).unwrap();
}
#[test]
fn stale_changed_content_symlink_and_duplicate_selection_refuse_without_exports() {
    let f = Fixture::new();
    let selected = f.jar("actual.jar");
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected.clone()],
        &AtomicBool::new(false),
    )
    .unwrap();
    fs::write(f.0.join("mods/actual.jar"), b"changed").unwrap();
    assert!(plan.rehash(&AtomicBool::new(false)).is_err());
    assert!(prepare(
        &f.0,
        "Example",
        "mods",
        &[selected.clone()],
        &AtomicBool::new(false)
    )
    .is_err());
    assert!(prepare(
        &f.0,
        "Example",
        "mods",
        &[selected.clone(), selected.clone()],
        &AtomicBool::new(false)
    )
    .is_err());
    let external = f.0.join("external.jar");
    fs::write(&external, b"private data").unwrap();
    std::os::unix::fs::symlink(&external, f.0.join("mods/link.jar")).unwrap();
    assert!(prepare(
        &f.0,
        "Example",
        "mods",
        &[ResourceFile {
            file_name: "link.jar".into(),
            fingerprint: selected.fingerprint
        }],
        &AtomicBool::new(false)
    )
    .is_err());
}
#[test]
fn changed_isolation_and_unknown_kinds_do_not_read_an_unrelated_source() {
    let f = Fixture::new();
    let selected = f.jar("actual.jar");
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected.clone()],
        &AtomicBool::new(false),
    )
    .unwrap();
    fs::create_dir(f.0.join("versions/Example/config")).unwrap();
    assert!(plan.check().is_err());
    assert!(!supported("saves", &[selected.clone()]));
    assert!(prepare(
        &f.0,
        "Example",
        "server",
        &[selected],
        &AtomicBool::new(false)
    )
    .is_err());
}
#[test]
fn bad_zip_exports_only_real_filename_and_explicit_metadata_warning() {
    let f = Fixture::new();
    let path = f.0.join("mods/plain.jar");
    fs::write(&path, b"not archive and not JSON-exported").unwrap();
    let selected = ResourceFile {
        file_name: "plain.jar".into(),
        fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
    };
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(plan.warning.is_some());
    assert!(!String::from_utf8_lossy(&plan.bytes).contains("not archive"));
    let doc: serde_json::Value = serde_json::from_slice(&plan.bytes).unwrap();
    assert_eq!(doc["files"][0]["name"], "plain.jar");
    assert!(doc["files"][0]["version"].is_null());
}
#[test]
fn cancellation_and_json_publication_leave_originals_and_existing_destination_intact() {
    let f = Fixture::new();
    let selected = f.jar("actual.jar");
    assert!(prepare(
        &f.0,
        "Example",
        "mods",
        &[selected.clone()],
        &AtomicBool::new(true)
    )
    .is_err());
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    let destination = f.0.join("selected-info.json");
    let result = crate::toolbox_images::publish::publish_new(
        &destination,
        &plan.bytes,
        "json",
        plan.count,
        || plan.check(),
    )
    .unwrap();
    assert_eq!(result.count, 1);
    assert_eq!(fs::read(&destination).unwrap(), plan.bytes);
    assert!(crate::toolbox_images::publish::publish_new(
        &destination,
        b"overwrite",
        "json",
        1,
        || Ok(())
    )
    .is_err());
    assert!(f.0.join("mods/actual.jar").is_file());
}
#[test]
fn raw_multiline_metadata_and_structured_pack_text_are_preserved_with_bom_instance() {
    let f = Fixture::new();
    fs::write(
        f.0.join("versions/Example/Example.json"),
        b"\xef\xbb\xbf{\"id\":\"Example\"}",
    )
    .unwrap();
    let description = format!("  first line\n{}\n last line  ", "中".repeat(9000));
    let metadata = serde_json::to_vec(&serde_json::json!({
        "name":"  Actual name  ", "version":" ${file.jarVersion} ", "description":description,
        "icon":"../private.png", "path":"/private/settings", "accounts":{"token":"never export account member"}
    })).unwrap();
    let selected = f.archive(
        "mods",
        "Raw name.jar",
        &[
            ("fabric.mod.json", &metadata),
            ("../private.png", b"never export icon member"),
            ("accounts.json", b"never export account member"),
        ],
    );
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    let document: serde_json::Value = serde_json::from_slice(&plan.bytes).unwrap();
    let row = &document["files"][0];
    assert_eq!(row["fileName"], "Raw name.jar");
    assert_eq!(row["name"], "  Actual name  ");
    assert_eq!(row["version"], " ${file.jarVersion} ");
    assert_eq!(row["description"], description);
    for field in ["path", "accounts", "token", "icon"] {
        assert!(row.get(field).is_none());
    }
    let output = String::from_utf8_lossy(&plan.bytes);
    assert!(!output.contains("/private/settings"));
    assert!(!output.contains("never export"));
    assert!(plan.warning.is_none());
    let text = serde_json::json!({"text":"  Original  ","extra":[{"translate":"pack.description","color":"gold"}]});
    let pack =
        serde_json::to_vec(&serde_json::json!({"pack":{"pack_format":34,"description":text}}))
            .unwrap();
    let selected = f.archive("resourcepacks", "Structured.zip", &[("pack.mcmeta", &pack)]);
    let plan = prepare(
        &f.0,
        "Example",
        "resourcepacks",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    let document: serde_json::Value = serde_json::from_slice(&plan.bytes).unwrap();
    assert_eq!(document["files"][0]["description"], text);
    assert!(plan.warning.is_none());
}
#[test]
fn declared_and_actual_inflated_metadata_limits_produce_explicit_fallback() {
    let f = Fixture::new();
    let valid = br#"{"name":"must not inflate declared oversized entry"}"#;
    let selected = f.archive("mods", "Declared.jar", &[("fabric.mod.json", valid)]);
    let path = f.0.join("mods/Declared.jar");
    let mut archive = fs::read(&path).unwrap();
    let index = archive.windows(4).position(|v| v == b"PK\x01\x02").unwrap();
    archive[22..26].copy_from_slice(&(1024u32 * 1024 * 1024).to_le_bytes());
    archive[index + 24..index + 28].copy_from_slice(&(1024u32 * 1024 * 1024).to_le_bytes());
    fs::write(&path, archive).unwrap();
    let declared = ResourceFile {
        fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
        ..selected
    };
    let actual = serde_json::to_vec(
        &serde_json::json!({"name":"oversized", "description":"x".repeat(262144)}),
    )
    .unwrap();
    let oversized = f.archive("mods", "Actual.jar", &[("fabric.mod.json", &actual)]);
    for selected in [declared, oversized] {
        let plan = prepare(
            &f.0,
            "Example",
            "mods",
            &[selected],
            &AtomicBool::new(false),
        )
        .unwrap();
        let document: serde_json::Value = serde_json::from_slice(&plan.bytes).unwrap();
        assert!(plan.warning.as_ref().unwrap().contains("1 个"));
        assert!(document["files"][0]["description"].is_null());
        assert_eq!(
            document["files"][0]["name"],
            document["files"][0]["fileName"]
        );
    }
}
#[test]
fn chooser_source_mutation_refuses_publication_and_late_conflict_is_retained() {
    let f = Fixture::new();
    let selected = f.jar("actual.jar");
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    let destination = f.0.join("selected.json");
    // A mutation while the native chooser was open invalidates the retained
    // source even when the final document was already encoded in memory.
    fs::write(f.0.join("mods/actual.jar"), b"changed while choosing").unwrap();
    assert!(plan.rehash(&AtomicBool::new(false)).is_err());
    assert!(crate::toolbox_images::publish::publish_new(
        &destination,
        &plan.bytes,
        "json",
        1,
        || plan.check()
    )
    .is_err());
    assert!(!destination.exists());
    let selected = f.jar("current.jar");
    let plan = prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(crate::toolbox_images::publish::publish_new(
        &destination,
        &plan.bytes,
        "json",
        1,
        || {
            plan.check()?;
            fs::write(&destination, b"external chosen file").unwrap();
            Ok(())
        }
    )
    .is_err());
    assert_eq!(fs::read(destination).unwrap(), b"external chosen file");
}
#[test]
fn hashing_batch_budget_and_deadline_refuse_before_export() {
    use std::time::Duration;
    let f = Fixture::new();
    fs::write(f.0.join("mods/first.jar"), b"12345678").unwrap();
    fs::write(f.0.join("mods/second.jar"), b"abcdefgh").unwrap();
    let folder = crate::launcher_local::filesystem::Dir::absolute(&f.0.join("mods")).unwrap();
    let closing = AtomicBool::new(false);
    let mut budget = Budget::limited(10, Duration::from_secs(1));
    Pinned::read(&folder, "first.jar", FILE_LIMIT, &mut budget, &closing).unwrap();
    assert!(Pinned::read(&folder, "second.jar", FILE_LIMIT, &mut budget, &closing).is_err());
    let mut expired = Budget::limited(10, Duration::ZERO);
    assert!(Pinned::read(&folder, "first.jar", FILE_LIMIT, &mut expired, &closing).is_err());
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 2);
}
#[test]
fn json_output_bound_applies_during_escaping_and_does_not_clip_metadata() {
    let document = Document {
        schema_version: 1,
        kind: "resourcepacks".into(),
        files: (0..24)
            .map(|i| Row {
                file_name: format!("{i}.zip"),
                name: format!("{i}.zip"),
                enabled: true,
                version: None,
                description: Some(serde_json::Value::String("\0".repeat(200000))),
                size_bytes: 42,
                fingerprint: "exact snapshot".into(),
            })
            .collect(),
    };
    assert!(encode(&document).is_err());
    let mut writer = JsonBuffer(Vec::new());
    writer.write_all(&vec![0; JSON_LIMIT]).unwrap();
    assert!(writer.write_all(b"extra").is_err());
    assert_eq!(writer.0.len(), JSON_LIMIT);
}
#[test]
fn zip_index_expansion_and_hardlinked_sources_do_not_authorize_metadata_reads() {
    let f = Fixture::new();
    let selected = f.jar("index.jar");
    let path = f.0.join("mods/index.jar");
    let original = fs::read(&path).unwrap();
    let footer = original
        .windows(4)
        .rposition(|v| v == b"PK\x05\x06")
        .unwrap();
    for expanded_entries in [true, false] {
        let mut bytes = original.clone();
        if expanded_entries {
            bytes[footer + 8..footer + 10].copy_from_slice(&65535u16.to_le_bytes());
            bytes[footer + 10..footer + 12].copy_from_slice(&65535u16.to_le_bytes());
        } else {
            bytes[footer + 12..footer + 16]
                .copy_from_slice(&(8u32 * 1024 * 1024 + 1).to_le_bytes());
        }
        fs::write(&path, bytes).unwrap();
        let selected = ResourceFile {
            fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
            ..selected.clone()
        };
        let plan = prepare(
            &f.0,
            "Example",
            "mods",
            &[selected],
            &AtomicBool::new(false),
        )
        .unwrap();
        let document: serde_json::Value = serde_json::from_slice(&plan.bytes).unwrap();
        assert!(plan.warning.is_some());
        assert_eq!(document["files"][0]["name"], "index.jar");
    }
    fs::hard_link(&path, f.0.join("outside.jar")).unwrap();
    let selected = ResourceFile {
        fingerprint: crate::resource_ops::fingerprint(&path).unwrap(),
        ..selected
    };
    assert!(prepare(
        &f.0,
        "Example",
        "mods",
        &[selected],
        &AtomicBool::new(false)
    )
    .is_err());
    assert_eq!(
        fs::read(&path).unwrap(),
        fs::read(f.0.join("outside.jar")).unwrap()
    );
}
