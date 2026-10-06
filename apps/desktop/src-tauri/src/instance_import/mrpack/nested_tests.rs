//! Normal nested format routes and small fixtures for the two-layer budget.
//! Payload vectors here contain only fixture ZIPs; production streams to FD.
use super::*;
use serde_json::json;
use std::{
    fs,
    io::{Cursor, Read, Write},
    sync::atomic::{AtomicU64, Ordering},
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    _directory: crate::integration_tests::Fixture,
    base: PathBuf,
    root: PathBuf,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let work = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../work/nested-pack-2026-10-06/archive-fixtures");
        fs::create_dir_all(&work).unwrap();
        let base = work.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let root = base.join("root");
        fs::create_dir(&root).unwrap();
        Self {
            _directory: crate::integration_tests::Fixture(base.clone()),
            source: base.join("selected.data"),
            root,
            base,
        }
    }
    fn anonymous(&self) -> File {
        Dir::open(&self.base).unwrap().anonymous().unwrap()
    }
    fn prepare(&self, bytes: &[u8], optional: Option<&[String]>) -> Result<CheckedPack> {
        fs::write(&self.source, bytes).unwrap();
        prepare_checked_with_stage(
            &self.root,
            &self.source,
            "Imported",
            optional,
            &AtomicBool::new(false),
            |_| Ok(self.anonymous()),
        )
    }
    fn assert_untouched(&self, bytes: &[u8]) {
        assert_eq!(fs::read(&self.source).unwrap(), bytes);
        assert_eq!(fs::read_dir(&self.root).unwrap().count(), 0);
    }
}
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (path, body) in entries {
        writer.start_file(*path, options).unwrap();
        writer.write_all(body).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn mrpack(prefix: &str) -> Vec<u8> {
    let bytes = b"remote fixture";
    let index = serde_json::to_vec(&json!({
        "formatVersion": 1, "game": "minecraft", "versionId": "v1", "name": "Inner Fixture",
        "dependencies": {"minecraft": "1.21.1"},
        "files": [{"path":"mods/optional.jar","fileSize":bytes.len(),
            "hashes":{"sha1":format!("{:x}",sha1::Sha1::digest(bytes)),"sha512":format!("{:x}",sha2::Sha512::digest(bytes))},
            "downloads":["https://cdn.modrinth.com/fixture.jar"],"env":{"client":"optional","server":"unsupported"}}]
    })).unwrap();
    let marker = format!("{prefix}{INDEX}");
    let common = format!("{prefix}overrides/config/settings.cfg");
    let client = format!("{prefix}client-overrides/config/settings.cfg");
    zip(&[
        (&marker, &index),
        (&common, b"common"),
        (&client, b"client"),
    ])
}
fn failure(result: Result<CheckedPack>) -> String {
    match result {
        Ok(_) => panic!("unexpected nested authority"),
        Err(error) => error,
    }
}

#[test]
fn nested_root_wrapper_and_exact_hmcl_layouts_keep_inner_overlay_and_outer_binding() {
    let optional = vec!["mods/optional.jar".to_owned()];
    for path in [
        "modpack.zip",
        "modpack.mrpack",
        "Launcher/modpack.zip",
        "Launcher/modpack.mrpack",
        ".hmcl/modpack/modpack.zip",
        ".hmcl/modpack/modpack.mrpack",
        "Launcher/.hmcl/modpack/modpack.zip",
    ] {
        for prefix in ["", "Inner/"] {
            let fixture = Fixture::new();
            let inner = mrpack(prefix);
            let outer = zip(&[
                (path, &inner),
                ("launcher.exe", b"ignored executable"),
                ("launcher_accounts.json", b"ignored account"),
            ]);
            let checked = fixture.prepare(&outer, Some(&optional)).unwrap();
            assert_eq!(checked.plan.format, "modrinth");
            assert_eq!(checked.plan.pack_name, "Inner Fixture");
            assert_eq!(checked.plan.binding.source, fixture.source);
            assert_eq!(
                checked.plan.binding.source_snapshot.hash,
                format!("{:x}", Sha256::digest(&outer))
            );
            let binding = checked.plan.binding.inner.as_ref().unwrap();
            assert_eq!(
                binding.snapshot.hash,
                format!("{:x}", Sha256::digest(&inner))
            );
            assert_eq!(binding.outer_entry.archive_path, path);
            assert_eq!(checked.retained_source_fds(), 2);
            assert_eq!(checked.retained_inner_bytes(), inner.len() as u64);
            assert_eq!(checked.outputs.len(), 2);
            assert!(matches!(
                &checked.outputs["mods/optional.jar"],
                Output::Remote { .. }
            ));
            let Output::Override(config) = &checked.outputs["config/settings.cfg"] else {
                panic!("expected inner override")
            };
            assert_eq!(
                config.archive_path,
                format!("{prefix}client-overrides/config/settings.cfg")
            );
            assert_eq!(config.hash, format!("{:x}", Sha256::digest(b"client")));
            assert_eq!(checked.plan.preview.shadowed_files, 1);
            assert!(checked
                .plan
                .warnings
                .iter()
                .any(|warning| warning.contains("内层整合包")));
            let mut archive = ZipArchive::new(checked.content_file().unwrap()).unwrap();
            let mut body = Vec::new();
            archive
                .by_name(&config.archive_path)
                .unwrap()
                .read_to_end(&mut body)
                .unwrap();
            assert_eq!(body, b"client");
            checked.recheck_source(&AtomicBool::new(false)).unwrap();
            checked.recheck_source_stamp().unwrap();
            fixture.assert_untouched(&outer);
        }
    }
}

#[test]
fn nested_curseforge_preserves_remote_provider_blockers() {
    for remote in [false, true] {
        let fixture = Fixture::new();
        let manifest = serde_json::to_vec(&json!({"manifestType":"minecraftModpack","manifestVersion":1,
            "name":"CF Inner","version":"1","overrides":"overrides","minecraft":{"version":"1.21.1","modLoaders":[]},
            "files":if remote {json!([{"projectID":123,"fileID":456,"required":true}])} else {json!([])}})).unwrap();
        let inner = zip(&[
            ("manifest.json", &manifest),
            ("overrides/config/local.cfg", b"local"),
        ]);
        let outer = zip(&[("modpack.zip", &inner)]);
        let checked = fixture.prepare(&outer, None).unwrap();
        assert_eq!(checked.plan.format, "curseforge");
        assert_eq!(checked.outputs.len(), 1);
        assert_eq!(
            checked
                .plan
                .preview
                .blockers
                .iter()
                .any(|reason| reason.contains("官方文件元数据")),
            remote
        );
        fixture.assert_untouched(&outer);
    }
}

#[test]
fn nested_ready_game_core_and_shared_entries_use_only_content_fd() {
    let fixture = Fixture::new();
    let metadata = serde_json::to_vec(&json!({"id":"1.21.1","mainClass":"net.minecraft.client.main.Main",
        "javaVersion":{"majorVersion":21},"libraries":[{"name":"fixture:library:1","downloads":{"artifact":{"path":"fixture/library/1/library-1.jar","size":6,"sha1":format!("{:x}",sha1::Sha1::digest(b"shared"))}}}],
        "arguments":{"game":[],"jvm":[]}})).unwrap();
    let inner = zip(&[
        ("versions/1.21.1/1.21.1.json", &metadata),
        ("versions/1.21.1/1.21.1.jar", b"core"),
        ("libraries/fixture/library/1/library-1.jar", b"shared"),
        ("config/local.cfg", b"local"),
    ]);
    let outer = zip(&[
        ("Wrapped/modpack.zip", &inner),
        ("launcher_accounts.json", b"ignored"),
    ]);
    let checked = fixture.prepare(&outer, None).unwrap();
    assert_eq!(checked.plan.format, "ready_game");
    let bundled = checked.bundled.as_ref().unwrap();
    assert_eq!(bundled.jar.archive_path, "versions/1.21.1/1.21.1.jar");
    assert_eq!(bundled.shared.len(), 1);
    assert!(checked.plan.preview.blockers.is_empty());
    let mut archive = ZipArchive::new(checked.content_file().unwrap()).unwrap();
    let mut actual = Vec::new();
    archive
        .by_name(&bundled.jar.archive_path)
        .unwrap()
        .read_to_end(&mut actual)
        .unwrap();
    assert_eq!(actual, b"core");
    assert_eq!(checked.outputs.len(), 1);
    fixture.assert_untouched(&outer);
}

#[test]
fn nested_legacy_pcl_requires_direct_inner_selection() {
    let fixture = Fixture::new();
    let inner = zip(&[("pcl-export.json", b"{}")]);
    let outer = zip(&[("modpack.zip", &inner)]);
    let error = failure(fixture.prepare(&outer, None));
    assert!(error.contains("直接选择内层文件"), "{error}");
    fixture.assert_untouched(&outer);
}

#[test]
fn nested_central_candidate_limit_precedes_allocation() {
    let fixture = Fixture::new();
    let mut outer = zip(&[("modpack.zip", b"small body")]);
    let central = outer
        .windows(4)
        .position(|bytes| bytes == b"PK\x01\x02")
        .unwrap();
    outer[central + 24..central + 28]
        .copy_from_slice(&(2u32 * 1024 * 1024 * 1024 + 1).to_le_bytes());
    fs::write(&fixture.source, &outer).unwrap();
    let error = failure(prepare_checked_with_stage(
        &fixture.root,
        &fixture.source,
        "Imported",
        None,
        &AtomicBool::new(false),
        |_| panic!("oversize candidate reached allocation"),
    ));
    assert!(error.contains("2 GiB"), "{error}");
    fixture.assert_untouched(&outer);
}

#[test]
fn nested_declared_and_actual_decoded_layers_share_one_remaining_budget() {
    let fixture = Fixture::new();
    let index = serde_json::to_vec(&json!({"formatVersion":1,"game":"minecraft","versionId":"1","name":"Budget","files":[],"dependencies":{"minecraft":"1.21.1"}})).unwrap();
    let inner = zip(&[(INDEX, &index), ("overrides/config/local.cfg", b"inner")]);
    let outer = zip(&[
        ("modpack.zip", &inner),
        ("launcher.exe", b"ignored launcher"),
    ]);
    fs::write(&fixture.source, &outer).unwrap();
    let entry = formats::nested_entry(
        &open_source(&fixture.source).unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let mut destination = fixture.anonymous();
    let scan = formats::scan_outer(
        open_source(&fixture.source).unwrap(),
        &entry,
        &mut destination,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        scan.decoded_bytes,
        inner.len() as u64 + b"ignored launcher".len() as u64
    );
    let inner_decoded = index.len() as u64 + b"inner".len() as u64;
    let fixture_total_limit = scan.decoded_bytes + inner_decoded;
    let remaining = fixture_total_limit - scan.decoded_bytes;
    assert!(formats::prepare_with_budget(
        destination.try_clone().unwrap(),
        "Imported",
        formats::Format::Modrinth,
        None,
        &AtomicBool::new(false),
        remaining - 1
    )
    .is_err());
    let prepared = formats::prepare_with_budget(
        destination,
        "Imported",
        formats::Format::Modrinth,
        None,
        &AtomicBool::new(false),
        remaining,
    )
    .unwrap();
    assert_eq!(prepared.outputs.len(), 1);
    fixture.assert_untouched(&outer);
}

#[test]
fn nested_classification_prepare_and_final_source_hash_honor_cancellation() {
    let fixture = Fixture::new();
    let outer = zip(&[("modpack.zip", &mrpack(""))]);
    let checked = fixture.prepare(&outer, None).unwrap();
    let cancel = AtomicBool::new(true);
    assert!(formats::classify_cancellable(&fixture.source, &cancel)
        .unwrap_err()
        .contains("取消"));
    assert!(is_local_export_cancellable(&fixture.source, &cancel)
        .unwrap_err()
        .contains("取消"));
    assert!(checked
        .plan
        .recheck_cancellable(&cancel)
        .unwrap_err()
        .contains("取消"));
    assert!(checked
        .recheck_source(&cancel)
        .unwrap_err()
        .contains("取消"));
    assert!(failure(prepare_checked_with_stage(
        &fixture.root,
        &fixture.source,
        "Imported",
        None,
        &cancel,
        |_| panic!("cancel reached allocation")
    ))
    .contains("取消"));
    fixture.assert_untouched(&outer);
}

#[test]
fn nested_launcher_siblings_do_not_hide_competing_ready_game_marker() {
    let fixture = Fixture::new();
    let inner = mrpack("");
    let mut entries = (0..128)
        .map(|index| {
            (
                format!("Sibling{index}/launcher.cfg"),
                b"ignored".as_slice(),
            )
        })
        .collect::<Vec<_>>();
    entries.push(("modpack.zip".into(), &inner));
    let outer = zip(&entries
        .iter()
        .map(|(path, body)| (path.as_str(), *body))
        .collect::<Vec<_>>());
    let checked = fixture.prepare(&outer, None).unwrap();
    assert_eq!(checked.plan.format, "modrinth");
    for path in [
        "versions/1.21.1/1.21.1.json",
        "Sibling127/.minecraft/versions/1.21.1/1.21.1.json",
    ] {
        let mut competing = entries.clone();
        competing.push((path.into(), b"{}"));
        let outer = zip(&competing
            .iter()
            .map(|(path, body)| (path.as_str(), *body))
            .collect::<Vec<_>>());
        let error = failure(fixture.prepare(&outer, None));
        assert!(error.contains("歧义"), "{error}");
        fixture.assert_untouched(&outer);
    }
}
