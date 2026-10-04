use super::*;
use std::{
    fs,
    io::Write,
    os::unix::fs::{symlink, MetadataExt},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

struct Fixture {
    base: PathBuf,
    source: PathBuf,
    target: PathBuf,
    archive: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("work/autonomous-2026-10-04/import/fixtures")
            .join(nonce());
        fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let source = base.join("source");
        let target = base.join("target");
        let archive = base.join("export.zip");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        Self {
            base,
            source,
            target,
            archive,
        }
    }
    fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let path = self.source.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn vanilla(&self, isolated: bool) {
        self.write("versions/original/original.json",json!({"id":"original","clientVersion":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[],"arguments":{"game":["--username","${auth_player_name}"]}}).to_string());
        self.write("versions/original/original.jar", b"example jar");
        self.write(
            if isolated {
                "versions/original/mods/example.jar"
            } else {
                "mods/example.jar"
            },
            b"example mod",
        );
    }
    fn export(&self, id: &str, bundle: bool) {
        let mut request = crate::instance_export::ExportRequest {
            name: "Example Pack".into(),
            version: "1.0".into(),
            checks: Default::default(),
            excluded: Default::default(),
        };
        request.checks.bundle_assets = bundle;
        let plan = crate::instance_export::prepare(&self.source, id, request).unwrap();
        crate::instance_export::execute(plan, &self.archive, &AtomicBool::new(false), |_| {})
            .unwrap();
    }
    fn operation(&self) -> PathBuf {
        fs::read_dir(self.target.join(".pcl-linux/instance-imports"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.is_dir())
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}

fn stage_all(plan: &ImportPlan) -> (Dir, Journal) {
    let root = Dir::open(&plan.root).unwrap();
    let store = storage(&root, true).unwrap().unwrap();
    let (operation, mut j) = setup(&root, &store, plan).unwrap();
    let mut zip = ZipArchive::new(open_source(&plan.source).unwrap()).unwrap();
    let mut done = 0;
    for (i, f) in plan.files.iter().enumerate() {
        if !f.reuse {
            stage_file(
                &operation,
                &mut j,
                i,
                &f.source,
                &mut zip,
                &AtomicBool::new(false),
                &mut done,
                &|_| {},
            )
            .unwrap();
        }
    }
    assemble_instance(&operation, &mut j, &AtomicBool::new(false)).unwrap();
    j.state = State::Prepared;
    write_journal(&operation, &j).unwrap();
    (operation, j)
}

#[test]
fn real_export_roundtrip_is_independent_named_and_opaque() {
    let f = Fixture::new();
    f.vanilla(false);
    f.export("original", false);
    let original = fs::read(&f.archive).unwrap();
    let plan = prepare(&f.target, &f.archive, "Imported Name").unwrap();
    let dto = serde_json::to_value(&plan).unwrap();
    assert_eq!(dto["pack_name"], "Example Pack");
    assert!(dto.get("source").is_none());
    assert!(dto.get("root").is_none());
    assert!(dto.get("files").is_none());
    execute(plan, &AtomicBool::new(false), |_| {}).unwrap();
    let folder = f.target.join("versions/Imported Name");
    assert_eq!(
        fs::read(folder.join("mods/example.jar")).unwrap(),
        b"example mod"
    );
    assert_eq!(
        fs::read(folder.join("Imported Name.jar")).unwrap(),
        b"example jar"
    );
    let data: Value =
        serde_json::from_slice(&fs::read(folder.join("Imported Name.json")).unwrap()).unwrap();
    assert_eq!(data["id"], "Imported Name");
    assert_eq!(data["jar"], "Imported Name");
    assert_eq!(data["clientVersion"], "1.20.1");
    assert!(folder.join("config").is_dir());
    assert!(!f.target.join("mods").exists());
    assert!(!f.target.join("versions/original").exists());
    assert_eq!(fs::read(&f.archive).unwrap(), original);
    ensure_ready(&f.target).unwrap();
}

#[test]
fn inheritance_is_flattened_with_runtime_library_override_and_verified_reuse() {
    let f = Fixture::new();
    f.write("versions/base/base.json",json!({"id":"base","clientVersion":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[{"name":"example:lib:1"}],"arguments":{"game":["base"],"jvm":["base-jvm"]}}).to_string());
    f.write("versions/base/base.jar", b"base jar");
    f.write("versions/child/child.json",json!({"id":"child","inheritsFrom":"base","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"example:lib:2"}],"arguments":{"game":["child"],"jvm":["child-jvm"]}}).to_string());
    f.write("versions/child/config/example.toml", b"setting=true");
    f.write("libraries/example/lib/1/lib-1.jar", b"old library");
    f.write("libraries/example/lib/2/lib-2.jar", b"new library");
    f.write(
        "libraries/generated/extra.jar",
        b"generated processor output",
    );
    f.export("child", true);
    let shared = f.target.join("libraries/example/lib/2/lib-2.jar");
    fs::create_dir_all(shared.parent().unwrap()).unwrap();
    fs::write(&shared, b"new library").unwrap();
    let identity = fs::metadata(&shared).unwrap().ino();
    let plan = prepare(&f.target, &f.archive, "Custom").unwrap();
    assert_eq!(plan.reused_files, 1);
    execute(plan, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(fs::metadata(&shared).unwrap().ino(), identity);
    let data: Value =
        serde_json::from_slice(&fs::read(f.target.join("versions/Custom/Custom.json")).unwrap())
            .unwrap();
    assert!(data.get("inheritsFrom").is_none());
    assert_eq!(data["arguments"]["game"], json!(["base", "child"]));
    assert_eq!(data["arguments"]["jvm"], json!(["base-jvm", "child-jvm"]));
    assert_eq!(data["libraries"], json!([{"name":"example:lib:2"}]));
    assert_eq!(
        fs::read(f.target.join("versions/Custom/Custom.jar")).unwrap(),
        b"base jar"
    );
    assert_eq!(
        fs::read(f.target.join("libraries/generated/extra.jar")).unwrap(),
        b"generated processor output"
    );
    assert_eq!(
        fs::read(f.target.join("versions/Custom/config/example.toml")).unwrap(),
        b"setting=true"
    );
    assert!(!f.target.join("versions/base").exists());
    assert!(!f.target.join("versions/child").exists());
}

#[test]
fn conflicting_shared_bytes_are_never_overwritten() {
    let f = Fixture::new();
    f.vanilla(true);
    f.write("libraries/extra.jar", b"new library");
    f.export("original", true);
    fs::create_dir_all(f.target.join("libraries")).unwrap();
    fs::write(f.target.join("libraries/extra.jar"), b"user library").unwrap();
    assert!(prepare(&f.target, &f.archive, "new")
        .unwrap_err()
        .contains("不同内容"));
    assert_eq!(
        fs::read(f.target.join("libraries/extra.jar")).unwrap(),
        b"user library"
    );
    assert!(!f.target.join(".pcl-linux").exists());
}

#[test]
fn source_and_target_changes_after_review_refuse_publication() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    fs::create_dir_all(f.target.join("versions/new")).unwrap();
    fs::write(f.target.join("versions/new/user.txt"), b"user data").unwrap();
    assert!(execute(plan, &AtomicBool::new(false), |_| {})
        .unwrap_err()
        .contains("变化"));
    assert_eq!(
        fs::read(f.target.join("versions/new/user.txt")).unwrap(),
        b"user data"
    );
    fs::remove_dir_all(f.target.join("versions/new")).unwrap();
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let mut bytes = fs::read(&f.archive).unwrap();
    bytes[0] ^= 1;
    fs::write(&f.archive, bytes).unwrap();
    assert!(execute(plan, &AtomicBool::new(false), |_| {})
        .unwrap_err()
        .contains("变化"));
    assert!(!f.target.join("versions/new").exists());
}

#[test]
fn replaced_captured_root_does_not_redirect_import() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let old = f.base.join("old-target");
    fs::rename(&f.target, &old).unwrap();
    fs::create_dir(&f.target).unwrap();
    assert!(execute(plan, &AtomicBool::new(false), |_| {})
        .unwrap_err()
        .contains("变化"));
    assert!(!f.target.join("versions").exists());
    assert!(!old.join("versions").exists());
}

#[test]
fn cancellation_during_extraction_removes_registered_and_anonymous_stage() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let cancel = AtomicBool::new(false);
    let message = execute(plan, &cancel, |p| {
        if p.stage == "import-extract" {
            cancel.store(true, Ordering::SeqCst);
        }
    })
    .unwrap_err();
    assert_eq!(message, "实例导入已取消");
    ensure_ready(&f.target).unwrap();
    assert!(!f.target.join("versions/new").exists());
    assert!(!f.operation().join("files").exists());
    assert!(!f.operation().join("instance").exists());
}

#[test]
fn cancellation_at_commit_gate_still_rolls_back_before_publication() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let cancel = AtomicBool::new(false);
    let message = execute(plan, &cancel, |p| {
        if p.stage == "import-commit" {
            cancel.store(true, Ordering::SeqCst);
        }
    })
    .unwrap_err();
    assert_eq!(message, "实例导入已取消");
    ensure_ready(&f.target).unwrap();
    assert!(!f.target.join("versions/new").exists());
}

#[test]
fn cleanup_conflict_is_an_error_even_when_cancelled_and_can_be_recovered() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let cancel = AtomicBool::new(false);
    let message = execute(plan, &cancel, |p| {
        if p.stage == "import-extract" {
            fs::write(f.operation().join("files/external.txt"), b"external data").unwrap();
            cancel.store(true, Ordering::SeqCst);
        }
    })
    .unwrap_err();
    assert!(message.contains("取消清理失败"));
    assert!(message.contains("实例导入已取消"));
    assert!(ensure_ready(&f.target).is_err());
    assert_eq!(
        fs::read(f.operation().join("files/external.txt")).unwrap(),
        b"external data"
    );
    fs::remove_file(f.operation().join("files/external.txt")).unwrap();
    recover_pending(&f.target).unwrap();
    ensure_ready(&f.target).unwrap();
}

#[test]
fn staging_recovery_needs_no_source_archive_and_removes_partial_registered_copy() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let root = Dir::open(&f.target).unwrap();
    let store = storage(&root, true).unwrap().unwrap();
    let (op, mut j) = setup(&root, &store, &plan).unwrap();
    let mut zip = ZipArchive::new(open_source(&f.archive).unwrap()).unwrap();
    let mut done = 0;
    stage_file(
        &op,
        &mut j,
        0,
        &plan.files[0].source,
        &mut zip,
        &AtomicBool::new(false),
        &mut done,
        &|_| {},
    )
    .unwrap();
    drop(zip);
    fs::remove_file(&f.archive).unwrap();
    drop(op);
    assert!(ensure_ready(&f.target).is_err());
    recover_pending(&f.target).unwrap();
    ensure_ready(&f.target).unwrap();
    assert!(!f.target.join("versions").exists());
}

