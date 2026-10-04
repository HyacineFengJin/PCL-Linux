//! Persisted launcher settings and registered game directories.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: u32 = 2;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// The active root projection used by existing settings and launch commands.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    #[serde(default)]
    pub root_id: String,
    pub root: String,
    pub player: String,
    pub memory_gib: u32,
    pub selected: Option<String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GameRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub selected: Option<String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RootSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub selected: Option<String>,
    pub overrides: BTreeMap<String, u32>,
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Persisted {
    schema_version: u32,
    active_root_id: String,
    player: String,
    memory_gib: u32,
    roots: Vec<GameRoot>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySettings {
    root: String,
    player: String,
    memory_gib: u32,
    selected: Option<String>,
    #[serde(default)]
    overrides: BTreeMap<String, u32>,
}

struct Stored {
    config: Persisted,
    blocked: Option<String>,
}

pub struct ConfigStore {
    file: PathBuf,
    inner: Mutex<Stored>,
}

fn nonce() -> String {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{time:x}-{:x}-{sequence:x}", std::process::id())
}

fn root_name(path: &Path) -> String {
    path.file_name()
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "游戏目录".into())
}

fn defaults(project: &Path) -> Persisted {
    let path = project.join("Minecraft/.minecraft");
    Persisted {
        schema_version: SCHEMA_VERSION,
        active_root_id: "root-default".into(),
        player: "Player".into(),
        memory_gib: 6,
        roots: vec![GameRoot {
            id: "root-default".into(),
            name: root_name(&path),
            path: path.to_string_lossy().into_owned(),
            selected: None,
            overrides: BTreeMap::new(),
        }],
    }
}

fn validate_globals(player: &str, memory_gib: u32) -> Result<(), String> {
    if !(3..=16).contains(&player.len())
        || !player
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("玩家名需要 3–16 位英文字母、数字或下划线".into());
    }
    if !(2..=64).contains(&memory_gib) {
        return Err("内存应为 2–64 GiB".into());
    }
    Ok(())
}

fn validate_root_values(root: &GameRoot) -> Result<(), String> {
    if root.id.is_empty()
        || !root
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("游戏目录标识无效".into());
    }
    if !Path::new(&root.path).is_absolute() {
        return Err("游戏目录需要使用绝对路径".into());
    }
    validate_name(&root.name)?;
    if let Some(selected) = &root.selected {
        pcl_core::identifier(selected)?;
    }
    for (id, memory) in &root.overrides {
        pcl_core::identifier(id)?;
        if !(2..=64).contains(memory) {
            return Err("内存应为 2–64 GiB".into());
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().any(char::is_control) {
        return Err("游戏目录名称不能为空或包含控制字符".into());
    }
    Ok(())
}

fn validate_config(config: &Persisted) -> Result<(), String> {
    if config.schema_version != SCHEMA_VERSION {
        return Err(format!("不支持设置版本 {}", config.schema_version));
    }
    validate_globals(&config.player, config.memory_gib)?;
    if config.roots.is_empty() {
        return Err("设置中至少需要一个游戏目录".into());
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for root in &config.roots {
        validate_root_values(root)?;
        if !ids.insert(&root.id) || !paths.insert(&root.path) {
            return Err("设置中存在重复游戏目录".into());
        }
    }
    if !ids.contains(&config.active_root_id) {
        return Err("当前游戏目录标识不存在".into());
    }
    Ok(())
}

fn canonical_root(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("游戏目录需要使用绝对路径".into());
    }
    let canonical = fs::canonicalize(path).map_err(|e| format!("游戏目录不可用：{e}"))?;
    let metadata = fs::metadata(&canonical).map_err(|e| format!("游戏目录不可用：{e}"))?;
    if !metadata.is_dir() {
        return Err("游戏目录不是文件夹".into());
    }
    Ok(canonical)
}

fn create_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|e| e.to_string())
}

