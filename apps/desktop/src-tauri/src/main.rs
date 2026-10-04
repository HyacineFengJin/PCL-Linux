mod accounts;
mod config;
mod downloads;
mod instance_meta;
mod platform;
mod resource_details;
mod resource_ops;
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
    instance_metadata: instance_meta::MetadataStore,
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
    instances: Vec<InstanceView>,
    roots: Vec<RootSummary>,
    scan_issues: Vec<pcl_core::ScanIssue>,
    scan_error: Option<String>,
    config_warning: Option<String>,
    status: RunStatus,
    auth: accounts::AuthState,
}
#[derive(Serialize)]
struct InstanceView {
    #[serde(flatten)]
    instance: pcl_core::Instance,
    metadata: instance_meta::Metadata,
    metadata_revision: String,
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
    // Bind scanning and metadata to the same directory even if a registered
    // alias is retargeted while this read is running.
    let canonical = Path::new(&settings.root).canonicalize().ok();
    let scan_path = canonical.as_deref().unwrap_or(Path::new(&settings.root));
    let (instances, scan_issues, scan_error) = match pcl_core::scan_instances_report(scan_path) {
        Ok(report) => (report.instances, report.issues, None),
        Err(error) => (Vec::new(), Vec::new(), Some(error)),
    };
    let instances = instances
        .into_iter()
        .map(|instance| {
            let view = s
                .instance_metadata
                .get(&settings.root_id, scan_path, &instance.id);
            InstanceView {
                metadata: view.metadata(),
                metadata_revision: view.revision,
                instance,
            }
        })
        .collect();
    let warnings: Vec<_> = [s.config.warning(), s.instance_metadata.warning()]
        .into_iter()
        .flatten()
        .collect();
    Bootstrap {
        settings,
        roots,
        instances,
        scan_issues,
        scan_error,
        config_warning: (!warnings.is_empty()).then(|| warnings.join("\n")),
        status: s.status.lock().unwrap().clone(),
        auth: s.accounts.snapshot(),
    }
}

fn update_instance_metadata(
    s: &Shared,
    root_id: Option<&str>,
    id: &str,
    revision: &str,
    patch: instance_meta::MetadataPatch,
) -> Result<instance_meta::MetaView, String> {
    let _operation = s.operations.lock().unwrap();
    s.config.ensure_writable()?;
    if s.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭，请重新打开后再修改实例信息".into());
    }
    if s.tasks.active().is_some() {
        return Err("请在文件操作结束后修改实例信息".into());
    }
    if matches!(
        s.status.lock().unwrap().stage.as_str(),
        "preparing" | "running"
    ) {
        return Err("请在游戏退出后修改实例信息".into());
    }
    pcl_core::identifier(id)?;
    let root = s.config.resolve(root_id)?;
    if !pcl_core::scan_instances_report(Path::new(&root.path))?
        .instances
        .iter()
        .any(|instance| instance.id == id)
    {
        return Err("未找到可读取的所选实例，请重新读取列表".into());
    }
    s.instance_metadata
        .patch(&root.id, Path::new(&root.path), id, revision, patch)
}

#[tauri::command]
async fn instance_metadata_update(
    root_id: Option<String>,
    id: String,
    revision: String,
    patch: instance_meta::MetadataPatch,
    state: State<'_, Arc<Shared>>,
) -> Result<instance_meta::MetaView, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        update_instance_metadata(&s, root_id.as_deref(), &id, &revision, patch)
    })
    .await
    .map_err(|_| "保存实例信息的任务未能完成")?
}

