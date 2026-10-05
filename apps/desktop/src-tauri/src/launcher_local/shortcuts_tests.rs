use super::*;
use std::{fs, os::unix::fs::symlink};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = super::super::filesystem::fixture_path(&format!(
            "entry-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(p.join("project")).unwrap();
        fs::write(p.join("project/start-native.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(
            p.join("project/start-native.sh"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        Self(p)
    }
    fn store(&self) -> ShortcutStore {
        ShortcutStore::new(
            self.0.join("project"),
            XdgPaths {
                applications: self.0.join("xdg/applications"),
                desktop: Some(self.0.join("Desktop")),
            },
        )
    }
    fn create(&self, target: ShortcutTarget) -> ShortcutStore {
        let store = self.store();
        let plan = store.prepare_create(target).unwrap();
        store.create(target, &plan.revision).unwrap();
        store
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn plans_are_read_only_and_entries_withdraw_and_restore_persistently() {
    let f = Fixture::new();
    let store = f.store();
    let plan = store.prepare_create(ShortcutTarget::Applications).unwrap();
    assert_eq!(plan.entries.len(), 1);
    assert!(!f.0.join("xdg").exists());
    assert!(!f.0.join("project/.pcl-rust").exists());
    store
        .create(ShortcutTarget::Applications, &plan.revision)
        .unwrap();
    let plan = store.prepare_create(ShortcutTarget::Desktop).unwrap();
    store
        .create(ShortcutTarget::Desktop, &plan.revision)
        .unwrap();
    let plan = store.prepare_withdraw().unwrap();
    assert_eq!(plan.entries.len(), 2);
    let outcome = store.withdraw(&plan.revision).unwrap();
    assert_eq!(outcome.operation_ids.len(), 2);
    assert!(!f.0.join("xdg/applications").join(NAME).exists());
    assert!(!f.0.join("Desktop").join(NAME).exists());
    drop(store);
    let store = f.store();
    let rows = store.recovery().unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert!(row.warnings.is_empty());
        store.restore(&row.operation_id, &row.revision).unwrap();
    }
    assert!(store.recovery().unwrap().is_empty());
    assert!(f.0.join("xdg/applications").join(NAME).is_file());
    assert!(f.0.join("Desktop").join(NAME).is_file());
    assert!(!f.0.join("project/.pcl-rust/accounts.json").exists());
}
#[test]
fn legacy_script_entry_is_owned_but_edited_or_foreign_entries_are_retained() {
    let f = Fixture::new();
    let store = f.store();
    fs::create_dir_all(&store.paths.applications).unwrap();
    let path = store.paths.applications.join(NAME);
    fs::write(&path, store.legacy().unwrap()).unwrap();
    let plan = store.prepare_withdraw().unwrap();
    assert_eq!(plan.entries.len(), 1);
    let outcome = store.withdraw(&plan.revision).unwrap();
    let row = store.recovery().unwrap().remove(0);
    store.restore(&row.operation_id, &row.revision).unwrap();
    assert_eq!(fs::read(&path).unwrap(), store.legacy().unwrap());
    assert_eq!(outcome.paths, vec![path.display().to_string()]);
    fs::write(&path, b"[Desktop Entry]\nExec=other-application\n").unwrap();
    assert!(store.prepare_create(ShortcutTarget::Applications).is_err());
    let plan = store.prepare_withdraw().unwrap();
    assert!(plan.entries.is_empty());
    assert_eq!(plan.warnings.len(), 1);
    assert!(store.withdraw(&plan.revision).is_err());
    assert_eq!(
        fs::read(path).unwrap(),
        b"[Desktop Entry]\nExec=other-application\n"
    );
}
#[test]
fn stale_withdraw_and_restore_conflict_keep_both_files() {
    let f = Fixture::new();
    let store = f.create(ShortcutTarget::Applications);
    let path = store.paths.applications.join(NAME);
    let plan = store.prepare_withdraw().unwrap();
    fs::write(&path, b"external replacement").unwrap();
    assert!(store.withdraw(&plan.revision).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"external replacement");
    fs::write(&path, store.contents().unwrap()).unwrap();
    let plan = store.prepare_withdraw().unwrap();
    store.withdraw(&plan.revision).unwrap();
    let row = store.recovery().unwrap().remove(0);
    fs::write(&path, b"keep new entry").unwrap();
    assert!(store.restore(&row.operation_id, &row.revision).is_err());
    let changed = store.recovery().unwrap().remove(0);
    assert!(!changed.warnings.is_empty());
    assert!(store
        .restore(&changed.operation_id, &changed.revision)
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"keep new entry");
    let id = row.operation_id.split_once(':').unwrap().1;
    assert!(store
        .paths
        .applications
        .join(TRASH)
        .join(id)
        .join(NAME)
        .is_file());
}
#[test]
fn directory_and_entry_symlinks_are_never_followed() {
    let f = Fixture::new();
    let store = f.store();
    fs::create_dir_all(f.0.join("actual-apps")).unwrap();
    fs::create_dir_all(f.0.join("xdg")).unwrap();
    symlink(f.0.join("actual-apps"), &store.paths.applications).unwrap();
    assert!(store.prepare_create(ShortcutTarget::Applications).is_err());
    assert_eq!(fs::read_dir(f.0.join("actual-apps")).unwrap().count(), 0);
    fs::remove_file(&store.paths.applications).unwrap();
    fs::create_dir(&store.paths.applications).unwrap();
    fs::write(f.0.join("foreign.desktop"), b"keep foreign").unwrap();
    symlink(
        f.0.join("foreign.desktop"),
        store.paths.applications.join(NAME),
    )
    .unwrap();
    assert!(store.prepare_withdraw().is_err());
    assert_eq!(
        fs::read(f.0.join("foreign.desktop")).unwrap(),
        b"keep foreign"
    );
}
#[test]
fn desktop_exec_escapes_both_parser_layers_and_percent_field_codes() {
    let text = desktop_exec(Path::new(
        "/example path/$value`tick\"quote\\slash%f/start-native.sh",
    ))
    .unwrap();
    assert_eq!(
        text,
        "\"/example path/\\\\$value\\\\`tick\\\\\"quote\\\\\\\\slash%%f/start-native.sh\""
    );
    assert!(desktop_exec(Path::new("/project=unsupported/start.sh")).is_err());
    assert!(desktop_exec(Path::new("/project\n/start.sh")).is_err());
}
#[test]
fn unknown_recovery_files_are_retained() {
    let f = Fixture::new();
    let store = f.create(ShortcutTarget::Applications);
    let plan = store.prepare_withdraw().unwrap();
    let outcome = store.withdraw(&plan.revision).unwrap();
    let id = outcome.operation_ids[0].split_once(':').unwrap().1;
    let unknown = store
        .paths
        .applications
        .join(TRASH)
        .join(id)
        .join("unknown-data");
    fs::write(&unknown, b"retain").unwrap();
    let row = store.recovery().unwrap().remove(0);
    assert!(!row.warnings.is_empty());
    assert!(store.restore(&row.operation_id, &row.revision).is_err());
    assert_eq!(fs::read(unknown).unwrap(), b"retain");
}

#[test]
fn interrupted_restore_and_later_original_replacement_do_not_reclaim_filename() {
    let f = Fixture::new();
    let store = f.create(ShortcutTarget::Applications);
    let plan = store.prepare_withdraw().unwrap();
    let outcome = store.withdraw(&plan.revision).unwrap();
    let id = outcome.operation_ids[0].split_once(':').unwrap().1;
    let parent = Dir::absolute(&store.paths.applications).unwrap();
    let operation = parent.child(TRASH).unwrap().child(id).unwrap();
    // A crash after rename, or intent persisted before an unperformed rename,
    // leaves a journal and the exact original inode in its original position.
    operation.move_new(NAME, &parent).unwrap();
    assert!(store.recovery().unwrap().is_empty());
    store
        .restore_one(ShortcutTarget::Applications, id, None)
        .unwrap();
    let original = store.paths.applications.join(NAME);
    fs::remove_file(&original).unwrap();
    let other = f.0.join("new-application.desktop");
    fs::write(&other, b"unrelated replacement").unwrap();
    symlink(&other, &original).unwrap();
    assert!(store.recovery().unwrap().is_empty());
    assert!(store
        .restore_one(ShortcutTarget::Applications, id, None)
        .is_err());
    assert_eq!(fs::read(other).unwrap(), b"unrelated replacement");
}

#[test]
fn same_basename_from_another_project_is_never_owned_by_current_project() {
    let f = Fixture::new();
    let store = f.store();
    fs::create_dir_all(&store.paths.applications).unwrap();
    let foreign_project = f.0.join("other-project");
    let foreign = ShortcutStore::new(foreign_project, store.paths.clone());
    let bytes = foreign.legacy().unwrap();
    fs::write(store.paths.applications.join(NAME), &bytes).unwrap();
    let plan = store.prepare_withdraw().unwrap();
    assert!(plan.entries.is_empty());
    assert!(!plan.warnings.is_empty());
    assert!(store.withdraw(&plan.revision).is_err());
    assert_eq!(
        fs::read(store.paths.applications.join(NAME)).unwrap(),
        bytes
    );
    assert!(!f.0.join("project/.pcl-rust").exists());
}

#[test]
fn unsafe_legacy_exec_is_withdrawable_but_cannot_be_silently_reused() {
    let f = Fixture::new();
    let project = f.0.join("project%f");
    fs::rename(f.0.join("project"), &project).unwrap();
    let original = f.store();
    let store = ShortcutStore::new(project, original.paths);
    fs::create_dir_all(&store.paths.applications).unwrap();
    let bytes = store.legacy().unwrap();
    fs::write(store.paths.applications.join(NAME), &bytes).unwrap();
    assert!(store.prepare_create(ShortcutTarget::Applications).is_err());
    let plan = store.prepare_withdraw().unwrap();
    assert_eq!(plan.entries.len(), 1);
    store.withdraw(&plan.revision).unwrap();
    let row = store.recovery().unwrap().remove(0);
    store.restore(&row.operation_id, &row.revision).unwrap();
    assert_eq!(
        fs::read(store.paths.applications.join(NAME)).unwrap(),
        bytes
    );
    assert_eq!(desktop_value("/project ").unwrap(), "/project\\s");
}
