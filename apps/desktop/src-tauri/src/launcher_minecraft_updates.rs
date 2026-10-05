//! Two opt-in Minecraft update hints, scoped to the launcher rather than a game
//! root. Epoch/network-bound checks establish quiet baselines and persist at
//! most one pending head per channel. UI adoption of the existing merged toast
//! is followed by an exact, expiring ack; suppressed replies cannot consume it.
//!
//! Command admission/completion owns Shared.operations. Lock order is operations
//! -> this controller -> receipt flock. Network awaits hold only the independent
//! async single-flight lock. invalidate does memory work only, cancels the old
//! fetch, and never waits for a network future or acquires an async lock.
#[path = "launcher_minecraft_updates/provider.rs"]
mod provider;
#[path = "launcher_minecraft_updates/receipt.rs"]
mod receipt;

use provider::{Failure, Heads, Mojang, Provider};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Enabled {
    pub release: bool,
    pub snapshot: bool,
}
impl Enabled {
    fn any(self) -> bool {
        self.release || self.snapshot
    }
    fn get(self, channel: NoticeChannel) -> bool {
        match channel {
            NoticeChannel::Release => self.release,
            NoticeChannel::Snapshot => self.snapshot,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeChannel {
    Release,
    Snapshot,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    version_id: String,
    released_at: String,
}
impl Marker {
    fn new(version_id: String, released_at: &str) -> Option<Self> {
        if !valid_id(&version_id) || released_at.len() > 64 {
            return None;
        }
        let time = chrono::DateTime::parse_from_rfc3339(released_at)
            .ok()?
            .with_timezone(&chrono::Utc);
        if time.timestamp() < 0 {
            return None;
        }
        Some(Self {
            version_id,
            released_at: time.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
        })
    }
    fn valid(&self) -> bool {
        Self::new(self.version_id.clone(), &self.released_at).as_ref() == Some(self)
    }
    fn time(&self) -> chrono::DateTime<chrono::Utc> {
        // Both provider and receipt validate before a marker reaches comparison.
        chrono::DateTime::parse_from_rfc3339(&self.released_at)
            .expect("validated release timestamp")
            .with_timezone(&chrono::Utc)
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.trim() == id && !id.chars().any(char::is_control)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub channel: NoticeChannel,
    pub version_id: String,
    pub released_at: String,
}
impl Notice {
    fn new(channel: NoticeChannel, marker: &Marker) -> Self {
        Self {
            channel,
            version_id: marker.version_id.clone(),
            released_at: marker.released_at.clone(),
        }
    }
    fn marker(&self) -> Marker {
        Marker {
            version_id: self.version_id.clone(),
            released_at: self.released_at.clone(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    Disabled,
    Baseline,
    Unchanged,
    Ready,
    Unavailable,
    StorageBlocked,
    Stale,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeBatch {
    pub token: String,
    pub items: Vec<Notice>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesView {
    pub state: UpdateState,
    pub policy_revision: String,
    pub checked_at: Option<u64>,
    pub retry_at: Option<u64>,
    pub cached: bool,
    pub batch: Option<NoticeBatch>,
    pub warning: Option<String>,
}
#[derive(Clone)]
pub(crate) struct CheckTicket {
    epoch: u64,
    enabled: Enabled,
    network: Arc<pcl_network::ClientFactory>,
    cancel: Arc<AtomicBool>,
}
#[derive(Clone)]
pub(crate) struct Fetched {
    result: Result<Heads, Failure>,
    at: u64,
    cached: bool,
}
struct Cached {
    fetched: Fetched,
    at: Instant,
    ttl: Duration,
}
struct PendingAck {
    batch: NoticeBatch,
    revision: String,
    at: Instant,
}
struct Controller {
    epoch: u64,
    serial: u64,
    nonce: String,
    enabled: Enabled,
    network: Option<Arc<pcl_network::ClientFactory>>,
    cancel: Arc<AtomicBool>,
    cache: Option<Cached>,
    pending: Option<PendingAck>,
    checked_at: Option<u64>,
}
impl Controller {
    fn invalidate(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.epoch = self.epoch.wrapping_add(1);
        self.cancel = Arc::new(AtomicBool::new(false));
        self.cache = None;
        self.pending = None;
        self.checked_at = None;
    }
    fn revision(&self) -> String {
        format!("{}-{}", self.nonce, self.epoch)
    }
    fn current(&self, ticket: &CheckTicket) -> bool {
        self.epoch == ticket.epoch
            && self.enabled == ticket.enabled
            && self
                .network
                .as_ref()
                .is_some_and(|n| Arc::ptr_eq(n, &ticket.network))
            && !ticket.cancel.load(Ordering::SeqCst)
    }
    fn view(&self, state: UpdateState, cached: bool, warning: Option<String>) -> UpdatesView {
        UpdatesView {
            state,
            policy_revision: self.revision(),
            checked_at: self.checked_at,
            retry_at: None,
            cached,
            batch: None,
            warning,
        }
    }
}
pub struct MinecraftUpdates {
    receipt: receipt::ReceiptStore,
    controller: Mutex<Controller>,
    fetch: tokio::sync::Mutex<()>,
}
impl MinecraftUpdates {
    pub fn new(project: PathBuf) -> Self {
        let nonce = format!(
            "{:x}",
            Sha256::digest(format!(
                "minecraft-hints:{}:{:?}:{}",
                std::process::id(),
                SystemTime::now(),
                project.display()
            ))
        );
        Self {
            receipt: receipt::ReceiptStore::new(project),
            controller: Mutex::new(Controller {
                epoch: 0,
                serial: 0,
                nonce,
                enabled: Enabled::default(),
                network: None,
                cancel: Arc::new(AtomicBool::new(false)),
                cache: None,
                pending: None,
                checked_at: None,
            }),
            fetch: tokio::sync::Mutex::new(()),
        }
    }
    /// Parent calls under operations for relevant preference edges, import,
    /// reload and close. No receipt read/write or async wait occurs here.
    pub fn invalidate(&self) {
        self.controller
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .invalidate();
    }
    pub(crate) fn begin(
        &self,
        enabled: Enabled,
        network: Arc<pcl_network::ClientFactory>,
    ) -> CheckTicket {
        let mut state = self.controller.lock().unwrap_or_else(|e| e.into_inner());
        if state.enabled != enabled
            || state
                .network
                .as_ref()
                .is_none_or(|n| !Arc::ptr_eq(n, &network))
        {
            state.invalidate();
            state.enabled = enabled;
            state.network = Some(network.clone());
        }
        CheckTicket {
            epoch: state.epoch,
            enabled,
            network,
            cancel: state.cancel.clone(),
        }
    }
    pub(crate) fn closed_view(&self) -> UpdatesView {
        self.controller
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .view(UpdateState::Stale, false, None)
    }
    pub(crate) async fn fetch(&self, ticket: &CheckTicket, refresh: bool) -> Fetched {
        let provider = Mojang::new(ticket.network.clone());
        self.fetch_with(ticket, refresh, &provider).await
    }
    async fn fetch_with(
        &self,
        ticket: &CheckTicket,
        refresh: bool,
        provider: &dyn Provider,
    ) -> Fetched {
        if !ticket.enabled.any() {
            return Fetched {
                result: Err(Failure::Cancelled),
                at: now(),
                cached: false,
            };
        }
        let _flight = tokio::select! {
            _ = cancelled(&ticket.cancel) => return Fetched { result: Err(Failure::Cancelled), at: now(), cached: false },
            guard = self.fetch.lock() => guard,
        };
        {
            let state = self.controller.lock().unwrap_or_else(|e| e.into_inner());
            if !state.current(ticket) {
                return Fetched {
                    result: Err(Failure::Cancelled),
                    at: now(),
                    cached: false,
                };
            }
            if let Some(cache) = state.cache.as_ref() {
                // Explicit refresh may bypass a successful hourly cache, never
                // a failure/429 backoff. Repeated focus cannot hammer a server.
                if cache.at.elapsed() < cache.ttl && (!refresh || cache.fetched.result.is_err()) {
                    let mut fetched = cache.fetched.clone();
                    fetched.cached = true;
                    return fetched;
                }
            }
        }
        let result = tokio::select! {
            _ = cancelled(&ticket.cancel) => Err(Failure::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(20), provider.fetch()) => result.unwrap_or(Err(Failure::Network)),
        };
        let fetched = Fetched {
            result,
            at: now(),
            cached: false,
        };
        let mut state = self.controller.lock().unwrap_or_else(|e| e.into_inner());
        if state.current(ticket) && fetched.result != Err(Failure::Cancelled) {
            let seconds = match &fetched.result {
                Ok(_) => 3600,
                Err(Failure::RateLimited(n)) => (*n).clamp(300, 3600),
                Err(_) => 300,
            };
            state.cache = Some(Cached {
                fetched: fetched.clone(),
                at: Instant::now(),
                ttl: Duration::from_secs(seconds),
            });
        }
        fetched
    }
    /// Caller holds operations through this bounded receipt transaction. Both
    /// current flags and immutable network identity are rechecked at completion.
    pub(crate) fn finish(
        &self,
        ticket: &CheckTicket,
        fetched: Fetched,
        enabled: Enabled,
        network: &Arc<pcl_network::ClientFactory>,
        closing: bool,
    ) -> UpdatesView {
        let mut state = self.controller.lock().unwrap_or_else(|e| e.into_inner());
        if closing
            || !state.current(ticket)
            || ticket.enabled != enabled
            || !Arc::ptr_eq(&ticket.network, network)
        {
            return state.view(UpdateState::Stale, fetched.cached, None);
        }
        if !enabled.any() {
            return state.view(UpdateState::Disabled, false, None);
        }
        let heads = match fetched.result {
            Ok(heads) => heads,
            Err(Failure::Cancelled) => return state.view(UpdateState::Stale, false, None),
            Err(failure) => {
                let mut view = state.view(
                    UpdateState::Unavailable,
                    fetched.cached,
                    Some(failure.message().into()),
                );
                view.retry_at = Some(fetched.at.saturating_add(match failure {
                    Failure::RateLimited(n) => n.clamp(300, 3600),
                    _ => 300,
                }));
                return view;
            }
        };
        let observation =
            match self.receipt.observe(enabled, &heads) {
                Ok(observation) => observation,
                Err(_) => return state.view(
                    UpdateState::StorageBlocked,
                    fetched.cached,
                    Some(
                        "Minecraft 更新提示的本地记录无法安全保存，未重置已有记录；请检查后重试"
                            .into(),
                    ),
                ),
            };
        state.checked_at = Some(state.checked_at.unwrap_or(0).max(fetched.at));
        let status = if !observation.items.is_empty() {
            UpdateState::Ready
        } else if observation.baseline {
            UpdateState::Baseline
        } else {
            UpdateState::Unchanged
        };
        let mut view = state.view(status, fetched.cached, None);
        // Fetches serialize, but their command completions can acquire
        // operations in reverse order. Reuse an unchanged batch token so an
        // older completion cannot invalidate the token the UI already adopted.
        if let Some(pending) = state.pending.as_ref().filter(|pending| {
            pending.at.elapsed() <= Duration::from_secs(600)
                && pending.revision == observation.revision
                && pending.batch.items == observation.items
        }) {
            view.batch = Some(pending.batch.clone());
            return view;
        }
        state.pending = if observation.items.is_empty() {
            None
        } else {
            state.serial = state.serial.wrapping_add(1);
            let token = format!(
                "{:x}",
                Sha256::digest(format!(
                    "{}:{}:{}:{}",
                    state.nonce, state.epoch, state.serial, observation.revision
                ))
            );
            let batch = NoticeBatch {
                token,
                items: observation.items,
            };
            view.batch = Some(batch.clone());
            Some(PendingAck {
                batch,
                revision: observation.revision,
                at: Instant::now(),
            })
        };
        view
    }
    pub(crate) fn ack(
        &self,
        token: &str,
        enabled: Enabled,
        network: &Arc<pcl_network::ClientFactory>,
        closing: bool,
    ) -> UpdatesView {
        let mut state = self.controller.lock().unwrap_or_else(|e| e.into_inner());
        if closing
            || state.enabled != enabled
            || state
                .network
                .as_ref()
                .is_none_or(|n| !Arc::ptr_eq(n, network))
        {
            return state.view(UpdateState::Stale, false, None);
        }
        if !enabled.any() {
            return state.view(UpdateState::Disabled, false, None);
        }
        let Some(pending) = state.pending.as_ref() else {
            return state.view(UpdateState::Stale, false, None);
        };
        if token.len() != 64
            || pending.batch.token != token
            || pending.at.elapsed() > Duration::from_secs(600)
            || pending
                .batch
                .items
                .iter()
                .any(|item| !enabled.get(item.channel))
        {
            return state.view(UpdateState::Stale, false, None);
        }
        if self
            .receipt
            .ack(&pending.revision, &pending.batch.items)
            .is_err()
        {
            return state.view(
                UpdateState::StorageBlocked,
                false,
                Some("Minecraft 通知确认未能安全保存，未重置已有记录；下次检查可重新确认".into()),
            );
        }
        state.pending = None;
        state.view(UpdateState::Unchanged, false, None)
    }
}
async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
#[path = "launcher_minecraft_updates/tests.rs"]
mod tests;