#[tauri::command]
async fn instance_metadata_read(
    root_id: Option<String>,
    id: String,
    state: State<'_, Arc<Shared>>,
) -> Result<instance_meta::MetaView, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        pcl_core::identifier(&id)?;
        let root = s.config.resolve(root_id.as_deref())?;
        if !pcl_core::scan_instances_report(Path::new(&root.path))?
            .instances
            .iter()
            .any(|instance| instance.id == id)
        {
            return Err("未找到可读取的所选实例".into());
        }
        if let Some(warning) = s.instance_metadata.warning() {
            return Err(warning);
        }
        Ok(s.instance_metadata
            .get(&root.id, Path::new(&root.path), &id))
    })
    .await
    .map_err(|_| "读取实例信息的任务未能完成")?
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
        return Err("该目录正在被游戏或文件操作使用，请等待结束后移除".into());
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
async fn download_cancel(
    task_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<downloads::DownloadStatus, String> {
    let downloads = state.downloads.clone();
    tauri::async_runtime::spawn_blocking(move || downloads.cancel_and_wait(task_id.as_deref()))
        .await
        .map_err(|_| "取消安装的任务意外退出")?
}
#[tauri::command]
fn download_start(
    id: String,
    name: Option<String>,
    components: Option<Vec<pcl_install::ComponentSelection>>,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<String, String> {
    let _operation = state.operations.lock().unwrap();
    if state.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭，请重新打开后安装".into());
    }
    let run = state.status.lock().unwrap();
    if matches!(run.stage.as_str(), "preparing" | "running") {
        return Err("请在游戏退出后安装新实例".into());
    }
    state.config.ensure_writable()?;
    let root = state.config.resolve(root_id.as_deref())?;
    let request = pcl_install::InstallRequest {
        name: name.unwrap_or_else(|| id.clone()),
        minecraft: id,
        components: components.unwrap_or_default(),
    };
    request.validate()?;
    let path = pcl_core::safe_join(Path::new(&root.path), format!("versions/{}", request.name))?;
    match fs::symlink_metadata(&path) {
        Ok(_) => return Err("实例名称已存在，请换一个名称".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法检查实例名称：{e}")),
    }
    let shared = state.inner().clone();
    let target = root.id.clone();
    state.downloads.start(
        PathBuf::from(root.path),
        root.id,
        request,
        shared.project.clone(),
        move |result| shared.config.select_installed(&target, &result.id),
    )
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

enum ResourceRequest {
    SetEnabled {
        files: Vec<resource_ops::ResourceFile>,
        enabled: bool,
    },
    Remove(Vec<resource_ops::ResourceFile>),
    Import(Vec<PathBuf>),
    Restore(String),
    Recover,
}

fn require_resource_write(s: &Shared) -> Result<(), String> {
    s.config.ensure_writable()?;
    if matches!(
        s.status.lock().unwrap().stage.as_str(),
        "preparing" | "running"
    ) {
        return Err("请在游戏退出后修改资源文件".into());
    }
    Ok(())
}

fn admit_resource(
    s: &Arc<Shared>,
    id: &str,
    root_id: Option<&str>,
    expected_path: Option<&str>,
) -> Result<(GameRoot, tasks::TaskHandle), String> {
    let _operation = s.operations.lock().unwrap();
    require_resource_write(s)?;
    pcl_core::identifier(id)?;
    let root = s.config.resolve(root_id)?;
    if expected_path.is_some_and(|path| path != root.path) {
        return Err("游戏目录位置已改变，请重新选择文件".into());
    }
    let task = s.tasks.admit(
        tasks::TaskTarget {
            root_id: root.id.clone(),
            root_path: root.path.clone(),
            instance_id: Some(id.into()),
        },
        tasks::TaskKind::ResourceOperation,
    )?;
    Ok((root, task))
}

async fn run_resource_request(
    root: GameRoot,
    id: String,
    kind: String,
    request: ResourceRequest,
    task: tasks::TaskHandle,
) -> Result<resource_ops::MutationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = task.cancellation_token();
        let mut commit = || {
            task.begin_finishing();
            if cancel.load(Ordering::SeqCst) {
                Err("资源操作已取消".into())
            } else {
                Ok(())
            }
        };
        let mut progress = |completed, total| {
            task.update(tasks::TaskProgress {
                stage: tasks::TaskStage::Processing,
                phase: "resources".into(),
                message: "正在处理资源文件…".into(),
                completed,
                total,
                bytes_done: 0,
                bytes_total: 0,
                network_bytes: 0,
                steps: Vec::new(),
            });
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let root = Path::new(&root.path);
            match request {
                ResourceRequest::SetEnabled { files, enabled } => resource_ops::set_enabled(
                    root,
                    &id,
                    &kind,
                    &files,
                    enabled,
                    &cancel,
                    &mut commit,
                    &mut progress,
                ),
                ResourceRequest::Remove(files) => resource_ops::remove(
                    root,
                    &id,
                    &kind,
                    &files,
                    &cancel,
                    &mut commit,
                    &mut progress,
                ),
                ResourceRequest::Import(sources) => resource_ops::import_files(
                    root,
                    &id,
                    &kind,
                    &sources,
                    &cancel,
                    &mut commit,
                    &mut progress,
                ),
                ResourceRequest::Restore(operation) => resource_ops::restore(
                    root,
                    &id,
                    &kind,
                    &operation,
                    &cancel,
                    &mut commit,
                    &mut progress,
                ),
                ResourceRequest::Recover => {
                    commit()?;
                    resource_ops::recover_pending(root, &id, &kind)?;
                    Ok(resource_ops::MutationResult {
                        changed: 0,
                        undo_id: None,
                        message: "已恢复未完成的资源操作，请检查资源列表".into(),
                    })
                }
            }
        }))
        .unwrap_or_else(|_| Err("资源操作意外中断，请刷新资源列表后重试".into()));
        match &result {
            Ok(report) => {
                task.finish(tasks::TaskOutcome::Complete {
                    result: serde_json::to_value(report).ok(),
                    message: report.message.clone(),
                    error: None,
                });
            }
            Err(error) => {
                task.finish(tasks::TaskOutcome::Failed(error.clone()));
            }
        }
        result
    })
    .await
    .map_err(|_| "资源操作任务未能完成".to_owned())?
}

