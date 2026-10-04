mod accounts;
mod config;
mod downloads;
mod export_presets;
mod instance_commands;
mod instance_delete;
mod instance_export;
mod instance_import;
mod instance_meta;
mod instance_rename;
mod instance_rename_refs;
mod instance_rename_service;
mod instance_reset;
mod java_commands;
mod java_service;
mod platform;
mod resource_details;
mod resource_ops;
mod tasks;
mod ui_catalog;
mod ui_data;
use config::{ConfigStore, GameRoot, RootSummary, Settings};
use serde::{Deserialize, Serialize};
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
    reset_recovery_error: Option<String>,
    import_recovery_error: Option<String>,
    delete_recovery_error: Option<String>,
    delete_recovery_root_id: Option<String>,
    rename_recovery_error: Option<String>,
    rename_recovery_root_id: Option<String>,
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
    let (instances, mut scan_issues, scan_error) = match pcl_core::scan_instances_report(scan_path)
    {
        Ok(report) => (report.instances, report.issues, None),
        Err(error) => (Vec::new(), Vec::new(), Some(error)),
    };
    // Deleted names remain reserved. An external recreation must not acquire
    // retained metadata or become a target of stale selection/confirmation.
    let reservations = instance_delete::reserved_names(scan_path);
    let instances = instances
        .into_iter()
        .filter(|instance| {
            let error = match &reservations {
                Ok(names) if names.contains(&instance.id) => {
                    Some("此实例名称由可恢复删除记录保留，请先恢复实例或移开冲突目录".into())
                }
                Err(error) => Some(error.clone()),
                _ => None,
            };
            if let Some(message) = error {
                scan_issues.push(pcl_core::ScanIssue {
                    id: instance.id.clone(),
                    message,
                });
                false
            } else {
                true
            }
        })
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
    let resetting_here = s.tasks.active().is_some_and(|task| {
        task.kind == tasks::TaskKind::InstanceReset && task.root_id == settings.root_id
    });
    let reset_recovery_error = if resetting_here {
        None
    } else {
        canonical
            .as_ref()
            .and_then(|path| instance_reset::ensure_ready(path).err())
    };
    let renaming = s
        .tasks
        .active()
        .is_some_and(|task| task.kind == tasks::TaskKind::InstanceRename);
    let (rename_recovery_error, rename_recovery_root_id) = if renaming {
        (None, None)
    } else {
        match instance_rename_refs::pending_root(&s.project) {
            Ok(Some(path)) => {
                let id = roots
                    .iter()
                    .find(|root| {
                        Path::new(&root.path) == path
                            || Path::new(&root.path)
                                .canonicalize()
                                .is_ok_and(|canonical| canonical == path)
                    })
                    .map(|root| root.id.clone());
                (
                    Some("存在未完成的实例重命名，请先恢复后再操作或启动".into()),
                    id,
                )
            }
            Ok(None) => (
                canonical
                    .as_ref()
                    .and_then(|path| instance_rename::ensure_ready(path).err()),
                Some(settings.root_id.clone()),
            ),
            Err(error) => (Some(error), None),
        }
    };
    let import_recovery_error = if s.tasks.active().is_some_and(|task| {
        task.kind == tasks::TaskKind::InstanceImport && task.root_id == settings.root_id
    }) {
        None
    } else {
        canonical
            .as_ref()
            .and_then(|path| instance_import::ensure_ready(path).err())
    };
    let (delete_recovery_error, delete_recovery_root_id) = if s.tasks.active().is_some_and(|task| {
        matches!(
            task.kind,
            tasks::TaskKind::InstanceDelete | tasks::TaskKind::InstanceRestore
        )
    }) {
        (None, None)
    } else {
        match instance_delete::pending_root(&s.project) {
            Ok(Some(path)) => (
                Some("存在未完成的实例删除或恢复，请先恢复后再操作".into()),
                roots
                    .iter()
                    .find(|root| {
                        Path::new(&root.path)
                            .canonicalize()
                            .is_ok_and(|canonical| canonical == path)
                    })
                    .map(|root| root.id.clone()),
            ),
            Ok(None) => (
                canonical
                    .as_ref()
                    .and_then(|path| instance_delete::ensure_ready(path).err()),
                Some(settings.root_id.clone()),
            ),
            Err(error) => (Some(error), None),
        }
    };
    Bootstrap {
        settings,
        roots,
        instances,
        scan_issues,
        scan_error,
        reset_recovery_error,
        import_recovery_error,
        delete_recovery_error,
        delete_recovery_root_id,
        rename_recovery_error,
        rename_recovery_root_id,
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
    require_reference_write(s)?;
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
    ensure_instance_files_ready(s, &root)?;
    instance_delete::ensure_name_available(Path::new(&root.path), id)?;
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
        instance_delete::ensure_name_available(Path::new(&root.path), &id)?;
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
fn save_settings(settings: Settings, state: State<'_, Arc<Shared>>) -> Result<Settings, String> {
    let _operation = state.operations.lock().unwrap();
    require_reference_write(&state)?;
    state.config.save(settings)?;
    Ok(state.config.snapshot())
}

/// Rename recovery snapshots include launcher references. Keep all cooperating
/// writers out until those references and the physical directory agree.
fn require_reference_write(s: &Shared) -> Result<(), String> {
    if s.tasks
        .active()
        .is_some_and(|task| task.kind == tasks::TaskKind::InstanceRename)
    {
        return Err("请等待实例重命名完成后再保存或切换游戏目录".into());
    }
    instance_rename_refs::ensure_project_ready(&s.project)
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
            require_reference_write(&s)?;
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
            require_reference_write(&s)?;
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
            require_reference_write(&s)?;
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

fn require_root_removable(s: &Shared, id: &str) -> Result<(), String> {
    require_root_unused(s, id)?;
    // Re-registration allocates a different registry identity. Keep the root
    // and its preferences until all deleted instances have been restored.
    let root = s
        .config
        .resolve(Some(id))
        .map_err(|error| format!("无法检查实例恢复记录，请先恢复目录访问后再移除登记：{error}"))?;
    if !instance_delete::reserved_names(Path::new(&root.path))?.is_empty() {
        return Err("此游戏目录仍有已删除实例，请先恢复它们后再移除目录登记".into());
    }
    Ok(())
}

#[tauri::command]
async fn root_remove(id: String, state: State<'_, Arc<Shared>>) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let _operation = s.operations.lock().unwrap();
            require_reference_write(&s)?;
            require_root_removable(&s, &id)?;
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
    instance_rename_refs::ensure_project_ready(&state.project)?;
    let root = state.config.resolve(root_id.as_deref())?;
    ensure_instance_files_ready(&state, &root)?;
    let request = pcl_install::InstallRequest {
        name: name.unwrap_or_else(|| id.clone()),
        minecraft: id,
        components: components.unwrap_or_default(),
    };
    request.validate()?;
    instance_commands::new_name(&state, &root, &request.name)?;
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

fn require_instance_job(s: &Shared) -> Result<(), String> {
    s.config.ensure_writable()?;
    if s.closing.load(Ordering::SeqCst) {
        return Err("启动器正在关闭，请重新打开后再操作实例".into());
    }
    if matches!(
        s.status.lock().unwrap().stage.as_str(),
        "preparing" | "running"
    ) {
        return Err("请在游戏退出后操作实例文件".into());
    }
    if s.tasks.active().is_some() {
        return Err("请在当前文件操作结束后操作实例".into());
    }
    Ok(())
}

fn ensure_instance_files_ready(s: &Shared, root: &GameRoot) -> Result<(), String> {
    instance_rename_refs::ensure_project_ready(&s.project)?;
    instance_rename::ensure_ready(Path::new(&root.path))?;
    instance_import::ensure_ready(Path::new(&root.path))?;
    instance_delete::ensure_ready(Path::new(&root.path))
}

#[derive(Deserialize)]
struct ResetSubmission {
    revision: String,
    id: String,
    components: Vec<pcl_install::ComponentSelection>,
}
#[derive(Deserialize)]
struct ExportSubmission {
    revision: String,
    instance_id: String,
    request: instance_export::ExportRequest,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameSubmission {
    revision: String,
    id: String,
    new_name: String,
}

#[tauri::command]
async fn instance_rename_prepare(
    id: String,
    new_name: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<serde_json::Value, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        let checked = instance_rename_service::prepare(&s, &root, &id, &new_name)?;
        let mut view = serde_json::to_value(checked.plan).map_err(|e| e.to_string())?;
        view["revision"] = checked.revision.into();
        Ok(view)
    })
    .await
    .map_err(|_| "检查改名方案的任务意外退出".to_string())?
}

#[tauri::command]
async fn instance_rename_start(
    plan: RenameSubmission,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<serde_json::Value, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        let checked = instance_rename_service::prepare(&s, &root, &plan.id, &plan.new_name)?;
        if checked.revision != plan.revision {
            return Err("实例、引用或保存的资料已改变，请重新检查改名方案".into());
        }
        let task = s.tasks.admit(
            tasks::TaskTarget {
                root_id: root.id.clone(),
                root_path: root.path.clone(),
                instance_id: Some(plan.id),
            },
            tasks::TaskKind::InstanceRename,
        )?;
        let task_id = task.id().to_owned();
        s.downloads.track(&task);
        let worker = s.clone();
        std::thread::Builder::new()
            .name(format!("pcl-rename-{task_id}"))
            .spawn(move || {
                let result = instance_rename_service::execute(&worker, &root, checked, &task);
                finish_instance_task(task, result, "实例重命名完成，游戏内容已保留");
            })
            .map_err(|e| format!("无法启动改名任务：{e}"))?;
        Ok(serde_json::json!({"id": task_id}))
    })
    .await
    .map_err(|_| "启动改名任务失败".to_string())?
}

