mod accounts;
mod config;
mod downloads;
mod platform;
mod resource_details;
mod tasks;
mod ui_catalog;
mod ui_data;
use config::{ConfigStore, GameRoot, RootSummary, Settings};
use serde::Serialize;
use std::{
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
use tauri::{Emitter, Manager, State};
#[derive(Clone, Serialize, Default)]
struct RunStatus {
    stage: String,
    message: String,
    version: Option<String>,
    pid: Option<u32>,
    exit_code: Option<i32>,
    root_id: Option<String>,
    root_path: Option<String>,
}
struct Shared {
    project: PathBuf,
    accounts: Arc<accounts::Accounts>,
    downloads: Arc<downloads::Downloads>,
    tasks: Arc<tasks::Tasks>,
    config: ConfigStore,
    desktop: Arc<platform::Desktop>,
    operations: Mutex<()>,
    status: Mutex<RunStatus>,
    stop: AtomicBool,
    closing: AtomicBool,
    log: Mutex<Option<PathBuf>>,
}
#[derive(Serialize)]
struct Bootstrap {
    settings: Settings,
    instances: Vec<pcl_core::Instance>,
    roots: Vec<RootSummary>,
    scan_issues: Vec<pcl_core::ScanIssue>,
    scan_error: Option<String>,
    config_warning: Option<String>,
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
fn bootstrap_view(s: &Shared) -> Bootstrap {
    let (settings, roots) = s.config.view();
    let (instances, scan_issues, scan_error) =
        match pcl_core::scan_instances_report(Path::new(&settings.root)) {
            Ok(report) => (report.instances, report.issues, None),
            Err(error) => (Vec::new(), Vec::new(), Some(error)),
        };
    Bootstrap {
        settings,
        roots,
        instances,
        scan_issues,
        scan_error,
        config_warning: s.config.warning(),
        status: s.status.lock().unwrap().clone(),
        auth: s.accounts.snapshot(),
    }
}
#[tauri::command]
async fn bootstrap(state: State<'_, Arc<Shared>>) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Ok(bootstrap_view(&s)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let _operation = state.operations.lock().unwrap();
    state.config.save(settings)
}

#[tauri::command]
async fn roots_list(state: State<'_, Arc<Shared>>) -> Result<Vec<RootSummary>, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.config.roots())
        .await
        .map_err(|_| "读取游戏目录失败".into())
}

#[tauri::command]
async fn root_pick(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<platform::DirectoryChoice, String> {
    state
        .desktop
        .pick_root(window, PathBuf::from(state.config.snapshot().root))
        .await
}

#[derive(Serialize)]
struct RootRegistration {
    root: GameRoot,
    bootstrap: Bootstrap,
}

#[tauri::command]
async fn root_register(
    path: String,
    name: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<RootRegistration, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = {
            let _operation = s.operations.lock().unwrap();
            s.config.register(path, name)?
        };
        Ok(RootRegistration {
            root,
            bootstrap: bootstrap_view(&s),
        })
    })
    .await
    .map_err(|_| "登记游戏目录失败")?
}

#[tauri::command]
async fn root_select(id: String, state: State<'_, Arc<Shared>>) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _operation = s.operations.lock().unwrap();
            s.config.select(&id)?;
        }
        Ok(bootstrap_view(&s))
    })
    .await
    .map_err(|_| "切换游戏目录失败")?
}

#[tauri::command]
async fn root_update(
    id: String,
    name: Option<String>,
    position: Option<usize>,
    state: State<'_, Arc<Shared>>,
) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _operation = s.operations.lock().unwrap();
            s.config.update(&id, name, position)?;
        }
        Ok(bootstrap_view(&s))
    })
    .await
    .map_err(|_| "更新游戏目录失败")?
}

fn require_root_unused(s: &Shared, id: &str) -> Result<(), String> {
    let run = s.status.lock().unwrap();
    if s.tasks.uses_root(id)
        || (run.root_id.as_deref() == Some(id)
            && matches!(run.stage.as_str(), "preparing" | "running"))
    {
        return Err("该目录正在被游戏或安装任务使用，请等待结束后移除".into());
    }
    Ok(())
}