#[test]
fn interrupted_shared_publication_rolls_back_only_owned_outputs() {
    let f = Fixture::new();
    f.vanilla(true);
    f.write("libraries/extra.jar", b"shared data");
    f.export("original", true);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let (op, mut j) = stage_all(&plan);
    let root = Dir::open(&f.target).unwrap();
    ensure_destination_dirs(&root, &op, &mut j).unwrap();
    let index = j
        .files
        .iter()
        .position(|p| p.target == "libraries/extra.jar")
        .unwrap();
    let files = op.child("files").unwrap();
    let (parent, name) = root.parent("libraries/extra.jar").unwrap();
    link_file(&files, &slot(index), &parent, &name).unwrap();
    drop(op);
    recover_pending(&f.target).unwrap();
    ensure_ready(&f.target).unwrap();
    assert!(!f.target.join("libraries").exists());
    assert!(!f.target.join("versions").exists());
}

#[test]
fn interrupted_instance_move_before_durable_commit_rolls_back_the_new_directory() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let (op, mut j) = stage_all(&plan);
    let root = Dir::open(&f.target).unwrap();
    ensure_destination_dirs(&root, &op, &mut j).unwrap();
    move_new(&op, "instance", &root.child("versions").unwrap(), "new").unwrap();
    drop(op);
    fs::remove_file(&f.archive).unwrap();
    recover_pending(&f.target).unwrap();
    assert!(!f.target.join("versions").exists());
    ensure_ready(&f.target).unwrap();
}