#[tauri::command]
async fn instance_rename_recover(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<serde_json::Value, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let task;
        let root;
        {
            let _operation = s.operations.lock().unwrap();
            require_instance_job(&s)?;
            root = s.config.resolve(root_id.as_deref())?;
            task = s.tasks.admit(
                tasks::TaskTarget {
                    root_id: root.id.clone(),
                    root_path: root.path.clone(),
                    instance_id: None,
                },
                tasks::TaskKind::ResourceOperation,
            )?;
            task.begin_finishing();
        }
        let result = instance_rename_service::recover(&s, &root);
        finish_instance_task(task, result.clone(), "已恢复未完成的实例重命名");
        result
    })
    .await
    .map_err(|_| "恢复实例重命名失败".to_string())?
}

#[tauri::command]
async fn instance_reset_plan(
    id: String,
    components: Vec<pcl_install::ComponentSelection>,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<instance_reset::ResetPlan, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        resource_ops::ensure_ready(Path::new(&root.path))?;
        ensure_instance_files_ready(&s, &root)?;
        instance_reset::prepare(Path::new(&root.path), &id, components)
    })
    .await
    .map_err(|_| "检查重置方案的任务意外退出".to_string())?
}

#[tauri::command]
async fn instance_reset_start(
    plan: ResetSubmission,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<String, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        resource_ops::ensure_ready(Path::new(&root.path))?;
        ensure_instance_files_ready(&s, &root)?;
        let checked = instance_reset::prepare(Path::new(&root.path), &plan.id, plan.components)?;
        if checked.revision != plan.revision {
            return Err("实例或重置方案已改变，请重新检查".into());
        }
        let task = s.tasks.admit(
            tasks::TaskTarget {
                root_id: root.id,
                root_path: root.path.clone(),
                instance_id: Some(plan.id),
            },
            tasks::TaskKind::InstanceReset,
        )?;
        let task_id = task.id().to_owned();
        s.downloads.track(&task);
        let worker = s.clone();
        std::thread::Builder::new()
            .name(format!("pcl-reset-{task_id}"))
            .spawn(move || {
                let cancel = task.cancellation_token();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    instance_reset::execute(
                        Path::new(&root.path),
                        &worker.project,
                        checked,
                        &cancel,
                        |p| worker.downloads.progress(&task, p),
                    )
                }))
                .unwrap_or_else(|_| {
                    Err("取消清理失败：重置任务意外退出，请恢复未完成的重置后重试".into())
                });
                finish_instance_task(task, result, "实例核心重置完成，游戏内容已保留");
            })
            .map_err(|e| format!("无法启动重置任务：{e}"))?;
        Ok(task_id)
    })
    .await
    .map_err(|_| "启动重置任务失败".to_string())?
}

