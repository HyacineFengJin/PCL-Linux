//! Fixed launcher-local receipt, independent of game roots and settings export.
//! A pending head is durable before presentation; only an exact batch ack marks
//! it read. External edits, unknown schemas and unsafe files are never reset.
use super::{provider::Heads, Enabled, Marker, Notice, NoticeChannel};
use crate::launcher_local::filesystem::{optional_snapshot, revision, Scope, Snapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf};

pub(super) const NAME: &str = "minecraft-updates.json";
pub(super) const LOCK: &str = ".minecraft-updates.lock";
pub(super) const LIMIT: u64 = 16 * 1024;
const HISTORY: usize = 32;
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelReceipt {
    high_water: Option<Marker>,
    pending: Option<Marker>,
    read_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    release: ChannelReceipt,
    snapshot: ChannelReceipt,
}
impl Default for Receipt {
    fn default() -> Self {
        Self {
            schema_version: 1,
            release: ChannelReceipt::default(),
            snapshot: ChannelReceipt::default(),
        }
    }
}
impl Receipt {
    fn channel(&self, channel: NoticeChannel) -> &ChannelReceipt {
        match channel {
            NoticeChannel::Release => &self.release,
            NoticeChannel::Snapshot => &self.snapshot,
        }
    }
    fn channel_mut(&mut self, channel: NoticeChannel) -> &mut ChannelReceipt {
        match channel {
            NoticeChannel::Release => &mut self.release,
            NoticeChannel::Snapshot => &mut self.snapshot,
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Minecraft 已读记录版本不受支持，未重置记录".into());
        }
        for channel in [NoticeChannel::Release, NoticeChannel::Snapshot] {
            let data = self.channel(channel);
            let mut seen = HashSet::new();
            if data.read_ids.len() > HISTORY
                || data
                    .read_ids
                    .iter()
                    .any(|id| !super::valid_id(id) || !seen.insert(id))
                || data.high_water.as_ref().is_some_and(|m| !m.valid())
                || data.pending.as_ref().is_some_and(|m| {
                    !m.valid()
                        || data.high_water.as_ref() != Some(m)
                        || data.read_ids.contains(&m.version_id)
                })
            {
                return Err("Minecraft 已读记录内容无效，未重置记录".into());
            }
        }
        Ok(())
    }
    fn observe(&mut self, enabled: Enabled, heads: &Heads) -> bool {
        let mut baseline = false;
        for channel in [NoticeChannel::Release, NoticeChannel::Snapshot] {
            if !enabled.get(channel) {
                continue;
            }
            let Some(head) = heads.get(channel) else {
                continue;
            };
            let data = self.channel_mut(channel);
            match &data.high_water {
                None => {
                    // First successful real head is quiet, including when the
                    // manifest's latest.snapshot currently aliases a release.
                    data.high_water = Some(head.clone());
                    baseline = true;
                }
                Some(old) if old.version_id != head.version_id && head.time() > old.time() => {
                    data.high_water = Some(head.clone());
                    data.pending =
                        (!data.read_ids.contains(&head.version_id)).then(|| head.clone());
                }
                _ => {} // Same ID, reorder or rollback never rewinds a receipt.
            }
        }
        baseline
    }
    fn pending(&self, enabled: Enabled) -> Vec<Notice> {
        [NoticeChannel::Release, NoticeChannel::Snapshot]
            .into_iter()
            .filter(|channel| enabled.get(*channel))
            .filter_map(|channel| {
                self.channel(channel)
                    .pending
                    .as_ref()
                    .map(|m| Notice::new(channel, m))
            })
            .collect()
    }
}
struct Loaded {
    data: Receipt,
    snapshot: Option<Snapshot>,
    revision: String,
}
fn read(scope: &Scope) -> Result<Loaded, String> {
    let snapshot = scope
        .folder
        .as_ref()
        .map(|d| optional_snapshot(d, NAME, LIMIT))
        .transpose()?
        .flatten();
    let data: Receipt = match &snapshot {
        Some(snapshot) => serde_json::from_slice(&snapshot.header)
            .map_err(|_| "Minecraft 已读记录格式无效，未重置记录")?,
        None => Receipt::default(),
    };
    data.validate()?;
    let revision = match &snapshot {
        Some(snapshot) => revision(&scope.path().join(NAME), snapshot)?,
        None => format!(
            "{:x}",
            Sha256::digest(format!(
                "missing-minecraft-updates:{}",
                scope.path().display()
            ))
        ),
    };
    scope.recheck()?;
    Ok(Loaded {
        data,
        snapshot,
        revision,
    })
}
pub(super) struct Observation {
    pub items: Vec<Notice>,
    pub baseline: bool,
    pub revision: String,
}
pub(super) struct ReceiptStore {
    project: PathBuf,
}
impl ReceiptStore {
    pub fn new(project: PathBuf) -> Self {
        Self { project }
    }
    pub fn observe(&self, enabled: Enabled, heads: &Heads) -> Result<Observation, String> {
        self.observe_before_commit(enabled, heads, || {})
    }
    pub(super) fn observe_before_commit(
        &self,
        enabled: Enabled,
        heads: &Heads,
        before_commit: impl FnOnce(),
    ) -> Result<Observation, String> {
        let initial_scope = Scope::open(&self.project, "launcher-local")?;
        let initial = read(&initial_scope)?;
        let mut next = initial.data.clone();
        let baseline = next.observe(enabled, heads);
        if next == initial.data {
            return Ok(Observation {
                items: next.pending(enabled),
                baseline,
                revision: initial.revision,
            });
        }
        initial_scope.recheck()?;
        let scope = Scope::create(&self.project, "launcher-local")?;
        // Creating a missing owned folder is permitted; replacing an already
        // captured ancestor/folder is not. Publication stays on pinned FDs.
        if scope.root.identity()? != initial_scope.root.identity()? {
            return Err("Minecraft 已读目录发生变化，未重置记录".into());
        }
        for (old, new) in [
            (&initial_scope.owner, &scope.owner),
            (&initial_scope.folder, &scope.folder),
        ] {
            if let Some(old) = old {
                if new.as_ref().map(|d| d.identity()).transpose()? != Some(old.identity()?) {
                    return Err("Minecraft 已读目录发生变化，未重置记录".into());
                }
            }
        }
        let folder = scope.folder.as_ref().unwrap();
        let _lock = folder.lock(LOCK)?;
        let current = read(&scope)?;
        if current.revision != initial.revision {
            return Err("Minecraft 已读记录已被修改，请重新检查".into());
        }
        before_commit();
        save(&scope, &current, &next)?;
        let saved = read(&scope)?;
        Ok(Observation {
            items: saved.data.pending(enabled),
            baseline,
            revision: saved.revision,
        })
    }
    pub fn ack(&self, expected: &str, items: &[Notice]) -> Result<(), String> {
        let scope = Scope::open(&self.project, "launcher-local")?;
        let folder = scope.folder.as_ref().ok_or("Minecraft 已读记录已失效")?;
        let _lock = folder.lock(LOCK)?;
        let current = read(&scope)?;
        if current.revision != expected || items.is_empty() || items.len() > 2 {
            return Err("Minecraft 通知确认已失效，请重新检查".into());
        }
        let mut next = current.data.clone();
        let mut seen = HashSet::new();
        // Validate the complete batch before mutating either channel.
        for notice in items {
            if !seen.insert(notice.channel)
                || next.channel(notice.channel).pending.as_ref() != Some(&notice.marker())
            {
                return Err("Minecraft 通知内容已变化，请重新检查".into());
            }
        }
        for notice in items {
            let data = next.channel_mut(notice.channel);
            data.read_ids.push(notice.version_id.clone());
            if data.read_ids.len() > HISTORY {
                data.read_ids.remove(0);
            }
            data.pending = None;
        }
        save(&scope, &current, &next)
    }
}
fn save(scope: &Scope, current: &Loaded, data: &Receipt) -> Result<(), String> {
    data.validate()?;
    let bytes = serde_json::to_vec_pretty(data).map_err(|_| "Minecraft 已读记录无法序列化")?;
    scope.recheck()?;
    scope
        .folder
        .as_ref()
        .unwrap()
        .replace(NAME, current.snapshot.as_ref(), &bytes, LIMIT)?;
    scope.recheck()
}
