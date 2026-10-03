mod accounts;
mod downloads;
mod ui_catalog;
mod ui_data;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State};

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    root: String,
    player: String,
    memory_gib: u32,
    selected: Option<String>,
    #[serde(default)]
    overrides: BTreeMap<String, u32>,
}
#[derive(Clone, Serialize, Default)]
struct RunStatus {
    stage: String,
    message: String,
    version: Option<String>,
    pid: Option<u32>,
    exit_code: Option<i32>,
}
struct Shared {
    project: PathBuf,
    accounts: Arc<accounts::Accounts>,
    downloads: Arc<downloads::Downloads>,
    settings: Mutex<Settings>,
    status: Mutex<RunStatus>,
    stop: AtomicBool,
    closing: AtomicBool,
    log: Mutex<Option<PathBuf>>,
}
#[derive(Serialize)]
struct Bootstrap {
    settings: Settings,
    instances: Vec<pcl_core::Instance>,
    status: RunStatus,
    auth: accounts::AuthState,
}
#[derive(Serialize)]
struct Inspection {
    java: String,
    game_dir: String,
    arguments: usize,
    log_path: String,
}
fn project() -> PathBuf {
    std::env::var_os("PCL_LINUX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .canonicalize()
        .expect("项目路径不存在")
}
fn settings_file(p: &Path) -> PathBuf {
    p.join(".pcl-rust/settings.json")
}
fn persist(p: &Path, s: &Settings) -> Result<(), String> {
    let f = settings_file(p);
    fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(tmp, f).map_err(|e| e.to_string())
}
fn validate(s: &Settings) -> Result<(), String> {
    if !Path::new(&s.root).is_absolute() || !Path::new(&s.root).is_dir() {
        return Err("请选择已存在的绝对游戏目录；新安装可使用空文件夹".into());
    }
    if !(3..=16).contains(&s.player.len())
        || !s
            .player
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("玩家名需要 3–16 位英文字母、数字或下划线".into());
    }
    if !(2..=64).contains(&s.memory_gib) || s.overrides.values().any(|v| !(2..=64).contains(v)) {
        return Err("内存应为 2–64 GiB".into());
    }
    Ok(())
}
#[tauri::command]
async fn bootstrap(state: State<'_, Arc<Shared>>) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = s.settings.lock().unwrap().clone();
        let (instances, scan_error) = match pcl_core::scan_instances(Path::new(&settings.root)) {
            Ok(v) => (v, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        let mut status = s.status.lock().unwrap();
        if let Some(e) = scan_error {
            status.stage = "error".into();
            status.message = format!("游戏目录读取失败，请在设置中修改目录：{e}");
        } else if status.message.starts_with("游戏目录读取失败") {
            status.stage = "idle".into();
            status.message = "准备就绪".into();
        }
        Ok(Bootstrap {
            settings,
            instances,
            status: status.clone(),
            auth: s.accounts.snapshot(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    validate(&settings)?;
    let run = state.status.lock().unwrap();
    let mut current = state.settings.lock().unwrap();
    if settings.root != current.root
        && (matches!(run.stage.as_str(), "preparing" | "running") || state.downloads.active())
    {
        return Err("请在游戏或安装任务结束后更换游戏目录".into());
    }
    persist(&state.project, &settings)?;
    *current = settings;
    Ok(())
}
#[tauri::command]
fn process_status(state: State<'_, Arc<Shared>>) -> RunStatus {
    state.status.lock().unwrap().clone()
}
#[tauri::command]
async fn download_catalog(
    refresh: Option<bool>,
    state: State<'_, Arc<Shared>>,
) -> Result<Vec<pcl_install::VersionEntry>, String> {
    let downloads = state.downloads.clone();
    tauri::async_runtime::spawn_blocking(move || downloads.catalog(refresh.unwrap_or(false)))
        .await
        .map_err(|_| "获取版本列表的任务失败")?
}
#[tauri::command]
fn download_status(state: State<'_, Arc<Shared>>) -> downloads::DownloadStatus {
    state.downloads.snapshot()
}
#[tauri::command]
fn download_cancel(state: State<'_, Arc<Shared>>) {
    state.downloads.cancel();
}
#[tauri::command]
fn download_start(id: String, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let run = state.status.lock().unwrap();
    require_account_edit(&run)?;
    let cfg = state.settings.lock().unwrap().clone();
    let shared = state.inner().clone();
    let root = PathBuf::from(&cfg.root);
    if !root.is_absolute() {
        return Err("游戏目录需要使用绝对路径，请先在设置中修改".into());
    }
    state.downloads.start(root, id, move |result| {
        let mut settings = shared.settings.lock().unwrap();
        if settings.root == cfg.root {
            let mut next = settings.clone();
            next.selected = Some(result.id.clone());
            persist(&shared.project, &next)?;
            *settings = next;
        }
        Ok(())
    })
}
fn require_account_edit(st: &RunStatus) -> Result<(), String> {
    if st.stage == "preparing" || st.stage == "running" {
        return Err("请在游戏退出后管理账号".into());
    }
    Ok(())
}
#[tauri::command]
fn auth_status(state: State<'_, Arc<Shared>>) -> accounts::AuthState {
    state.accounts.snapshot()
}
#[tauri::command]
fn auth_configure(client_id: String, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let st = state.status.lock().unwrap();
    require_account_edit(&st)?;
    state.accounts.configure(client_id)
}
#[tauri::command]
fn auth_start(remember: bool, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let st = state.status.lock().unwrap();
    require_account_edit(&st)?;
    state.accounts.start(remember)
}
#[tauri::command]
fn auth_cancel(state: State<'_, Arc<Shared>>) {
    state.accounts.cancel();
}
#[tauri::command]
fn auth_select(id: Option<String>, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let st = state.status.lock().unwrap();
    require_account_edit(&st)?;
    state.accounts.select(id)
}
#[tauri::command]
async fn auth_remove(id: String, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = s.status.lock().unwrap();
        require_account_edit(&st)?;
        s.accounts.remove(id)
    })
    .await
    .map_err(|_| "账号操作任务失败")?
}
fn open_official(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|_| "无法打开默认浏览器")?;
    Ok(())
}
#[tauri::command]
fn auth_open_browser(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    if state.accounts.snapshot().challenge.is_none() {
        return Err("请先开始微软登录，获取设备代码".into());
    }
    open_official("https://www.microsoft.com/link")
}
#[tauri::command]
fn auth_open_help(kind: String) -> Result<(), String> {
    open_official(match kind.as_str() {
        "register" => {
            "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app"
        }
        "tenant" => "https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account",
        "review" => "https://aka.ms/mce-reviewappid",
        _ => return Err("未知帮助类型".into()),
    })
}
#[tauri::command]
async fn inspect_instance(id: String, state: State<'_, Arc<Shared>>) -> Result<Inspection, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = s.settings.lock().unwrap().clone();
        let plan = pcl_core::build_launch_plan(
            Path::new(&cfg.root),
            &s.project,
            &id,
            &cfg.player,
            *cfg.overrides.get(&id).unwrap_or(&cfg.memory_gib),
        )?;
        Ok(Inspection {
            java: plan.java.display().to_string(),
            game_dir: plan.game_dir.display().to_string(),
            arguments: plan.args.len(),
            log_path: plan.log_path.display().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn update(s: &Shared, stage: &str, message: String, pid: Option<u32>, exit_code: Option<i32>) {
    let mut st = s.status.lock().unwrap();
    st.stage = stage.into();
    st.message = message;
    st.pid = pid;
    st.exit_code = exit_code;
}
fn capture_output(
    reader: impl Read + Send + 'static,
    log: Arc<Mutex<fs::File>>,
    accounts: Arc<accounts::Accounts>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let safe = accounts.redact(String::from_utf8_lossy(&line).into_owned());
                    if log.lock().unwrap().write_all(safe.as_bytes()).is_err() {
                        break;
                    }
                }
            }
        }
    })
}
#[tauri::command]
fn launch_game(id: String, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    {
        let mut st = state.status.lock().unwrap();
        if state.downloads.active() {
            return Err("请在安装任务结束后启动游戏".into());
        }
        if st.stage == "preparing" || st.stage == "running" {
            return Err("已有启动任务或游戏正在运行".into());
        }
        if matches!(
            state.accounts.snapshot().stage.as_str(),
            "preparing" | "waiting"
        ) {
            return Err("请先完成或取消微软登录".into());
        }
        state.stop.store(false, Ordering::SeqCst);
        *st = RunStatus {
            stage: "preparing".into(),
            message: "正在解析版本和检查 Linux 依赖…".into(),
            version: Some(id.clone()),
            ..Default::default()
        };
    }
    let s = state.inner().clone();
    std::thread::spawn(move || {
        let task = || -> Result<(), String> {
            let cfg = s.settings.lock().unwrap().clone();
            validate(&cfg)?;
            let memory = *cfg.overrides.get(&id).unwrap_or(&cfg.memory_gib);
            let plan = match s.accounts.identity()? {
                Some(identity) => pcl_core::build_launch_plan_authenticated(
                    Path::new(&cfg.root),
                    &s.project,
                    &id,
                    &pcl_core::OnlineIdentity {
                        name: identity.name,
                        uuid: identity.uuid,
                        access_token: identity.access_token,
                        xuid: identity.xuid,
                        client_id: identity.client_id,
                    },
                    memory,
                )?,
                None => pcl_core::build_launch_plan(
                    Path::new(&cfg.root),
                    &s.project,
                    &id,
                    &cfg.player,
                    memory,
                )?,
            };
            if s.stop.load(Ordering::SeqCst) {
                update(&s, "idle", "启动已取消".into(), None, None);
                return Ok(());
            }
            fs::create_dir_all(plan.log_path.parent().unwrap()).map_err(|e| e.to_string())?;
            let log = fs::File::create(&plan.log_path).map_err(|e| e.to_string())?;
            let mut child = Command::new(&plan.java)
                .args(&plan.args)
                .current_dir(&plan.game_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Java 启动失败：{e}"))?;
            let log = Arc::new(Mutex::new(log));
            let stdout = capture_output(
                child.stdout.take().unwrap(),
                log.clone(),
                s.accounts.clone(),
            );
            let stderr = capture_output(child.stderr.take().unwrap(), log, s.accounts.clone());
            *s.log.lock().unwrap() = Some(plan.log_path);
            update(
                &s,
                "running",
                "游戏进程已启动，正在加载".into(),
                Some(child.id()),
                None,
            );
            loop {
                if s.stop.swap(false, Ordering::SeqCst) {
                    child.kill().map_err(|e| e.to_string())?;
                    let _ = child.wait();
                    update(&s, "exited", "游戏进程已结束".into(), None, None);
                    break;
                }
                if let Some(result) = child.try_wait().map_err(|e| e.to_string())? {
                    update(
                        &s,
                        if result.success() { "exited" } else { "error" },
                        format!(
                            "游戏已退出（{}）",
                            result
                                .code()
                                .map(|v| v.to_string())
                                .unwrap_or("信号".into())
                        ),
                        None,
                        result.code(),
                    );
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            let _ = stdout.join();
            let _ = stderr.join();
            Ok(())
        };
        if let Err(e) = task() {
            update(&s, "error", e, None, None);
        }
    });
    Ok(())
}
#[tauri::command]
fn stop_game(state: State<'_, Arc<Shared>>) {
    state.stop.store(true, Ordering::SeqCst);
}
#[tauri::command]
fn read_log(state: State<'_, Arc<Shared>>) -> Result<String, String> {
    let p = state
        .log
        .lock()
        .unwrap()
        .clone()
        .ok_or("这次会话还没有游戏日志")?;
    let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
    let n = f.metadata().map_err(|e| e.to_string())?.len();
    f.seek(SeekFrom::Start(n.saturating_sub(65536)))
        .map_err(|e| e.to_string())?;
    let mut b = Vec::new();
    f.read_to_end(&mut b).map_err(|e| e.to_string())?;
    Ok(state
        .accounts
        .redact(String::from_utf8_lossy(&b).into_owned()))
}
#[tauri::command]
fn open_folder(
    kind: String,
    id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<(), String> {
    let cfg = state.settings.lock().unwrap().clone();
    let root = PathBuf::from(cfg.root);
    let path = match kind.as_str() {
        "game" => root.clone(),
        "instance" => {
            let name = id.ok_or("未选择版本")?;
            if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
                return Err("无效版本名".into());
            }
            root.join("versions").join(name)
        }
        "logs" => root.join(".pcl-linux/logs"),
        "mods" | "saves" | "screenshots" | "resourcepacks" | "shaderpacks" | "litematics"
        | "server" => ui_data::resource_dir(&root, &id.ok_or("未选择版本")?, &kind)?,
        _ => return Err("未知目录类型".into()),
    };
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("目录超出游戏目录".into());
    }
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn main() {
    let project = project();
    let f = settings_file(&project);
    let defaults = Settings {
        root: project.join("Minecraft/.minecraft").display().to_string(),
        player: "Player".into(),
        memory_gib: 6,
        selected: None,
        overrides: BTreeMap::new(),
    };
    let mut warning = None;
    let cfg = if f.exists() {
        match fs::read(&f)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Settings>(&b).map_err(|e| e.to_string()))
        {
            Ok(c) => c,
            Err(e) => {
                let backup = f.with_extension(format!(
                    "invalid-{}.json",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                ));
                match fs::copy(&f, &backup) {
                    Ok(_) => {
                        warning = Some(format!("设置读取失败，已保留原文件副本并恢复默认值：{e}"))
                    }
                    Err(b) => panic!("无法读取或备份设置，原文件未修改：{e}；{b}"),
                };
                defaults
            }
        }
    } else {
        defaults
    };
    let state = Arc::new(Shared {
        accounts: Arc::new(accounts::Accounts::new(&project)),
        downloads: Arc::new(downloads::Downloads::new()),
        project,
        settings: Mutex::new(cfg),
        status: Mutex::new(RunStatus {
            stage: if warning.is_some() { "error" } else { "idle" }.into(),
            message: warning.unwrap_or_else(|| "准备就绪".into()),
            ..Default::default()
        }),
        stop: AtomicBool::new(false),
        closing: AtomicBool::new(false),
        log: Mutex::new(None),
    });
    tauri::Builder::default()
        .manage(state)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Arc<Shared>>();
                if state.downloads.active() {
                    api.prevent_close();
                    state.downloads.cancel();
                    if !state.closing.swap(true, Ordering::SeqCst) {
                        let downloads = state.downloads.clone();
                        let window = window.clone();
                        std::thread::spawn(move || {
                            while downloads.active() {
                                std::thread::sleep(Duration::from_millis(100));
                            }
                            let _ = window.close();
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            ui_catalog::ui_open_link,
            ui_catalog::loader_catalog,
            ui_catalog::upstream_contributors,
            ui_catalog::project_feedback,
            ui_catalog::launcher_logs,
            ui_catalog::launcher_read_log,
            ui_catalog::instance_servers,
            ui_data::system_info,
            ui_data::java_list,
            ui_data::instance_resources,
            ui_data::modrinth_search,
            save_settings,
            process_status,
            inspect_instance,
            launch_game,
            stop_game,
            read_log,
            open_folder,
            auth_status,
            auth_configure,
            auth_start,
            auth_cancel,
            auth_select,
            auth_remove,
            auth_open_browser,
            auth_open_help,
            download_catalog,
            download_status,
            download_start,
            download_cancel
        ])
        .run(tauri::generate_context!())
        .expect("桌面应用运行失败");
}