fn finish_instance_task(
    task: tasks::TaskHandle,
    result: Result<serde_json::Value, String>,
    message: &str,
) {
    match result {
        Ok(result) => {
            let warning = result
                .get("warning")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            task.finish(tasks::TaskOutcome::Complete {
                message: warning
                    .as_ref()
                    .map_or_else(|| message.into(), |warning| format!("{message}；{warning}")),
                result: Some(result),
                error: warning,
            })
        }
        Err(error) if error.starts_with("取消清理失败：") => {
            task.finish(tasks::TaskOutcome::CleanupFailed(error))
        }
        Err(error) => task.finish(tasks::TaskOutcome::Failed(error)),
    };
}

#[tauri::command]
async fn instance_reset_recover(
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<serde_json::Value, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        ensure_instance_files_ready(&s, &root)?;
        let task = s.tasks.admit(
            tasks::TaskTarget {
                root_id: root.id,
                root_path: root.path.clone(),
                instance_id: None,
            },
            tasks::TaskKind::ResourceOperation,
        )?;
        task.begin_finishing();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            instance_reset::recover_pending(Path::new(&root.path))
        }))
        .unwrap_or_else(|_| Err("恢复重置任务意外退出，原文件和备份已保留".into()));
        finish_instance_task(task, result.clone(), "已恢复未完成的实例重置");
        result
    })
    .await
    .map_err(|_| "恢复重置任务失败".to_string())?
}

#[tauri::command]
async fn instance_export_plan(
    id: String,
    request: instance_export::ExportRequest,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<instance_export::ExportPlan, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        resource_ops::ensure_ready(Path::new(&root.path))?;
        instance_reset::ensure_ready(Path::new(&root.path))?;
        ensure_instance_files_ready(&s, &root)?;
        instance_export::prepare(Path::new(&root.path), &id, request)
    })
    .await
    .map_err(|_| "检查导出文件的任务意外退出".to_string())?
}

