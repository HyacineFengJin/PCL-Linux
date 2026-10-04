use super::*;
use std::{
    ffi::CString,
    fs::{self, File},
    os::unix::{
        ffi::OsStrExt,
        fs::{symlink, MetadataExt},
    },
};

struct Fixture {
    path: PathBuf,
    root: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("work/autonomous-2026-10-04/delete/tests")
            .join(nonce());
        fs::create_dir_all(path.join("game/versions/sample/saves/world")).unwrap();
        fs::create_dir_all(path.join("project/.pcl-rust")).unwrap();
        let path = path.canonicalize().unwrap();
        let root = path.join("game");
        let project = path.join("project");
        fs::write(
            root.join("versions/sample/sample.json"),
            br#"{"id":"sample","jar":"sample"}"#,
        )
        .unwrap();
        fs::write(root.join("versions/sample/sample.jar"), b"client jar").unwrap();
        fs::write(
            root.join("versions/sample/saves/world/level.dat"),
            b"world data",
        )
        .unwrap();
        for (name, data) in [
            ("libraries/shared.jar", b"shared jar".as_slice()),
            ("assets/indexes/shared.json", b"asset index"),
            ("mods/shared.jar", b"global mod"),
        ] {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, data).unwrap();
        }
        let result = Self {
            path,
            root,
            project,
        };
        result.write_settings(result.settings());
        fs::write(
            result.project.join(".pcl-rust/instance-metadata.json"),
            br#"{"kept":"sample metadata"}"#,
        )
        .unwrap();
        fs::create_dir_all(result.project.join(".pcl-rust/export-presets")).unwrap();
        fs::write(
            result.project.join(".pcl-rust/export-presets/sample.json"),
            b"sample preset",
        )
        .unwrap();
        result
    }
    fn source(&self) -> PathBuf {
        self.root.join("versions/sample")
    }
    fn settings(&self) -> Value {
        json!({"schema_version":3,"active_root_id":"root-fixture","player":"Player","memory_gib":6,
            "java":{"mode":"auto"},"java_paths":[],
            "roots":[{"id":"root-fixture","name":"Game","path":self.root,"selected":"sample","overrides":{"sample":8},"java_overrides":{}}]})
    }
    fn write_settings(&self, value: Value) {
        fs::write(
            self.project.join(".pcl-rust/settings.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn plan(&self) -> DeletePlan {
        prepare(&self.root, &self.project, "root-fixture", "sample").unwrap()
    }
    fn delete(&self) -> DeleteHistoryEntry {
        execute(
            &self.root,
            &self.project,
            self.plan(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        history(&self.root, &self.project, "root-fixture")
            .unwrap()
            .remove(0)
    }
    fn staged(&self) -> (Dir, Dir, Dir, Record) {
        let plan = self.plan();
        let root = Dir::open(&self.root).unwrap();
        let store = storage(&root, true).unwrap().unwrap();
        let name = nonce();
        let operation = store.create(&name).unwrap();
        let journal = Journal {
            schema: 1,
            operation_id: name,
            root_id: plan.root_id,
            id: plan.id,
            root: plan.root,
            project: plan.project,
            root_key: plan.root_key,
            project_key: plan.project_key,
            versions_key: plan.versions_key,
            storage_key: store.key().unwrap(),
            operation_key: operation.key().unwrap(),
            created_ms: 1,
            state: State::Prepared,
            tree: plan.tree,
            marker_cleared: false,
            generation: 0,
            previous_hash: None,
        };
        let mut record = Record {
            journal,
            token: None,
        };
        write_record(&operation, &mut record).unwrap();
        create_marker(&record.journal).unwrap();
        (root, store, operation, record)
    }
    fn restore(&self, entry: &DeleteHistoryEntry) -> Result<Value> {
        undo(
            &self.root,
            &self.project,
            "root-fixture",
            &entry.operation_id,
            entry.revision.as_ref().unwrap(),
            &AtomicBool::new(false),
            |_| {},
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn deletion_and_restore_preserve_content_inodes_shared_resources_and_launcher_references() {
    let f = Fixture::new();
    let world = f.source().join("saves/world/level.dat");
    let inode = fs::metadata(&world).unwrap().ino();
    let settings = fs::read(f.project.join(".pcl-rust/settings.json")).unwrap();
    let metadata = fs::read(f.project.join(".pcl-rust/instance-metadata.json")).unwrap();
    let entry = f.delete();
    assert!(entry.can_restore);
    assert!(!f.source().exists());
    assert!(ensure_ready(&f.root).is_ok());
    assert!(ensure_name_available(&f.root, "sample").is_err());
    assert!(ensure_name_available(&f.root, "other").is_ok());
    assert_eq!(
        fs::read(f.root.join("libraries/shared.jar")).unwrap(),
        b"shared jar"
    );
    assert_eq!(
        fs::read(f.root.join("mods/shared.jar")).unwrap(),
        b"global mod"
    );
    assert_eq!(
        fs::read(f.root.join("assets/indexes/shared.json")).unwrap(),
        b"asset index"
    );
    assert_eq!(
        fs::read(f.project.join(".pcl-rust/settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        fs::read(f.project.join(".pcl-rust/instance-metadata.json")).unwrap(),
        metadata
    );
    assert_eq!(
        fs::read(f.project.join(".pcl-rust/export-presets/sample.json")).unwrap(),
        b"sample preset"
    );
    f.restore(&entry).unwrap();
    assert_eq!(fs::metadata(&world).unwrap().ino(), inode);
    assert_eq!(fs::read(world).unwrap(), b"world data");
    assert!(ensure_name_available(&f.root, "sample").is_ok());
    assert!(history(&f.root, &f.project, "root-fixture")
        .unwrap()
        .is_empty());
}

#[test]
fn dependency_instances_are_rejected_for_inheritance_and_jar() {
    for field in ["inheritsFrom", "jar"] {
        let f = Fixture::new();
        let directory = f.root.join("versions/dependent");
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("dependent.json"),
            serde_json::to_vec(&json!({"id":"dependent",field:"sample"})).unwrap(),
        )
        .unwrap();
        assert!(f.plan_error().contains(field));
        assert!(f.source().exists());
    }
}
impl Fixture {
    fn plan_error(&self) -> String {
        prepare(&self.root, &self.project, "root-fixture", "sample").unwrap_err()
    }
}

#[test]
fn stale_tree_or_new_dependency_is_rejected_before_move() {
    let f = Fixture::new();
    let plan = f.plan();
    fs::write(f.source().join("saves/world/level.dat"), b"external edit").unwrap();
    assert!(execute(&f.root, &f.project, plan, &AtomicBool::new(false), |_| {}).is_err());
    assert!(f.source().exists());
    let plan = f.plan();
    let directory = f.root.join("versions/new-dependent");
    fs::create_dir(&directory).unwrap();
    fs::write(
        directory.join("new-dependent.json"),
        br#"{"id":"new-dependent","jar":"sample"}"#,
    )
    .unwrap();
    assert!(execute(&f.root, &f.project, plan, &AtomicBool::new(false), |_| {}).is_err());
    assert!(f.source().exists());
}

#[test]
fn runtime_dependencies_include_aliases_and_manual_choices_from_other_roots() {
    let f = Fixture::new();
    let runtime = f.source().join("runtime/bin/java");
    fs::create_dir_all(runtime.parent().unwrap()).unwrap();
    fs::write(&runtime, b"not executed").unwrap();
    let alias = f.path.join("java-alias");
    symlink(&runtime, &alias).unwrap();
    let mut settings = f.settings();
    settings["java_paths"] = json!([alias]);
    f.write_settings(settings);
    assert!(f.plan_error().contains("Java"));
    let other = f.path.join("other-game");
    fs::create_dir(&other).unwrap();
    let mut settings = f.settings();
    settings["roots"].as_array_mut().unwrap().push(
        json!({"id":"root-other","name":"Other","path":other,"selected":"other","overrides":{},
        "java_overrides":{"other":{"mode":"manual","path":f.source().join("missing/java")}}}),
    );
    f.write_settings(settings);
    assert!(f.plan_error().contains("Java"));
}

#[test]
fn symlinks_hard_links_and_special_content_are_preserved_and_rejected() {
    let f = Fixture::new();
    symlink(f.root.join("mods"), f.source().join("external-mods")).unwrap();
    assert!(prepare(&f.root, &f.project, "root-fixture", "sample").is_err());
    assert!(f.root.join("mods/shared.jar").exists());
    fs::remove_file(f.source().join("external-mods")).unwrap();
    fs::hard_link(
        f.root.join("mods/shared.jar"),
        f.source().join("hardlink.jar"),
    )
    .unwrap();
    assert!(prepare(&f.root, &f.project, "root-fixture", "sample").is_err());
    fs::remove_file(f.source().join("hardlink.jar")).unwrap();
    let pipe = CString::new(f.source().join("pipe").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
    assert!(prepare(&f.root, &f.project, "root-fixture", "sample").is_err());
}

#[test]
fn cancellation_before_commit_and_at_task_gate_rolls_back_and_releases_reservation() {
    let f = Fixture::new();
    let cancelled_token = AtomicBool::new(true);
    assert_eq!(
        execute(&f.root, &f.project, f.plan(), &cancelled_token, |_| {}).unwrap_err(),
        CANCELLED
    );
    let cancel = AtomicBool::new(false);
    assert_eq!(
        execute(&f.root, &f.project, f.plan(), &cancel, |p| {
            if p.phase == "committing" {
                cancel.store(true, Ordering::Relaxed)
            }
        })
        .unwrap_err(),
        CANCELLED
    );
    assert!(f.source().exists());
    assert!(pending_root(&f.project).unwrap().is_none());
    assert!(ensure_name_available(&f.root, "sample").is_ok());
}

#[test]
fn failed_commit_reports_error_and_retains_externally_changed_source() {
    let f = Fixture::new();
    let result = execute(
        &f.root,
        &f.project,
        f.plan(),
        &AtomicBool::new(false),
        |p| {
            if p.phase == "committing" {
                fs::write(f.source().join("saves/world/level.dat"), b"changed at gate").unwrap()
            }
        },
    );
    assert!(result.unwrap_err().starts_with("取消清理失败："));
    assert_eq!(
        fs::read(f.source().join("saves/world/level.dat")).unwrap(),
        b"changed at gate"
    );
    assert!(ensure_ready(&f.root).is_err());
    assert!(recover_pending(&f.root, &f.project).is_err());
    assert!(pending_root(&f.project).unwrap().is_some());
}

#[test]
fn interrupted_delete_before_and_after_move_rolls_back() {
    for move_first in [false, true] {
        let f = Fixture::new();
        let (root, _store, operation, record) = f.staged();
        if move_first {
            rename_new(
                &root.child("versions").unwrap(),
                "sample",
                &operation,
                "instance",
            )
            .unwrap()
        }
        assert!(ensure_ready(&f.root).is_err());
        assert_eq!(pending_root(&f.project).unwrap(), Some(f.root.clone()));
        recover_pending(&f.root, &f.project).unwrap();
        assert!(f.source().exists());
        assert!(ensure_ready(&f.root).is_ok());
        assert!(ensure_name_available(&f.root, "sample").is_ok());
        assert!(!operation.optional("instance").unwrap().is_some());
        assert_eq!(
            read_record(&operation, &record.journal.operation_id)
                .unwrap()
                .journal
                .state,
            State::RolledBack
        );
    }
}

#[test]
fn interrupted_restore_before_and_after_move_returns_copy_to_recovery() {
    for move_first in [false, true] {
        let f = Fixture::new();
        let entry = f.delete();
        let root = Dir::open(&f.root).unwrap();
        let store = storage(&root, false).unwrap().unwrap();
        let operation = store.child(&entry.operation_id).unwrap();
        let mut record = read_record(&operation, &entry.operation_id).unwrap();
        record.journal.state = State::Restoring;
        record.journal.marker_cleared = false;
        write_record(&operation, &mut record).unwrap();
        create_marker(&record.journal).unwrap();
        if move_first {
            rename_new(
                &operation,
                "instance",
                &root.child("versions").unwrap(),
                "sample",
            )
            .unwrap()
        }
        recover_pending(&f.root, &f.project).unwrap();
        assert!(!f.source().exists());
        assert!(operation.child("instance").is_ok());
        let refreshed = history(&f.root, &f.project, "root-fixture")
            .unwrap()
            .remove(0);
        assert!(refreshed.can_restore);
        f.restore(&refreshed).unwrap();
    }
}

#[test]
fn recovery_copy_edits_are_warned_and_preserved() {
    let f = Fixture::new();
    let entry = f.delete();
    let copy = f
        .root
        .join(".pcl-rust")
        .join(STORE)
        .join(&entry.operation_id)
        .join("instance/saves/world/level.dat");
    fs::write(&copy, b"external recovery edit").unwrap();
    let entry = history(&f.root, &f.project, "root-fixture")
        .unwrap()
        .remove(0);
    assert!(!entry.can_restore);
    assert!(entry.revision.is_none());
    assert!(entry.warning.unwrap().contains("外部修改"));
    assert!(recover_pending(&f.root, &f.project).is_err());
    assert_eq!(fs::read(copy).unwrap(), b"external recovery edit");
    assert!(!f.source().exists());
}

#[test]
fn restore_destination_conflict_preserves_both_directories_and_tombstone() {
    let f = Fixture::new();
    let entry = f.delete();
    fs::create_dir(f.source()).unwrap();
    fs::write(f.source().join("new.txt"), b"external new instance").unwrap();
    assert!(f.restore(&entry).unwrap_err().contains("占用"));
    let entry = history(&f.root, &f.project, "root-fixture")
        .unwrap()
        .remove(0);
    assert!(!entry.can_restore);
    assert!(ensure_name_available(&f.root, "sample").is_err());
    assert_eq!(
        fs::read(f.source().join("new.txt")).unwrap(),
        b"external new instance"
    );
    assert!(f
        .root
        .join(".pcl-rust")
        .join(STORE)
        .join(entry.operation_id)
        .join("instance/sample.jar")
        .exists());
}

#[test]
fn restore_confirmation_is_scoped_and_stale_generation_is_rejected() {
    let f = Fixture::new();
    let entry = f.delete();
    assert!(undo(
        &f.root,
        &f.project,
        "root-readded",
        &entry.operation_id,
        entry.revision.as_ref().unwrap(),
        &AtomicBool::new(false),
        |_| {}
    )
    .unwrap_err()
    .contains("原游戏目录标识"));
    assert!(undo(
        &f.root,
        &f.project,
        "root-fixture",
        &entry.operation_id,
        "restore:stale",
        &AtomicBool::new(false),
        |_| {}
    )
    .is_err());
    assert!(!f.source().exists());
    f.restore(&entry).unwrap();
}

#[test]
fn externally_replaced_journal_and_root_directories_are_never_adopted() {
    let f = Fixture::new();
    let (_root, _store, operation, mut record) = f.staged();
    let journal = f
        .root
        .join(".pcl-rust")
        .join(STORE)
        .join(&record.journal.operation_id)
        .join("journal.json");
    let original = fs::read(&journal).unwrap();
    fs::remove_file(&journal).unwrap();
    fs::write(&journal, &original).unwrap();
    record.journal.state = State::RolledBack;
    assert!(write_record(&operation, &mut record).is_err());
    assert_eq!(fs::read(journal).unwrap(), original);
    let moved = f.path.join("original-game");
    fs::rename(&f.root, &moved).unwrap();
    fs::create_dir_all(f.root.join("versions")).unwrap();
    assert!(recover_pending(&f.root, &f.project).is_err());
    assert!(moved.join("versions/sample").exists());
}

#[test]
fn journal_exchange_crash_artifacts_are_checked_and_safely_cleaned() {
    for after_exchange in [false, true] {
        let f = Fixture::new();
        let (_root, _store, operation, record) = f.staged();
        let mut next = record.journal.clone();
        next.generation += 1;
        next.previous_hash = Some(record.token.as_ref().unwrap().hash.clone());
        next.marker_cleared = true;
        let mut file = operation.anonymous().unwrap();
        file.write_all(&serde_json::to_vec(&next).unwrap()).unwrap();
        file.sync_all().unwrap();
        let name = format!("journal-{}.next", nonce());
        operation.link(&file, &name).unwrap();
        if after_exchange {
            operation
                .exchange(&name, "journal.json", "测试日志交换失败")
                .unwrap();
        }
        recover_pending(&f.root, &f.project).unwrap();
        assert!(f.source().exists());
        assert_eq!(operation.names().unwrap(), vec!["journal.json"]);
    }
}

#[test]
fn operation_lock_is_released_explicitly_even_with_inherited_descriptor() {
    let f = Fixture::new();
    let root = Dir::open(&f.root).unwrap();
    let store = storage(&root, true).unwrap().unwrap();
    let owner = lock(&store).unwrap();
    let inherited = owner.duplicate_descriptor().unwrap();
    assert!(lock(&store).is_err());
    drop(owner);
    let next = lock(&store).unwrap();
    assert!(lock(&store).is_err());
    drop(inherited);
    assert!(lock(&store).is_err());
    drop(next);
    assert!(lock(&store).is_ok());
}

#[test]
fn recovery_preserves_temporary_journals_in_a_replaced_operation_directory() {
    let f = Fixture::new();
    let (_root, _store, operation, record) = f.staged();
    let mut next = record.journal.clone();
    next.generation += 1;
    next.previous_hash = Some(record.token.as_ref().unwrap().hash.clone());
    next.marker_cleared = true;
    let temporary = format!("journal-{}.next", nonce());
    let mut file = operation.anonymous().unwrap();
    file.write_all(&serde_json::to_vec(&next).unwrap()).unwrap();
    file.sync_all().unwrap();
    operation.link(&file, &temporary).unwrap();

    // A valid generation chain does not grant ownership of another directory.
    // Simulate an external replacement carrying copies of both known journals.
    let original = f
        .root
        .join(".pcl-rust")
        .join(STORE)
        .join(&next.operation_id);
    let retained = f.path.join("retained-operation");
    fs::rename(&original, &retained).unwrap();
    fs::create_dir(&original).unwrap();
    for name in ["journal.json", temporary.as_str()] {
        fs::copy(retained.join(name), original.join(name)).unwrap();
    }
    let marker = fs::read(f.project.join(".pcl-rust").join(MARKER)).unwrap();
    let temporary_bytes = fs::read(original.join(&temporary)).unwrap();

    assert!(recover_pending(&f.root, &f.project).is_err());
    assert_eq!(fs::read(original.join(temporary)).unwrap(), temporary_bytes);
    assert_eq!(
        fs::read(f.project.join(".pcl-rust").join(MARKER)).unwrap(),
        marker
    );
    assert_eq!(
        fs::read(f.source().join("saves/world/level.dat")).unwrap(),
        b"world data"
    );
}

#[test]
fn empty_setup_slots_recover_but_unknown_nonempty_slots_are_preserved() {
    let f = Fixture::new();
    let root = Dir::open(&f.root).unwrap();
    let store = storage(&root, true).unwrap().unwrap();
    let empty = nonce();
    store.create(&empty).unwrap();
    assert!(ensure_ready(&f.root).is_err());
    assert_eq!(
        recover_pending(&f.root, &f.project).unwrap()["recovered"],
        1
    );
    assert!(store.stat(&empty).unwrap().is_none());
    let nonempty = nonce();
    store.create(&nonempty).unwrap();
    let path = f
        .root
        .join(".pcl-rust")
        .join(STORE)
        .join(&nonempty)
        .join("unknown");
    fs::write(&path, b"external content").unwrap();
    assert!(recover_pending(&f.root, &f.project).is_err());
    assert_eq!(fs::read(path).unwrap(), b"external content");
    assert!(f.source().exists());
}

#[test]
fn durable_delete_commit_cleans_marker_and_retains_recovery_copy() {
    let f = Fixture::new();
    let (root, _store, operation, mut record) = f.staged();
    rename_new(
        &root.child("versions").unwrap(),
        "sample",
        &operation,
        "instance",
    )
    .unwrap();
    record.journal.state = State::Deleted;
    write_record(&operation, &mut record).unwrap();
    recover_pending(&f.root, &f.project).unwrap();
    assert!(!f.source().exists());
    assert!(pending_root(&f.project).unwrap().is_none());
    let entry = history(&f.root, &f.project, "root-fixture")
        .unwrap()
        .remove(0);
    assert!(entry.can_restore);
    f.restore(&entry).unwrap();
}

#[test]
fn cancellation_of_restore_at_gate_keeps_copy_and_late_cancellation_keeps_commit() {
    let f = Fixture::new();
    let entry = f.delete();
    let cancel = AtomicBool::new(false);
    assert_eq!(
        undo(
            &f.root,
            &f.project,
            "root-fixture",
            &entry.operation_id,
            entry.revision.as_ref().unwrap(),
            &cancel,
            |p| {
                if p.phase == "committing" {
                    cancel.store(true, Ordering::Relaxed)
                }
            }
        )
        .unwrap_err(),
        CANCELLED
    );
    assert!(!f.source().exists());
    assert!(ensure_ready(&f.root).is_ok());
    assert!(pending_root(&f.project).unwrap().is_none());
    let entry = history(&f.root, &f.project, "root-fixture")
        .unwrap()
        .remove(0);
    cancel.store(false, Ordering::Relaxed);
    undo(
        &f.root,
        &f.project,
        "root-fixture",
        &entry.operation_id,
        entry.revision.as_ref().unwrap(),
        &cancel,
        |p| {
            if p.phase == "complete" {
                cancel.store(true, Ordering::Relaxed)
            }
        },
    )
    .unwrap();
    assert!(f.source().exists());
    assert!(ensure_name_available(&f.root, "sample").is_ok());
}

#[test]
fn settings_changes_at_gate_block_delete_without_erasing_runtime_references() {
    let f = Fixture::new();
    let result = execute(
        &f.root,
        &f.project,
        f.plan(),
        &AtomicBool::new(false),
        |p| {
            if p.phase == "committing" {
                let mut settings = f.settings();
                settings["java"] = json!({"mode":"manual","path":f.source().join("runtime/java")});
                f.write_settings(settings)
            }
        },
    );
    assert!(result.unwrap_err().starts_with("取消清理失败："));
    assert!(f.source().exists());
    let settings: Value =
        serde_json::from_slice(&fs::read(f.project.join(".pcl-rust/settings.json")).unwrap())
            .unwrap();
    assert_eq!(settings["java"]["mode"], "manual");
    assert!(pending_root(&f.project).unwrap().is_none());
    assert!(ensure_ready(&f.root).is_ok());
}

#[test]
fn root_reregistration_keeps_history_visible_with_original_scope_warning() {
    let f = Fixture::new();
    f.delete();
    let entry = history(&f.root, &f.project, "root-readded")
        .unwrap()
        .remove(0);
    assert_eq!(entry.root_id, "root-readded");
    assert_eq!(entry.original_root_id, "root-fixture");
    assert!(!entry.can_restore);
    assert!(entry.warning.unwrap().contains("原游戏目录标识"));
    assert!(reserved_names(&f.root).unwrap().contains("sample"));
    fs::create_dir(f.source()).unwrap();
    assert!(prepare(&f.root, &f.project, "root-fixture", "sample")
        .unwrap_err()
        .contains("保留"));
}

#[test]
fn restore_and_recovery_refuse_an_independent_pending_rename() {
    let f = Fixture::new();
    let entry = f.delete();
    let identity = |path: &Path| {
        let metadata = fs::metadata(path).unwrap();
        json!({"device":metadata.dev(),"inode":metadata.ino()})
    };
    let marker = f.project.join(".pcl-rust/instance-rename-pending.json");
    let mut file = File::create(&marker).unwrap();
    let data = json!({"schema_version":1,"root_path":f.root,"root_id":"root-fixture","root_identity":identity(&f.root),
        "project_identity":identity(&f.project),"file_identity":identity(&marker),"old_id":"other","new_id":"renamed",
        "operation_id":"n-1-2-3","revision":"0".repeat(64)});
    file.write_all(&serde_json::to_vec(&data).unwrap()).unwrap();
    file.sync_all().unwrap();
    assert!(f.restore(&entry).unwrap_err().contains("重命名"));
    assert!(recover_pending(&f.root, &f.project)
        .unwrap_err()
        .contains("重命名"));
    assert_eq!(
        fs::read(&marker).unwrap(),
        serde_json::to_vec(&data).unwrap()
    );
    assert!(!f.source().exists());
    fs::remove_file(marker).unwrap();
    f.restore(&entry).unwrap();
}
