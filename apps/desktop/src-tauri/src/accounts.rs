use pcl_auth::{AccountSummary, DeviceChallenge, LaunchIdentity, MicrosoftClient, Session};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedAccount {
    pub profile: AccountSummary,
    pub remembered: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../work/auth-tests")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    const CLIENT: &str = "01234567-89ab-cdef-0123-456789abcdef";
    #[test]
    fn missing_id_does_not_start_and_public_settings_survive_reload() {
        let f = Fixture::new();
        let a = Arc::new(Accounts::new(&f.0));
        assert!(a.start(false).err().unwrap().contains("Client ID"));
        assert_eq!(a.snapshot().stage, "idle");
        assert!(a.identity().unwrap().is_none());
        assert!(a.configure("wrong-id".into()).is_err());
        a.configure(CLIENT.into()).unwrap();
        assert_eq!(Accounts::new(&f.0).snapshot().client_id, CLIENT);
    }
    #[test]
    fn broken_book_is_preserved() {
        let f = Fixture::new();
        let file = f.0.join(".pcl-rust/accounts.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"broken existing settings").unwrap();
        let a = Accounts::new(&f.0);
        assert!(a.snapshot().warning.is_some());
        assert!(a.configure(CLIENT.into()).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"broken existing settings");
    }
    #[test]
    fn restored_session_only_account_requires_login_and_can_be_removed() {
        let f = Fixture::new();
        let a = Accounts::new(&f.0);
        let id = "1234567890abcdef1234567890abcdef".to_string();
        a.persist(&Book {
            client_id: CLIENT.into(),
            selected: Some(id.clone()),
            accounts: vec![SavedAccount {
                profile: AccountSummary {
                    id: id.clone(),
                    uuid: id.clone(),
                    name: "OnlinePlayer".into(),
                    expires_at: 0,
                },
                remembered: false,
            }],
        })
        .unwrap();
        let a = Accounts::new(&f.0);
        assert!(a.identity().err().unwrap().contains("重新登录"));
        a.remove(id).unwrap();
        let state = Accounts::new(&f.0).snapshot();
        assert!(state.accounts.is_empty());
        assert!(state.selected.is_none());
    }
    #[test]
    fn log_redaction_survives_account_removal_and_cancel_is_a_noop_when_idle() {
        let f = Fixture::new();
        let a = Accounts::new(&f.0);
        a.inner
            .lock()
            .unwrap()
            .redactions
            .push("minecraft-secret".into());
        assert_eq!(
            a.redact("token:minecraft-secret:uuid".into()),
            "token:[REDACTED]:uuid"
        );
        a.cancel();
        assert_eq!(a.snapshot().message, "选择离线账户或添加微软账户");
        let serialized = serde_json::to_string(&a.snapshot()).unwrap();
        assert!(!serialized.contains("minecraft-secret"));
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
struct Book {
    client_id: String,
    selected: Option<String>,
    accounts: Vec<SavedAccount>,
}
#[derive(Clone, Serialize)]
pub struct AuthState {
    pub client_id: String,
    pub selected: Option<String>,
    pub accounts: Vec<SavedAccount>,
    pub stage: String,
    pub message: String,
    pub challenge: Option<DeviceChallenge>,
    pub warning: Option<String>,
}
struct Inner {
    book: Book,
    sessions: BTreeMap<String, Session>,
    stage: String,
    message: String,
    challenge: Option<DeviceChallenge>,
    warning: Option<String>,
    generation: u64,
    cancel: Option<Arc<AtomicBool>>,
    // Includes credentials used by a running game even after account selection changes.
    redactions: Vec<String>,
}
pub struct Accounts {
    file: PathBuf,
    project_key: String,
    inner: Mutex<Inner>,
}
impl Accounts {
    pub fn new(project: &Path) -> Self {
        let file = project.join(".pcl-rust/accounts.json");
        let (book, warning) = if file.exists() {
            match fs::read(&file)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            {
                Some(book) => (book, None),
                None => (
                    Book::default(),
                    Some("账号列表读取失败，原文件已保留；请先修复 accounts.json".into()),
                ),
            }
        } else {
            (Book::default(), None)
        };
        Self {
            file,
            project_key: project.display().to_string(),
            inner: Mutex::new(Inner {
                book,
                sessions: BTreeMap::new(),
                stage: "idle".into(),
                message: "选择离线账户或添加微软账户".into(),
                challenge: None,
                warning,
                generation: 0,
                cancel: None,
                redactions: Vec::new(),
            }),
        }
    }
    fn persist(&self, book: &Book) -> Result<(), String> {
        // Only public profile data and client ID are ever written to this file.
        if self.file.exists()
            && serde_json::from_slice::<Book>(
                &fs::read(&self.file).map_err(|_| "无法读取账号列表")?,
            )
            .is_err()
        {
            return Err("账号列表损坏，原文件保留，请先修复后再保存".into());
        }
        fs::create_dir_all(self.file.parent().unwrap()).map_err(|_| "无法创建账号设置目录")?;
        let temp = self.file.with_extension("tmp");
        fs::write(
            &temp,
            serde_json::to_vec_pretty(book).map_err(|_| "无法编码账号列表")?,
        )
        .map_err(|_| "无法保存账号列表")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法设置账号文件权限")?;
        }
        fs::rename(temp, &self.file).map_err(|_| "无法提交账号列表".into())
    }
    pub fn snapshot(&self) -> AuthState {
        let i = self.inner.lock().unwrap();
        AuthState {
            client_id: i.book.client_id.clone(),
            selected: i.book.selected.clone(),
            accounts: i.book.accounts.clone(),
            stage: i.stage.clone(),
            message: i.message.clone(),
            challenge: i.challenge.clone(),
            warning: i.warning.clone(),
        }
    }
    pub fn configure(&self, id: String) -> Result<(), String> {
        let id = id.trim().to_owned();
        if !id.is_empty() {
            MicrosoftClient::new(&id)?;
        }
        let mut i = self.inner.lock().unwrap();
        if i.cancel.is_some() {
            return Err("请先结束当前登录".into());
        }
        let mut book = i.book.clone();
        book.client_id = id;
        self.persist(&book)?;
        i.book = book;
        Ok(())
    }
    pub fn select(&self, id: Option<String>) -> Result<(), String> {
        let mut i = self.inner.lock().unwrap();
        if i.cancel.is_some() {
            return Err("请先结束当前登录".into());
        }
        if id
            .as_ref()
            .is_some_and(|id| !i.book.accounts.iter().any(|a| &a.profile.id == id))
        {
            return Err("账号不存在".into());
        }
        let mut book = i.book.clone();
        book.selected = id;
        self.persist(&book)?;
        i.book = book;
        Ok(())
    }
    pub fn cancel(&self) {
        let mut i = self.inner.lock().unwrap();
        let Some(c) = i.cancel.take() else {
            return;
        };
        c.store(true, Ordering::SeqCst);
        i.generation += 1;
        i.stage = "idle".into();
        i.message = "已取消登录".into();
        i.challenge = None;
    }
    pub fn start(self: &Arc<Self>, remember: bool) -> Result<(), String> {
        let (client, cancel, generation) = {
            let mut i = self.inner.lock().unwrap();
            if i.cancel.is_some() {
                return Err("正在进行微软登录".into());
            }
            let client = MicrosoftClient::new(&i.book.client_id)?;
            let cancel = Arc::new(AtomicBool::new(false));
            i.generation += 1;
            i.cancel = Some(cancel.clone());
            i.stage = "preparing".into();
            i.message = "正在获取微软登录码".into();
            i.challenge = None;
            i.warning = None;
            (client, cancel, i.generation)
        };
        let s = self.clone();
        std::thread::spawn(move || {
            let result = client.login_device(
                &cancel,
                |challenge| {
                    let mut i = s.inner.lock().unwrap();
                    if i.generation == generation && !cancel.load(Ordering::SeqCst) {
                        i.challenge = Some(challenge);
                        i.stage = "waiting".into();
                    }
                },
                |message| {
                    let mut i = s.inner.lock().unwrap();
                    if i.generation == generation && !cancel.load(Ordering::SeqCst) {
                        i.message = message.into();
                    }
                },
            );
            match result {
                Err(error) => {
                    let mut i = s.inner.lock().unwrap();
                    if i.generation == generation {
                        i.cancel = None;
                        i.stage = "error".into();
                        i.message = error;
                        i.challenge = None;
                    }
                }
                Ok(session) => {
                    // Commit the completed identity while holding the state lock. Cancellation
                    // can discard network work, but cannot partially remove an existing credential.
                    let mut i = s.inner.lock().unwrap();
                    if i.generation != generation || cancel.load(Ordering::SeqCst) {
                        return;
                    }
                    let saved = if remember {
                        pcl_auth::save_session(&s.project_key, &session)
                    } else {
                        if i.book
                            .accounts
                            .iter()
                            .any(|a| a.profile.id == session.public().id && a.remembered)
                        {
                            pcl_auth::delete_session(&s.project_key, &session.public().id)
                        } else {
                            Ok(())
                        }
                    };
                    let profile = session.public();
                    let mut book = i.book.clone();
                    book.accounts.retain(|a| a.profile.id != profile.id);
                    book.accounts.push(SavedAccount {
                        profile: profile.clone(),
                        remembered: remember && saved.is_ok(),
                    });
                    book.selected = Some(profile.id.clone());
                    i.cancel = None;
                    i.challenge = None;
                    match s.persist(&book) {
                        Err(error) => {
                            i.stage = "error".into();
                            i.message = error;
                        }
                        Ok(()) => {
                            i.book = book;
                            i.redactions.push(session.launch_identity().access_token);
                            i.sessions.insert(profile.id, session);
                            i.stage = "success".into();
                            i.message = format!("已登录 {}", profile.name);
                            i.warning = saved.err();
                        }
                    }
                }
            }
        });
        Ok(())
    }
    pub fn remove(&self, id: String) -> Result<(), String> {
        let mut i = self.inner.lock().unwrap();
        if i.cancel.is_some() {
            return Err("请先结束当前登录".into());
        }
        let remembered = i
            .book
            .accounts
            .iter()
            .find(|a| a.profile.id == id)
            .ok_or("账号不存在")?
            .remembered;
        if remembered {
            pcl_auth::delete_session(&self.project_key, &id)?;
        }
        let mut book = i.book.clone();
        book.accounts.retain(|a| a.profile.id != id);
        if book.selected.as_ref() == Some(&id) {
            book.selected = None;
        }
        self.persist(&book)?;
        i.book = book;
        i.sessions.remove(&id);
        Ok(())
    }
    /// Refuses an unavailable/expired online identity instead of silently using offline mode.
    pub fn identity(&self) -> Result<Option<LaunchIdentity>, String> {
        let (id, client_id, cached, remembered) = {
            let i = self.inner.lock().unwrap();
            let Some(id) = i.book.selected.clone() else {
                return Ok(None);
            };
            let account = i
                .book
                .accounts
                .iter()
                .find(|a| a.profile.id == id)
                .ok_or("选择的账号不存在")?;
            (
                id.clone(),
                i.book.client_id.clone(),
                i.sessions.get(&id).cloned(),
                account.remembered,
            )
        };
        let client = MicrosoftClient::new(&client_id)?;
        let session = match cached {
            Some(s) => s,
            None if remembered => {
                pcl_auth::load_session(&self.project_key, &id)?.ok_or("此账号已失效，请重新登录")?
            }
            None => return Err("此账号只在上次会话有效，请重新登录".into()),
        };
        let refreshed = session.expires_soon();
        let session = if refreshed {
            client.refresh(&session)?
        } else {
            session
        };
        let identity = session.launch_identity();
        if identity.client_id != client_id {
            return Err("应用编号已更改，请重新登录".into());
        }
        let warning = if refreshed && remembered {
            pcl_auth::save_session(&self.project_key, &session).err()
        } else {
            None
        };
        let mut i = self.inner.lock().unwrap();
        if i.book.selected.as_ref() != Some(&id) {
            return Err("启动期间账号已更改，请重新启动".into());
        }
        if let Some(a) = i.book.accounts.iter_mut().find(|a| a.profile.id == id) {
            a.profile = session.public();
        }
        i.redactions.push(identity.access_token.clone());
        i.sessions.insert(id, session);
        if warning.is_some() {
            i.warning = warning;
        }
        self.persist(&i.book)?;
        Ok(Some(identity))
    }
    pub fn redact(&self, text: String) -> String {
        let i = self.inner.lock().unwrap();
        i.redactions
            .iter()
            .filter(|s| !s.is_empty())
            .fold(text, |text, secret| text.replace(secret, "[REDACTED]"))
    }
}