fn atomic_save(path: &Path, config: &Persisted) -> Result<(), String> {
    let parent = path.parent().ok_or("设置文件路径无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".settings-{}.tmp", nonce()));
    let result = (|| {
        let mut file = create_file(&temporary)?;
        serde_json::to_writer_pretty(&mut file, config).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        // The rename is the commit point. A directory sync failure must not leave
        // in-memory settings behind the already committed file.
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn backup_legacy(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("设置文件路径无效")?;
    let backup = parent.join(format!("settings.v1-backup-{}.json", nonce()));
    let mut file = create_file(&backup)?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if let Ok(directory) = File::open(parent) {
        directory.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl ConfigStore {
    /// Never replaces unreadable, malformed, or newer settings with defaults.
    /// Such stores remain readable but every mutation is explicitly blocked.
    pub fn load(project: &Path) -> (Self, Option<String>) {
        let file = project.join(".pcl-rust/settings.json");
        let mut config = defaults(project);
        let mut blocked = None;
        match fs::read(&file) {
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && matches!(fs::symlink_metadata(&file), Err(missing) if missing.kind() == std::io::ErrorKind::NotFound) =>
                {}
            Err(e) => blocked = Some(format!("设置读取失败，原文件未修改；已禁止保存设置：{e}")),
            Ok(bytes) => {
                let loaded = (|| -> Result<Persisted, String> {
                    let value: serde_json::Value =
                        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                    if let Some(version) = value.get("schema_version") {
                        if version.as_u64() != Some(u64::from(SCHEMA_VERSION)) {
                            return Err(format!("不支持设置版本 {version}，请使用兼容的启动器"));
                        }
                        let loaded: Persisted =
                            serde_json::from_value(value).map_err(|e| e.to_string())?;
                        validate_config(&loaded)?;
                        return Ok(loaded);
                    }
                    let old: LegacySettings =
                        serde_json::from_value(value).map_err(|e| e.to_string())?;
                    let migrated = Persisted {
                        schema_version: SCHEMA_VERSION,
                        active_root_id: "root-legacy".into(),
                        player: old.player,
                        memory_gib: old.memory_gib,
                        roots: vec![GameRoot {
                            id: "root-legacy".into(),
                            name: root_name(Path::new(&old.root)),
                            path: old.root,
                            selected: old.selected,
                            overrides: old.overrides,
                        }],
                    };
                    validate_config(&migrated)?;
                    // Keep the actual legacy values visible if backing up or
                    // committing migration fails, while continuing to block saves.
                    config = migrated.clone();
                    backup_legacy(&file, &bytes).map_err(|e| format!("旧版设置备份失败：{e}"))?;
                    atomic_save(&file, &migrated).map_err(|e| format!("设置迁移失败：{e}"))?;
                    Ok(migrated)
                })();
                match loaded {
                    Ok(loaded) => config = loaded,
                    Err(e) => {
                        blocked = Some(format!(
                            "设置读取或迁移失败，原设置已保留；已禁止保存设置：{e}"
                        ))
                    }
                }
            }
        }
        let warning = blocked.clone();
        (
            Self {
                file,
                inner: Mutex::new(Stored { config, blocked }),
            },
            warning,
        )
    }

    fn lock(&self) -> MutexGuard<'_, Stored> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn commit(&self, current: &mut Stored, next: Persisted) -> Result<(), String> {
        if let Some(reason) = &current.blocked {
            return Err(reason.clone());
        }
        validate_config(&next)?;
        atomic_save(&self.file, &next)?;
        current.config = next;
        Ok(())
    }

    pub fn warning(&self) -> Option<String> {
        self.lock().blocked.clone()
    }

    /// Call before operations that would mutate game files when settings could
    /// not be read. This avoids acting on the read-only fallback configuration.
    pub fn ensure_writable(&self) -> Result<(), String> {
        match self.lock().blocked.clone() {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    pub fn snapshot(&self) -> Settings {
        let current = self.lock();
        project_settings(&current.config)
    }

    /// Checks directory metadata only; this does not read any game contents.
    pub fn roots(&self) -> Vec<RootSummary> {
        let roots = self.lock().config.roots.clone();
        summarize_roots(roots)
    }

    /// Captures the active projection and registry from one locked revision;
    /// availability probes run after releasing the lock.
    pub fn view(&self) -> (Settings, Vec<RootSummary>) {
        let config = self.lock().config.clone();
        (project_settings(&config), summarize_roots(config.roots))
    }

    #[cfg(test)]
    fn registered(&self, id: &str) -> Result<GameRoot, String> {
        self.lock()
            .config
            .roots
            .iter()
            .find(|root| root.id == id)
            .cloned()
            .ok_or_else(|| "游戏目录未注册或已移除".into())
    }

    /// Returns a verified canonical path for a root bound to an operation.
    pub fn resolve(&self, root_id: Option<&str>) -> Result<GameRoot, String> {
        let mut root = {
            let current = self.lock();
            let id = root_id.unwrap_or(&current.config.active_root_id);
            current
                .config
                .roots
                .iter()
                .find(|root| root.id == id)
                .cloned()
                .ok_or("游戏目录未注册或已移除")?
        };
        let canonical = canonical_root(&root.path)?;
        root.path = canonical
            .to_str()
            .ok_or("游戏目录路径不是有效的 UTF-8")?
            .into();
        Ok(root)
    }

    /// Canonical aliases reuse the registered id and do not switch the active root.
    pub fn register(&self, path: String, name: Option<String>) -> Result<GameRoot, String> {
        let canonical = canonical_root(&path)?;
        let root = GameRoot {
            id: format!("root-{}", nonce()),
            name: name
                .map(|name| name.trim().to_owned())
                .unwrap_or_else(|| root_name(Path::new(&path))),
            path,
            selected: None,
            overrides: BTreeMap::new(),
        };
        validate_root_values(&root)?;
        loop {
            let roots = {
                let current = self.lock();
                if let Some(reason) = &current.blocked {
                    return Err(reason.clone());
                }
                current.config.roots.clone()
            };
            // Offline mounts and canonicalization must not hold the settings
            // mutex. Recheck the registry before committing to avoid duplicate
            // aliases when callers register directories concurrently.
            let existing = roots.iter().find(|saved| {
                saved.path == root.path
                    || canonical_root(&saved.path).is_ok_and(|saved| saved == canonical)
            });
            let mut current = self.lock();
            if current.config.roots != roots {
                continue;
            }
            if let Some(existing) = existing {
                return Ok(existing.clone());
            }
            let mut next = current.config.clone();
            next.roots.push(root.clone());
            self.commit(&mut current, next)?;
            return Ok(root);
        }
    }

    pub fn select(&self, id: &str) -> Result<Settings, String> {
        let mut current = self.lock();
        if !current.config.roots.iter().any(|root| root.id == id) {
            return Err("游戏目录未注册或已移除".into());
        }
        let mut next = current.config.clone();
        next.active_root_id = id.into();
        self.commit(&mut current, next)?;
        Ok(project_settings(&current.config))
    }

    pub fn update(
        &self,
        id: &str,
        name: Option<String>,
        position: Option<usize>,
    ) -> Result<(), String> {
        let mut current = self.lock();
        let index = current
            .config
            .roots
            .iter()
            .position(|root| root.id == id)
            .ok_or("游戏目录未注册或已移除")?;
        let mut next = current.config.clone();
        if let Some(name) = name {
            let name = name.trim().to_owned();
            validate_name(&name)?;
            next.roots[index].name = name;
        }
        if let Some(position) = position {
            if position >= next.roots.len() {
                return Err("游戏目录排序位置无效".into());
            }
            let root = next.roots.remove(index);
            next.roots.insert(position, root);
        }
        self.commit(&mut current, next)
    }

    /// Removes only a registry reference. Game files are never removed.
    pub fn remove(&self, id: &str) -> Result<Settings, String> {
        let mut current = self.lock();
        let index = current
            .config
            .roots
            .iter()
            .position(|root| root.id == id)
            .ok_or("游戏目录未注册或已移除")?;
        if current.config.roots.len() == 1 {
            return Err("至少需要保留一个游戏目录".into());
        }
        let mut next = current.config.clone();
        next.roots.remove(index);
        if next.active_root_id == id {
            next.active_root_id = next.roots[index.min(next.roots.len() - 1)].id.clone();
        }
        self.commit(&mut current, next)?;
        Ok(project_settings(&current.config))
    }

    pub fn save(&self, settings: Settings) -> Result<(), String> {
        let mut current = self.lock();
        if settings.root_id != current.config.active_root_id {
            return Err("当前游戏目录已改变，请刷新后再保存设置".into());
        }
        let index = current
            .config
            .roots
            .iter()
            .position(|root| root.id == settings.root_id)
            .ok_or("游戏目录未注册或已移除")?;
        if settings.root != current.config.roots[index].path {
            return Err("请通过游戏目录管理注册或切换目录".into());
        }
        let mut next = current.config.clone();
        next.player = settings.player;
        next.memory_gib = settings.memory_gib;
        next.roots[index].selected = settings.selected;
        next.roots[index].overrides = settings.overrides;
        self.commit(&mut current, next)
    }

    /// Updates the operation's bound root even if another root is now active.
    pub fn select_installed(&self, root_id: &str, id: &str) -> Result<(), String> {
        pcl_core::identifier(id)?;
        let mut current = self.lock();
        let index = current
            .config
            .roots
            .iter()
            .position(|root| root.id == root_id)
            .ok_or("游戏目录未注册或已移除")?;
        let mut next = current.config.clone();
        next.roots[index].selected = Some(id.into());
        self.commit(&mut current, next)
    }
}

fn project_settings(config: &Persisted) -> Settings {
    let root = config
        .roots
        .iter()
        .find(|root| root.id == config.active_root_id)
        .expect("validated settings have an active root");
    Settings {
        root_id: root.id.clone(),
        root: root.path.clone(),
        player: config.player.clone(),
        memory_gib: config.memory_gib,
        selected: root.selected.clone(),
        overrides: root.overrides.clone(),
    }
}

fn summarize_roots(roots: Vec<GameRoot>) -> Vec<RootSummary> {
    roots
        .into_iter()
        .map(|root| {
            let error = canonical_root(&root.path).err();
            RootSummary {
                id: root.id,
                name: root.name,
                path: root.path,
                selected: root.selected,
                overrides: root.overrides,
                available: error.is_none(),
                error,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../work/config-tests");
            let project = base.join(nonce());
            fs::create_dir_all(project.join("Minecraft/.minecraft")).unwrap();
            Self(fs::canonicalize(project).unwrap())
        }
        fn file(&self) -> PathBuf {
            self.0.join(".pcl-rust/settings.json")
        }
        fn root(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path.to_str().unwrap().into()
        }
        fn write(&self, bytes: &[u8]) {
            fs::create_dir_all(self.file().parent().unwrap()).unwrap();
            fs::write(self.file(), bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn legacy_migration_preserves_values_exact_path_and_original_backup_once() {
        let fixture = Fixture::new();
        let root = fixture.root("legacy");
        let exact = format!("{root}/../legacy");
        let original = json!({
            "root":exact,"player":"Old_Player","memory_gib":14,"selected":"Same Instance",
            "overrides":{"Same Instance":12,"Other":8}
        })
        .to_string()
        .into_bytes();
        fixture.write(&original);
        let (store, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_none());
        let settings = store.snapshot();
        assert_eq!(settings.root, exact);
        assert_eq!(settings.player, "Old_Player");
        assert_eq!(settings.memory_gib, 14);
        assert_eq!(settings.selected.as_deref(), Some("Same Instance"));
        assert_eq!(
            settings.overrides,
            BTreeMap::from([("Same Instance".into(), 12), ("Other".into(), 8)])
        );
        let backups = || {
            fs::read_dir(fixture.file().parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("settings.v1-backup-")
                })
                .collect::<Vec<_>>()
        };
        let before = backups();
        assert_eq!(before.len(), 1);
        assert_eq!(fs::read(&before[0]).unwrap(), original);
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.file()).unwrap()).unwrap();
        assert_eq!(persisted["schema_version"], 2);
        assert_eq!(persisted["roots"][0]["path"], exact);
        let (reloaded, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_none());
        assert_eq!(reloaded.snapshot(), settings);
        assert_eq!(backups(), before);
    }

    #[test]
    fn same_instance_id_has_independent_root_selection_and_memory() {
        let fixture = Fixture::new();
        let (store, _) = ConfigStore::load(&fixture.0);
        let first = store.snapshot().root_id;
        let second = store
            .register(fixture.root("second"), Some("Second".into()))
            .unwrap();
        let mut settings = store.snapshot();
        settings.selected = Some("Same".into());
        settings.overrides.insert("Same".into(), 14);
        store.save(settings).unwrap();
        let mut settings = store.select(&second.id).unwrap();
        settings.overrides.insert("Same".into(), 4);
        settings.selected = Some("Different".into());
        settings.memory_gib = 10;
        store.save(settings).unwrap();
        store.select(&first).unwrap();
        store.select_installed(&second.id, "Same").unwrap();
        assert_eq!(store.snapshot().root_id, first);
        assert_eq!(store.snapshot().overrides["Same"], 14);
        assert_eq!(store.snapshot().memory_gib, 10);
        assert_eq!(
            store.registered(&second.id).unwrap().selected.as_deref(),
            Some("Same")
        );
        assert_eq!(store.registered(&second.id).unwrap().overrides["Same"], 4);
        let (reloaded, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_none());
        assert_eq!(reloaded.snapshot(), store.snapshot());
        assert_eq!(
            reloaded.registered(&second.id).unwrap(),
            store.registered(&second.id).unwrap()
        );
    }

    #[test]
    fn stale_active_root_and_changed_path_saves_leave_settings_unchanged() {
        let fixture = Fixture::new();
        let (store, _) = ConfigStore::load(&fixture.0);
        let stale = store.snapshot();
        let second = store.register(fixture.root("second"), None).unwrap();
        store.select(&second.id).unwrap();
        let before = fs::read(fixture.file()).unwrap();
        assert!(store.save(stale).unwrap_err().contains("已改变"));
        let mut changed = store.snapshot();
        changed.root = fixture.root("replacement");
        assert!(store.save(changed).unwrap_err().contains("目录管理"));
        let mut missing_id = store.snapshot();
        missing_id.root_id.clear();
        assert!(store.save(missing_id).is_err());
        assert_eq!(fs::read(fixture.file()).unwrap(), before);
        assert_eq!(store.snapshot().root_id, second.id);
    }

    #[test]
    fn unavailable_root_stays_registered_and_can_be_selected_then_recover() {
        let fixture = Fixture::new();
        let (store, _) = ConfigStore::load(&fixture.0);
        let path = fixture.root("removable");
        let root = store.register(path.clone(), None).unwrap();
        let moved = fixture.0.join("temporarily-absent");
        fs::rename(&path, &moved).unwrap();
        let selected = store.select(&root.id).unwrap();
        assert_eq!(selected.root, path);
        assert_eq!(store.registered(&root.id).unwrap().path, path);
        assert!(store.resolve(Some(&root.id)).is_err());
        let (settings, summaries) = store.view();
        assert_eq!(settings.root_id, root.id);
        let summary = summaries
            .iter()
            .find(|summary| summary.id == root.id)
            .unwrap();
        assert!(!summary.available);
        assert!(summary.error.is_some());
        let (reloaded, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_none());
        assert_eq!(reloaded.snapshot(), selected);
        fs::rename(moved, &path).unwrap();
        assert!(
            store
                .roots()
                .iter()
                .find(|summary| summary.id == root.id)
                .unwrap()
                .available
        );
        assert_eq!(store.resolve(None).unwrap().id, root.id);
    }

    #[cfg(unix)]
    #[test]
    fn canonical_alias_registration_reuses_stable_id() {
        let fixture = Fixture::new();
        let (store, _) = ConfigStore::load(&fixture.0);
        let initial = store.snapshot();
        let alias = fixture.0.join("alias");
        std::os::unix::fs::symlink(&initial.root, &alias).unwrap();
        let duplicate = store
            .register(alias.to_str().unwrap().into(), Some("Alias".into()))
            .unwrap();
        assert_eq!(duplicate.id, initial.root_id);
        assert_eq!(duplicate.path, initial.root);
        assert_eq!(store.roots().len(), 1);
        assert_eq!(
            store.resolve(Some(&duplicate.id)).unwrap().path,
            fs::canonicalize(&initial.root).unwrap().to_str().unwrap()
        );
        assert!(store.register("relative".into(), None).is_err());
        let regular_file = fixture.0.join("file");
        fs::write(&regular_file, "fixture").unwrap();
        assert!(store
            .register(regular_file.to_str().unwrap().into(), None)
            .is_err());
    }

    #[test]
    fn malformed_or_future_settings_block_all_writes_and_preserve_original() {
        for bytes in [
            b"{broken".as_slice(),
            br#"{"schema_version":3,"player":"Future","memory_gib":14,"roots":[]}"#.as_slice(),
            br#"{"schema_version":2,"active_root_id":"missing","player":"Player","memory_gib":6,"roots":[]}"#.as_slice(),
            br#"{"root":"/example","player":"Player","memory_gib":6,"selected":null,"version":5}"#.as_slice(),
        ] {
            let fixture = Fixture::new();
            fixture.write(bytes);
            let (store, warning) = ConfigStore::load(&fixture.0);
            assert!(warning.as_deref().unwrap().contains("禁止保存"));
            assert_eq!(store.warning(), warning);
            assert!(store.ensure_writable().is_err());
            assert!(store.save(store.snapshot()).is_err());
            assert!(store.select(&store.snapshot().root_id).is_err());
            assert!(store.update(&store.snapshot().root_id, Some("Changed".into()), None).is_err());
            assert!(store.register(fixture.root("other"), None).is_err());
            assert!(store.select_installed(&store.snapshot().root_id, "Example").is_err());
            assert_eq!(fs::read(fixture.file()).unwrap(), bytes);
        }
    }

    #[cfg(unix)]
    #[test]
    fn dangling_settings_link_is_preserved_and_blocks_saves() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.file().parent().unwrap()).unwrap();
        let target = fixture.0.join("unavailable-settings.json");
        std::os::unix::fs::symlink(&target, fixture.file()).unwrap();
        let (store, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_some());
        assert!(store.ensure_writable().is_err());
        assert!(store.save(store.snapshot()).is_err());
        assert_eq!(fs::read_link(fixture.file()).unwrap(), target);
        assert!(!target.exists());
    }

    #[test]
    fn removal_only_forgets_reference_and_reorder_survives_reload() {
        let fixture = Fixture::new();
        let (store, _) = ConfigStore::load(&fixture.0);
        let first = store.snapshot().root_id;
        let path = fixture.root("second");
        let game_file = Path::new(&path).join("save-fixture");
        fs::write(&game_file, b"unchanged").unwrap();
        let second = store.register(path, None).unwrap();
        store
            .update(&second.id, Some("Renamed".into()), Some(0))
            .unwrap();
        let (reloaded, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_none());
        assert_eq!(reloaded.roots()[0].id, second.id);
        assert_eq!(reloaded.roots()[0].name, "Renamed");
        assert!(reloaded.update(&second.id, None, Some(2)).is_err());
        reloaded.select(&second.id).unwrap();
        assert_eq!(reloaded.remove(&second.id).unwrap().root_id, first);
        assert_eq!(fs::read(&game_file).unwrap(), b"unchanged");
        assert!(reloaded.registered(&second.id).is_err());
        assert!(reloaded.remove(&first).is_err());
        assert_eq!(reloaded.roots().len(), 1);
    }

    #[test]
    fn failed_atomic_save_keeps_previous_memory_state_and_cleans_temporary_file() {
        let fixture = Fixture::new();
        let (store, _) = ConfigStore::load(&fixture.0);
        let original = store.snapshot();
        store.save(original.clone()).unwrap();
        fs::remove_file(fixture.file()).unwrap();
        fs::create_dir(fixture.file()).unwrap();
        let mut changed = original.clone();
        changed.memory_gib = 14;
        assert!(store.save(changed).is_err());
        assert_eq!(store.snapshot(), original);
        assert!(fs::read_dir(fixture.file().parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }
}