#[test]
fn committed_recovery_keeps_instance_and_retries_owned_stage_cleanup() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let (op, mut j) = stage_all(&plan);
    let root = Dir::open(&f.target).unwrap();
    publish(&root, &op, &mut j, &plan.source, &plan.source_snapshot).unwrap();
    fs::write(f.operation().join("files/external.txt"), b"user bytes").unwrap();
    assert!(recover_pending(&f.target).unwrap_err().contains("清理失败"));
    assert!(f.target.join("versions/new/new.jar").is_file());
    assert_eq!(
        fs::read(f.operation().join("files/external.txt")).unwrap(),
        b"user bytes"
    );
    fs::remove_file(f.operation().join("files/external.txt")).unwrap();
    recover_pending(&f.target).unwrap();
    ensure_ready(&f.target).unwrap();
    assert!(f.target.join("versions/new/new.jar").is_file());
}

fn raw_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut zip = ZipWriter::new(File::create(path).unwrap());
    for (name, bytes) in entries {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}
#[test]
fn foreign_formats_and_dangerous_archive_paths_are_explicitly_rejected() {
    let f = Fixture::new();
    raw_zip(&f.archive, &[("modrinth.index.json", b"{}")]);
    assert!(prepare(&f.target, &f.archive, "new")
        .unwrap_err()
        .contains("仅支持"));
    for path in [
        "../escape",
        ".minecraft/../escape",
        ".minecraft/colon:file",
        ".minecraft/back\\slash",
        "/absolute",
        ".minecraft/.pcl-linux/accounts.json",
    ] {
        raw_zip(&f.archive, &[(path, b"data")]);
        assert!(prepare(&f.target, &f.archive, "new").is_err(), "{path}");
    }
    raw_zip(
        &f.archive,
        &[(".minecraft/a", b"file"), (".minecraft/a/b", b"nested")],
    );
    assert!(prepare(&f.target, &f.archive, "new")
        .unwrap_err()
        .contains("冲突"));
}

