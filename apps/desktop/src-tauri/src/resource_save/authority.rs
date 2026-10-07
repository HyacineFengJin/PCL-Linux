//! Exact-file authority comes from an official Modrinth version. A selected
//! non-primary file is allowed because the request names it explicitly.
use super::*;
use crate::modrinth_install::provider::{self, ApiFile, HttpProvider, Provider};
use sha2::{Digest, Sha512};

#[derive(Debug)]
pub(crate) struct Authority {
    pub plan: SavePlan,
    pub file: ApiFile,
}
pub(super) fn validate_request(request: &SaveRequest) -> Result<()> {
    provider::id(&request.project_id)?;
    provider::id(&request.version_id)?;
    provider::file_name(&request.file_name)
}
pub(super) async fn resolve(
    provider: &(impl Provider + ?Sized),
    request: SaveRequest,
) -> Result<Authority> {
    resolve_for(provider, request, None).await
}
/// Direct installation requires the official project type in addition to the
/// exact version/file identity used by standalone Save.
pub(crate) async fn resolve_pack(
    provider: &(impl Provider + ?Sized),
    request: SaveRequest,
) -> Result<Authority> {
    let authority = resolve_for(provider, request, Some("modpack")).await?;
    if !authority.file.filename.ends_with(".mrpack") || authority.file.size > 512 * 1024 * 1024 {
        return Err("请选择不超过 512 MiB 的官方 .mrpack 整合包文件".into());
    }
    Ok(authority)
}
async fn resolve_for(
    provider: &(impl Provider + ?Sized),
    request: SaveRequest,
    project_type: Option<&str>,
) -> Result<Authority> {
    validate_request(&request)?;
    let (project, version) = tokio::try_join!(
        provider.project(&request.project_id),
        provider.version(&request.version_id)
    )?;
    provider::validate_version(&version)?;
    if project.id != request.project_id
        || project_type.is_some_and(|kind| project.project_type != kind)
        || version.project_id != request.project_id
        || version.id != request.version_id
        || project.title.len() > 2048
        || project.title.chars().any(char::is_control)
        || version.name.chars().any(char::is_control)
    {
        return Err("Modrinth保存文件的项目、版本或标题身份无效".into());
    }
    let file = version
        .files
        .iter()
        .find(|file| file.filename == request.file_name)
        .ok_or("所选文件已不在该Modrinth官方版本中，请重新选择")?
        .clone();
    // Preserve the complete actual extension in suggested names while leaving
    // room within the 240-byte dialog basename budget for a readable stem.
    if std::path::Path::new(&file.filename)
        .extension()
        .is_some_and(|extension| extension.len() > 64)
    {
        return Err("所选文件扩展名超过64字节，无法生成安全的保存名称".into());
    }
    let token = serde_json::to_vec(&(&request, &project.title, &version.name, &file))
        .map_err(|_| "无法生成文件保存确认")?;
    Ok(Authority {
        plan: SavePlan {
            request,
            project_title: project.title,
            version_name: version.name,
            file_name: file.filename.clone(),
            size: file.size,
            sha512: file.hashes.sha512.clone(),
            revision: format!("save-v1:{:x}", Sha512::digest(token)),
        },
        file,
    })
}
pub(super) async fn prepare(request: SaveRequest, cancel: &AtomicBool) -> Result<SavePlan> {
    cancelled(cancel)?;
    validate_request(&request)?;
    let provider = HttpProvider::new(cancel)?;
    let authority = resolve(&provider, request).await?;
    cancelled(cancel)?;
    Ok(authority.plan)
}
/// Linux permits characters that common save dialogs/filesystems reject. Use a
/// conservative readable stem, preserve the official extension and truncate at
/// a UTF-8 boundary. This only suggests a name; chosen targets are revalidated.
pub(super) fn suggested_filename(plan: &SavePlan, project_version: bool) -> String {
    if !project_version {
        return plan.file_name.clone();
    }
    let extension = std::path::Path::new(&plan.file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let suffix = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    let title = format!("{} {}", plan.project_title, plan.version_name);
    let mut stem = String::new();
    let mut separator = false;
    for ch in title.chars() {
        if ch.is_control()
            || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || ch.is_whitespace()
        {
            separator = !stem.is_empty();
            continue;
        }
        if separator {
            stem.push(' ');
            separator = false;
        }
        stem.push(ch);
    }
    let mut stem = stem.trim_matches([' ', '.']).to_string();
    if stem.is_empty() {
        stem = "resource".into();
    }
    let max = 240 - suffix.len();
    while stem.len() > max {
        stem.pop();
    }
    let stem = stem.trim_end_matches([' ', '.']);
    format!("{stem}{suffix}")
}