#[tauri::command]
async fn instance_export_start(
    plan: ExportSubmission,
    root_id: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Shared>>,
) -> Result<Option<String>, String> {
    let s = state.inner().clone();
    let (root, checked) = tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        resource_ops::ensure_ready(Path::new(&root.path))?;
        instance_reset::ensure_ready(Path::new(&root.path))?;
        ensure_instance_files_ready(&s, &root)?;
        let checked =
            instance_export::prepare(Path::new(&root.path), &plan.instance_id, plan.request)?;
        if checked.revision != plan.revision {
            return Err("导出内容或选项已改变，请重新检查".to_string());
        }
        Ok((root, checked))
    })
    .await
    .map_err(|_| "检查导出方案的任务意外退出".to_string())??;
    let filename = format!("{}-{}.zip", checked.request.name, checked.request.version)
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let choice = state
        .desktop
        .save_zip(window, state.project.clone(), filename)
        .await?;
    if choice.status == "cancelled" {
        return Ok(None);
    }
    if choice.status != "selected" {
        return Err(choice
            .message
            .unwrap_or_else(|| "无法选择导出文件位置".into()));
    }
    let destination = choice
        .paths
        .into_iter()
        .next()
        .ok_or("未选择导出文件位置")?;
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let current = s.config.resolve(Some(&root.id))?;
        ensure_instance_files_ready(&s, &current)?;
        if current.path != root.path {
            return Err("游戏目录位置已改变，请重新导出".into());
        }
        let task = s.tasks.admit(
            tasks::TaskTarget {
                root_id: root.id,
                root_path: root.path,
                instance_id: Some(checked.instance_id.clone()),
            },
            tasks::TaskKind::InstanceExport,
        )?;
        let task_id = task.id().to_owned();
        s.downloads.track(&task);
        let worker = s.clone();
        std::thread::Builder::new()
            .name(format!("pcl-export-{task_id}"))
            .spawn(move || {
                let cancel = task.cancellation_token();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    instance_export::execute(checked, &destination, &cancel, |p| {
                        worker.downloads.progress(&task, p)
                    })
                }))
                .unwrap_or_else(|_| {
                    Err("取消清理失败：导出任务意外退出，请检查保存目录中的临时文件".into())
                });
                let message = result
                    .as_ref()
                    .ok()
                    .and_then(|v| v.get("file_name"))
                    .and_then(|v| v.as_str())
                    .map(|name| format!("导出完成：{name}"))
                    .unwrap_or_else(|| "导出完成".into());
                finish_instance_task(task, result, &message);
            })
            .map_err(|e| format!("无法启动导出任务：{e}"))?;
        Ok(Some(task_id))
    })
    .await
    .map_err(|_| "启动导出任务失败".to_string())?
}

