use super::*;
use std::{fs, os::unix::fs::symlink};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../work/launcher-local-actions-2026-10-05/tests/favorites")
            .join(nonce());
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn file(&self) -> PathBuf {
        self.0.join(".pcl-rust/resource-favorites.json")
    }
    fn seed(&self, value: &[u8]) {
        fs::create_dir_all(self.0.join(".pcl-rust")).unwrap();
        fs::write(self.file(), value).unwrap();
    }
    fn store(&self) -> FavoriteStore {
        FavoriteStore::load(&self.0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn entry(id: &str) -> Entry {
    Entry {
        provider: "modrinth".into(),
        project_id: id.into(),
        folder_id: "default".into(),
        title: "Exact provider title".into(),
        project_type: "mod".into(),
        icon_url: None,
        summary: "raw description\nsecond line".into(),
    }
}
fn save(store: &FavoriteStore, view: &View, id: &str, folder: &str) -> View {
    store
        .change(
            &view.revision,
            Change::Save {
                project_id: id.into(),
                folder_id: folder.into(),
            },
            vec![entry(id)],
        )
        .unwrap()
}

#[test]
fn empty_read_does_not_create_shared_storage() {
    let fixture = Fixture::new();
    let view = fixture.store().snapshot();
    assert!(view.warning.is_none());
    assert_eq!(view.folders[0].id, "default");
    assert!(view.entries.is_empty());
    assert!(!fixture.0.join(".pcl-rust").exists());
}

#[test]
fn create_save_move_rename_remove_and_restart_preserve_other_documents() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join(".pcl-rust")).unwrap();
    fs::write(
        fixture.0.join(".pcl-rust/settings.json"),
        b"opaque game preferences",
    )
    .unwrap();
    let store = fixture.store();
    let view = store.snapshot();
    let view = store
        .change(
            &view.revision,
            Change::CreateFolder {
                name: "My resources".into(),
            },
            Vec::new(),
        )
        .unwrap();
    let folder = view.folders[1].id.clone();
    let view = save(&store, &view, "abcDEF12", "default");
    let view = save(&store, &view, "abcDEF12", &folder);
    assert_eq!(view.entries.len(), 1);
    assert_eq!(view.entries[0].summary, "raw description\nsecond line");
    assert!(store
        .change(
            &view.revision,
            Change::RemoveFolder {
                folder_id: folder.clone()
            },
            Vec::new()
        )
        .unwrap_err()
        .contains("先移动"));
    let view = store
        .change(
            &view.revision,
            Change::RenameFolder {
                folder_id: folder.clone(),
                name: "Tools".into(),
            },
            Vec::new(),
        )
        .unwrap();
    let restarted = fixture.store().snapshot();
    assert_eq!(restarted.folders, view.folders);
    assert_eq!(restarted.entries, view.entries);
    let view = store
        .change(
            &view.revision,
            Change::Remove {
                project_id: "abcDEF12".into(),
            },
            Vec::new(),
        )
        .unwrap();
    let view = store
        .change(
            &view.revision,
            Change::RemoveFolder { folder_id: folder },
            Vec::new(),
        )
        .unwrap();
    assert_eq!(view.folders.len(), 1);
    assert!(view.entries.is_empty());
    assert_eq!(
        fs::read(fixture.0.join(".pcl-rust/settings.json")).unwrap(),
        b"opaque game preferences"
    );
    assert!(!fixture.0.join(".pcl-rust/accounts.json").exists());
}

