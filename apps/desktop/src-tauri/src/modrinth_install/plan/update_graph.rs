//! Update-specific graph admission. The shared planner retains its no-overwrite
//! behavior unless this explicit policy authorizes one identified old mod.
//! After the new graph is complete, surviving installed mods keep their exact
//! required pins and incompatibilities. Replaced versions use new declarations.
use super::super::updates::UpdateReplacement;
use super::*;

pub(in crate::modrinth_install) async fn prepare_updates<P: Provider>(
    provider: &P,
    target: TargetSnapshot,
    installed: Vec<Installed>,
    roots: Vec<(Installed, Version)>,
    cancel: &AtomicBool,
) -> Result<(InstallPlan, Vec<UpdateReplacement>)> {
    let unidentified = target.local_files.len().saturating_sub(installed.len());
    let mut planner = Planner {
        provider,
        target: &target,
        cancel,
        projects: BTreeMap::new(),
        versions: BTreeMap::new(),
        selected: BTreeMap::new(),
        authority_versions: BTreeMap::new(),
        visiting: BTreeSet::new(),
        visited: BTreeSet::new(),
        installed,
        files: vec![],
        edges: vec![],
        warnings: BTreeSet::new(),
        incompatible: vec![],
        updating: Some(Policy::new(&roots)),
    };
    if unidentified > 0 {
        planner.warnings.insert(format!(
            "{unidentified}个本地文件未被Modrinth识别，无法自动核对这些文件的依赖与不兼容声明"
        ));
    }
    // Predeclare every selected root before recursion. Project-only dependencies
    // then see another selected root's intended version, not its old bytes.
    for (_, new) in &roots {
        if planner
            .selected
            .insert(new.project_id.clone(), new.id.clone())
            .is_some()
        {
            return Err("同一项目被重复选择更新".into());
        }
        planner.versions.insert(new.id.clone(), new.clone());
    }
    for (_, new) in roots {
        planner.add(new, None, None, false, 0).await?;
    }
    planner.surviving_constraints().await?;
    planner.check_incompatible()?;
    let policy = planner.updating.as_ref().expect("explicit update policy");
    policy.check_additions(&planner.files)?;
    let mut replacements = policy.replacements.clone();
    replacements.sort_by(|a, b| a.old_file_name.cmp(&b.old_file_name));
    planner.files.sort_by(|a, b| {
        (&a.kind, &a.file_name, &a.project_id).cmp(&(&b.kind, &b.file_name, &b.project_id))
    });
    let total_bytes = planner.files.iter().try_fold(0u64, |sum, file| {
        sum.checked_add(file.size).ok_or("更新资源总大小过大")
    })?;
    if total_bytes > MAX_BATCH_BYTES {
        return Err("更新资源总大小超过8GiB".into());
    }
    let download_bytes = planner
        .files
        .iter()
        .filter(|f| !f.reused)
        .map(|f| f.size)
        .sum();
    planner.warnings.insert(
        "已装模组的启用/禁用状态保持；必需前置的额外替换、新增文件与资源包均在本方案列出".into(),
    );
    let result = InstallPlan {
        root_id: target.root_id.clone(),
        instance_id: target.instance_id.clone(),
        minecraft_version: target.minecraft_version.clone(),
        loader: target.loader.clone(),
        revision: String::new(),
        files: planner.files,
        dependencies: planner.edges,
        warnings: planner.warnings.into_iter().collect(),
        total_bytes,
        download_bytes,
        authority_versions: planner.authority_versions,
        installed: planner.installed,
        unidentified_warning: None,
        target,
    };
    Ok((result, replacements))
}
impl<P: Provider> Planner<'_, P> {
    async fn declared_version(&mut self, id: &str) -> Result<Version> {
        if let Some(installed) = self.installed.iter().find(|i| i.version.id == id) {
            return Ok(installed.version.clone());
        }
        self.version(id).await
    }
    async fn surviving_constraints(&mut self) -> Result<()> {
        let surviving: Vec<Installed> = self
            .installed
            .iter()
            .filter(|i| {
                i.file.enabled && !self.updating.as_ref().is_some_and(|p| p.replaced(&i.file))
            })
            .cloned()
            .collect();
        for installed in surviving {
            for dependency in &installed.version.dependencies {
                if !matches!(
                    dependency.dependency_type.as_str(),
                    "required" | "incompatible"
                ) {
                    continue;
                }
                let mut dependency = dependency.clone();
                if let Some(id) = &dependency.version_id {
                    // Unrelated project pins remain unchanged and need no new
                    // request. Version-only pins must first identify a project.
                    if dependency
                        .project_id
                        .as_ref()
                        .is_some_and(|project| !self.selected.contains_key(project))
                    {
                        continue;
                    }
                    let referenced = self.declared_version(id).await?;
                    if dependency
                        .project_id
                        .as_ref()
                        .is_some_and(|project| project != &referenced.project_id)
                    {
                        return Err("已装模组依赖的项目与精确版本ID不符".into());
                    }
                    dependency.project_id = Some(referenced.project_id);
                }
                if dependency.dependency_type == "incompatible" {
                    self.incompatible.push(dependency);
                    continue;
                }
                if let Some(project) = &dependency.project_id {
                    let Some(selected) = self.selected.get(project) else {
                        continue;
                    };
                    if dependency
                        .version_id
                        .as_ref()
                        .is_some_and(|pin| pin != selected)
                    {
                        return Err(format!(
                            "未更新模组 {} 仍要求旧精确前置版本，不能替换为所选新版",
                            installed.file.file_name
                        ));
                    }
                    if self.updating.as_ref().is_some_and(|p| {
                        p.replacements
                            .iter()
                            .any(|r| &r.project_id == project && !r.enabled)
                    }) {
                        return Err(format!(
                            "未更新模组 {} 需要启用的前置，但所选前置处于禁用状态",
                            installed.file.file_name
                        ));
                    }
                } else if let Some(name) = &dependency.file_name {
                    let affected = self
                        .updating
                        .as_ref()
                        .is_some_and(|p| p.replacements.iter().any(|r| &r.old_file_name == name));
                    if affected
                        && !self
                            .files
                            .iter()
                            .any(|f| &f.file_name == name && !f.file_name.ends_with(".disabled"))
                        && !self.target.local_files.iter().any(|f| {
                            f.enabled
                                && &f.file_name == name
                                && !self.updating.as_ref().is_some_and(|p| p.replaced(f))
                        })
                    {
                        return Err(format!(
                            "未更新模组 {} 仍要求旧前置文件 {}，更新不能移走该文件",
                            installed.file.file_name, name
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}