#[tauri::command]
async fn instance_export_config_read(
    id: String,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<Option<instance_export::ExportRequest>, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        pcl_core::identifier(&id)?;
        let root = s.config.resolve(root_id.as_deref())?;
        export_presets::read(&s.project, &root.id, Path::new(&root.path), &id)
    })
    .await
    .map_err(|_| "读取导出配置失败".to_string())?
}
#[tauri::command]
async fn instance_export_config_save(
    id: String,
    request: instance_export::ExportRequest,
    root_id: Option<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<(), String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = s.operations.lock().unwrap();
        require_instance_job(&s)?;
        let root = s.config.resolve(root_id.as_deref())?;
        // Validate the exact choices before retaining them for this instance.
        ensure_instance_files_ready(&s, &root)?;
        instance_export::prepare(Path::new(&root.path), &id, request.clone())?;
        export_presets::save(&s.project, &root.id, Path::new(&root.path), &id, request)
    })
    .await
    .map_err(|_| "保存导出配置失败".to_string())?
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
    ensure_instance_files_ready(s, &root)?;
    instance_delete::ensure_name_available(Path::new(&root.path), id)?;
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
        instance_reset::ensure_ready(Path::new(&root.path))?;
        ensure_instance_files_ready(&s, &root)?;
        let plan = pcl_core::build_launch_plan_with_java(
            Path::new(&root.path),
            &s.project,
            &id,
            &cfg.player,
            *root.overrides.get(&id).unwrap_or(&cfg.memory_gib),
            java_service::effective_choice(&cfg, &root, &id),
            &cfg.java_paths,
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
    instance_delete::ensure_name_available(Path::new(&root.path), id)?;
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
    instance_reset::ensure_ready(Path::new(&root.path))?;
    ensure_instance_files_ready(&state, &root)?;
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
                Some(identity) => pcl_core::build_launch_plan_authenticated_with_java(
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
                    java_service::effective_choice(&cfg, &root, &id),
                    &cfg.java_paths,
                )?,
                None => pcl_core::build_launch_plan_with_java(
                    Path::new(&root.path),
                    &s.project,
                    &id,
                    &cfg.player,
                    memory,
                    java_service::effective_choice(&cfg, &root, &id),
                    &cfg.java_paths,
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
            java_commands::java_catalog,
            java_commands::java_add,
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
            instance_reset_plan,
            instance_reset_start,
            instance_reset_recover,
            instance_rename_prepare,
            instance_rename_start,
            instance_rename_recover,
            instance_export_plan,
            instance_export_start,
            instance_export_config_read,
            instance_export_config_save,
            instance_commands::instance_import_pick,
            instance_commands::instance_import_prepare,
            instance_commands::instance_import_start,
            instance_commands::instance_import_recover,
            instance_commands::instance_delete_prepare,
            instance_commands::instance_delete_start,
            instance_commands::instance_deleted_list,
            instance_commands::instance_restore_start,
            instance_commands::instance_delete_recover,
            download_cancel
        ])
        .run(tauri::generate_context!())
        .expect("桌面应用运行失败");
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::thread;
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
            Self(path.canonicalize().unwrap())
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

    fn rename_fixture(state: &Shared) -> (GameRoot, String) {
        let root = state.config.resolve(None).unwrap();
        let id = "1.21.1".to_owned();
        let folder = Path::new(&root.path).join("versions").join(&id);
        fs::create_dir_all(folder.join("mods")).unwrap();
        fs::create_dir_all(folder.join("saves/ExampleWorld")).unwrap();
        fs::write(folder.join("saves/ExampleWorld/keep.txt"), b"world data").unwrap();
        fs::write(folder.join("1.21.1.jar"), b"fixture core").unwrap();
        fs::write(
            folder.join("1.21.1.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": id, "mainClass":"net.minecraft.client.main.Main", "libraries": [],
            }))
            .unwrap(),
        )
        .unwrap();
        let mut settings = state.config.snapshot();
        settings.selected = Some(id.clone());
        settings.memory_gib = 14;
        settings.overrides.insert(id.clone(), 12);
        state.config.save(settings).unwrap();
        (root, id)
    }

    #[test]
    fn deleted_name_never_rebinds_old_settings_and_metadata_to_external_recreation() {
        let fixture = Fixture::new();
        let state = Arc::new(fixture.shared());
        let (root, id) = rename_fixture(&state);
        let path = Path::new(&root.path);
        let revision = state.instance_metadata.get(&root.id, path, &id).revision;
        update_instance_metadata(
            &state,
            Some(&root.id),
            &id,
            &revision,
            instance_meta::MetadataPatch {
                description: Some("Retained description".into()),
                favorite: Some(true),
                icon: None,
                category: None,
            },
        )
        .unwrap();
        let settings_before = fs::read(fixture.0.join(".pcl-rust/settings.json")).unwrap();
        let metadata_before = fs::read(fixture.0.join(".pcl-rust/instance-metadata.json")).unwrap();
        let plan = instance_delete::prepare(path, &fixture.0, &root.id, &id).unwrap();
        instance_delete::execute(path, &fixture.0, plan, &AtomicBool::new(false), |_| {}).unwrap();
        assert!(bootstrap_view(&state).instances.is_empty());
        assert!(require_root_removable(&state, &root.id)
            .unwrap_err()
            .contains("已删除"));
        assert!(instance_commands::new_name(&state, &root, &id).is_err());
        let folder = path.join("versions").join(&id);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join(format!("{id}.json")),
            serde_json::to_vec(&serde_json::json!({"id":id,"mainClass":"Example","libraries":[]}))
                .unwrap(),
        )
        .unwrap();
        let view = bootstrap_view(&state);
        assert!(view.instances.is_empty());
        assert!(view
            .scan_issues
            .iter()
            .any(|issue| issue.id == id && issue.message.contains("保留")));
        assert!(instance_context(&state.config, Some(&root.id), &id).is_err());
        assert!(admit_resource(&state, &id, Some(&root.id), None).is_err());
        let mut entry = instance_delete::history(path, &fixture.0, &root.id)
            .unwrap()
            .remove(0);
        assert!(!entry.can_restore);
        fs::remove_dir_all(&folder).unwrap();
        entry = instance_delete::history(path, &fixture.0, &root.id)
            .unwrap()
            .remove(0);
        instance_delete::undo(
            path,
            &fixture.0,
            &root.id,
            &entry.operation_id,
            entry.revision.as_deref().unwrap(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(require_root_removable(&state, &root.id).is_ok());
        let view = bootstrap_view(&state);
        assert_eq!(view.instances.len(), 1);
        assert_eq!(
            view.instances[0].metadata.description,
            "Retained description"
        );
        assert_eq!(view.settings.memory_gib, 14);
        assert_eq!(view.settings.overrides[&id], 12);
        assert_eq!(
            fs::read(fixture.0.join(".pcl-rust/settings.json")).unwrap(),
            settings_before
        );
        assert_eq!(
            fs::read(fixture.0.join(".pcl-rust/instance-metadata.json")).unwrap(),
            metadata_before
        );
    }

    #[test]
    fn pending_delete_defers_v2_migration_until_recovery_and_preserves_exact_backup() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let (root, id) = rename_fixture(&state);
        let path = Path::new(&root.path);
        let file = fixture.0.join(".pcl-rust/settings.json");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        legacy["schema_version"] = 2.into();
        legacy.as_object_mut().unwrap().remove("java");
        legacy.as_object_mut().unwrap().remove("java_paths");
        for root in legacy["roots"].as_array_mut().unwrap() {
            root.as_object_mut().unwrap().remove("java_overrides");
        }
        let before = serde_json::to_vec_pretty(&legacy).unwrap();
        fs::write(&file, &before).unwrap();
        let checked = instance_delete::prepare(path, &fixture.0, &root.id, &id).unwrap();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            instance_delete::execute(
                path,
                &fixture.0,
                checked,
                &AtomicBool::new(false),
                |progress| {
                    if progress.phase == "committing" {
                        panic!("Interrupted before directory move");
                    }
                },
            )
            .unwrap();
        }))
        .is_err());
        let (config, warning) = ConfigStore::load(&fixture.0);
        assert!(warning.is_none(), "{warning:?}");
        assert_eq!(config.snapshot().memory_gib, 14);
        assert_eq!(fs::read(&file).unwrap(), before);
        assert!(instance_rename_refs::ensure_project_ready(&fixture.0).is_err());
        instance_delete::recover_pending(path, &fixture.0).unwrap();
        config.refresh_after_rename().unwrap();
        let mut next = config.snapshot();
        next.player = "ExamplePlayer".into();
        config.save(next).unwrap();
        let migrated: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(migrated["schema_version"], 3);
        assert_eq!(migrated["memory_gib"], 14);
        let backups: Vec<_> = fs::read_dir(fixture.0.join(".pcl-rust"))
            .unwrap()
            .filter_map(|entry| {
                let entry = entry.unwrap();
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.v2-backup-")
                    .then_some(entry.path())
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(&backups[0]).unwrap(), before);
        assert!(path.join("versions").join(id).exists());
    }

    #[test]
    fn new_instance_name_rejects_cleared_metadata_and_root_scoped_old_references() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let (root, id) = rename_fixture(&state);
        let path = Path::new(&root.path);
        let revision = state.instance_metadata.get(&root.id, path, &id).revision;
        let patch = |description| instance_meta::MetadataPatch {
            description: Some(description),
            favorite: None,
            icon: None,
            category: None,
        };
        let changed = update_instance_metadata(
            &state,
            Some(&root.id),
            &id,
            &revision,
            patch("Edited".into()),
        )
        .unwrap();
        update_instance_metadata(
            &state,
            Some(&root.id),
            &id,
            &changed.revision,
            patch(String::new()),
        )
        .unwrap();
        let mut settings = state.config.snapshot();
        settings.selected = None;
        settings.overrides.clear();
        state.config.save(settings).unwrap();
        assert!(instance_commands::new_name(&state, &root, &id)
            .unwrap_err()
            .contains("资料"));
        assert!(instance_commands::new_name(&state, &root, "Fresh Instance").is_ok());
        let second = fixture.second(&state.config);
        assert!(instance_commands::new_name(&state, &second, &id).is_ok());
    }

    #[test]
    fn rename_refresh_preserves_browsed_root_memory_metadata_presets_and_resource_undo() {
        use std::os::unix::fs::MetadataExt;
        let fixture = Fixture::new();
        let state = fixture.shared();
        let (root, old) = rename_fixture(&state);
        let new = "Example Renamed";
        let path = Path::new(&root.path);
        let world = path
            .join("versions")
            .join(&old)
            .join("saves/ExampleWorld/keep.txt");
        let inode = world.metadata().unwrap().ino();
        let revision = state.instance_metadata.get(&root.id, path, &old).revision;
        update_instance_metadata(
            &state,
            Some(&root.id),
            &old,
            &revision,
            instance_meta::MetadataPatch {
                description: Some("Keep my description".into()),
                favorite: Some(true),
                icon: None,
                category: None,
            },
        )
        .unwrap();
        let preset = instance_export::ExportRequest {
            name: "Example Pack".into(),
            version: "1.0".into(),
            checks: Default::default(),
            excluded: Default::default(),
        };
        export_presets::save(&fixture.0, &root.id, path, &old, preset.clone()).unwrap();
        let mod_path = path.join("versions").join(&old).join("mods/example.jar");
        fs::write(&mod_path, b"example resource").unwrap();
        let removal = resource_ops::remove(
            path,
            &old,
            "mods",
            &[resource_ops::ResourceFile {
                file_name: "example.jar".into(),
                fingerprint: resource_ops::fingerprint(&mod_path).unwrap(),
            }],
            &AtomicBool::new(false),
            &mut || Ok(()),
            &mut |_, _| {},
        )
        .unwrap();
        let second = fixture.second(&state.config);
        let mut settings = state.config.select(&second.id).unwrap();
        settings.selected = Some("Other".into());
        settings.overrides.insert("Other".into(), 4);
        state.config.save(settings.clone()).unwrap();
        let checked = instance_rename_service::prepare(&state, &root, &old, new).unwrap();
        let task = state
            .tasks
            .admit(
                TaskTarget {
                    root_id: root.id.clone(),
                    root_path: root.path.clone(),
                    instance_id: Some(old.clone()),
                },
                TaskKind::InstanceRename,
            )
            .unwrap();
        let task_id = task.id().to_owned();
        let result = instance_rename_service::execute(&state, &root, checked, &task).unwrap();
        assert_eq!(result["id"], new);
        finish_instance_task(task, Ok(result), "实例重命名完成");
        assert_eq!(
            state.tasks.snapshot(&task_id).unwrap().stage,
            tasks::TaskStage::Complete
        );
        let mut refreshed = state.config.snapshot();
        assert_ne!(refreshed.revision, settings.revision);
        refreshed.revision = settings.revision.clone();
        assert_eq!(refreshed, settings);
        let renamed_root = state.config.resolve(Some(&root.id)).unwrap();
        assert_eq!(renamed_root.selected.as_deref(), Some(new));
        assert_eq!(renamed_root.overrides.get(new), Some(&12));
        assert!(!renamed_root.overrides.contains_key(&old));
        let metadata = state.instance_metadata.get(&root.id, path, new);
        assert!(metadata.favorite);
        assert_eq!(metadata.description, "Keep my description");
        assert_eq!(
            export_presets::read(&fixture.0, &root.id, path, new).unwrap(),
            Some(preset)
        );
        assert!(export_presets::read(&fixture.0, &root.id, path, &old)
            .unwrap()
            .is_none());
        let new_world = path
            .join("versions")
            .join(new)
            .join("saves/ExampleWorld/keep.txt");
        assert_eq!(new_world.metadata().unwrap().ino(), inode);
        assert_eq!(fs::read(new_world).unwrap(), b"world data");
        let removed = resource_ops::removed(path, new, "mods").unwrap();
        assert_eq!(removed[0].id, removal.undo_id.unwrap());
        resource_ops::restore(
            path,
            new,
            "mods",
            &removed[0].id,
            &AtomicBool::new(false),
            &mut || Ok(()),
            &mut |_, _| {},
        )
        .unwrap();
        assert_eq!(
            fs::read(path.join("versions").join(new).join("mods/example.jar")).unwrap(),
            b"example resource"
        );
        state.config.select(&root.id).unwrap();
        let bootstrap = bootstrap_view(&state);
        let instance = bootstrap
            .instances
            .iter()
            .find(|instance| instance.instance.id == new)
            .unwrap();
        assert_eq!(instance.instance.minecraft_version, old);
        assert!(instance.metadata.favorite);
        assert!(bootstrap.rename_recovery_error.is_none());
    }

    #[test]
    fn rename_revision_and_global_recovery_guard_include_scoped_launcher_references() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        let (root, old) = rename_fixture(&state);
        let before = instance_rename_service::prepare(&state, &root, &old, "Example Renamed")
            .unwrap()
            .revision;
        let mut settings = state.config.snapshot();
        settings.overrides.insert(old.clone(), 10);
        state.config.save(settings).unwrap();
        let after = instance_rename_service::prepare(&state, &root, &old, "Example Renamed")
            .unwrap()
            .revision;
        assert_ne!(before, after);
        let second = fixture.second(&state.config);
        state.config.select(&second.id).unwrap();
        // Recapture references after the legitimate navigation, then emulate
        // a durable pending transaction without touching any game contents.
        let refs = instance_rename_refs::prepare(
            &fixture.0,
            &root.id,
            Path::new(&root.path),
            &old,
            "Example Renamed",
        )
        .unwrap();
        refs.mark_pending(&fixture.0, Path::new(&root.path), "n-abcdef-123-1")
            .unwrap();
        let bootstrap = bootstrap_view(&state);
        assert!(bootstrap.rename_recovery_error.is_some());
        assert_eq!(
            bootstrap.rename_recovery_root_id.as_deref(),
            Some(root.id.as_str())
        );
        assert_eq!(bootstrap.settings.root_id, second.id);
        assert!(require_reference_write(&state).is_err());
        assert!(ensure_instance_files_ready(&state, &root).is_err());
        refs.clear_pending(&fixture.0, Path::new(&root.path), "n-abcdef-123-1")
            .unwrap();
        assert!(require_reference_write(&state).is_ok());
    }

    #[test]
    fn rename_recovery_resolves_registered_directory_alias() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let state = fixture.shared();
        let physical = fixture.0.join("alias-target");
        fs::create_dir_all(&physical).unwrap();
        let alias = fixture.0.join("registered-alias");
        symlink(&physical, &alias).unwrap();
        let registered = state
            .config
            .register(alias.to_str().unwrap().into(), None)
            .unwrap();
        state.config.select(&registered.id).unwrap();
        let (root, old) = rename_fixture(&state);
        assert_eq!(Path::new(&root.path), physical);
        let second = fixture.second(&state.config);
        state.config.select(&second.id).unwrap();
        let refs = instance_rename_refs::prepare(
            &fixture.0,
            &root.id,
            Path::new(&root.path),
            &old,
            "Example Renamed",
        )
        .unwrap();
        refs.mark_pending(&fixture.0, Path::new(&root.path), "n-abcdef-123-2")
            .unwrap();
        let bootstrap = bootstrap_view(&state);
        assert!(bootstrap.rename_recovery_error.is_some());
        assert_eq!(
            bootstrap.rename_recovery_root_id.as_deref(),
            Some(root.id.as_str())
        );
        assert!(bootstrap
            .roots
            .iter()
            .any(|item| item.id == root.id && item.available && Path::new(&item.path) == alias));
        refs.clear_pending(&fixture.0, Path::new(&root.path), "n-abcdef-123-2")
            .unwrap();
    }

    #[test]
    fn captured_instance_context_survives_browsing_another_root() {
        use pcl_core::java::JavaSelection;
        let fixture = Fixture::new();
        let state = fixture.shared();
        let first = state.config.snapshot().root_id;
        let second = fixture.second(&state.config);
        let mut settings = state.config.snapshot();
        settings.memory_gib = 14;
        settings.overrides.insert("Same".into(), 12);
        let global_java = JavaSelection::Manual {
            path: fixture.0.join("global/bin/java").to_str().unwrap().into(),
        };
        settings.java = global_java.clone();
        settings
            .java_overrides
            .insert("Same".into(), JavaSelection::Auto);
        state.config.save(settings).unwrap();
        let (captured_settings, captured_root) =
            instance_context(&state.config, None, "Same").unwrap();
        let mut settings = state.config.select(&second.id).unwrap();
        settings.overrides.insert("Same".into(), 4);
        let second_java = JavaSelection::Manual {
            path: fixture.0.join("other/bin/java").to_str().unwrap().into(),
        };
        settings
            .java_overrides
            .insert("Same".into(), second_java.clone());
        state.config.save(settings).unwrap();
        assert_eq!(captured_root.id, first);
        assert_eq!(captured_settings.memory_gib, 14);
        assert_eq!(captured_root.overrides["Same"], 12);
        assert_eq!(
            java_service::effective_choice(&captured_settings, &captured_root, "Same"),
            &JavaSelection::Auto,
        );
        assert_eq!(
            java_service::effective_choice(&captured_settings, &captured_root, "Other"),
            &global_java,
        );
        let (_, bound) = instance_context(&state.config, Some(&first), "Same").unwrap();
        assert_eq!(bound, captured_root);
        let (current_settings, current_root) =
            instance_context(&state.config, None, "Same").unwrap();
        assert_eq!(
            java_service::effective_choice(&current_settings, &current_root, "Same"),
            &second_java,
        );
        assert_eq!(
            instance_context(&state.config, None, "Same")
                .unwrap()
                .1
                .overrides["Same"],
            4
        );
    }

    fn java_fixture(fixture: &Fixture, wait_for_release: bool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = fixture.0.join("jdk/bin/java");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let wait = if wait_for_release {
            "while [ ! -f \"$0.release\" ]; do sleep 0.01; done\n"
        } else {
            ""
        };
        fs::write(&path, format!(
            "#!/bin/sh\nprintf inspected > \"$0.inspected\"\n{wait}printf 'java.specification.version = 21\\njava.vendor = Fixture\\nos.arch = {}\\n' >&2\n",
            std::env::consts::ARCH,
        )).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn java_registration_rejects_stale_requests_before_execution_and_keeps_selection() {
        use pcl_core::java::JavaSelection;
        let fixture = Fixture::new();
        let state = fixture.shared();
        let java = java_fixture(&fixture, false);
        let settings = state.config.snapshot();
        let context =
            java_service::registration_context(&state, Some(&settings.root_id), &settings.revision)
                .unwrap();
        let mut newer = settings;
        newer.memory_gib = 14;
        state.config.save(newer).unwrap();
        assert!(java_service::register(&state, &java, &context).is_err());
        assert!(!java.with_file_name("java.inspected").exists());
        assert!(state.config.snapshot().java_paths.is_empty());

        let settings = state.config.snapshot();
        let context =
            java_service::registration_context(&state, Some(&settings.root_id), &settings.revision)
                .unwrap();
        let registered = java_service::register(&state, &java, &context).unwrap();
        assert_ne!(registered.revision, settings.revision);
        assert_eq!(registered.memory_gib, 14);
        assert_eq!(registered.java, JavaSelection::Auto);
        assert_eq!(registered.java_paths, vec![java.to_str().unwrap()]);
        let repeated = java_service::registration_context(
            &state,
            Some(&registered.root_id),
            &registered.revision,
        )
        .unwrap();
        assert_eq!(
            java_service::register(&state, &java, &repeated)
                .unwrap()
                .java_paths,
            registered.java_paths
        );

        let second = fixture.second(&state.config);
        state.config.select(&second.id).unwrap();
        fs::remove_file(java.with_file_name("java.inspected")).unwrap();
        assert!(java_service::register(&state, &java, &repeated).is_err());
        assert!(!java.with_file_name("java.inspected").exists());
    }

    #[test]
    fn java_registration_rechecks_settings_after_the_probe() {
        let fixture = Fixture::new();
        let state = Arc::new(fixture.shared());
        let java = java_fixture(&fixture, true);
        let settings = state.config.snapshot();
        let context =
            java_service::registration_context(&state, Some(&settings.root_id), &settings.revision)
                .unwrap();
        let worker_state = state.clone();
        let worker_java = java.clone();
        let worker =
            thread::spawn(move || java_service::register(&worker_state, &worker_java, &context));
        let started = java.with_file_name("java.inspected");
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while !started.exists() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(started.exists());
        let mut changed = state.config.snapshot();
        changed.memory_gib = 14;
        state.config.save(changed).unwrap();
        fs::write(java.with_file_name("java.release"), b"continue").unwrap();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(state.config.snapshot().memory_gib, 14);
        assert!(state.config.snapshot().java_paths.is_empty());
    }

    #[test]
    fn instance_jobs_wait_for_game_and_all_writers_and_refuse_shutdown() {
        let fixture = Fixture::new();
        let state = fixture.shared();
        assert!(require_instance_job(&state).is_ok());
        for stage in ["preparing", "running"] {
            state.status.lock().unwrap().stage = stage.into();
            assert!(require_instance_job(&state).is_err());
        }
        state.status.lock().unwrap().stage = "idle".into();
        let root = state.config.resolve(None).unwrap();
        for kind in [
            TaskKind::Install,
            TaskKind::ResourceOperation,
            TaskKind::InstanceReset,
            TaskKind::InstanceExport,
            TaskKind::InstanceRename,
        ] {
            let task = state
                .tasks
                .admit(
                    TaskTarget {
                        root_id: root.id.clone(),
                        root_path: root.path.clone(),
                        instance_id: Some("Example".into()),
                    },
                    kind,
                )
                .unwrap();
            assert!(require_instance_job(&state).is_err());
            state.tasks.cancel(task.id()).unwrap();
            assert!(require_instance_job(&state).is_err());
            task.finish(TaskOutcome::Failed("stopped".into()));
            assert!(require_instance_job(&state).is_ok());
        }
        state.closing.store(true, Ordering::SeqCst);
        assert!(require_instance_job(&state).is_err());
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
