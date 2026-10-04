//! Official loader profile assembly and isolated Forge installer processors.
use super::*;
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::Seek,
    process::{Command, Stdio},
    time::Instant,
};
const MAX_COMPONENT: u64 = 512 * 1024 * 1024;

pub(crate) fn initial_steps(request: &InstallRequest) -> Vec<InstallStep> {
    let mut steps = vec![
        step("metadata", "下载原版 Json 文件"),
        step("vanilla_libraries", "下载原版支持库文件"),
        step("vanilla_resources", "下载原版资源文件"),
    ];
    if let Some(component) = request.components.first() {
        let name = match component.provider.to_ascii_lowercase().as_str() {
            "fabric" => "Fabric",
            "forge" => "Forge",
            _ => "NeoForge",
        };
        steps.push(step("component_metadata", &format!("下载 {name} 主文件")));
        steps.push(step(
            "component_analyze",
            &format!("分析 {name} 支持库文件"),
        ));
        steps.push(step(
            "component_download",
            &format!("下载 {name} 支持库文件"),
        ));
        steps.push(step("component_install", &format!("安装 {name}")));
    }
    steps.push(step("game_install", "安装游戏"));
    steps.push(step("game_support", "下载游戏支持库文件"));
    steps
}
fn step(id: &str, label: &str) -> InstallStep {
    InstallStep {
        id: id.into(),
        label: label.into(),
        state: "pending".into(),
        progress: Some(0.0),
    }
}
pub(crate) fn download_hint(relative: &str, done: u64, total: u64) -> InstallStep {
    let id = if relative.starts_with("assets/") {
        "vanilla_resources"
    } else {
        "vanilla_libraries"
    };
    InstallStep {
        id: id.into(),
        label: String::new(),
        state: if done == total { "complete" } else { "running" }.into(),
        progress: Some(done as f64 / total.max(1) as f64),
    }
}
pub(crate) fn advance_steps(steps: &mut [InstallStep], p: &Progress) {
    if p.stage == "complete" {
        for s in steps {
            s.state = "complete".into();
            s.progress = Some(1.0);
        }
        return;
    }
    if p.stage == "installing" {
        for s in steps.iter_mut().filter(|s| {
            matches!(
                s.id.as_str(),
                "metadata" | "vanilla_libraries" | "vanilla_resources"
            )
        }) {
            s.state = "complete".into();
            s.progress = Some(1.0);
        }
        return;
    }
    if p.stage == "downloading" {
        if let Some(s) = steps.iter_mut().find(|s| s.id == "metadata") {
            s.state = "complete".into();
            s.progress = Some(1.0);
        }
        // The two groups download concurrently, so only the group's own worker
        // counters can complete its row.
        for hint in &p.steps {
            if let Some(s) = steps.iter_mut().find(|s| s.id == hint.id) {
                if s.state != "complete" {
                    s.state = hint.state.clone();
                }
                s.progress = hint
                    .progress
                    .map(|n| n.max(s.progress.unwrap_or(0.0)).clamp(0.0, 1.0));
            }
        }
        return;
    }
    let target = if p.stage == "publishing" {
        "game_support"
    } else {
        p.stage.as_str()
    };
    if let Some(index) = steps.iter().position(|s| s.id == target) {
        for (i, s) in steps.iter_mut().enumerate() {
            if i < index {
                s.state = "complete".into();
                s.progress = Some(1.0);
            }
            if i == index {
                s.state = "running".into();
                s.progress = p
                    .steps
                    .iter()
                    .find(|x| x.id == p.stage)
                    .and_then(|x| x.progress)
                    .map(|n| n.clamp(0.0, 1.0));
            }
        }
    }
}
pub(crate) struct ComponentStats {
    pub completed: u64,
    pub total: u64,
    pub bytes: u64,
    pub byte_total: u64,
    pub network: u64,
    pub downloaded: u64,
    pub reused: u64,
    pub component_total: u64,
    pub component_completed: u64,
}
impl ComponentStats {
    pub fn new(total: u64, byte_total: u64, network: u64, downloaded: u64, reused: u64) -> Self {
        Self {
            completed: total,
            total,
            bytes: byte_total,
            byte_total,
            network,
            downloaded,
            reused,
            component_total: 0,
            component_completed: 0,
        }
    }
    pub fn event(&self, stage: &str, message: &str, fraction: f64) -> Progress {
        // A one-step progress hint is consumed by the request's full step tracker.
        Progress {
            stage: stage.into(),
            message: message.into(),
            completed: self.completed,
            total: self.total,
            bytes_done: self.bytes,
            bytes_total: self.byte_total,
            network_bytes: self.network,
            steps: vec![InstallStep {
                id: stage.into(),
                label: String::new(),
                state: "running".into(),
                progress: Some(if stage == "component_download" {
                    self.component_completed as f64 / self.component_total.max(1) as f64
                } else {
                    fraction
                }),
            }],
        }
    }
}
fn maven_path(coordinate: &str) -> Result<String> {
    let (coordinate, extension) = coordinate.split_once('@').unwrap_or((coordinate, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    if !(3..=4).contains(&parts.len()) || parts.iter().any(|s| s.is_empty()) || extension.is_empty()
    {
        return Err("组件 Maven 坐标无效".into());
    }
    for part in parts.iter().copied().chain(std::iter::once(extension)) {
        pcl_core::identifier(part)?;
        if part.chars().any(char::is_control) {
            return Err("组件 Maven 坐标无效".into());
        }
    }
    let classifier = parts.get(3).map(|x| format!("-{x}")).unwrap_or_default();
    Ok(format!(
        "{}/{}/{}/{}-{}{classifier}.{extension}",
        parts[0].replace('.', "/"),
        parts[1],
        parts[2],
        parts[1],
        parts[2]
    ))
}
fn library_key(library: &Value) -> String {
    let coordinate = library["name"]
        .as_str()
        .unwrap_or("")
        .split('@')
        .next()
        .unwrap_or("");
    let p: Vec<_> = coordinate.split(':').collect();
    format!(
        "{}:{}:{}",
        p.first().unwrap_or(&""),
        p.get(1).unwrap_or(&""),
        p.get(3).unwrap_or(&"")
    )
}
fn merge_profile(mut base: Value, profile: Value, minecraft: &str) -> Result<Value> {
    if !profile.is_object()
        || profile["inheritsFrom"]
            .as_str()
            .is_some_and(|id| id != minecraft)
        || !profile["mainClass"].is_string()
    {
        return Err("组件启动信息与所选 Minecraft 版本不匹配".into());
    }
    let mut libs = base["libraries"]
        .as_array()
        .cloned()
        .ok_or("游戏依赖库信息无效")?;
    for library in profile["libraries"]
        .as_array()
        .ok_or("组件依赖库信息无效")?
    {
        let key = library_key(library);
        libs.retain(|old| library_key(old) != key);
        libs.push(library.clone());
    }
    let mut arguments = json!({});
    for key in ["game", "jvm"] {
        let mut args = base["arguments"][key]
            .as_array()
            .cloned()
            .unwrap_or_default();
        args.extend(
            profile["arguments"][key]
                .as_array()
                .into_iter()
                .flatten()
                .cloned(),
        );
        arguments[key] = args.into();
    }
    let has_arguments = base.get("arguments").is_some() || profile.get("arguments").is_some();
    for (key, value) in profile.as_object().unwrap() {
        if !matches!(key.as_str(), "inheritsFrom" | "jar" | "downloads") {
            base[key] = value.clone();
        }
    }
    base["libraries"] = libs.into();
    if has_arguments {
        base["arguments"] = arguments;
    }
    Ok(base)
}
fn archive_bytes<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>> {
    let mut entry = zip
        .by_name(name)
        .map_err(|_| format!("官方安装器缺少文件：{name}"))?;
    if entry.is_dir()
        || entry.size() > limit
        || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
    {
        return Err("官方安装器文件无效或过大".into());
    }
    let mut bytes = Vec::new();
    entry
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > limit {
        return Err("官方安装器文件过大".into());
    }
    Ok(bytes)
}
impl Installer {
    fn component_url(&self, raw: &str) -> Result<String> {
        let url = self.url(raw)?;
        #[cfg(test)]
        if let Some(endpoint) = &self.endpoint {
            let mut target = Url::parse(endpoint).map_err(error)?;
            target.set_path(url.path());
            target.set_query(url.query());
            return Ok(target.to_string());
        }
        Ok(url.to_string())
    }
    fn component_bytes(
        &self,
        url: &str,
        limit: u64,
        cancel: &AtomicBool,
        stats: &mut ComponentStats,
        cb: &(impl Fn(Progress) + Send + Sync),
    ) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.transfer(&self.url(url)?, limit, cancel, |chunk| {
            stats.network += chunk.len() as u64;
            bytes.extend_from_slice(chunk);
            cb(stats.event("component_metadata", "正在读取组件安装信息", 0.0));
            Ok(())
        })?;
        Ok(bytes)
    }
    fn component_file(
        &self,
        workspace: &Path,
        cache: &Path,
        d: &Download,
        cancel: &AtomicBool,
        stats: &mut ComponentStats,
        cb: &(impl Fn(Progress) + Send + Sync),
    ) -> Result<()> {
        let path = pcl_core::safe_join(workspace, &d.relative)?;
        let cached = pcl_core::safe_join(cache, &d.relative)?;
        fs::create_dir_all(path.parent().ok_or("组件文件路径无效")?).map_err(error)?;
        if verify(&path, &d.hash, d.size, cancel)? {
            return Ok(());
        }
        stats.total += 1;
        stats.byte_total += d.size;
        if verify(&cached, &d.hash, d.size, cancel)? {
            // Copy instead of hard links: processors can rewrite their inputs.
            copy_cancel(&cached, &path, cancel)?;
            stats.component_completed += 1;
            stats.reused += 1;
            stats.completed += 1;
            stats.bytes += d.size;
            cb(stats.event("component_download", "正在校验组件依赖库", 0.0));
            return Ok(());
        }
        let url = self.url(&d.url)?;
        let mut last = String::new();
        for attempt in 0..3 {
            check(cancel)?;
            if attempt > 0 {
                retry_wait(cancel, attempt)?;
            }
            let mut written = 0;
            let mut output =
                tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(error)?;
            let result = (|| {
                let mut digest = Sha1::new();
                self.transfer(&url, d.size, cancel, |chunk| {
                    output.write_all(chunk).map_err(error)?;
                    digest.update(chunk);
                    written += chunk.len() as u64;
                    stats.bytes += chunk.len() as u64;
                    stats.network += chunk.len() as u64;
                    cb(stats.event("component_download", "正在下载组件依赖库", 0.0));
                    Ok(())
                })?;
                if written != d.size
                    || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&d.hash)
                {
                    return Err("组件文件 SHA1 或大小校验失败".into());
                }
                output.as_file().sync_all().map_err(error)?;
                Ok(())
            })();
            let result = match result {
                Ok(()) => persist_download(output, &path),
                Err(e) => Err(close_download(output, e)),
            };
            match result {
                Ok(()) => {
                    stats.component_completed += 1;
                    stats.downloaded += 1;
                    stats.completed += 1;
                    cb(stats.event("component_download", "组件依赖下载完成", 1.0));
                    return Ok(());
                }
                Err(e) => {
                    if e.starts_with("取消清理失败：") {
                        return Err(e);
                    }
                    check(cancel)?;
                    stats.bytes = stats.bytes.saturating_sub(written);
                    last = e;
                }
            }
        }
        Err(last)
    }
    fn loader_library(
        &self,
        library: &Value,
        provider: &str,
        cancel: &AtomicBool,
    ) -> Result<Download> {
        let coordinate = library["name"].as_str().ok_or("组件库缺少名称")?;
        let art = &library["downloads"]["artifact"];
        if art.is_object() {
            return artifact(
                art,
                format!(
                    "libraries/{}",
                    art["path"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or(maven_path(coordinate)?)
                ),
            );
        }
        let path = maven_path(coordinate)?;
        let repository = library["url"].as_str().unwrap_or(if provider == "fabric" {
            "https://maven.fabricmc.net/"
        } else {
            "https://libraries.minecraft.net/"
        });
        // Old official Forge profiles contain HTTP URLs for its own Maven.
        let repository = repository
            .replace(
                "http://files.minecraftforge.net/maven/",
                "https://maven.minecraftforge.net/",
            )
            .replace(
                "http://maven.minecraftforge.net/",
                "https://maven.minecraftforge.net/",
            );
        let url = Url::parse(&repository)
            .map_err(error)?
            .join(&path)
            .map_err(error)?;
        let hash = if let Some(hash) = library["sha1"].as_str().filter(|s| hash_valid(s)) {
            hash.to_string()
        } else {
            String::from_utf8(self.bytes(&format!("{url}.sha1"), 1024, cancel)?).map_err(error)?
        };
        let hash = hash
            .split_whitespace()
            .next()
            .filter(|x| hash_valid(x))
            .ok_or("组件库缺少官方 SHA1 校验信息")?;
        // Fabric's launch profile does not declare lengths. Resolve the length
        // through the verified artifact response, then record it in launch JSON.
        let size = match library["size"].as_u64() {
            Some(size) => size,
            None => self.head_size(&url, cancel)?,
        };
        Ok(Download {
            url: url.into(),
            hash: hash.into(),
            size,
            relative: format!("libraries/{path}"),
        })
    }
    pub(crate) fn install_component(
        &self,
        root: &Path,
        temporary: &Path,
        name: &str,
        minecraft: &str,
        vanilla: Value,
        component: &ComponentSelection,
        cancel: &AtomicBool,
        stats: &mut ComponentStats,
        cb: &(impl Fn(Progress) + Send + Sync),
    ) -> Result<Value> {
        let provider = component.provider.to_ascii_lowercase();
        cb(stats.event("component_metadata", "正在获取组件安装信息", 0.0));
        let workspace = temporary.join("component-work");
        fs::create_dir(&workspace).map_err(error)?;
        let mut profile;
        let mut descriptors = BTreeMap::new();
        if provider == "fabric" {
            let mut url =
                Url::parse("https://meta.fabricmc.net/v2/versions/loader/").map_err(error)?;
            url.path_segments_mut()
                .map_err(|_| "组件地址无效")?
                .pop_if_empty()
                .push(minecraft)
                .push(&component.version)
                .push("profile")
                .push("json");
            let url = self.component_url(url.as_str())?;
            profile = serde_json::from_slice::<Value>(&self.component_bytes(
                &url,
                MAX_METADATA,
                cancel,
                stats,
                cb,
            )?)
            .map_err(error)?;
            if profile["inheritsFrom"].as_str() != Some(minecraft) {
                return Err("Fabric 不支持所选 Minecraft 版本".into());
            }
            cb(stats.event("component_analyze", "正在分析 Fabric 支持库文件", 0.0));
            let libs = profile["libraries"]
                .as_array_mut()
                .ok_or("Fabric 依赖信息无效")?;
            let count = libs.len();
            stats.component_total = count as u64;
            for (index, library) in libs.iter_mut().enumerate() {
                check(cancel)?;
                let d = self.loader_library(library, &provider, cancel)?;
                self.component_file(&workspace, root, &d, cancel, stats, cb)?;
                descriptors.insert(d.relative.clone(), d.clone());
                library["downloads"] = json!({"artifact":{"url":d.url,"sha1":d.hash,"size":d.size,"path":d.relative.strip_prefix("libraries/").unwrap()}});
                cb(stats.event(
                    "component_download",
                    "正在下载 Fabric 依赖文件",
                    (index + 1) as f64 / count.max(1) as f64,
                ));
            }
            cb(stats.event("component_install", "正在组装 Fabric 启动信息", 1.0));
        } else {
            let coordinate = if provider == "forge" {
                let version = if component.version.starts_with(&format!("{minecraft}-")) {
                    component.version.clone()
                } else {
                    format!("{minecraft}-{}", component.version)
                };
                format!("net.minecraftforge:forge:{version}:installer")
            } else if component.version.starts_with("1.20.1-") {
                format!("net.neoforged:forge:{}:installer", component.version)
            } else {
                format!("net.neoforged:neoforge:{}:installer", component.version)
            };
            let repository = if provider == "forge" {
                "https://maven.minecraftforge.net/"
            } else {
                "https://maven.neoforged.net/releases/"
            };
            let installer_url =
                self.component_url(&format!("{repository}{}", maven_path(&coordinate)?))?;
            let expected = String::from_utf8(self.component_bytes(
                &format!("{installer_url}.sha1"),
                1024,
                cancel,
                stats,
                cb,
            )?)
            .map_err(error)?;
            let hash = expected
                .split_whitespace()
                .next()
                .filter(|s| hash_valid(s))
                .ok_or("官方安装器缺少有效 SHA1")?;
            let bytes = self.component_bytes(&installer_url, MAX_COMPONENT, cancel, stats, cb)?;
            if !format!("{:x}", Sha1::digest(&bytes)).eq_ignore_ascii_case(hash) {
                return Err("官方组件安装器 SHA1 校验失败".into());
            }
            let installer_path = workspace.join("installer.jar");
            fs::write(&installer_path, &bytes).map_err(error)?;
            stats.downloaded += 1;
            stats.total += 1;
            stats.completed += 1;
            stats.bytes += bytes.len() as u64;
            stats.byte_total += bytes.len() as u64;
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(error)?;
            let install: Value = serde_json::from_slice(&archive_bytes(
                &mut archive,
                "install_profile.json",
                MAX_METADATA,
            )?)
            .map_err(error)?;
            let modern = install["spec"].as_u64().is_some();
            if !modern {
                return Err(
                    "暂不支持 1.7.10 等旧版 Forge 安装器，请选择 1.12.2 或更新的安装器".into(),
                );
            }
            profile = if modern {
                let json_path = install["json"]
                    .as_str()
                    .unwrap_or("/version.json")
                    .trim_start_matches('/');
                serde_json::from_slice(&archive_bytes(&mut archive, json_path, MAX_METADATA)?)
                    .map_err(error)?
            } else {
                install["versionInfo"].clone()
            };
            let declared_mc = install["minecraft"]
                .as_str()
                .or_else(|| install["install"]["minecraft"].as_str())
                .or_else(|| profile["inheritsFrom"].as_str());
            if declared_mc != Some(minecraft) {
                return Err("组件安装器与所选 Minecraft 版本不匹配".into());
            }
            cb(stats.event("component_analyze", "正在分析组件支持库文件", 0.0));
            let mut generated = vec![];
            for library in install["libraries"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(profile["libraries"].as_array().into_iter().flatten())
            {
                if !pcl_core::library_allowed(library)? {
                    continue;
                }
                let d = self.loader_library(library, &provider, cancel)?;
                if let Some(previous) = descriptors.insert(d.relative.clone(), d.clone()) {
                    if previous.hash != d.hash || previous.size != d.size {
                        return Err("组件库包含冲突的文件路径".into());
                    }
                }
            }
            stats.component_total = descriptors.len() as u64;
            for d in descriptors.values() {
                check(cancel)?;
                let entry_name =
                    format!("maven/{}", d.relative.strip_prefix("libraries/").unwrap());
                if archive.by_name(&entry_name).is_ok() {
                    let bytes = archive_bytes(&mut archive, &entry_name, MAX_COMPONENT)?;
                    if bytes.len() as u64 != d.size
                        || !format!("{:x}", Sha1::digest(&bytes)).eq_ignore_ascii_case(&d.hash)
                    {
                        return Err("官方安装器内嵌组件校验失败".into());
                    }
                    let target = pcl_core::safe_join(&workspace, &d.relative)?;
                    fs::create_dir_all(target.parent().unwrap()).map_err(error)?;
                    fs::write(target, bytes).map_err(error)?;
                    stats.component_completed += 1;
                } else if d.url.is_empty() {
                    generated.push(d.clone());
                    stats.component_total -= 1;
                } else {
                    self.component_file(&workspace, root, d, cancel, stats, cb)?;
                }
            }
            if !modern {
                let embedded = install["install"]["filePath"]
                    .as_str()
                    .ok_or("旧版 Forge 安装器缺少通用组件文件")?;
                let target = install["install"]["path"]
                    .as_str()
                    .ok_or("旧版 Forge 安装器缺少组件坐标")?;
                let relative = format!("libraries/{}", maven_path(target)?);
                let target = pcl_core::safe_join(&workspace, relative)?;
                fs::create_dir_all(target.parent().unwrap()).map_err(error)?;
                fs::write(
                    target,
                    archive_bytes(&mut archive, embedded, MAX_COMPONENT)?,
                )
                .map_err(error)?;
            }
            let processors: Vec<_> = install["processors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| {
                    p["sides"]
                        .as_array()
                        .is_none_or(|s| s.iter().any(|v| v.as_str() == Some("client")))
                })
                .collect();
            if !processors.is_empty() {
                let java_major =
                    vanilla["javaVersion"]["majorVersion"].as_u64().unwrap_or(8) as u32;
                let java = self.installer_java(java_major, &workspace, cancel)?;
                let minecraft_jar = temporary.join(format!("{name}.jar"));
                let mut data = processor_data(
                    &install,
                    &workspace,
                    &minecraft_jar,
                    &installer_path,
                    &mut archive,
                )?;
                // Most mapping tasks consume the raw official text. Tasks with
                // --sanitize must still execute their official transformation.
                if let Some(target) = data.get("MOJMAPS") {
                    if let Some(mapping) = vanilla["downloads"].get("client_mappings") {
                        let path = Path::new(target);
                        let relative = path
                            .strip_prefix(&workspace)
                            .map_err(error)?
                            .to_string_lossy()
                            .into_owned();
                        let d = artifact(mapping, relative)?;
                        stats.component_total += 1;
                        self.component_file(&workspace, root, &d, cancel, stats, cb)?;
                    }
                }
                data.insert("SIDE".into(), "client".into());
                cb(stats.event("component_install", "正在安装组件", 0.0));
                for (index, processor) in processors.iter().enumerate() {
                    check(cancel)?;
                    let args: Vec<_> = processor["args"]
                        .as_array()
                        .ok_or("组件处理器缺少参数")?
                        .iter()
                        .map(|v| v.as_str().ok_or_else(|| "组件处理器参数无效".to_string()))
                        .collect::<Result<_>>()?;
                    let mappings_task = args
                        .windows(2)
                        .any(|pair| pair == ["--task", "DOWNLOAD_MOJMAPS"]);
                    if mappings_task
                        && !args.contains(&"--sanitize")
                        && data.get("MOJMAPS").is_some_and(|p| Path::new(p).is_file())
                    {
                        verify_processor_outputs(processor, &data, &workspace, cancel)?;
                        cb(stats.event(
                            "component_install",
                            "正在安装组件",
                            (index + 1) as f64 / processors.len() as f64,
                        ));
                        continue;
                    }
                    run_processor(&java, processor, &data, &workspace, cancel)?;
                    cb(stats.event(
                        "component_install",
                        "正在安装组件",
                        (index + 1) as f64 / processors.len() as f64,
                    ));
                }
                for key in ["MC_SRG", "MC_EXTRA", "PATCHED", "MC_OFF"] {
                    if let Some(path) = data.get(key) {
                        let path = Path::new(path);
                        let file = fs::File::open(path)
                            .map_err(|e| format!("组件运行文件 {key} 尚未正确生成：{e}"))?;
                        let archive = zip::ZipArchive::new(file)
                            .map_err(|e| format!("组件运行文件 {key} 不是有效的 JAR：{e}"))?;
                        if archive.is_empty() {
                            return Err(format!("组件运行文件 {key} 为空"));
                        }
                        if let Some(hash) = data.get(&format!("{key}_SHA")) {
                            let size = fs::metadata(path).map_err(error)?.len();
                            if !hash_valid(hash) || !verify(path, hash, size, cancel)? {
                                return Err(format!("组件运行文件 {key} SHA1 校验失败"));
                            }
                        }
                    }
                }
            }
            // New NeoForge installers omit processor outputs. All launch-time
            // generated artifacts still carry hashes in version.json.
            for d in &generated {
                let target = pcl_core::safe_join(&workspace, &d.relative)?;
                if !verify(&target, &d.hash, d.size, cancel)? {
                    return Err(format!("组件处理结果校验失败：{}", d.relative));
                }
            }
        }
        cb(stats.event("component_install", "组件安装完成", 1.0));
        cb(stats.event("game_install", "正在组装游戏启动信息", 0.0));
        let result = merge_profile(vanilla, profile.clone(), minecraft)?;
        // The loader's launch JSON omits some runtime jars (patched Minecraft,
        // split extras, universal). Preserve the complete successful library
        // workspace after verifying declared and generated runtime artifacts.
        let library_root = workspace.join("libraries");
        for source in collect_files(&library_root)? {
            check(cancel)?;
            let relative = source
                .strip_prefix(&workspace)
                .map_err(error)?
                .to_string_lossy()
                .into_owned();
            if let Some(d) = descriptors.get(&relative) {
                if !verify(&source, &d.hash, d.size, cancel)? {
                    return Err("组件运行库校验失败".into());
                }
            }
        }
        Ok(result)
    }
    pub(crate) fn publish_component_libraries(
        &self,
        root: &Path,
        workspace: &Path,
        cancel: &AtomicBool,
        stats: &ComponentStats,
        cb: &(impl Fn(Progress) + Send + Sync),
    ) -> Result<()> {
        let files = collect_files(&workspace.join("libraries"))?;
        cb(stats.event("game_support", "正在安装游戏支持库文件", 0.0));
        for (index, source) in files.iter().enumerate() {
            check(cancel)?;
            let relative = source.strip_prefix(workspace).map_err(error)?;
            let destination = pcl_core::safe_join(root, relative)?;
            let hash = file_hash(source, cancel)?;
            let size = fs::metadata(source).map_err(error)?.len();
            if !verify(&destination, &hash, size, cancel)? {
                fs::create_dir_all(destination.parent().unwrap()).map_err(error)?;
                let mut output = tempfile::NamedTempFile::new_in(destination.parent().unwrap())
                    .map_err(error)?;
                let result = (|| {
                    let mut input = fs::File::open(source).map_err(error)?;
                    copy_stream(&mut input, &mut output, cancel)?;
                    output.as_file().sync_all().map_err(error)
                })();
                match result {
                    Ok(()) => persist_download(output, &destination)?,
                    Err(e) => return Err(close_download(output, e)),
                }
            }
            cb(stats.event(
                "game_support",
                "正在安装游戏支持库文件",
                (index + 1) as f64 / files.len().max(1) as f64,
            ));
        }
        Ok(())
    }
}
fn copy_stream(input: &mut impl Read, output: &mut impl Write, cancel: &AtomicBool) -> Result<()> {
    let mut buf = [0; 65536];
    loop {
        check(cancel)?;
        let n = input.read(&mut buf).map_err(error)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(error)?;
    }
    Ok(())
}
fn copy_cancel(source: &Path, target: &Path, cancel: &AtomicBool) -> Result<()> {
    copy_stream(
        &mut fs::File::open(source).map_err(error)?,
        &mut fs::File::create(target).map_err(error)?,
        cancel,
    )
}
fn processor_data<R: Read + Seek>(
    profile: &Value,
    workspace: &Path,
    minecraft_jar: &Path,
    installer: &Path,
    archive: &mut zip::ZipArchive<R>,
) -> Result<HashMap<String, String>> {
    let libraries = workspace.join("libraries");
    fs::create_dir_all(&libraries).map_err(error)?;
    let mut data = HashMap::new();
    for (key, entry) in profile["data"].as_object().into_iter().flatten() {
        let Some(raw) = entry["client"].as_str() else {
            continue;
        };
        let value = if let Some(coordinate) =
            raw.strip_prefix('[').and_then(|s| s.strip_suffix(']'))
        {
            let path =
                pcl_core::safe_join(workspace, format!("libraries/{}", maven_path(coordinate)?))?;
            fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
            path.to_string_lossy().into_owned()
        } else if let Some(literal) = raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
            literal.to_string()
        } else {
            let archive_path = raw.trim_start_matches('/');
            let path = pcl_core::safe_join(workspace, format!("extracted/{archive_path}"))?;
            fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
            fs::write(&path, archive_bytes(archive, archive_path, MAX_COMPONENT)?)
                .map_err(error)?;
            path.to_string_lossy().into_owned()
        };
        data.insert(key.clone(), value);
    }
    for (key, value) in [
        ("SIDE", "client".to_string()),
        (
            "MINECRAFT_VERSION",
            profile["minecraft"]
                .as_str()
                .ok_or("组件安装器缺少 Minecraft 版本")?
                .into(),
        ),
        (
            "MINECRAFT_JAR",
            minecraft_jar.to_string_lossy().into_owned(),
        ),
        ("ROOT", workspace.to_string_lossy().into_owned()),
        ("LIBRARY_DIR", libraries.to_string_lossy().into_owned()),
        ("INSTALLER", installer.to_string_lossy().into_owned()),
    ] {
        data.insert(key.into(), value);
    }
    Ok(data)
}
fn expand(raw: &str, data: &HashMap<String, String>, workspace: &Path) -> Result<String> {
    if let Some(coordinate) = raw.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return Ok(pcl_core::safe_join(
            workspace,
            format!("libraries/{}", maven_path(coordinate)?),
        )?
        .to_string_lossy()
        .into_owned());
    }
    let raw = raw
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .unwrap_or(raw);
    let mut result = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        let end = rest[start..]
            .find('}')
            .ok_or("组件处理器参数缺少闭合标记")?
            + start;
        result.push_str(
            data.get(&rest[start + 1..end])
                .ok_or("组件处理器引用了未知参数")?,
        );
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    Ok(result)
}
fn main_class(path: &Path) -> Result<String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(error)?).map_err(error)?;
    let raw = String::from_utf8(archive_bytes(
        &mut archive,
        "META-INF/MANIFEST.MF",
        1024 * 1024,
    )?)
    .map_err(error)?;
    let mut lines: Vec<String> = vec![];
    for line in raw.lines() {
        if let Some(cont) = line.strip_prefix(' ') {
            if let Some(last) = lines.last_mut() {
                last.push_str(cont);
            }
        } else {
            lines.push(line.into());
        }
    }
    lines
        .iter()
        .find_map(|line| line.strip_prefix("Main-Class: ").map(str::trim))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or("组件处理器缺少 Main-Class".into())
}
fn run_processor(
    java: &Path,
    processor: &Value,
    data: &HashMap<String, String>,
    workspace: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let jar = processor["jar"].as_str().ok_or("组件处理器缺少可执行库")?;
    let jar = pcl_core::safe_join(workspace, format!("libraries/{}", maven_path(jar)?))?;
    let mut classpath = vec![jar.clone()];
    for coordinate in processor["classpath"].as_array().into_iter().flatten() {
        classpath.push(pcl_core::safe_join(
            workspace,
            format!(
                "libraries/{}",
                maven_path(coordinate.as_str().ok_or("组件处理器依赖无效")?)?
            ),
        )?);
    }
    if classpath.iter().any(|path| !path.is_file()) {
        return Err("组件处理器依赖下载不完整".into());
    }
    let args = processor["args"]
        .as_array()
        .ok_or("组件处理器参数无效")?
        .iter()
        .map(|v| expand(v.as_str().ok_or("组件处理器参数无效")?, data, workspace))
        .collect::<Result<Vec<_>>>()?;
    let classpath = std::env::join_paths(classpath).map_err(error)?;
    let mut command = Command::new(java);
    command
        .args(["-Djava.awt.headless=true", "-cp"])
        .arg(classpath)
        .arg(main_class(&jar)?)
        .args(args)
        .current_dir(workspace);
    let log = fs::File::create(workspace.join("processor.log")).map_err(error)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(error)?))
        .stderr(Stdio::from(log));
    let status = run_child(&mut command, cancel, Duration::from_secs(15 * 60))?;
    if !status.success() {
        let bytes = fs::read(workspace.join("processor.log")).unwrap_or_default();
        let tail = &bytes[bytes.len().saturating_sub(4096)..];
        return Err(format!(
            "组件安装处理器失败（{status}）：{}",
            String::from_utf8_lossy(tail)
        ));
    }
    verify_processor_outputs(processor, data, workspace, cancel)
}
fn verify_processor_outputs(
    processor: &Value,
    data: &HashMap<String, String>,
    workspace: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    for (raw_path, expected) in processor["outputs"].as_object().into_iter().flatten() {
        let path = PathBuf::from(expand(raw_path, data, workspace)?);
        let relative = path
            .strip_prefix(workspace)
            .map_err(|_| "组件处理器输出超出临时目录")?;
        let path = pcl_core::safe_join(workspace, relative)?;
        let hash = expand(
            expected.as_str().ok_or("组件处理器输出校验信息无效")?,
            data,
            workspace,
        )?;
        if !hash_valid(&hash) {
            return Err("组件处理器输出缺少有效 SHA1".into());
        }
        let size = fs::metadata(&path).map_err(error)?.len();
        if !verify(&path, &hash, size, cancel)? {
            return Err("组件处理器输出 SHA1 校验失败".into());
        }
    }
    Ok(())
}
fn file_hash(path: &Path, cancel: &AtomicBool) -> Result<String> {
    let mut digest = Sha1::new();
    let mut input = fs::File::open(path).map_err(error)?;
    let mut buf = [0; 65536];
    loop {
        check(cancel)?;
        let n = input.read(&mut buf).map_err(error)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn collect_files(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut files = vec![];
    if !directory.exists() {
        return Ok(files);
    }
    for entry in fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        let kind = entry.file_type().map_err(error)?;
        if kind.is_symlink() {
            return Err("组件处理器生成了不允许的符号链接".into());
        }
        if kind.is_dir() {
            files.extend(collect_files(&entry.path())?);
        } else if kind.is_file() {
            files.push(entry.path());
        } else {
            return Err("组件处理器生成了不允许的文件类型".into());
        }
    }
    Ok(files)
}

fn run_child(
    command: &mut Command,
    cancel: &AtomicBool,
    limit: Duration,
) -> Result<std::process::ExitStatus> {
    check(cancel)?;
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行 Java 安装处理器：{e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error(e));
            }
        }
        if cancel.load(Ordering::Relaxed) || start.elapsed() > limit {
            // Wait for the JVM to exit before deleting its workspace or marking
            // the task cancelled. A failed stop remains a cleanup failure.
            if let Err(e) = child.kill() {
                if child.try_wait().map_err(error)?.is_none() {
                    return Err(format!("取消清理失败：无法终止 Java 处理器：{e}"));
                }
            }
            child
                .wait()
                .map_err(|e| format!("取消清理失败：等待 Java 处理器退出失败：{e}"))?;
            return if cancel.load(Ordering::Relaxed) {
                Err("安装已取消".into())
            } else {
                Err("组件安装处理器运行超时".into())
            };
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}
impl Installer {
    fn installer_java(
        &self,
        required: u32,
        workspace: &Path,
        cancel: &AtomicBool,
    ) -> Result<PathBuf> {
        let mut paths = vec![];
        if let Some(path) = &self.java {
            paths.push(path.clone());
        }
        let project = self
            .project
            .clone()
            .or_else(|| std::env::current_dir().ok());
        if let Some(project) = project {
            for base in [project.clone(), project.join("PCL-Linux")] {
                if let Ok(entries) = fs::read_dir(base) {
                    for entry in entries.flatten() {
                        if entry.file_name().to_string_lossy().starts_with("runtime") {
                            paths.push(entry.path().join("bin/java"));
                        }
                    }
                }
            }
        }
        if let Some(home) = std::env::var_os("JAVA_HOME") {
            paths.push(PathBuf::from(home).join("bin/java"));
        }
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path).map(|p| p.join("java")));
        }
        if let Ok(entries) = fs::read_dir("/usr/lib/jvm") {
            paths.extend(entries.flatten().map(|e| e.path().join("bin/java")));
        }
        let mut seen = HashSet::new();
        for path in paths {
            check(cancel)?;
            let Ok(path) = fs::canonicalize(path) else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            let log = tempfile::NamedTempFile::new_in(workspace).map_err(error)?;
            let mut command = Command::new(&path);
            command
                .arg("-version")
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.reopen().map_err(error)?))
                .stderr(Stdio::from(log.reopen().map_err(error)?));
            match run_child(&mut command, cancel, Duration::from_secs(5)) {
                Ok(status) if status.success() => {
                    let text = fs::read_to_string(log.path()).unwrap_or_default();
                    let major = text
                        .split("version \"")
                        .nth(1)
                        .and_then(|s| s.strip_prefix("1.").or(Some(s)))
                        .and_then(|s| s.split(['.', '"', '-']).next())
                        .and_then(|s| s.parse::<u32>().ok());
                    if major == Some(required) {
                        return Ok(path);
                    }
                }
                Err(e) if cancel.load(Ordering::Relaxed) || e.starts_with("取消清理失败：") => {
                    return Err(e)
                }
                _ => {}
            }
        }
        Err(format!(
            "安装此组件需要 Java {required}，请配置兼容的 Java 或放入项目 runtime 目录后重试"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_kills_and_reaps_running_processor_before_return() {
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        let mut command = Command::new("/bin/sleep");
        command
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                cancelled.store(true, Ordering::Relaxed);
            });
            assert!(run_child(&mut command, &cancelled, Duration::from_secs(10))
                .unwrap_err()
                .contains("取消"));
        });
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn concurrent_download_steps_retain_labels_and_own_completion() {
        let request = InstallRequest {
            minecraft: "fixture".into(),
            name: "fixture".into(),
            components: vec![ComponentSelection {
                provider: "NeoForge".into(),
                version: "1".into(),
            }],
        };
        let mut steps = initial_steps(&request);
        let stats = ComponentStats::new(10, 100, 100, 10, 0);
        let mut progress = stats.event("downloading", "", 0.0);
        progress.steps = vec![download_hint("libraries/library.jar", 1, 2)];
        advance_steps(&mut steps, &progress);
        progress.steps = vec![download_hint("assets/indexes/index.json", 1, 1)];
        advance_steps(&mut steps, &progress);
        assert_eq!(steps[1].state, "running");
        assert_eq!(steps[1].progress, Some(0.5));
        assert_eq!(steps[2].state, "complete");
        advance_steps(&mut steps, &stats.event("component_metadata", "", 0.0));
        assert_eq!(steps.len(), 9);
        assert!(steps.iter().all(|step| !step.label.is_empty()));
    }
    #[test]
    fn output_hash_verification_is_kept_when_mapping_task_is_skipped() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mappings.txt");
        fs::write(&path, b"raw mappings").unwrap();
        let data = HashMap::from([("MOJMAPS".into(), path.to_string_lossy().into_owned())]);
        let processor =
            json!({"outputs":{"{MOJMAPS}":"'0000000000000000000000000000000000000000'"}});
        assert!(
            verify_processor_outputs(&processor, &data, root.path(), &AtomicBool::new(false))
                .unwrap_err()
                .contains("SHA1")
        );
    }
}
