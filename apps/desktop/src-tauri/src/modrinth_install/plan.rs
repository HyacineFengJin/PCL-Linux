//! Bounded mandatory dependency graph and local conflict checks. Provider data
//! is authoritative; UI selections name only a root version and optional file.
//!
//! Planning first identifies local hashes, then resolves the required graph,
//! checks declared conflicts, and hashes its complete target/request/result.
//! One project has one selected version. Visiting versions detect recursion;
//! visited versions may still contribute another explicitly required file.
//! Matching enabled bytes may be reused under their existing name. Disabled
//! files and ambiguous versions require manual action rather than mutation.
use super::{
    provider::{ApiFile, Dependency, FutureResult, Project, Provider, Version},
    *,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize)]
pub struct InstallFile {
    pub project_id: String,
    pub version_id: String,
    pub title: String,
    pub kind: String,
    pub file_name: String,
    pub size: u64,
    pub sha512: String,
    pub required: bool,
    pub reused: bool,
    pub existing_file_name: Option<String>,
    #[serde(skip)]
    pub(super) url: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct PlannedDependency {
    pub from_project_id: String,
    pub from_version_id: String,
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub file_name: Option<String>,
    pub dependency_type: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct InstallPlan {
    pub root_id: String,
    pub instance_id: String,
    pub minecraft_version: String,
    pub loader: String,
    pub revision: String,
    pub files: Vec<InstallFile>,
    pub dependencies: Vec<PlannedDependency>,
    pub warnings: Vec<String>,
    pub total_bytes: u64,
    pub download_bytes: u64,
    #[serde(skip)]
    pub(super) target: TargetSnapshot,
}
#[derive(Clone)]
struct Installed {
    file: LocalFile,
    version: Version,
}
struct Planner<'a, P: Provider> {
    provider: &'a P,
    target: &'a TargetSnapshot,
    cancel: &'a AtomicBool,
    projects: BTreeMap<String, Project>,
    versions: BTreeMap<String, Version>,
    selected: BTreeMap<String, String>,
    visiting: BTreeSet<String>,
    visited: BTreeSet<String>,
    installed: Vec<Installed>,
    files: Vec<InstallFile>,
    edges: Vec<PlannedDependency>,
    warnings: BTreeSet<String>,
    incompatible: Vec<Dependency>,
}
fn kind(project: &Project) -> Result<&'static str> {
    match project.project_type.as_str() {
        "mod" => Ok("mods"),
        "resourcepack" => Ok("resourcepacks"),
        "shader" => Ok("shaderpacks"),
        _ => Err("首批仅支持Modrinth模组、资源包与光影文件".into()),
    }
}
fn compatible(version: &Version, kind: &str, target: &Compatibility) -> bool {
    version
        .game_versions
        .iter()
        .any(|v| v == &target.minecraft_version)
        && match kind {
            "mods" => {
                version.loaders.iter().any(|v| v == &target.loader) && target.loader != "minecraft"
            }
            "resourcepacks" => version.loaders.iter().any(|v| v == "minecraft"),
            "shaderpacks" => version
                .loaders
                .iter()
                .any(|v| matches!(v.as_str(), "iris" | "optifine" | "vanilla" | "canvas")),
            _ => false,
        }
}
fn file_kind(project: &Project, file: &ApiFile) -> Result<&'static str> {
    if matches!(
        file.file_type.as_deref(),
        Some("required-resource-pack" | "optional-resource-pack")
    ) {
        return Ok("resourcepacks");
    }
    if matches!(
        file.file_type.as_deref(),
        Some("sources-jar" | "dev-jar" | "javadoc-jar" | "signature")
    ) {
        return Err("所选文件是源码、开发、文档或签名文件，不能作为游戏资源安装".into());
    }
    kind(project)
}
fn extension(kind: &str, file: &ApiFile) -> Result<()> {
    if file.filename.starts_with(".pcl-") {
        return Err("资源文件名称与应用保留名称冲突".into());
    }
    let matches = match kind {
        "mods" => file.filename.ends_with(".jar"),
        "resourcepacks" | "shaderpacks" => file.filename.ends_with(".zip"),
        _ => false,
    };
    if !matches {
        return Err(format!("文件 {} 的类型与项目资源类型不符", file.filename));
    }
    Ok(())
}
fn select_file<'a>(version: &'a Version, name: Option<&str>) -> Result<&'a ApiFile> {
    match name {
        Some(name) => version
            .files
            .iter()
            .find(|file| file.filename == name)
            .ok_or_else(|| "官方版本中没有所选文件，请重新读取资源详情".into()),
        None => Ok(version
            .files
            .iter()
            .find(|file| file.primary)
            .unwrap_or(&version.files[0])),
    }
}
impl<'a, P: Provider> Planner<'a, P> {
    async fn project(&mut self, id: &str) -> Result<Project> {
        if let Some(project) = self.projects.get(id) {
            return Ok(project.clone());
        }
        if self.projects.len() >= MAX_PROJECTS {
            return Err("必需依赖项目超过64项".into());
        }
        let project = self.provider.project(id).await?;
        if project.id != id {
            return Err("Modrinth项目ID不匹配".into());
        }
        kind(&project)?;
        self.projects.insert(id.into(), project.clone());
        Ok(project)
    }
    async fn version(&mut self, id: &str) -> Result<Version> {
        if let Some(version) = self.versions.get(id) {
            return Ok(version.clone());
        }
        if self.versions.len() >= MAX_PROJECTS * 2 {
            return Err("依赖版本请求超过限制".into());
        }
        let version = self.provider.version(id).await?;
        provider::validate_version(&version)?;
        if version.id != id {
            return Err("Modrinth版本ID不匹配".into());
        }
        self.versions.insert(id.into(), version.clone());
        Ok(version)
    }
    async fn dependency_version(&mut self, dependency: &Dependency) -> Result<Version> {
        if let Some(id) = &dependency.version_id {
            let version = self.version(id).await?;
            if dependency
                .project_id
                .as_ref()
                .is_some_and(|project| project != &version.project_id)
            {
                return Err("必需依赖的项目与版本ID不符".into());
            }
            return Ok(version);
        }
        let project_id = dependency.project_id.as_deref().ok_or_else(|| {
            format!(
                "必需依赖 {} 没有Modrinth项目或版本ID，请先手动处理外部依赖",
                dependency.file_name.as_deref().unwrap_or("未知文件")
            )
        })?;
        if let Some(id) = self.selected.get(project_id).cloned() {
            return self.version(&id).await;
        }
        let project = self.project(project_id).await?;
        let resource_kind = kind(&project)?;
        let mut installed_versions: BTreeMap<String, Version> = BTreeMap::new();
        for installed in &self.installed {
            if installed.version.project_id == project_id {
                installed_versions.insert(installed.version.id.clone(), installed.version.clone());
            }
        }
        if installed_versions.len() > 1 {
            return Err(format!(
                "已装项目 {} 存在多个版本，请先手动处理",
                project.title
            ));
        }
        if let Some((_, version)) = installed_versions.into_iter().next() {
            if !compatible(&version, resource_kind, &self.target.compatibility) {
                return Err(format!(
                    "已装依赖 {} 与所选实例不兼容，请先手动处理",
                    project.title
                ));
            }
            return Ok(version);
        }
        let mut candidates = self
            .provider
            .versions(project_id, &self.target.compatibility)
            .await?;
        candidates.retain(|v| compatible(v, resource_kind, &self.target.compatibility));
        candidates.sort_by(|a, b| {
            (a.version_type != "release")
                .cmp(&(b.version_type != "release"))
                .then_with(|| b.date_published.cmp(&a.date_published))
                .then_with(|| a.id.cmp(&b.id))
        });
        let version = candidates.into_iter().next().ok_or_else(|| {
            format!(
                "必需依赖 {} 没有适合此游戏版本与加载器的文件",
                project.title
            )
        })?;
        provider::validate_version(&version)?;
        if version.project_id != project_id {
            return Err("依赖候选版本项目ID不符".into());
        }
        if version.version_type != "release" {
            self.warnings.insert(format!(
                "必需依赖 {} 使用{}版本",
                project.title, version.version_type
            ));
        }
        self.versions.insert(version.id.clone(), version.clone());
        Ok(version)
    }
    fn add_file(
        &mut self,
        project: &Project,
        version: &Version,
        file: &ApiFile,
        required: bool,
    ) -> Result<()> {
        let resource_kind = file_kind(project, file)?;
        extension(resource_kind, file)?;
        if let Some(previous) = self
            .files
            .iter_mut()
            .find(|p| p.kind == resource_kind && p.file_name == file.filename)
        {
            if previous.sha512 != file.hashes.sha512 {
                return Err(format!("依赖文件 {} 名称相同但内容不同", file.filename));
            }
            previous.required |= required;
            return Ok(());
        }
        if self.files.len() >= MAX_FILES {
            return Err("依赖文件数量超过128项".into());
        }
        for installed in &self.installed {
            if installed.version.project_id == version.project_id
                && installed.version.id != version.id
            {
                return Err(format!(
                    "项目 {} 已存在其他版本 {}，请先手动处理旧文件",
                    project.title, installed.file.file_name
                ));
            }
        }
        let exact = self
            .target
            .local_files
            .iter()
            .find(|f| f.kind == resource_kind && f.sha512 == file.hashes.sha512 && f.enabled);
        if exact.is_none()
            && self
                .target
                .local_files
                .iter()
                .any(|f| f.kind == resource_kind && f.sha512 == file.hashes.sha512 && !f.enabled)
        {
            return Err(format!(
                "文件 {} 的相同内容已被禁用，请先手动启用或移开旧文件",
                file.filename
            ));
        }
        if exact.is_none() && target::existing_name(self.target, resource_kind, &file.filename) {
            return Err(format!(
                "目标文件 {} 已存在且内容不同，原文件已保留",
                file.filename
            ));
        }
        if exact.is_none()
            && resource_kind == "mods"
            && target::existing_name(
                self.target,
                resource_kind,
                &format!("{}.disabled", file.filename),
            )
        {
            return Err(format!(
                "文件 {} 已有同名禁用旧文件，请先手动处理",
                file.filename
            ));
        }
        if exact.is_some_and(|f| f.size != file.size) {
            return Err("已装文件大小与官方校验数据不符".into());
        }
        self.files.push(InstallFile {
            project_id: project.id.clone(),
            version_id: version.id.clone(),
            title: project.title.clone(),
            kind: resource_kind.into(),
            file_name: file.filename.clone(),
            size: file.size,
            sha512: file.hashes.sha512.clone(),
            required,
            reused: exact.is_some(),
            existing_file_name: exact.map(|f| f.file_name.clone()),
            url: file.url.clone(),
        });
        Ok(())
    }
    fn add<'b>(
        &'b mut self,
        version: Version,
        requested_project: Option<String>,
        selected_file: Option<String>,
        required: bool,
        depth: usize,
    ) -> FutureResult<'b, ()> {
        Box::pin(async move {
            target::cancelled(self.cancel)?;
            provider::validate_version(&version)?;
            if depth > MAX_DEPTH {
                return Err("必需依赖深度超过32层".into());
            }
            if requested_project
                .as_ref()
                .is_some_and(|id| id != &version.project_id)
            {
                return Err("所选项目与版本ID不符".into());
            }
            if self.visiting.contains(&version.id) {
                return Err("必需依赖存在循环，无法自动安装".into());
            }
            if let Some(previous) = self.selected.get(&version.project_id) {
                if previous != &version.id {
                    return Err("必需依赖要求同一项目的多个版本，请先手动处理冲突".into());
                }
            }
            if self.visited.contains(&version.id) {
                let project = self.project(&version.project_id).await?;
                return self.add_file(
                    &project,
                    &version,
                    select_file(&version, selected_file.as_deref())?,
                    required,
                );
            }
            let project = self.project(&version.project_id).await?;
            let resource_kind = kind(&project)?;
            if !compatible(&version, resource_kind, &self.target.compatibility) {
                return Err(format!(
                    "项目 {} 的此版本不支持所选实例的游戏版本或加载器",
                    project.title
                ));
            }
            if resource_kind == "shaderpacks" {
                self.warnings.insert("此计划尚未确认实例中已安装Iris、OptiFine或Oculus；光影文件下载后需使用相应光影引擎".into());
            }
            self.selected
                .insert(version.project_id.clone(), version.id.clone());
            self.visiting.insert(version.id.clone());
            for dependency in &version.dependencies {
                self.edges.push(PlannedDependency {
                    from_project_id: version.project_id.clone(),
                    from_version_id: version.id.clone(),
                    project_id: dependency.project_id.clone(),
                    version_id: dependency.version_id.clone(),
                    file_name: dependency.file_name.clone(),
                    dependency_type: dependency.dependency_type.clone(),
                });
                match dependency.dependency_type.as_str() {
                    "required" => {
                        let child = self.dependency_version(dependency).await?;
                        self.add(
                            child,
                            dependency.project_id.clone(),
                            dependency.file_name.clone(),
                            true,
                            depth + 1,
                        )
                        .await?;
                    }
                    "optional" => {
                        self.warnings.insert(format!(
                            "可选依赖 {} 未自动下载",
                            dependency
                                .project_id
                                .as_deref()
                                .or(dependency.file_name.as_deref())
                                .unwrap_or("未指定项目")
                        ));
                    }
                    "embedded" => {}
                    "incompatible" => {
                        let mut dependency = dependency.clone();
                        if let Some(id) = &dependency.version_id {
                            let referenced = self.version(id).await?;
                            if dependency
                                .project_id
                                .as_ref()
                                .is_some_and(|project| project != &referenced.project_id)
                            {
                                return Err("不兼容依赖的项目与版本ID不符".into());
                            }
                            dependency.project_id = Some(referenced.project_id);
                        }
                        self.incompatible.push(dependency);
                    }
                    _ => return Err("依赖类型不受支持".into()),
                }
            }
            let file = select_file(&version, selected_file.as_deref())?;
            self.add_file(&project, &version, file, required)?;
            for file in &version.files {
                if file.file_type.as_deref() == Some("required-resource-pack") {
                    self.add_file(&project, &version, file, true)?
                }
            }
            self.visiting.remove(&version.id);
            self.visited.insert(version.id.clone());
            self.versions.insert(version.id.clone(), version);
            Ok(())
        })
    }
    fn check_incompatible(&self) -> Result<()> {
        for dependency in &self.incompatible {
            let project_conflict = dependency.project_id.as_ref().is_some_and(|project| {
                self.selected.get(project).is_some_and(|version| {
                    dependency
                        .version_id
                        .as_ref()
                        .is_none_or(|id| id == version)
                }) || self.installed.iter().any(|i| {
                    i.file.enabled
                        && &i.version.project_id == project
                        && dependency
                            .version_id
                            .as_ref()
                            .is_none_or(|id| id == &i.version.id)
                })
            });
            let external_conflict = dependency.project_id.is_none()
                && dependency.version_id.is_none()
                && dependency.file_name.as_ref().is_some_and(|name| {
                    self.target
                        .local_files
                        .iter()
                        .any(|f| f.enabled && &f.file_name == name)
                        || self.files.iter().any(|f| &f.file_name == name)
                });
            if project_conflict || external_conflict {
                return Err(
                    "计划与已装文件或其他必需依赖存在Modrinth声明的不兼容关系，请先手动处理".into(),
                );
            }
        }
        Ok(())
    }
}
pub(super) async fn prepare<P: Provider>(
    provider: &P,
    target: TargetSnapshot,
    request: InstallRequest,
    cancel: &AtomicBool,
) -> Result<InstallPlan> {
    request.validate()?;
    let mut installed = Vec::new();
    let hashes: Vec<String> = target
        .local_files
        .iter()
        .map(|f| f.sha512.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut recognized = BTreeMap::new();
    for batch in hashes.chunks(256) {
        target::cancelled(cancel)?;
        recognized.extend(provider.from_hashes(batch).await?);
    }
    for file in &target.local_files {
        if let Some(version) = recognized.get(&file.sha512) {
            provider::validate_version(version)?;
            if !version
                .files
                .iter()
                .any(|f| f.hashes.sha512 == file.sha512 && f.size == file.size)
            {
                return Err("Modrinth已有文件校验响应不符".into());
            }
            installed.push(Installed {
                file: file.clone(),
                version: version.clone(),
            });
        }
    }
    let unidentified = target.local_files.len().saturating_sub(installed.len());
    let installed_incompatibilities: Vec<Dependency> = installed
        .iter()
        .filter(|i| i.file.enabled)
        .flat_map(|i| i.version.dependencies.iter())
        .filter(|d| d.dependency_type == "incompatible")
        .cloned()
        .collect();
    let mut planner = Planner {
        provider,
        target: &target,
        cancel,
        projects: BTreeMap::new(),
        versions: BTreeMap::new(),
        selected: BTreeMap::new(),
        visiting: BTreeSet::new(),
        visited: BTreeSet::new(),
        installed,
        files: vec![],
        edges: vec![],
        warnings: BTreeSet::new(),
        incompatible: vec![],
    };
    if unidentified > 0 {
        planner.warnings.insert(format!(
            "{unidentified}个本地文件未被Modrinth识别，无法自动核对这些文件的项目版本与不兼容声明"
        ));
    }
    for mut dependency in installed_incompatibilities {
        if let Some(id) = &dependency.version_id {
            let referenced = planner.version(id).await?;
            if dependency
                .project_id
                .as_ref()
                .is_some_and(|project| project != &referenced.project_id)
            {
                return Err("已装项目不兼容依赖的项目与版本ID不符".into());
            }
            dependency.project_id = Some(referenced.project_id);
        }
        planner.incompatible.push(dependency);
    }
    let version = planner.version(&request.version_id).await?;
    planner
        .add(
            version,
            Some(request.project_id.clone()),
            request.file_name.clone(),
            false,
            0,
        )
        .await?;
    planner.check_incompatible()?;
    planner.files.sort_by(|a, b| {
        (&a.kind, &a.file_name, &a.project_id).cmp(&(&b.kind, &b.file_name, &b.project_id))
    });
    let total_bytes = planner.files.iter().try_fold(0u64, |sum, file| {
        sum.checked_add(file.size).ok_or("资源文件总大小过大")
    })?;
    if total_bytes > MAX_BATCH_BYTES {
        return Err("资源下载总大小超过8GiB限制".into());
    }
    let download_bytes = planner
        .files
        .iter()
        .filter(|f| !f.reused)
        .map(|f| f.size)
        .sum();
    let dto = (
        &target,
        &request,
        &planner.files,
        &planner.edges,
        &planner.warnings,
    );
    let revision = format!(
        "modrinth:{:x}",
        Sha256::digest(serde_json::to_vec(&dto).map_err(|e| e.to_string())?)
    );
    Ok(InstallPlan {
        root_id: target.root_id.clone(),
        instance_id: target.instance_id.clone(),
        minecraft_version: target.minecraft_version.clone(),
        loader: target.loader.clone(),
        revision,
        files: planner.files,
        dependencies: planner.edges,
        warnings: planner.warnings.into_iter().collect(),
        total_bytes,
        download_bytes,
        target,
    })
}