#[tauri::command]
async fn resource_set_enabled(
    id: String,
    kind: String,
    files: Vec<resource_ops::ResourceFile>,
    enabled: bool,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<resource_ops::MutationResult, String> {
    let (root, task) = admit_resource(state.inner(), &id, root_id.as_deref(), None)?;
    run_resource_request(
        root,
        id,
        kind,
        ResourceRequest::SetEnabled { files, enabled },
        task,
    )
    .await
}

#[tauri::command]
async fn resource_remove(
    id: String,
    kind: String,
    files: Vec<resource_ops::ResourceFile>,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<resource_ops::MutationResult, String> {
    let (root, task) = admit_resource(state.inner(), &id, root_id.as_deref(), None)?;
    run_resource_request(root, id, kind, ResourceRequest::Remove(files), task).await
}

#[tauri::command]
async fn resource_restore(
    id: String,
    kind: String,
    operation_id: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<resource_ops::MutationResult, String> {
    let (root, task) = admit_resource(state.inner(), &id, root_id.as_deref(), None)?;
    run_resource_request(root, id, kind, ResourceRequest::Restore(operation_id), task).await
}

#[tauri::command]
async fn resource_recover(
    id: String,
    kind: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<resource_ops::MutationResult, String> {
    let (root, task) = admit_resource(state.inner(), &id, root_id.as_deref(), None)?;
    run_resource_request(root, id, kind, ResourceRequest::Recover, task).await
}

#[tauri::command]
async fn resource_removed(
    id: String,
    kind: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<Vec<resource_ops::RemovedOperation>, String> {
    let root = state.config.resolve(root_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        resource_ops::removed(Path::new(&root.path), &id, &kind)
    })
    .await
    .map_err(|_| "读取可恢复资源失败".to_owned())?
}

#[derive(Serialize)]
struct ResourceImportResult {
    status: &'static str,
    changed: usize,
    undo_id: Option<String>,
    message: Option<String>,
}

#[tauri::command]
async fn resource_import(
    id: String,
    kind: String,
    root_id: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<ResourceImportResult, String> {
    let initial = {
        let _operation = state.operations.lock().unwrap();
        require_resource_write(state.inner())?;
        pcl_core::identifier(&id)?;
        if state.tasks.active().is_some() {
            return Err("请在当前文件操作结束后安装资源".into());
        }
        state.config.resolve(root_id.as_deref())?
    };
    let choice = state
        .desktop
        .pick_resource_files(window, PathBuf::from(&initial.path), &kind)
        .await?;
    if choice.status != "selected" {
        return Ok(ResourceImportResult {
            status: choice.status,
            changed: 0,
            undo_id: None,
            message: choice.message,
        });
    }
    let (root, task) = admit_resource(state.inner(), &id, Some(&initial.id), Some(&initial.path))?;
    let result =
        run_resource_request(root, id, kind, ResourceRequest::Import(choice.paths), task).await?;
    Ok(ResourceImportResult {
        status: "complete",
        changed: result.changed,
        undo_id: result.undo_id,
        message: Some(result.message),
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
            return Err("请在文件操作结束后检查启动环境".into());
        }
        let (cfg, root) = instance_context(&s.config, root_id.as_deref(), &id)?;
        resource_ops::ensure_ready(Path::new(&root.path))?;
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
    resource_ops::ensure_ready(Path::new(&root.path))?;
    {
        let mut st = state.status.lock().unwrap();
        if state.tasks.active().is_some() {
            return Err("请在文件操作结束后启动游戏".into());
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
        instance_metadata: instance_meta::MetadataStore::load(&project),
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
                if let Some(task) = state.tasks.active() {
                    api.prevent_close();
                    let _ = state.tasks.cancel(&task.id);
                    if !state.closing.swap(true, Ordering::SeqCst) {
                        let tasks = state.tasks.clone();
                        let window = window.clone();
                        std::thread::spawn(move || {
                            while tasks.active().is_some() {
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
            instance_metadata_update,
            instance_metadata_read,
            roots_list,
            root_pick,
            root_register,
            root_select,
            root_update,
            root_remove,
            task_list,
            task_snapshot,
            task_cancel,
            resource_set_enabled,
            resource_remove,
            resource_restore,
            resource_recover,
            resource_removed,
            resource_import,
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
                instance_metadata: instance_meta::MetadataStore::load(&self.0),
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

    #[test]
    fn resource_admission_keeps_captured_root_and_excludes_all_other_writers() {
        let fixture = Fixture::new();
        let state = Arc::new(fixture.shared());
        let first = state.config.resolve(None).unwrap();
        let second = fixture.second(&state.config);
        let (bound, task) = admit_resource(&state, "Same", Some(&first.id), None).unwrap();
        assert_eq!(bound.id, first.id);
        state.config.select(&second.id).unwrap();
        assert!(admit_resource(&state, "Same", Some(&second.id), None).is_err());
        assert!(require_root_unused(&state, &first.id).is_err());
        assert!(require_root_unused(&state, &second.id).is_ok());
        state.tasks.cancel(task.id()).unwrap();
        assert!(state.tasks.active().is_some());
        assert!(admit_resource(&state, "Same", Some(&second.id), None).is_err());
        task.finish(TaskOutcome::Failed("cancelled".into()));
        assert!(state.tasks.active().is_none());
        let (_, task) = admit_resource(&state, "Same", Some(&second.id), None).unwrap();
        task.finish(TaskOutcome::Complete {
            result: None,
            message: "done".into(),
            error: None,
        });
        *state.status.lock().unwrap() = RunStatus {
            stage: "running".into(),
            root_id: Some(first.id),
            ..Default::default()
        };
        assert!(admit_resource(&state, "Same", Some(&second.id), None).is_err());
        assert!(state.tasks.active().is_none());
    }

    #[test]
    fn import_admission_rejects_directory_retargeted_after_file_selection() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let state = Arc::new(fixture.shared());
        let first = fixture.0.join("source-a");
        let second = fixture.0.join("source-b");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let alias = fixture.0.join("chosen-folder");
        symlink(&first, &alias).unwrap();
        let registered = state
            .config
            .register(alias.to_str().unwrap().into(), None)
            .unwrap();
        let initial = state.config.resolve(Some(&registered.id)).unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&second, &alias).unwrap();
        assert!(admit_resource(&state, "Same", Some(&initial.id), Some(&initial.path)).is_err());
        assert!(state.tasks.active().is_none());
        state.config.remove(&registered.id).unwrap();
        assert!(admit_resource(&state, "Same", Some(&initial.id), Some(&initial.path)).is_err());
        assert!(state.tasks.active().is_none());
    }

    fn metadata_fixture_version(root: &GameRoot) {
        let folder = Path::new(&root.path).join("versions/Same");
        fs::create_dir_all(folder.join("mods")).unwrap();
        fs::write(
            folder.join("Same.json"),
            r#"{"id":"Same","clientVersion":"1.21.1","libraries":[]}"#,
        )
        .unwrap();
    }

    #[test]
    fn instance_metadata_keeps_root_scope_and_bootstrap_physical_identity() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let first = state.config.resolve(None).unwrap();
        let second = fixture.second(&state.config);
        metadata_fixture_version(&first);
        metadata_fixture_version(&second);
        let view = state
            .instance_metadata
            .get(&first.id, Path::new(&first.path), "Same");
        state.config.select(&second.id).unwrap();
        let config_before = fs::read(fixture.0.join(".pcl-rust/settings.json")).unwrap();
        let saved = update_instance_metadata(
            &state,
            Some(&first.id),
            "Same",
            &view.revision,
            instance_meta::MetadataPatch {
                description: Some("Local description".into()),
                favorite: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(saved.metadata().favorite);
        assert_eq!(
            fs::read(fixture.0.join(".pcl-rust/settings.json")).unwrap(),
            config_before
        );
        let second_view = bootstrap_view(&state);
        assert_eq!(second_view.instances.len(), 1);
        assert!(!second_view.instances[0].metadata.favorite);
        assert!(second_view.instances[0].metadata.description.is_empty());
        state.config.select(&first.id).unwrap();
        let first_view = bootstrap_view(&state);
        assert_eq!(first_view.instances[0].instance.id, "Same");
        assert_eq!(
            first_view.instances[0].metadata.description,
            "Local description"
        );
        let projection = serde_json::to_value(&first_view.instances[0]).unwrap();
        assert_eq!(projection["id"], "Same");
        assert_eq!(projection["metadata_revision"], saved.revision);
        assert!(Path::new(&first.path)
            .join("versions/Same/Same.json")
            .is_file());
    }

    #[test]
    fn instance_metadata_rejects_wrong_scope_busy_missing_and_removed_targets() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let first = state.config.resolve(None).unwrap();
        let second = fixture.second(&state.config);
        metadata_fixture_version(&first);
        metadata_fixture_version(&second);
        let first_view = state
            .instance_metadata
            .get(&first.id, Path::new(&first.path), "Same");
        let patch = || instance_meta::MetadataPatch {
            favorite: Some(true),
            ..Default::default()
        };
        assert!(update_instance_metadata(
            &state,
            Some(&second.id),
            "Same",
            &first_view.revision,
            patch()
        )
        .is_err());
        assert!(update_instance_metadata(
            &state,
            Some(&first.id),
            "Missing",
            &first_view.revision,
            patch()
        )
        .is_err());
        let task = state
            .tasks
            .admit(
                TaskTarget {
                    root_id: first.id.clone(),
                    root_path: first.path.clone(),
                    instance_id: Some("Same".into()),
                },
                TaskKind::ResourceOperation,
            )
            .unwrap();
        assert!(update_instance_metadata(
            &state,
            Some(&first.id),
            "Same",
            &first_view.revision,
            patch()
        )
        .is_err());
        task.finish(TaskOutcome::Failed("stopped".into()));
        for stage in ["preparing", "running"] {
            state.status.lock().unwrap().stage = stage.into();
            assert!(update_instance_metadata(
                &state,
                Some(&first.id),
                "Same",
                &first_view.revision,
                patch()
            )
            .is_err());
        }
        state.status.lock().unwrap().stage = "idle".into();
        let second_view = state
            .instance_metadata
            .get(&second.id, Path::new(&second.path), "Same");
        state.config.remove(&second.id).unwrap();
        assert!(update_instance_metadata(
            &state,
            Some(&second.id),
            "Same",
            &second_view.revision,
            patch()
        )
        .is_err());
        assert!(!fixture.0.join(".pcl-rust/instance-metadata.json").exists());
        assert!(
            !state
                .instance_metadata
                .get(&first.id, Path::new(&first.path), "Same")
                .metadata()
                .favorite
        );
    }
}
