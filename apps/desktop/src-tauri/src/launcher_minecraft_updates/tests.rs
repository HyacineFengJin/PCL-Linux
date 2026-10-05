use super::*;
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{symlink, PermissionsExt},
    sync::atomic::{AtomicU64, AtomicUsize},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .find(|p| p.join("crates/core/Cargo.toml").is_file())
            .unwrap()
            .to_owned();
        let path = root
            .join("work/launcher-local-actions-2026-10-05/tests")
            .join(format!(
                "minecraft-updates-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn receipt(&self) -> PathBuf {
        self.0.join(".pcl-rust/launcher-local").join(receipt::NAME)
    }
    fn write_receipt(&self, bytes: &[u8]) {
        crate::launcher_local::filesystem::Scope::create(&self.0, "launcher-local").unwrap();
        fs::write(self.receipt(), bytes).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn network() -> Arc<pcl_network::ClientFactory> {
    Arc::new(
        pcl_network::ClientFactory::new(pcl_network::Policy {
            proxy: pcl_network::ProxyPolicy::None,
            dns: pcl_network::DnsPolicy::System,
        })
        .unwrap(),
    )
}
fn both() -> Enabled {
    Enabled {
        release: true,
        snapshot: true,
    }
}
fn marker(id: &str, day: u32) -> Marker {
    Marker::new(id.into(), &format!("2026-01-{day:02}T00:00:00Z")).unwrap()
}
fn heads(day: u32) -> Heads {
    Heads {
        release: Some(marker(&format!("release-{day}"), day)),
        snapshot: Some(marker(&format!("snapshot-{day}"), day)),
    }
}
struct Fake {
    results: Mutex<VecDeque<Result<Heads, Failure>>>,
    calls: AtomicUsize,
}
impl Fake {
    fn new(results: Vec<Result<Heads, Failure>>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            calls: AtomicUsize::new(0),
        }
    }
}
impl Provider for Fake {
    fn fetch(&self) -> provider::BoxFuture<'_, Result<Heads, Failure>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.results
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected provider call")
        })
    }
}
async fn check(
    service: &MinecraftUpdates,
    enabled: Enabled,
    net: &Arc<pcl_network::ClientFactory>,
    fake: &dyn Provider,
) -> UpdatesView {
    let ticket = service.begin(enabled, net.clone());
    let fetched = service.fetch_with(&ticket, true, fake).await;
    service.finish(&ticket, fetched, enabled, net, false)
}
fn manifest(release: &str, snapshot: &str, versions: &[(&str, &str, u32)]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "latest": {"release":release,"snapshot":snapshot},
        "versions": versions.iter().map(|(id,kind,day)| serde_json::json!({
            "id":id,"type":kind,"releaseTime":format!("2026-01-{day:02}T00:00:00+00:00"),
            "url":"https://metadata.example.invalid/not-followed", "time":"2030-01-01T00:00:00Z"
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

#[tokio::test]
async fn disabled_does_not_touch_files_or_provider() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let fake = Fake::new(vec![]);
    let view = check(&service, Enabled::default(), &net, &fake).await;
    assert_eq!(view.state, UpdateState::Disabled);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    assert!(!fixture.0.join(".pcl-rust").exists());
    service.invalidate();
    assert!(!fixture.0.join(".pcl-rust").exists());
}
#[tokio::test]
async fn independent_first_baselines_are_quiet_and_combined_ack_is_durable() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let release_only = Enabled {
        release: true,
        snapshot: false,
    };
    let fake = Fake::new(vec![Ok(heads(1)), Ok(heads(2)), Ok(heads(3)), Ok(heads(3))]);
    assert_eq!(
        check(&service, release_only, &net, &fake).await.state,
        UpdateState::Baseline
    );
    // Enabling snapshots is quiet for that channel, while the release advance
    // remains a real notice. It never baselines another channel's pending away.
    let view = check(&service, both(), &net, &fake).await;
    let batch = view.batch.unwrap();
    assert_eq!(batch.items.len(), 1);
    assert_eq!(batch.items[0].channel, NoticeChannel::Release);
    assert_eq!(
        service.ack(&batch.token, both(), &net, false).state,
        UpdateState::Unchanged
    );
    let batch = check(&service, both(), &net, &fake).await.batch.unwrap();
    assert_eq!(batch.items.len(), 2);
    assert_eq!(
        service.ack(&batch.token, both(), &net, false).state,
        UpdateState::Unchanged
    );
    assert_eq!(
        check(&service, both(), &net, &fake).await.state,
        UpdateState::Unchanged
    );
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.receipt()).unwrap()).unwrap();
    assert!(value["release"]["pending"].is_null());
    assert!(value["snapshot"]["pending"].is_null());
    assert_eq!(value["release"]["readIds"].as_array().unwrap().len(), 2);
    assert!(!fixture.0.join(".pcl-rust/settings.json").exists());
}
#[tokio::test]
async fn pending_survives_suppressed_reply_disable_and_process_restart() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let fake = Fake::new(vec![Ok(heads(1)), Ok(heads(2))]);
    check(&service, both(), &net, &fake).await;
    let batch = check(&service, both(), &net, &fake).await.batch.unwrap();
    let saved = fs::read(fixture.receipt()).unwrap();
    service.invalidate();
    assert_eq!(
        service.ack(&batch.token, both(), &net, false).state,
        UpdateState::Stale
    );
    check(&service, Enabled::default(), &net, &Fake::new(vec![])).await;
    assert_eq!(fs::read(fixture.receipt()).unwrap(), saved);
    let restarted = MinecraftUpdates::new(fixture.0.clone());
    let batch2 = check(&restarted, both(), &net, &Fake::new(vec![Ok(heads(2))]))
        .await
        .batch
        .unwrap();
    assert_eq!(batch.items, batch2.items);
    assert_ne!(batch.token, batch2.token);
    assert_eq!(
        restarted.ack(&batch2.token, both(), &net, false).state,
        UpdateState::Unchanged
    );
}
#[tokio::test]
async fn latest_snapshot_release_alias_never_duplicates_or_rewinds_snapshot() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let initial = provider::parse(&manifest(
        "r1",
        "s1",
        &[("s1", "snapshot", 1), ("r1", "release", 1)],
    ))
    .unwrap();
    let alias = provider::parse(&manifest(
        "r2",
        "r2",
        &[
            ("r2", "release", 2),
            ("s1", "snapshot", 1),
            ("r1", "release", 1),
        ],
    ))
    .unwrap();
    let later = provider::parse(&manifest(
        "r2",
        "s3",
        &[
            ("s3", "snapshot", 3),
            ("r2", "release", 2),
            ("s1", "snapshot", 1),
        ],
    ))
    .unwrap();
    let fake = Fake::new(vec![Ok(initial), Ok(alias.clone()), Ok(alias), Ok(later)]);
    assert_eq!(
        check(&service, both(), &net, &fake).await.state,
        UpdateState::Baseline
    );
    let batch = check(&service, both(), &net, &fake).await.batch.unwrap();
    assert_eq!(batch.items.len(), 1);
    assert_eq!(batch.items[0].channel, NoticeChannel::Release);
    service.ack(&batch.token, both(), &net, false);
    let restarted = MinecraftUpdates::new(fixture.0.clone());
    assert_eq!(
        check(&restarted, both(), &net, &fake).await.state,
        UpdateState::Unchanged
    );
    let batch = check(&restarted, both(), &net, &fake).await.batch.unwrap();
    assert_eq!(batch.items.len(), 1);
    assert_eq!(batch.items[0].channel, NoticeChannel::Snapshot);
    assert_eq!(batch.items[0].version_id, "s3");
}
#[tokio::test]
async fn no_actual_snapshot_leaves_channel_uninitialized_until_first_real_head() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let first = provider::parse(&manifest("r1", "r1", &[("r1", "release", 1)])).unwrap();
    let next = provider::parse(&manifest(
        "r1",
        "s2",
        &[("r1", "release", 1), ("s2", "snapshot", 2)],
    ))
    .unwrap();
    let fake = Fake::new(vec![Ok(first), Ok(next), Ok(heads(3))]);
    assert_eq!(
        check(&service, both(), &net, &fake).await.state,
        UpdateState::Baseline
    );
    let view = check(&service, both(), &net, &fake).await;
    assert_eq!(view.state, UpdateState::Baseline);
    assert!(view.batch.is_none());
    assert_eq!(
        check(&service, both(), &net, &fake)
            .await
            .batch
            .unwrap()
            .items
            .len(),
        2
    );
}
#[tokio::test]
async fn same_id_metadata_changes_and_older_heads_never_advance_watermark() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let initial = heads(3);
    let mut same_id = initial.clone();
    same_id.release = Some(marker("release-3", 4));
    let fake = Fake::new(vec![Ok(initial), Ok(same_id), Ok(heads(2))]);
    check(&service, both(), &net, &fake).await;
    let bytes = fs::read(fixture.receipt()).unwrap();
    assert_eq!(
        check(&service, both(), &net, &fake).await.state,
        UpdateState::Unchanged
    );
    assert_eq!(
        check(&service, both(), &net, &fake).await.state,
        UpdateState::Unchanged
    );
    assert_eq!(fs::read(fixture.receipt()).unwrap(), bytes);
}
#[tokio::test]
async fn failures_preserve_receipt_and_backoff_even_explicit_refresh() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let fake = Fake::new(vec![
        Ok(heads(1)),
        Ok(heads(2)),
        Err(Failure::RateLimited(600)),
    ]);
    check(&service, both(), &net, &fake).await;
    check(&service, both(), &net, &fake).await;
    let before = fs::read(fixture.receipt()).unwrap();
    let view = check(&service, both(), &net, &fake).await;
    assert_eq!(view.state, UpdateState::Unavailable);
    assert!(view.batch.is_none());
    assert!(view.retry_at.unwrap() >= now() + 599);
    assert_eq!(
        check(&service, both(), &net, &fake).await.retry_at,
        view.retry_at
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 3);
    assert_eq!(fs::read(fixture.receipt()).unwrap(), before);
}
#[tokio::test]
async fn success_cache_and_policy_identity_have_distinct_lifetimes() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    let fake = Fake::new(vec![Ok(heads(1)), Ok(heads(2))]);
    let view = check(&service, both(), &net, &fake).await;
    let ticket = service.begin(both(), net.clone());
    let fetched = service.fetch_with(&ticket, false, &fake).await;
    let cached = service.finish(&ticket, fetched, both(), &net, false);
    assert!(cached.cached);
    assert_eq!(cached.policy_revision, view.policy_revision);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    let new_net = network();
    let fresh = check(&service, both(), &new_net, &fake).await;
    assert_ne!(fresh.policy_revision, view.policy_revision);
    assert!(!fresh.cached);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn old_network_disable_import_and_close_replies_cannot_commit_or_ack() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    for mode in 0..4 {
        let ticket = service.begin(both(), net.clone());
        let fetched = service
            .fetch_with(&ticket, true, &Fake::new(vec![Ok(heads(1))]))
            .await;
        let (enabled, current_net, closing) = match mode {
            0 => (both(), network(), false),
            1 => (Enabled::default(), net.clone(), false),
            2 => {
                service.invalidate();
                (both(), net.clone(), false)
            }
            _ => (both(), net.clone(), true),
        };
        assert_eq!(
            service
                .finish(&ticket, fetched, enabled, &current_net, closing)
                .state,
            UpdateState::Stale
        );
        assert!(!fixture.receipt().exists());
    }
    check(&service, both(), &net, &Fake::new(vec![Ok(heads(1))])).await;
    let batch = check(&service, both(), &net, &Fake::new(vec![Ok(heads(2))]))
        .await
        .batch
        .unwrap();
    let bytes = fs::read(fixture.receipt()).unwrap();
    assert_eq!(
        service.ack(&batch.token, both(), &network(), false).state,
        UpdateState::Stale
    );
    assert_eq!(
        service
            .ack(&batch.token, Enabled::default(), &net, false)
            .state,
        UpdateState::Stale
    );
    assert_eq!(
        service.ack(&batch.token, both(), &net, true).state,
        UpdateState::Stale
    );
    assert_eq!(fs::read(fixture.receipt()).unwrap(), bytes);
}
struct Deferred {
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
    calls: AtomicUsize,
}
impl Deferred {
    fn new() -> Self {
        Self {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            calls: AtomicUsize::new(0),
        }
    }
}
impl Provider for Deferred {
    fn fetch(&self) -> provider::BoxFuture<'_, Result<Heads, Failure>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.release.notified().await;
            Ok(heads(1))
        })
    }
}
#[tokio::test]
async fn invalidation_cancels_deferred_network_without_waiting_or_creating_receipt() {
    let fixture = Fixture::new();
    let service = Arc::new(MinecraftUpdates::new(fixture.0.clone()));
    let net = network();
    let provider = Arc::new(Deferred::new());
    let ticket = service.begin(both(), net.clone());
    let worker = {
        let service = service.clone();
        let provider = provider.clone();
        let ticket = ticket.clone();
        tokio::spawn(async move { service.fetch_with(&ticket, true, provider.as_ref()).await })
    };
    provider.started.notified().await;
    service.invalidate();
    let fetched = tokio::time::timeout(Duration::from_millis(500), worker)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fetched.result, Err(Failure::Cancelled));
    assert_eq!(
        service.finish(&ticket, fetched, both(), &net, false).state,
        UpdateState::Stale
    );
    assert!(!fixture.0.join(".pcl-rust").exists());
}
#[tokio::test]
async fn simultaneous_checks_share_one_request_and_one_baseline() {
    let fixture = Fixture::new();
    let service = Arc::new(MinecraftUpdates::new(fixture.0.clone()));
    let net = network();
    let provider = Arc::new(Deferred::new());
    let ticket = service.begin(both(), net.clone());
    let worker = {
        let service = service.clone();
        let provider = provider.clone();
        let ticket = ticket.clone();
        tokio::spawn(async move { service.fetch_with(&ticket, false, provider.as_ref()).await })
    };
    provider.started.notified().await;
    let worker2 = {
        let service = service.clone();
        let provider = provider.clone();
        let ticket = ticket.clone();
        tokio::spawn(async move { service.fetch_with(&ticket, false, provider.as_ref()).await })
    };
    provider.release.notify_one();
    let first = worker.await.unwrap();
    let second = worker2.await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(second.cached);
    assert_eq!(
        service.finish(&ticket, first, both(), &net, false).state,
        UpdateState::Baseline
    );
    assert_eq!(
        service.finish(&ticket, second, both(), &net, false).state,
        UpdateState::Unchanged
    );
}
#[tokio::test]
async fn reverse_completion_reuses_adopted_token_for_the_same_pending_batch() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    check(&service, both(), &net, &Fake::new(vec![Ok(heads(1))])).await;
    let ticket = service.begin(both(), net.clone());
    let older = service
        .fetch_with(&ticket, true, &Fake::new(vec![Ok(heads(2))]))
        .await;
    let newer = service.fetch_with(&ticket, false, &Fake::new(vec![])).await;
    let adopted = service
        .finish(&ticket, newer, both(), &net, false)
        .batch
        .unwrap();
    let late = service
        .finish(&ticket, older, both(), &net, false)
        .batch
        .unwrap();
    assert_eq!(adopted.token, late.token);
    assert_eq!(
        service.ack(&adopted.token, both(), &net, false).state,
        UpdateState::Unchanged
    );
}
#[tokio::test]
async fn expired_wrong_and_external_changed_ack_leave_pending_unread() {
    let fixture = Fixture::new();
    let service = MinecraftUpdates::new(fixture.0.clone());
    let net = network();
    check(&service, both(), &net, &Fake::new(vec![Ok(heads(1))])).await;
    let batch = check(&service, both(), &net, &Fake::new(vec![Ok(heads(2))]))
        .await
        .batch
        .unwrap();
    let bytes = fs::read(fixture.receipt()).unwrap();
    assert_eq!(
        service.ack(&"a".repeat(64), both(), &net, false).state,
        UpdateState::Stale
    );
    service
        .controller
        .lock()
        .unwrap()
        .pending
        .as_mut()
        .unwrap()
        .at = Instant::now() - Duration::from_secs(601);
    assert_eq!(
        service.ack(&batch.token, both(), &net, false).state,
        UpdateState::Stale
    );
    assert_eq!(fs::read(fixture.receipt()).unwrap(), bytes);
    let batch = check(&service, both(), &net, &Fake::new(vec![Ok(heads(2))]))
        .await
        .batch
        .unwrap();
    let mut edit: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    edit["release"]["readIds"] = serde_json::json!(["historic-version"]);
    let edited = serde_json::to_vec(&edit).unwrap();
    fs::write(fixture.receipt(), &edited).unwrap();
    assert_eq!(
        service.ack(&batch.token, both(), &net, false).state,
        UpdateState::StorageBlocked
    );
    assert_eq!(fs::read(fixture.receipt()).unwrap(), edited);
}
#[test]
fn receipt_batch_ack_validates_all_items_before_saving() {
    let fixture = Fixture::new();
    let store = receipt::ReceiptStore::new(fixture.0.clone());
    store.observe(both(), &heads(1)).unwrap();
    let result = store.observe(both(), &heads(2)).unwrap();
    let before = fs::read(fixture.receipt()).unwrap();
    let mut wrong = result.items.clone();
    wrong[1].version_id = "wrong-version".into();
    assert!(store.ack(&result.revision, &wrong).is_err());
    assert_eq!(fs::read(fixture.receipt()).unwrap(), before);
    store.ack(&result.revision, &result.items).unwrap();
}
#[test]
fn receipt_history_is_bounded_and_no_other_store_lock_is_used() {
    let fixture = Fixture::new();
    let store = receipt::ReceiptStore::new(fixture.0.clone());
    store.observe(both(), &heads(1)).unwrap();
    let scope =
        crate::launcher_local::filesystem::Scope::open(&fixture.0, "launcher-local").unwrap();
    let folder = scope.folder.as_ref().unwrap();
    let _other = folder.lock(".statistics.lock").unwrap();
    for index in 1..=40 {
        let time = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap()
            + chrono::Duration::days(index);
        let head = Marker::new(format!("version-{index}"), &time.to_rfc3339()).unwrap();
        let result = store
            .observe(
                both(),
                &Heads {
                    release: Some(head),
                    snapshot: None,
                },
            )
            .unwrap();
        store.ack(&result.revision, &result.items).unwrap();
    }
    let bytes = fs::read(fixture.receipt()).unwrap();
    assert!(bytes.len() <= receipt::LIMIT as usize);
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["release"]["readIds"].as_array().unwrap().len(), 32);
    assert_eq!(value["release"]["readIds"][0], "version-9");
}
#[test]
fn external_byte_edit_and_parent_replacement_during_commit_are_retained() {
    let fixture = Fixture::new();
    let store = receipt::ReceiptStore::new(fixture.0.clone());
    store.observe(both(), &heads(1)).unwrap();
    let external = b"outside editor bytes";
    assert!(store
        .observe_before_commit(both(), &heads(2), || fs::write(fixture.receipt(), external)
            .unwrap())
        .is_err());
    assert_eq!(fs::read(fixture.receipt()).unwrap(), external);
    let fixture = Fixture::new();
    let store = receipt::ReceiptStore::new(fixture.0.clone());
    store.observe(both(), &heads(1)).unwrap();
    let original = fs::read(fixture.receipt()).unwrap();
    let parent = fixture.receipt().parent().unwrap().to_owned();
    let moved = parent.with_file_name("retained-folder");
    assert!(store
        .observe_before_commit(both(), &heads(2), || {
            fs::rename(&parent, &moved).unwrap();
            fs::create_dir(&parent).unwrap();
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(parent.join(receipt::NAME), external).unwrap();
        })
        .is_err());
    assert_eq!(fs::read(fixture.receipt()).unwrap(), external);
    assert_eq!(fs::read(moved.join(receipt::NAME)).unwrap(), original);
}
#[tokio::test]
async fn malformed_future_oversize_and_unknown_receipts_are_never_reset() {
    for bytes in [b"malformed".to_vec(), vec![b'x'; receipt::LIMIT as usize + 1],
        br#"{"schemaVersion":2,"release":{"highWater":null,"pending":null,"readIds":[]},"snapshot":{"highWater":null,"pending":null,"readIds":[]}}"#.to_vec(),
        br#"{"schemaVersion":1,"release":{"highWater":null,"pending":null,"readIds":[]},"snapshot":{"highWater":null,"pending":null,"readIds":[]},"account":"not-allowed"}"#.to_vec()]
    {
        let fixture = Fixture::new(); fixture.write_receipt(&bytes);
        let service = MinecraftUpdates::new(fixture.0.clone());
        let view = check(&service, both(), &network(), &Fake::new(vec![Ok(heads(1))])).await;
        assert_eq!(view.state, UpdateState::StorageBlocked); assert!(view.batch.is_none());
        assert_eq!(fs::read(fixture.receipt()).unwrap(), bytes);
    }
}
#[test]
fn symlink_hardlink_and_busy_lock_cannot_publish_receipt() {
    let fixture = Fixture::new();
    fixture.write_receipt(b"outside file");
    let outside = fixture.0.join("outside");
    fs::rename(fixture.receipt(), &outside).unwrap();
    symlink(&outside, fixture.receipt()).unwrap();
    let store = receipt::ReceiptStore::new(fixture.0.clone());
    assert!(store.observe(both(), &heads(1)).is_err());
    fs::remove_file(fixture.receipt()).unwrap();
    fs::hard_link(&outside, fixture.receipt()).unwrap();
    assert!(store.observe(both(), &heads(1)).is_err());
    assert_eq!(fs::read(outside).unwrap(), b"outside file");
    let fixture = Fixture::new();
    let store = receipt::ReceiptStore::new(fixture.0.clone());
    store.observe(both(), &heads(1)).unwrap();
    let scope =
        crate::launcher_local::filesystem::Scope::open(&fixture.0, "launcher-local").unwrap();
    let folder = scope.folder.as_ref().unwrap();
    let guard = folder.lock(receipt::LOCK).unwrap();
    let original = fs::read(fixture.receipt()).unwrap();
    assert!(store.observe(both(), &heads(2)).is_err());
    assert_eq!(fs::read(fixture.receipt()).unwrap(), original);
    drop(guard);
    assert!(store.observe(both(), &heads(2)).is_ok());
}
#[test]
fn provider_rejects_invalid_identity_dates_types_and_bounds() {
    let valid = manifest("r", "s", &[("r", "release", 1), ("s", "snapshot", 2)]);
    assert!(provider::parse(&valid).is_ok());
    for change in 0..5 {
        let mut value: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        match change {
            0 => value["latest"]["release"] = serde_json::json!("missing"),
            1 => value["versions"][0]["releaseTime"] = serde_json::json!("not-a-date"),
            2 => value["versions"][1]["id"] = serde_json::json!("r"),
            3 => value["versions"][0]["type"] = serde_json::json!("snapshot"),
            _ => value["versions"][0]["id"] = serde_json::json!("x".repeat(129)),
        }
        assert_eq!(
            provider::parse(&serde_json::to_vec(&value).unwrap()),
            Err(Failure::Invalid)
        );
    }
    assert_eq!(
        provider::parse(&vec![b' '; provider::MAX_BYTES + 1]),
        Err(Failure::TooLarge)
    );
    let mut value: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    value["versions"] = serde_json::json!((0..4097).map(|i| serde_json::json!({"id":format!("v{i}"),"type":"release","releaseTime":"2026-01-01T00:00:00Z"})).collect::<Vec<_>>());
    assert_eq!(
        provider::parse(&serde_json::to_vec(&value).unwrap()),
        Err(Failure::Invalid)
    );
}
fn server(response: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut block = [0u8; 1024];
        while request.len() < 16384 && !request.windows(4).any(|b| b == b"\r\n\r\n") {
            let n = stream.read(&mut block).unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&block[..n]);
        }
        let _ = stream.write_all(&response);
    });
    (format!("http://{address}/manifest"), worker)
}
fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n").into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
#[tokio::test]
async fn actual_http_accepts_complete_manifest_and_rejects_partial_encoding_redirect_and_large_body(
) {
    let body = manifest("r", "r", &[("r", "release", 1)]);
    for (bytes, expected) in [
        (
            response(
                "200 OK",
                &format!("Content-Length: {}\r\n", body.len()),
                &body,
            ),
            None,
        ),
        (
            response("206 Partial Content", "Content-Length: 0\r\n", b""),
            Some(Failure::Protocol),
        ),
        (
            response(
                "200 OK",
                "Content-Encoding: gzip\r\nContent-Length: 0\r\n",
                b"",
            ),
            Some(Failure::Protocol),
        ),
        (
            response(
                "200 OK",
                "Content-Range: bytes 0-1/3\r\nContent-Length: 0\r\n",
                b"",
            ),
            Some(Failure::Protocol),
        ),
        (
            response(
                "302 Found",
                "Location: http://127.0.0.1:1/not-followed\r\nContent-Length: 0\r\n",
                b"",
            ),
            Some(Failure::Protocol),
        ),
        (
            response(
                "200 OK",
                &format!("Content-Length: {}\r\n", provider::MAX_BYTES + 1),
                b"",
            ),
            Some(Failure::TooLarge),
        ),
        (
            response("200 OK", "Content-Length: 500\r\n", b"{}"),
            Some(Failure::Network),
        ),
        (
            response("200 OK", "Content-Length: 5\r\n", b"<html"),
            Some(Failure::Invalid),
        ),
        (
            response(
                "429 Too Many Requests",
                "Retry-After: 900\r\nContent-Length: 0\r\n",
                b"",
            ),
            Some(Failure::RateLimited(900)),
        ),
    ] {
        let (url, worker) = server(bytes);
        let provider = provider::Mojang::loopback(network(), url);
        let result = provider.fetch().await;
        worker.join().unwrap();
        match expected {
            None => assert!(result.is_ok()),
            Some(error) => assert_eq!(result, Err(error)),
        }
    }
    // No Content-Length: enforce the limit while consuming actual HTTP chunks.
    let (url, worker) = server(response("200 OK", "", &vec![b' '; provider::MAX_BYTES + 1]));
    assert_eq!(
        provider::Mojang::loopback(network(), url).fetch().await,
        Err(Failure::TooLarge)
    );
    worker.join().unwrap();
}