#[test]
fn stale_reply_and_unconfirmed_metadata_cannot_publish() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let before = store.snapshot();
    let after = store
        .change(
            &before.revision,
            Change::CreateFolder {
                name: "First".into(),
            },
            Vec::new(),
        )
        .unwrap();
    let old = fs::read(fixture.file()).unwrap();
    assert!(store
        .change(
            &before.revision,
            Change::Save {
                project_id: "abcDEF12".into(),
                folder_id: "default".into()
            },
            vec![entry("abcDEF12")]
        )
        .is_err());
    assert!(store
        .change(
            &after.revision,
            Change::Save {
                project_id: "abcDEF12".into(),
                folder_id: "default".into()
            },
            Vec::new()
        )
        .is_err());
    assert!(store
        .change(
            &after.revision,
            Change::Save {
                project_id: "abcDEF12".into(),
                folder_id: "default".into()
            },
            vec![entry("other123")]
        )
        .is_err());
    assert_eq!(fs::read(fixture.file()).unwrap(), old);
}

#[test]
fn external_edit_blocks_then_explicit_reload_adopts_valid_data() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let first = store.snapshot();
    let first = save(&store, &first, "abcDEF12", "default");
    let replacement = Document::default();
    fixture.seed(&serde_json::to_vec(&replacement).unwrap());
    let bytes = fs::read(fixture.file()).unwrap();
    assert!(store
        .change(
            &first.revision,
            Change::Remove {
                project_id: "abcDEF12".into()
            },
            Vec::new()
        )
        .is_err());
    let stale = store.snapshot();
    assert!(stale.warning.is_some());
    assert_eq!(stale.entries.len(), 1);
    assert_eq!(fs::read(fixture.file()).unwrap(), bytes);
    let fresh = store.reload();
    assert!(fresh.warning.is_none());
    assert!(fresh.entries.is_empty());
    assert_ne!(fresh.revision, first.revision);
    let _ = save(&store, &fresh, "newID123", "default");
}

#[test]
fn unsupported_corrupt_linked_and_oversized_stores_are_retained() {
    for bytes in [
        b"broken".as_slice(),
        b"{\"schemaVersion\":9,\"folders\":[],\"entries\":[]}".as_slice(),
    ] {
        let fixture = Fixture::new();
        fixture.seed(bytes);
        let store = fixture.store();
        let view = store.snapshot();
        assert!(view.warning.is_some());
        assert!(store
            .change(
                &view.revision,
                Change::CreateFolder { name: "New".into() },
                Vec::new()
            )
            .is_err());
        assert_eq!(fs::read(fixture.file()).unwrap(), bytes);
    }
    let fixture = Fixture::new();
    fixture.seed(&vec![b' '; MAX_BYTES + 1]);
    assert!(fixture.store().snapshot().warning.is_some());
    assert_eq!(
        fs::metadata(fixture.file()).unwrap().len(),
        (MAX_BYTES + 1) as u64
    );
    let fixture = Fixture::new();
    fixture.seed(b"outside unchanged");
    let outside = fixture.0.join("outside");
    fs::rename(fixture.file(), &outside).unwrap();
    symlink(&outside, fixture.file()).unwrap();
    assert!(fixture.store().snapshot().warning.is_some());
    assert!(fs::symlink_metadata(fixture.file())
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(outside).unwrap(), b"outside unchanged");
}

#[test]
fn invalid_folders_and_entries_leave_no_document() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let before = store.snapshot();
    for name in ["", " leading", "trailing ", "bad\nname"] {
        assert!(store
            .change(
                &before.revision,
                Change::CreateFolder { name: name.into() },
                Vec::new()
            )
            .is_err());
    }
    assert!(store
        .change(
            &before.revision,
            Change::RemoveFolder {
                folder_id: "default".into()
            },
            Vec::new()
        )
        .is_err());
    assert!(store
        .change(
            &before.revision,
            Change::RenameFolder {
                folder_id: "default".into(),
                name: "Changed".into()
            },
            Vec::new()
        )
        .is_err());
    let mut untrusted = entry("abcDEF12");
    untrusted.icon_url = Some("https://cdn.modrinth.com.evil.invalid/icon.png".into());
    assert!(store
        .change(
            &before.revision,
            Change::Save {
                project_id: "abcDEF12".into(),
                folder_id: "default".into()
            },
            vec![untrusted]
        )
        .is_err());
    assert!(!fixture.file().exists());
}