#[test]
fn duplicate_paths_symlink_entries_and_bombs_are_rejected() {
    let f = Fixture::new();
    raw_zip(
        &f.archive,
        &[(".minecraft/a", b"one"), (".minecraft/b", b"two")],
    );
    let mut bytes = fs::read(&f.archive).unwrap();
    let needle = b".minecraft/b";
    for index in 0..bytes.len() - needle.len() + 1 {
        if &bytes[index..index + needle.len()] == needle {
            bytes[index + needle.len() - 1] = b'a';
        }
    }
    fs::write(&f.archive, bytes).unwrap();
    assert!(prepare(&f.target, &f.archive, "new")
        .unwrap_err()
        .contains("重复"));
    let mut zip = ZipWriter::new(File::create(&f.archive).unwrap());
    zip.add_symlink(".minecraft/link", "outside", SimpleFileOptions::default())
        .unwrap();
    zip.finish().unwrap();
    assert!(prepare(&f.target, &f.archive, "new")
        .unwrap_err()
        .contains("链接"));
    let mut zip = ZipWriter::new(File::create(&f.archive).unwrap());
    zip.start_file(
        ".minecraft/bomb",
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )
    .unwrap();
    zip.write_all(&vec![0; 4 * 1024 * 1024]).unwrap();
    zip.finish().unwrap();
    assert!(prepare(&f.target, &f.archive, "new")
        .unwrap_err()
        .contains("压缩比"));
}

#[test]
fn archive_and_destination_symlinks_are_refused_without_following_them() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let alias = f.base.join("alias.zip");
    symlink(&f.archive, &alias).unwrap();
    assert!(prepare(&f.target, &alias, "new").is_err());
    let outside = f.base.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, f.target.join("versions")).unwrap();
    assert!(prepare(&f.target, &f.archive, "new").is_err());
    assert!(fs::read_dir(outside).unwrap().next().is_none());
}

