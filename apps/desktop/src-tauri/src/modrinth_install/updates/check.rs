//! Hash identity and bounded latest-release selection. Version labels and local
//! file names are presentation, never project identity or ordering authority.
use super::super::{
    plan::Installed,
    provider::{Project, Provider, Version},
};
use super::*;
use chrono::{DateTime, FixedOffset};
use std::collections::BTreeMap;

pub(super) fn published(version: &Version) -> Result<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(&version.date_published)
        .map_err(|_| "Modrinth版本发布日期无效，不能安全判断更新顺序".into())
}
pub(super) fn newer(new: &Version, old: &Version) -> Result<bool> {
    Ok(new.id != old.id
        && new.version_type == "release"
        && old.version_type == "release"
        && published(new)? > published(old)?)
}
pub(super) fn validate_old(old: &Installed, installed: &[Installed]) -> Result<()> {
    if installed
        .iter()
        .filter(|i| i.file.kind == "mods" && i.version.project_id == old.version.project_id)
        .count()
        != 1
    {
        return Err("同一项目存在多个本地模组文件（包括禁用文件），请先手动处理".into());
    }
    if old.version.version_type != "release" {
        return Err("已装版本为alpha或beta，首批更新仅支持正式版本".into());
    }
    published(&old.version)?;
    // First installation may accept a version's first runtime file when the
    // provider omitted its primary flag. Updates have an existing file to
    // replace, so only an explicit primary declaration grants that permission.
    let primary = old
        .version
        .files
        .iter()
        .find(|file| file.primary)
        .ok_or("已有版本没有官方主文件声明，无法自动确定对应更新文件")?;
    if primary.hashes.sha512 != old.file.sha512 {
        return Err("已有文件不是官方主文件，无法自动确定对应更新文件".into());
    }
    Ok(())
}
fn validate_candidate(
    old: &Installed,
    project: &Project,
    new: &Version,
    target: &TargetSnapshot,
) -> Result<bool> {
    provider::validate_version(new)?;
    if new.project_id != old.version.project_id || project.id != old.version.project_id {
        return Err("更新候选项目ID与旧文件哈希身份不符".into());
    }
    if project.project_type != "mod" {
        return Err("已有文件未对应Modrinth模组项目".into());
    }
    if !newer(new, &old.version)? || !plan::compatible(new, "mods", &target.compatibility) {
        return Ok(false);
    }
    let file = new
        .files
        .iter()
        .find(|file| file.primary)
        .ok_or("新版没有官方主文件声明，无法自动确定更新文件")?;
    plan::extension("mods", file)?;
    if plan::file_kind(project, file)? != "mods" {
        return Err("新版主文件不是模组文件".into());
    }
    Ok(file.hashes.sha512 != old.file.sha512)
}
pub(super) struct Catalog<'a, P: Provider> {
    provider: &'a P,
    target: &'a TargetSnapshot,
    installed: &'a [Installed],
    projects: BTreeMap<String, Project>,
    versions: BTreeMap<String, Vec<Version>>,
}
impl<'a, P: Provider> Catalog<'a, P> {
    pub fn new(provider: &'a P, target: &'a TargetSnapshot, installed: &'a [Installed]) -> Self {
        Self {
            provider,
            target,
            installed,
            projects: BTreeMap::new(),
            versions: BTreeMap::new(),
        }
    }
    pub async fn project(&mut self, id: &str) -> Result<Project> {
        if let Some(project) = self.projects.get(id) {
            return Ok(project.clone());
        }
        if self.projects.len() >= MAX_PROJECTS {
            return Err("更新检查项目超过64项，请先减少本地模组".into());
        }
        let project = self.provider.project(id).await?;
        if project.id != id || project.project_type != "mod" {
            return Err("已有文件未对应Modrinth模组项目".into());
        }
        self.projects.insert(id.into(), project.clone());
        Ok(project)
    }
    pub async fn candidate(&mut self, old: &Installed) -> Result<Option<Version>> {
        self.project(&old.version.project_id).await?;
        validate_old(old, self.installed)?;
        let id = &old.version.project_id;
        if !self.versions.contains_key(id) {
            let versions = self
                .provider
                .versions(id, &self.target.compatibility)
                .await?;
            if versions.len() > 4096 {
                return Err("Modrinth候选更新版本超过限制".into());
            }
            for version in &versions {
                provider::validate_version(version)?;
                if &version.project_id != id {
                    return Err("更新候选项目ID不符".into());
                }
                published(version)?;
            }
            self.versions.insert(id.clone(), versions);
        }
        let mut candidates: Vec<&Version> = self.versions[id]
            .iter()
            .filter(|v| {
                v.version_type == "release"
                    && plan::compatible(v, "mods", &self.target.compatibility)
            })
            .collect();
        candidates.sort_by(|a, b| {
            published(b)
                .expect("validated date")
                .cmp(&published(a).expect("validated date"))
                .then_with(|| a.id.cmp(&b.id))
        });
        let Some(candidate) = candidates
            .into_iter()
            .find(|v| newer(v, &old.version).unwrap_or(false))
        else {
            return Ok(None);
        };
        if !validate_candidate(old, &self.projects[id], candidate, self.target)? {
            return Ok(None);
        }
        Ok(Some(candidate.clone()))
    }
}
pub(super) async fn check<P: Provider>(
    provider: &P,
    target: &TargetSnapshot,
    cancel: &AtomicBool,
) -> Result<UpdateCheck> {
    let installed = plan::identify(provider, target, cancel).await?;
    let hashes: Vec<String> = installed
        .iter()
        .filter(|i| i.file.kind == "mods")
        .map(|i| i.file.sha512.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let ids: Vec<String> = installed
        .iter()
        .filter(|i| i.file.kind == "mods")
        .map(|i| i.version.project_id.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut candidates = BTreeMap::new();
    for batch in hashes.chunks(256) {
        target::cancelled(cancel)?;
        let response = provider.updates(batch, &target.compatibility).await?;
        provider::validate_updates(batch, &response)?;
        candidates.extend(response);
    }
    let mut projects = BTreeMap::new();
    for batch in ids.chunks(256) {
        target::cancelled(cancel)?;
        let response = provider.projects(batch).await?;
        provider::validate_projects(batch, &response)?;
        for project in response {
            projects.insert(project.id.clone(), project);
        }
    }
    let mut entries = Vec::new();
    for local in target.local_files.iter().filter(|f| f.kind == "mods") {
        target::cancelled(cancel)?;
        let mut entry = UpdateEntry {
            file_name: local.file_name.clone(),
            fingerprint: local.resource_fingerprint.clone(),
            enabled: local.enabled,
            project_id: None,
            title: None,
            old_version_id: None,
            old_version: None,
            new_version_id: None,
            new_version: None,
            status: UpdateStatus::Unknown,
            reason: Some("Modrinth未识别此文件哈希，不能按名称推断更新".into()),
        };
        if let Some(old) = installed
            .iter()
            .find(|i| i.file.kind == "mods" && i.file.file_name == local.file_name)
        {
            entry.project_id = Some(old.version.project_id.clone());
            entry.old_version_id = Some(old.version.id.clone());
            entry.old_version = Some(old.version.version_number.clone());
            let evaluation = (|| {
                validate_old(old, &installed)?;
                let project = projects
                    .get(&old.version.project_id)
                    .ok_or("Modrinth未返回已装模组项目，无法检查更新")?;
                entry.title = Some(project.title.clone());
                if project.project_type != "mod" {
                    return Err("已有文件未对应Modrinth模组项目".into());
                }
                match candidates.get(&old.file.sha512) {
                    Some(new) if validate_candidate(old, project, new, target)? => Ok(Some(new)),
                    _ => Ok(None),
                }
            })();
            match evaluation {
                Ok(Some(new)) => {
                    entry.status = UpdateStatus::UpdateAvailable;
                    entry.reason = None;
                    entry.new_version_id = Some(new.id.clone());
                    entry.new_version = Some(new.version_number.clone())
                }
                Ok(None) => {
                    entry.status = UpdateStatus::UpToDate;
                    entry.reason = Some("没有较新的兼容正式版本，保留当前文件".into())
                }
                Err(error) => {
                    entry.status = UpdateStatus::Blocked;
                    entry.reason = Some(error)
                }
            }
        }
        entries.push(entry);
    }
    Ok(UpdateCheck {
        root_id: target.root_id.clone(),
        instance_id: target.instance_id.clone(),
        minecraft_version: target.minecraft_version.clone(),
        loader: target.loader.clone(),
        entries,
        warnings: vec![
            "仅检查比已装版本发布时间更晚的兼容正式版本；alpha/beta及未识别文件需手动处理".into(),
        ],
    })
}