#[test]
fn duplicate_folder_names_and_missing_membership_are_rejected() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let before = store.snapshot();
    let first = store
        .change(
            &before.revision,
            Change::CreateFolder {
                name: "Unique".into(),
            },
            Vec::new(),
        )
        .unwrap();
    let bytes = fs::read(fixture.file()).unwrap();
    assert!(store
        .change(
            &first.revision,
            Change::CreateFolder {
                name: "Unique".into()
            },
            Vec::new()
        )
        .is_err());
    assert!(store
        .change(
            &first.revision,
            Change::Save {
                project_id: "abcDEF12".into(),
                folder_id: "missing".into()
            },
            vec![entry("abcDEF12")]
        )
        .is_err());
    assert_eq!(fs::read(fixture.file()).unwrap(), bytes);
}

#[test]
fn concurrent_process_snapshot_cannot_overwrite_first_commit() {
    let fixture = Fixture::new();
    let first = fixture.store();
    let second = fixture.store();
    let a = first.snapshot();
    let b = second.snapshot();
    let _ = save(&first, &a, "abcDEF12", "default");
    let bytes = fs::read(fixture.file()).unwrap();
    assert!(second
        .change(
            &b.revision,
            Change::CreateFolder {
                name: "Outdated".into()
            },
            Vec::new()
        )
        .is_err());
    assert_eq!(fs::read(fixture.file()).unwrap(), bytes);
    let b = second.reload();
    let b = second
        .change(
            &b.revision,
            Change::CreateFolder {
                name: "Fresh".into(),
            },
            Vec::new(),
        )
        .unwrap();
    assert_eq!(b.entries.len(), 1);
}

#[test]
fn selected_project_batch_has_one_commit_and_never_partial_authority() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let before = store.snapshot();
    let ids = vec!["abcDEF12".into(), "other123".into()];
    let request = || Change::SaveMany {
        project_ids: ids.clone(),
        folder_id: "default".into(),
    };
    assert!(store
        .change(&before.revision, request(), vec![entry("abcDEF12")])
        .is_err());
    assert!(!fixture.file().exists());
    let mut wrong = entry("other123");
    wrong.provider = "unknown".into();
    assert!(store
        .change(&before.revision, request(), vec![entry("abcDEF12"), wrong])
        .is_err());
    assert!(!fixture.file().exists());
    let after = store
        .change(
            &before.revision,
            request(),
            vec![entry("other123"), entry("abcDEF12")],
        )
        .unwrap();
    assert_eq!(after.entries.len(), 2);
    assert_ne!(after.revision, before.revision);
    let bytes = fs::read(fixture.file()).unwrap();
    assert!(store
        .change(
            &before.revision,
            request(),
            vec![entry("other123"), entry("abcDEF12")]
        )
        .is_err());
    assert_eq!(fs::read(fixture.file()).unwrap(), bytes);
}

#[test]
fn bookmarks_and_preferences_share_only_the_parent_directory() {
    let fixture = Fixture::new();
    let favorites = fixture.store();
    let before = favorites.snapshot();
    let prefs = crate::launcher_prefs::LauncherPreferencesStore::load(&fixture.0);
    let prefs_before = prefs.snapshot();
    let project = io::Directory::open_preferences(&fixture.0).unwrap();
    let dir = project.ensure_storage().unwrap();
    let guard = dir.write_lock().unwrap();
    // A held preference process lock must not exclude bookmark publication.
    let after = save(&favorites, &before, "abcDEF12", "default");
    drop(guard);
    let patch =
        serde_json::from_value(serde_json::json!({"appearance":{"opacity_percent":90}})).unwrap();
    let _ = prefs.update(&prefs_before.revision, patch).unwrap();
    assert_eq!(favorites.snapshot().entries, after.entries);
    assert!(favorites.snapshot().warning.is_none());
    assert!(prefs.snapshot().warning.is_none());
}