#[tauri::command]
async fn root_remove(id: String, state: State<'_, Arc<Shared>>) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _operation = s.operations.lock().unwrap();
            require_root_unused(&s, &id)?;
            s.config.remove(&id)?;
        }
        Ok(bootstrap_view(&s))
    })
    .await
    .map_err(|_| "移除游戏目录失败")?
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
fn download_cancel(task_id: Option<String>, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    if let Some(id) = task_id {
        state.tasks.cancel(&id)?;
    } else {
        state.downloads.cancel();
    }
    Ok(())
}
#[tauri::command]
fn download_start(
    id: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<String, String> {
    let _operation = state.operations.lock().unwrap();
    let run = state.status.lock().unwrap();
    require_account_edit(&run)?;
    state.config.ensure_writable()?;
    let root = state.config.resolve(root_id.as_deref())?;
    pcl_core::identifier(&id)?;
    let shared = state.inner().clone();
    let target = root.id.clone();
    state
        .downloads
        .start(PathBuf::from(root.path), root.id, id, move |result| {
            shared.config.select_installed(&target, &result.id)
        })
}

#[tauri::command]
fn task_list(state: State<'_, Arc<Shared>>) -> Vec<tasks::TaskSnapshot> {
    state.tasks.list()
}

#[tauri::command]
fn task_snapshot(id: String, state: State<'_, Arc<Shared>>) -> Option<tasks::TaskSnapshot> {
    state.tasks.snapshot(&id)
}

#[tauri::command]
fn task_cancel(id: String, state: State<'_, Arc<Shared>>) -> Result<tasks::TaskSnapshot, String> {
    state.tasks.cancel(&id)
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
async fn inspect_instance(
    id: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<Inspection, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Building the current launch plan extracts natives. Coordinate this
        // short write with game startup, installs and root removal.
        let _operation = s.operations.lock().unwrap();
        s.config.ensure_writable()?;
        require_account_edit(&s.status.lock().unwrap())?;
        if s.tasks.active().is_some() {
            return Err("请在安装任务结束后检查启动环境".into());
        }
        let (cfg, root) = instance_context(&s.config, root_id.as_deref(), &id)?;
        let plan = pcl_core::build_launch_plan(
            Path::new(&root.path),
            &s.project,
            &id,
            &cfg.player,
            *root.overrides.get(&id).unwrap_or(&cfg.memory_gib),
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
fn instance_context(
    config: &ConfigStore,
    root_id: Option<&str>,
    id: &str,
) -> Result<(Settings, GameRoot), String> {
    pcl_core::identifier(id)?;
    let settings = config.snapshot();
    let root = config.resolve(Some(root_id.unwrap_or(&settings.root_id)))?;
    Ok((settings, root))
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
fn launch_game(
    id: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<(), String> {
    let _operation = state.operations.lock().unwrap();
    state.config.ensure_writable()?;
    let (cfg, root) = instance_context(&state.config, root_id.as_deref(), &id)?;
    {
        let mut st = state.status.lock().unwrap();
        if state.tasks.active().is_some() {
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
            root_id: Some(root.id.clone()),
            root_path: Some(root.path.clone()),
            ..Default::default()
        };
    }
    let s = state.inner().clone();
    std::thread::spawn(move || {
        let task = || -> Result<(), String> {
            let memory = *root.overrides.get(&id).unwrap_or(&cfg.memory_gib);
            let plan = match s.accounts.identity()? {
                Some(identity) => pcl_core::build_launch_plan_authenticated(
                    Path::new(&root.path),
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
                    Path::new(&root.path),
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
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<(), String> {
    let root = PathBuf::from(state.config.resolve(root_id.as_deref())?.path);
    let path = match kind.as_str() {
        "game" => root.clone(),
        "instance" => {
            let name = id.ok_or("未选择版本")?;
            pcl_core::identifier(&name)?;
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
    let (config, warning) = ConfigStore::load(&project);
    let tasks = Arc::new(tasks::Tasks::new());
    let state = Arc::new(Shared {
        accounts: Arc::new(accounts::Accounts::new(&project)),
        downloads: Arc::new(downloads::Downloads::new(tasks.clone())),
        tasks,
        config,
        desktop: Arc::new(platform::Desktop::default()),
        operations: Mutex::new(()),
        project,
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
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<Arc<Shared>>()
                .tasks
                .set_listener(move |snapshot| {
                    let _ = handle.emit("task_changed", snapshot);
                });
            Ok(())
        })
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
            roots_list,
            root_pick,
            root_register,
            root_select,
            root_update,
            root_remove,
            task_list,
            task_snapshot,
            task_cancel,
            ui_catalog::ui_open_link,
            ui_catalog::loader_catalog,
            ui_catalog::loader_candidates,
            resource_details::resource_details,
            resource_details::resource_dependencies,
            resource_details::resource_open_link,
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

#[cfg(test)]
mod integration_tests {
    use super::*;
    use tasks::{TaskKind, TaskOutcome, TaskTarget};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../work/desktop-integration-tests")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            fs::create_dir_all(path.join("Minecraft/.minecraft")).unwrap();
            Self(path)
        }
        fn shared(&self) -> Shared {
            let (config, warning) = ConfigStore::load(&self.0);
            assert!(warning.is_none());
            let tasks = Arc::new(tasks::Tasks::new());
            Shared {
                project: self.0.clone(),
                accounts: Arc::new(accounts::Accounts::new(&self.0)),
                downloads: Arc::new(downloads::Downloads::new(tasks.clone())),
                tasks,
                config,
                desktop: Arc::new(platform::Desktop::default()),
                operations: Mutex::new(()),
                status: Mutex::new(RunStatus::default()),
                stop: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                log: Mutex::new(None),
            }
        }
        fn second(&self, config: &ConfigStore) -> GameRoot {
            let path = self.0.join("second");
            fs::create_dir_all(&path).unwrap();
            config
                .register(path.to_str().unwrap().into(), Some("Second".into()))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn captured_instance_context_survives_browsing_another_root() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let first = state.config.snapshot().root_id;
        let second = fixture.second(&state.config);
        let mut settings = state.config.snapshot();
        settings.memory_gib = 14;
        settings.overrides.insert("Same".into(), 12);
        state.config.save(settings).unwrap();
        let (captured_settings, captured_root) =
            instance_context(&state.config, None, "Same").unwrap();
        let mut settings = state.config.select(&second.id).unwrap();
        settings.overrides.insert("Same".into(), 4);
        state.config.save(settings).unwrap();
        assert_eq!(captured_root.id, first);
        assert_eq!(captured_settings.memory_gib, 14);
        assert_eq!(captured_root.overrides["Same"], 12);
        let (_, bound) = instance_context(&state.config, Some(&first), "Same").unwrap();
        assert_eq!(bound, captured_root);
        assert_eq!(
            instance_context(&state.config, None, "Same")
                .unwrap()
                .1
                .overrides["Same"],
            4
        );
    }

    #[test]
    fn root_removal_guard_tracks_bound_task_and_process_after_switching() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let first = state.config.resolve(None).unwrap();
        let second = fixture.second(&state.config);
        let task = state
            .tasks
            .admit(
                TaskTarget {
                    root_id: first.id.clone(),
                    root_path: first.path.clone(),
                    instance_id: Some("Same".into()),
                },
                TaskKind::Install,
            )
            .unwrap();
        state.config.select(&second.id).unwrap();
        assert!(require_root_unused(&state, &first.id).is_err());
        assert!(require_root_unused(&state, &second.id).is_ok());
        state.tasks.cancel(task.id()).unwrap();
        assert!(require_root_unused(&state, &first.id).is_err());
        task.finish(TaskOutcome::Failed("cancelled".into()));
        assert!(require_root_unused(&state, &first.id).is_ok());
        *state.status.lock().unwrap() = RunStatus {
            stage: "running".into(),
            root_id: Some(first.id.clone()),
            root_path: Some(first.path),
            ..Default::default()
        };
        assert!(require_root_unused(&state, &first.id).is_err());
        assert!(require_root_unused(&state, &second.id).is_ok());
        update(&state, "exited", "finished".into(), None, Some(0));
        assert!(require_root_unused(&state, &first.id).is_ok());
    }
}
