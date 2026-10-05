//! Replacement permissions operate on logical versions, never on a filtered
//! filesystem snapshot. Surviving installed constraints therefore still see the
//! full original inventory, while updated projects use their new declarations.
use super::super::{
    plan::{InstallFile, Installed},
    provider::{ApiFile, Project, Version},
    *,
};
use super::{check, UpdateReplacement};
use std::collections::BTreeSet;

pub(in crate::modrinth_install) struct Policy {
    requested: BTreeSet<String>,
    has_disabled_root: bool,
    pub replacements: Vec<UpdateReplacement>,
}
impl Policy {
    pub fn new(roots: &[(Installed, Version)]) -> Self {
        Self {
            requested: roots
                .iter()
                .map(|(old, _)| old.file.file_name.clone())
                .collect(),
            has_disabled_root: roots.iter().any(|(old, _)| !old.file.enabled),
            replacements: vec![],
        }
    }
    pub fn replaced(&self, file: &LocalFile) -> bool {
        self.replacements
            .iter()
            .any(|r| r.kind == file.kind && r.old_file_name == file.file_name)
    }
    pub fn replacement(
        &mut self,
        installed: &[Installed],
        project: &Project,
        version: &Version,
        file: &ApiFile,
        required: bool,
    ) -> Result<Option<UpdateReplacement>> {
        let matching: Vec<&Installed> = installed
            .iter()
            .filter(|i| i.file.kind == "mods" && i.version.project_id == project.id)
            .collect();
        if matching.len() > 1 {
            return Err(format!(
                "项目 {} 存在多个本地模组文件（包括禁用文件），请先手动处理",
                project.title
            ));
        }
        let Some(old) = matching.first() else {
            return Ok(None);
        };
        if required && !old.file.enabled {
            return Err(format!(
                "必需前置 {} 已被禁用，更新不会自动启用，请先手动处理",
                old.file.file_name
            ));
        }
        if old.version.id == version.id {
            return Ok(None);
        }
        // Extra required replacements receive the same old-file authority as
        // explicitly selected roots; a dependency edge cannot widen it.
        check::validate_old(old, installed)?;
        if !check::newer(version, &old.version)? {
            return Err(format!(
                "项目 {} 要求较早、相同或非正式版本，更新不会降级",
                project.title
            ));
        }
        if file.hashes.sha512 == old.file.sha512 {
            return Err("所需新版本与旧文件内容相同，无法安全改变哈希版本身份".into());
        }
        if !self.requested.contains(&old.file.file_name) && !required {
            return Err("旧模组不在所选更新或明确必需前置范围内".into());
        }
        let name = if old.file.enabled {
            file.filename.clone()
        } else {
            format!("{}.disabled", file.filename)
        };
        provider::file_name(&name)?;
        let mut replacement = UpdateReplacement {
            kind: "mods".into(),
            old_file_name: old.file.file_name.clone(),
            old_fingerprint: old.file.resource_fingerprint.clone(),
            old_sha512: old.file.sha512.clone(),
            new_file_name: name,
            enabled: old.file.enabled,
            project_id: project.id.clone(),
            title: project.title.clone(),
            old_version_id: old.version.id.clone(),
            old_version: old.version.version_number.clone(),
            new_version_id: version.id.clone(),
            new_version: version.version_number.clone(),
            size: file.size,
            sha512: file.hashes.sha512.clone(),
            required: !self.requested.contains(&old.file.file_name),
        };
        if let Some(previous) = self
            .replacements
            .iter_mut()
            .find(|r| r.old_file_name == old.file.file_name)
        {
            if previous.new_file_name != replacement.new_file_name
                || previous.sha512 != replacement.sha512
                || previous.new_version_id != replacement.new_version_id
            {
                return Err("同一旧模组要求替换为多个不同文件或版本".into());
            }
            replacement.required = previous.required;
        } else {
            self.replacements.push(replacement.clone());
        }
        Ok(Some(replacement))
    }
    pub fn check_additions(&self, files: &[InstallFile]) -> Result<()> {
        if self.has_disabled_root
            && files.iter().any(|file| {
                file.kind == "mods"
                    && !file.reused
                    && !self
                        .replacements
                        .iter()
                        .any(|r| r.new_file_name == file.file_name)
            })
        {
            return Err("本次更新包含禁用模组且需要新增模组前置，请分开更新或先处理前置".into());
        }
        Ok(())
    }
}