#[test]
fn import_lock_is_released_even_if_its_description_was_duplicated() {
    let f = Fixture::new();
    let root = Dir::open(&f.target).unwrap();
    let store = storage(&root, true).unwrap().unwrap();
    let first = lock(&store).unwrap();
    let duplicate = first.0.try_clone().unwrap();
    assert!(lock(&store).is_err());
    drop(first);
    let next = lock(&store).unwrap();
    drop(next);
    drop(duplicate);
}

#[test]
fn thousand_files_use_constant_full_journal_writes_with_individual_crash_registration() {
    let f = Fixture::new();
    f.vanilla(true);
    for index in 0..1000 {
        f.write(
            &format!("versions/original/config/example-{index}.txt"),
            format!("file {index}"),
        );
    }
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "large").unwrap();
    assert!(plan.file_count >= 1000);
    let before = FULL_JOURNAL_WRITES.with(|n| n.get());
    execute(plan, &AtomicBool::new(false), |p| {
        if p.stage == "import-commit" {
            let registered = fs::read_dir(f.operation())
                .unwrap()
                .map(|p| p.unwrap().file_name())
                .filter(|n| n.to_string_lossy().starts_with("owned-f-"))
                .count();
            assert!(
                registered >= 1000,
                "Every visible extracted inode must have a small durable registration"
            );
        }
    })
    .unwrap();
    let full_writes = FULL_JOURNAL_WRITES.with(|n| n.get()) - before;
    assert!(
        full_writes <= 8,
        "Full-plan writes must depend on transaction states, not pack file count: {full_writes}"
    );
    assert_eq!(
        fs::read(f.target.join("versions/large/config/example-999.txt")).unwrap(),
        b"file 999"
    );
}

#[test]
fn launcher_reference_commit_rejection_rolls_back_as_business_error() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let message = execute_checked(
        plan,
        &AtomicBool::new(false),
        |_| {},
        || Err("目标启动器设置已经变化".into()),
    )
    .unwrap_err();
    assert_eq!(message, "目标启动器设置已经变化");
    assert!(!f.target.join("versions/new").exists());
    ensure_ready(&f.target).unwrap();
}

#[test]
fn shared_legacy_asset_resources_are_preserved_for_root_runtime_and_isolated_game_content() {
    let f = Fixture::new();
    f.vanilla(false);
    f.write("versions/original/original.json",json!({"id":"original","clientVersion":"1.7.10","mainClass":"net.minecraft.client.main.Main","libraries":[],"assets":"legacy"}).to_string());
    let hash = "ab00000000000000000000000000000000000000";
    f.write(
        "assets/indexes/legacy.json",
        json!({"map_to_resources":true,"objects":{"lang/example.lang":{"hash":hash,"size":5}}})
            .to_string(),
    );
    f.write(&format!("assets/objects/ab/{hash}"), b"asset");
    f.write("resources/lang/example.lang", b"asset");
    f.export("original", true);
    let plan = prepare(&f.target, &f.archive, "legacy").unwrap();
    execute(plan, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(
        fs::read(f.target.join("resources/lang/example.lang")).unwrap(),
        b"asset"
    );
    assert_eq!(
        fs::read(f.target.join("versions/legacy/resources/lang/example.lang")).unwrap(),
        b"asset"
    );
    assert!(f.target.join("assets/indexes/legacy.json").is_file());
    ensure_ready(&f.target).unwrap();
}

#[test]
fn recovery_retries_after_partial_rollback_removed_its_created_directories() {
    let f = Fixture::new();
    f.vanilla(true);
    f.export("original", false);
    let plan = prepare(&f.target, &f.archive, "new").unwrap();
    let (op, mut j) = stage_all(&plan);
    let root = Dir::open(&f.target).unwrap();
    ensure_destination_dirs(&root, &op, &mut j).unwrap();
    fs::write(f.operation().join("files/external.txt"), b"external bytes").unwrap();
    assert!(recover_pending(&f.target).is_err());
    assert!(!f.target.join("versions").exists());
    fs::remove_file(f.operation().join("files/external.txt")).unwrap();
    recover_pending(&f.target).unwrap();
    ensure_ready(&f.target).unwrap();
}
