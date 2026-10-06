//! Native service regressions using real local ready-game ZIP authority. No
//! provider HTTP, chooser, Java/game process or user root participates. Worker
//! pauses acknowledge a progress boundary rather than guessing from sleeps.
use super::*;
use crate::{integration_tests::Fixture as SharedFixture, tasks::TaskStage};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::MetadataExt,
    sync::{mpsc, Condvar},
};
use zip::{write::SimpleFileOptions, ZipWriter};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    project: SharedFixture,
    shared: Arc<Shared>,
    root: GameRoot,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../work/modpack-install-2026-10-06/service/fixtures")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(base.join("Minecraft/.minecraft")).unwrap();
        let project = SharedFixture(base.canonicalize().unwrap());
        let shared = Arc::new(project.shared());
        let root = shared.config.resolve(None).unwrap();
        let source = project.0.join("ready.zip");
        let fixture = Self {
            project,
            shared,
            root,
            source,
        };
        fixture.zip(0);
        fs::write(
            Path::new(&fixture.root.path).join("untouched.txt"),
            b"existing root data",
        )
        .unwrap();
        fixture
    }
    fn zip(&self, padding: usize) {
        let mut metadata = json!({"id":"1.21.1","mainClass":"net.minecraft.client.main.Main","javaVersion":{"majorVersion":21},"libraries":[],"arguments":{"game":[],"jvm":[]}});
        if padding > 0 {
            metadata["fixturePadding"] = json!("x".repeat(padding));
        }
        let metadata = serde_json::to_vec(&metadata).unwrap();
        let mut zip = ZipWriter::new(File::create(&self.source).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (path, bytes) in [
            ("versions/1.21.1/1.21.1.json", metadata.as_slice()),
            ("versions/1.21.1/1.21.1.jar", b"bundled core".as_slice()),
            ("mods/local.jar", b"MOD_BODY".as_slice()),
            ("config/local.cfg", b"pack configuration".as_slice()),
            ("libraries/fixture/extra.jar", b"shared library".as_slice()),
            ("assets/objects/fixture", b"shared asset".as_slice()),
            (
                "launcher_accounts.json",
                b"ignored private launcher account".as_slice(),
            ),
        ] {
            zip.start_file(path, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    fn prepare(&self, name: &str) -> PackPlan {
        self.shared
            .pack_confirmations
            .prepare(&self.root, &self.project.0, &self.source, name, None)
            .unwrap()
    }
    fn submit(&self, root: &GameRoot, plan: &PackPlan) -> String {
        let _operations = self.shared.operations.lock().unwrap();
        crate::require_network_submission(&self.shared).unwrap();
        crate::instance_commands::new_name(&self.shared, root, &plan.name).unwrap();
        start(
            self.shared.clone(),
            root.clone(),
            self.source.clone(),
            plan.name.clone(),
            plan.revision.clone(),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn gate(&self) -> TaskHandle {
        let root = Path::new(&self.root.path);
        let handle = self
            .shared
            .tasks
            .admit_queued(
                TaskTarget {
                    root_id: self.root.id.clone(),
                    root_path: self.root.path.clone(),
                    instance_id: Some("loader-gate".into()),
                },
                TaskKind::Install,
                TaskScope::root(root).unwrap(),
            )
            .unwrap();
        handle.wait_turn().unwrap();
        handle
    }
}
fn complete(handle: &TaskHandle) {
    handle
        .finish(TaskOutcome::Complete {
            message: "isolated gate completed".into(),
            result: None,
            error: None,
        })
        .unwrap();
}
fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            let key = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                out.insert(format!("{key}/"), Vec::new());
                visit(root, &path, out);
            } else {
                out.insert(key, fs::read(path).unwrap());
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}
fn budget(cache: &ConfirmationCache) -> (usize, usize) {
    let usage = cache.budget.lock().unwrap();
    (usage.fds, usage.bytes)
}

#[test]
fn ready_zip_real_confirmation_worker_publishes_complete_instance_and_preserves_source() {
    let f = Fixture::new();
    let source = fs::read(&f.source).unwrap();
    let inode = fs::metadata(&f.source).unwrap().ino();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let recorded = samples.clone();
    f.shared.tasks.set_listener(move |snapshot| {
        recorded.lock().unwrap().push(snapshot);
    });
    let plan = f.prepare("Installed");
    assert_eq!(plan.format, "ready_game");
    assert!(plan.installable);
    assert!(plan.revision.starts_with("pack-confirm-v1:"));
    assert!(f.shared.pack_confirmations.entries.lock().unwrap()[0]
        .authority
        .core
        .is_none());
    let id = f.submit(&f.root, &plan);
    let terminal = f.shared.tasks.wait_terminal(&id).unwrap();
    assert_eq!(terminal.stage, TaskStage::Complete, "{:?}", terminal.error);
    assert_eq!(terminal.kind, TaskKind::ModpackInstall);
    assert_eq!(terminal.network_bytes, 0);
    let root = Path::new(&f.root.path);
    let version = root.join("versions/Installed");
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(version.join("Installed.json")).unwrap()).unwrap();
    assert_eq!(metadata["id"], "Installed");
    assert_eq!(metadata["jar"], "Installed");
    assert_eq!(metadata["clientVersion"], "1.21.1");
    assert!(metadata.get("inheritsFrom").is_none());
    for (path, body) in [
        ("Installed.jar", b"bundled core".as_slice()),
        ("mods/local.jar", b"MOD_BODY".as_slice()),
        ("config/local.cfg", b"pack configuration".as_slice()),
    ] {
        assert_eq!(fs::read(version.join(path)).unwrap(), body);
    }
    assert_eq!(
        fs::read(root.join("libraries/fixture/extra.jar")).unwrap(),
        b"shared library"
    );
    assert_eq!(
        fs::read(root.join("assets/objects/fixture")).unwrap(),
        b"shared asset"
    );
    assert_eq!(
        fs::read(root.join("untouched.txt")).unwrap(),
        b"existing root data"
    );
    assert!(!version.join("launcher_accounts.json").exists());
    assert_eq!(fs::read(&f.source).unwrap(), source);
    assert_eq!(fs::metadata(&f.source).unwrap().ino(), inode);
    assert_eq!(
        f.shared
            .config
            .resolve(Some(&f.root.id))
            .unwrap()
            .selected
            .as_deref(),
        Some("Installed")
    );
    assert!(f
        .shared
        .pack_confirmations
        .active
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
    super::super::super::ensure_ready(root).unwrap();
    let snapshots = samples.lock().unwrap();
    assert!(snapshots.iter().any(|s| s.phase == "pack-files"
        && s.steps
            .iter()
            .any(|step| step.id == "pack-content" && step.state == "pending")
        && s.progress < 1.0));
    assert!(snapshots
        .iter()
        .filter(|s| !s.stage.is_terminal())
        .all(|s| s.progress < 1.0 || s.steps.iter().all(|step| step.state == "complete")));
}

#[test]
fn native_confirmation_binding_one_use_expiry_and_claimed_lease_are_distinct() {
    let f = Fixture::new();
    let cache = &f.shared.pack_confirmations;
    let plan = f.prepare("Confirmed");
    assert!(cache
        .claim(
            &f.root,
            &f.project.0,
            &f.source,
            "wrong-name",
            &plan.revision
        )
        .err()
        .unwrap()
        .contains("不符"));
    let mut wrong_root = f.root.clone();
    wrong_root.id = "other-root".into();
    assert!(cache
        .claim(
            &wrong_root,
            &f.project.0,
            &f.source,
            &plan.name,
            &plan.revision
        )
        .is_err());
    assert!(cache
        .claim(
            &f.root,
            &f.project.0,
            &f.project.0.join("other.zip"),
            &plan.name,
            &plan.revision
        )
        .is_err());
    let authority = cache
        .claim(&f.root, &f.project.0, &f.source, &plan.name, &plan.revision)
        .unwrap();
    assert!(cache
        .claim(&f.root, &f.project.0, &f.source, &plan.name, &plan.revision)
        .err()
        .unwrap()
        .contains("过期或已提交"));
    let held = budget(cache);
    assert_eq!(held.0, 1);
    assert!(held.1 > 0);
    let expires = f.prepare("Expired");
    cache.entries.lock().unwrap().back_mut().unwrap().expires =
        Instant::now() - Duration::from_secs(1);
    assert!(cache
        .claim(
            &f.root,
            &f.project.0,
            &f.source,
            &expires.name,
            &expires.revision
        )
        .err()
        .unwrap()
        .contains("过期或已提交"));
    assert_eq!(budget(cache), held);
    authority
        .checked
        .recheck_source(&AtomicBool::new(false))
        .unwrap();
    drop(authority);
    assert_eq!(budget(cache), (0, 0));
}

#[test]
fn cache_retains_only_64_unclaimed_authorities_and_evicts_the_oldest_token() {
    let f = Fixture::new();
    let cache = &f.shared.pack_confirmations;
    let first = f.prepare("Cache0");
    let mut last = first.clone();
    for index in 1..=MAX_ENTRIES {
        last = f.prepare(&format!("Cache{index}"));
    }
    assert_eq!(cache.entries.lock().unwrap().len(), MAX_ENTRIES);
    assert_eq!(budget(cache).0, MAX_ENTRIES);
    assert!(cache
        .claim(
            &f.root,
            &f.project.0,
            &f.source,
            &first.name,
            &first.revision
        )
        .is_err());
    drop(
        cache
            .claim(&f.root, &f.project.0, &f.source, &last.name, &last.revision)
            .unwrap(),
    );
    assert_eq!(budget(cache).0, MAX_ENTRIES - 1);
    cache.entries.lock().unwrap().clear();
    assert_eq!(budget(cache), (0, 0));
}

#[test]
fn claimed_source_descriptors_keep_fd_budget_until_the_owner_drops() {
    let f = Fixture::new();
    let cache = &f.shared.pack_confirmations;
    let mut authorities = Vec::new();
    for index in 0..MAX_FDS {
        let plan = f.prepare(&format!("FD{index}"));
        authorities.push(
            cache
                .claim(&f.root, &f.project.0, &f.source, &plan.name, &plan.revision)
                .unwrap(),
        );
    }
    assert_eq!(budget(cache).0, MAX_FDS);
    assert!(cache.entries.lock().unwrap().is_empty());
    assert!(cache
        .prepare(&f.root, &f.project.0, &f.source, "FDOverflow", None)
        .err()
        .unwrap()
        .contains("占满确认缓存"));
    drop(authorities.pop());
    let plan = f.prepare("FDAfterDrop");
    assert!(plan.installable);
    assert_eq!(budget(cache).0, MAX_FDS);
    drop(authorities);
    assert_eq!(budget(cache).0, 1);
    cache.entries.lock().unwrap().clear();
    assert_eq!(budget(cache), (0, 0));
}

#[test]
fn retained_native_metadata_obeys_per_authority_and_claimed_total_byte_limits() {
    let f = Fixture::new();
    f.zip(1024 * 1024);
    let cache = &f.shared.pack_confirmations;
    let mut held = Vec::new();
    let mut overflow = false;
    for index in 0..40 {
        match cache.prepare(
            &f.root,
            &f.project.0,
            &f.source,
            &format!("Bytes{index}"),
            None,
        ) {
            Ok(plan) => held.push(
                cache
                    .claim(&f.root, &f.project.0, &f.source, &plan.name, &plan.revision)
                    .unwrap(),
            ),
            Err(error) => {
                assert!(error.contains("占满确认缓存"), "{error}");
                overflow = true;
                break;
            }
        }
    }
    assert!(overflow);
    assert!(held.len() > 1 && held.len() < MAX_FDS);
    assert!(budget(cache).1 <= MAX_BYTES);
    assert!(cache.entries.lock().unwrap().is_empty());
    drop(held);
    assert_eq!(budget(cache), (0, 0));
    f.zip(3 * 1024 * 1024);
    assert!(cache
        .prepare(&f.root, &f.project.0, &f.source, "OneOversize", None)
        .err()
        .unwrap()
        .contains("内存限额"));
    assert_eq!(budget(cache), (0, 0));
}

#[test]
fn queued_same_root_cancellation_releases_source_after_no_destination_write() {
    let f = Fixture::new();
    let gate = f.gate();
    let before = tree(Path::new(&f.root.path));
    let source = fs::read(&f.source).unwrap();
    let plan = f.prepare("Queued");
    let id = f.submit(&f.root, &plan);
    assert_eq!(
        f.shared.tasks.snapshot(&id).unwrap().stage,
        TaskStage::Queued
    );
    assert_eq!(budget(&f.shared.pack_confirmations).0, 1);
    let cancelled = f.shared.downloads.cancel_and_wait(Some(&id)).unwrap();
    assert_eq!(cancelled.stage, "cancelled");
    assert_eq!(tree(Path::new(&f.root.path)), before);
    assert_eq!(fs::read(&f.source).unwrap(), source);
    assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
    assert!(!f
        .shared
        .tasks
        .snapshot(gate.id())
        .unwrap()
        .stage
        .is_terminal());
    complete(&gate);
}

#[test]
fn queued_source_replacement_alias_edit_and_root_replacement_fail_before_private_writes() {
    for mutation in ["source-replace", "alias-edit", "root-replace"] {
        let f = Fixture::new();
        let alias = f.project.0.join("alias.zip");
        if mutation == "alias-edit" {
            fs::hard_link(&f.source, &alias).unwrap();
        }
        let gate = f.gate();
        let plan = f.prepare("Stale");
        let id = f.submit(&f.root, &plan);
        assert_eq!(
            f.shared.tasks.snapshot(&id).unwrap().stage,
            TaskStage::Queued
        );
        match mutation {
            "source-replace" => {
                let replacement = f.project.0.join("replacement.zip");
                fs::write(&replacement, fs::read(&f.source).unwrap()).unwrap();
                fs::rename(replacement, &f.source).unwrap();
            }
            "alias-edit" => {
                let mut raw = fs::read(&alias).unwrap();
                let index = raw.windows(8).position(|b| b == b"MOD_BODY").unwrap();
                raw[index] ^= 1;
                fs::write(&alias, raw).unwrap();
            }
            "root-replace" => {
                fs::rename(&f.root.path, f.project.0.join("previous-root")).unwrap();
                fs::create_dir(&f.root.path).unwrap();
            }
            _ => unreachable!(),
        }
        let before = tree(Path::new(&f.root.path));
        complete(&gate);
        let terminal = f.shared.tasks.wait_terminal(&id).unwrap();
        assert_eq!(terminal.stage, TaskStage::Error, "{mutation}");
        assert!(
            terminal
                .error
                .as_deref()
                .is_some_and(|e| e.contains("变化") || e.contains("改变")),
            "{:?}",
            terminal.error
        );
        assert_eq!(tree(Path::new(&f.root.path)), before, "{mutation}");
        assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
    }
}

struct Release(Arc<(Mutex<bool>, Condvar)>);
impl Release {
    fn open(&self) {
        let (lock, changed) = &*self.0;
        *lock.lock().unwrap() = true;
        changed.notify_all();
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.open();
    }
}

#[test]
fn four_disjoint_pack_workers_run_and_fifth_queue_cancels_before_creating_a_build() {
    let f = Fixture::new();
    let (send, receive) = mpsc::channel();
    let pause = Release(Arc::new((Mutex::new(false), Condvar::new())));
    let pause_workers = pause.0.clone();
    let once = Mutex::new(BTreeSet::new());
    f.shared.tasks.set_listener(move |snapshot| {
        if snapshot.kind == TaskKind::ModpackInstall
            && snapshot.phase == "pack-files"
            && once.lock().unwrap().insert(snapshot.id.clone())
        {
            send.send(snapshot.id).unwrap();
            let (lock, changed) = &*pause_workers;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = changed.wait(released).unwrap();
            }
        }
    });
    let mut jobs = Vec::new();
    for index in 0..5 {
        let path = f.project.0.join(format!("independent-{index}"));
        fs::create_dir(&path).unwrap();
        let root = f
            .shared
            .config
            .register(
                path.to_string_lossy().into_owned(),
                Some(format!("Root{index}")),
            )
            .unwrap();
        let plan = f
            .shared
            .pack_confirmations
            .prepare(
                &root,
                &f.project.0,
                &f.source,
                &format!("Pack{index}"),
                None,
            )
            .unwrap();
        let id = f.submit(&root, &plan);
        jobs.push((root, id));
    }
    for _ in 0..4 {
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
    }
    assert_eq!(f.shared.tasks.running_all().len(), 4);
    assert_eq!(
        f.shared.tasks.snapshot(&jobs[4].1).unwrap().stage,
        TaskStage::Queued
    );
    assert_eq!(fs::read_dir(&jobs[4].0.path).unwrap().count(), 0);
    assert_eq!(
        f.shared
            .downloads
            .cancel_and_wait(Some(&jobs[4].1))
            .unwrap()
            .stage,
        "cancelled"
    );
    assert_eq!(fs::read_dir(&jobs[4].0.path).unwrap().count(), 0);
    pause.open();
    for (root, id) in jobs.iter().take(4) {
        assert_eq!(
            f.shared.tasks.wait_terminal(id).unwrap().stage,
            TaskStage::Complete
        );
        assert!(Path::new(&root.path).join("versions").is_dir());
    }
    assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
}

#[test]
fn publication_rechecks_name_references_with_callbacks_outside_operations_lock() {
    let f = Fixture::new();
    let weak = Arc::downgrade(&f.shared);
    let root = f.root.id.clone();
    let injected = Arc::new(AtomicBool::new(false));
    let did_inject = injected.clone();
    f.shared.tasks.set_listener(move |snapshot| {
        if snapshot.kind == TaskKind::ModpackInstall
            && snapshot.phase == "import-commit"
            && !did_inject.swap(true, Ordering::Relaxed)
        {
            let shared = weak.upgrade().unwrap();
            assert!(shared.operations.try_lock().is_ok());
            shared.config.select_installed(&root, "Reserved").unwrap();
        }
    });
    let plan = f.prepare("Reserved");
    let id = f.submit(&f.root, &plan);
    let terminal = f.shared.tasks.wait_terminal(&id).unwrap();
    assert!(injected.load(Ordering::Relaxed));
    assert_eq!(terminal.stage, TaskStage::Error);
    assert!(terminal.error.as_deref().unwrap().contains("实例设置"));
    assert!(!Path::new(&f.root.path).join("versions/Reserved").exists());
    assert_eq!(
        f.shared
            .config
            .resolve(Some(&f.root.id))
            .unwrap()
            .selected
            .as_deref(),
        Some("Reserved")
    );
    super::super::super::ensure_ready(Path::new(&f.root.path)).unwrap();
    assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
}

#[test]
fn service_closes_cancellation_admission_only_at_commit_and_late_cancel_preserves_success() {
    for late in [false, true] {
        let f = Fixture::new();
        let weak = Arc::downgrade(&f.shared);
        let attempted = Arc::new(AtomicBool::new(false));
        let did_attempt = attempted.clone();
        f.shared.tasks.set_listener(move |snapshot| {
            if snapshot.kind == TaskKind::ModpackInstall
                && snapshot.phase == "import-commit"
                && snapshot.can_cancel != late
                && !did_attempt.swap(true, Ordering::Relaxed)
            {
                let shared = weak.upgrade().unwrap();
                assert!(shared.operations.try_lock().is_ok());
                shared.tasks.cancel(&snapshot.id).unwrap();
            }
        });
        let plan = f.prepare(if late { "Late" } else { "Early" });
        let id = f.submit(&f.root, &plan);
        let terminal = f.shared.tasks.wait_terminal(&id).unwrap();
        assert!(attempted.load(Ordering::Relaxed));
        assert_eq!(
            terminal.stage,
            if late {
                TaskStage::Complete
            } else {
                TaskStage::Cancelled
            },
            "{:?}",
            terminal.error
        );
        assert_eq!(
            Path::new(&f.root.path)
                .join(format!("versions/{}", plan.name))
                .exists(),
            late
        );
        super::super::super::ensure_ready(Path::new(&f.root.path)).unwrap();
        assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
    }
}

#[test]
fn bundled_worker_retargeted_build_preserves_foreign_root_and_conflicting_journal() {
    let f = Fixture::new();
    let foreign = f.project.0.join("foreign-root");
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join("untouched.txt"), b"foreign root data").unwrap();
    let before = tree(&foreign);
    let source = fs::read(&f.source).unwrap();
    let weak = Arc::downgrade(&f.shared);
    let root = PathBuf::from(&f.root.path);
    let foreign_target = foreign.clone();
    let injected = Arc::new(AtomicBool::new(false));
    let did_inject = injected.clone();
    let captured = Arc::new(Mutex::new(None::<PathBuf>));
    let operation_path = captured.clone();
    f.shared.tasks.set_listener(move |snapshot| {
        if snapshot.kind == TaskKind::ModpackInstall
            && snapshot.phase == "pack-files"
            && !did_inject.swap(true, Ordering::Relaxed)
        {
            let shared = weak.upgrade().unwrap();
            assert!(shared.operations.try_lock().is_ok());
            let id = shared.pack_confirmations.active.lock().unwrap()[&root].clone();
            let operation = root
                .join(".pcl-linux")
                .join(super::super::super::STORE)
                .join(id);
            let build = operation.join("build");
            fs::rename(&build, operation.join("build-moved")).unwrap();
            std::os::unix::fs::symlink(&foreign_target, &build).unwrap();
            *operation_path.lock().unwrap() = Some(operation);
        }
    });
    let plan = f.prepare("Retargeted");
    let id = f.submit(&f.root, &plan);
    let terminal = f.shared.tasks.wait_terminal(&id).unwrap();
    assert!(injected.load(Ordering::Relaxed));
    assert_eq!(terminal.stage, TaskStage::Error);
    assert!(terminal.error.as_deref().unwrap().contains("清理失败"));
    assert_eq!(tree(&foreign), before);
    assert_eq!(fs::read(&f.source).unwrap(), source);
    assert!(!Path::new(&f.root.path).join("versions/Retargeted").exists());
    let operation = captured.lock().unwrap().clone().unwrap();
    assert!(operation.join("journal.json").is_file());
    assert!(operation.join("build-moved").is_dir());
    assert_eq!(fs::read_link(operation.join("build")).unwrap(), foreign);
    assert!(super::super::super::ensure_ready(Path::new(&f.root.path)).is_err());
    assert!(f
        .shared
        .pack_confirmations
        .ensure_ready(Path::new(&f.root.path))
        .is_err());
    assert!(f
        .shared
        .pack_confirmations
        .active
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(budget(&f.shared.pack_confirmations), (0, 0));
}
