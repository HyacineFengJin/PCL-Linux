use crate::{ui_data, Shared};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};
use tauri::State;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("PCL-Linux/0.2.0 (https://github.com/HyacineFengJin/PCL-Linux)")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}
async fn get(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if data.len() + chunk.len() > limit {
            return Err("响应内容过大".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
#[tauri::command]
pub fn ui_open_link(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "无效链接")?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(
            parsed.host_str(),
            Some("github.com" | "neoforged.net" | "www.mcmod.cn")
        )
    {
        return Err("不支持的链接".into());
    }
    crate::open_official(parsed.as_str())
}
#[derive(Serialize)]
pub struct LoaderGroup {
    minecraft: String,
    versions: Vec<String>,
}
fn neoforge_game(version: &str) -> Option<String> {
    if let Some(rest) = version.strip_prefix("0.") {
        return rest.split('.').next().map(str::to_owned);
    }
    let core = version.split('-').next()?;
    let numbers: Vec<_> = core.split('.').collect();
    if numbers.len() < 3 {
        return None;
    }
    if numbers[0] == "20" || numbers[0] == "21" {
        Some(format!("1.{}.{}", numbers[0], numbers[1]))
    } else if numbers[0].parse::<u32>().ok()? >= 26 {
        Some(if numbers[2] == "0" {
            format!("{}.{}", numbers[0], numbers[1])
        } else {
            format!("{}.{}.{}", numbers[0], numbers[1], numbers[2])
        })
    } else {
        None
    }
}
#[tauri::command]
pub async fn loader_catalog(loader: String) -> Result<Vec<LoaderGroup>, String> {
    if loader != "NeoForge" {
        return Err("此安装包目录尚未接入".into());
    }
    let data = get(
        "https://maven.neoforged.net/api/maven/versions/releases/net%2Fneoforged%2Fneoforge",
        2 * 1024 * 1024,
    )
    .await?;
    #[derive(Deserialize)]
    struct Catalog {
        versions: Vec<String>,
    }
    let catalog: Catalog = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let mut groups = Vec::<LoaderGroup>::new();
    for version in &catalog.versions {
        if version.contains('+') {
            continue;
        }
        if version.len() > 100
            || !version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
        {
            continue;
        }
        let Some(mut game) = neoforge_game(version) else {
            continue;
        };
        if let Some((_, snapshot)) = version.split_once('+') {
            game.push('-');
            game.push_str(snapshot);
        }
        if let Some(group) = groups.iter_mut().find(|v| v.minecraft == game) {
            group.versions.push(version.to_owned());
        } else {
            groups.push(LoaderGroup {
                minecraft: game,
                versions: vec![version.to_owned()],
            });
        }
    }
    groups.reverse();
    if let Some(index) = groups.iter().position(|g| g.minecraft == "25w14craftmine") {
        let group = groups.remove(index);
        let index = groups
            .iter()
            .position(|g| g.minecraft.starts_with("1."))
            .unwrap_or(groups.len());
        groups.insert(index, group);
    }
    for group in &mut groups {
        group.versions.reverse();
    }
    Ok(groups)
}
#[derive(Serialize)]
pub struct Contributor {
    login: String,
    avatar: String,
    url: String,
}
#[tauri::command]
pub async fn upstream_contributors() -> Result<Vec<Contributor>, String> {
    let data = get(
        "https://api.github.com/repos/PCL-Community/PCL-CE/contributors?per_page=30",
        2 * 1024 * 1024,
    )
    .await?;
    let list: Vec<serde_json::Value> = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .filter_map(|v| {
            let login = v["login"].as_str()?;
            let avatar = v["avatar_url"].as_str()?;
            let url = v["html_url"].as_str()?;
            if !avatar.starts_with("https://avatars.githubusercontent.com/")
                || !url.starts_with("https://github.com/")
            {
                return None;
            }
            Some(Contributor {
                login: login.to_owned(),
                avatar: format!(
                    "{avatar}{}s=80",
                    if avatar.contains('?') { "&" } else { "?" }
                ),
                url: url.to_owned(),
            })
        })
        .collect())
}
#[derive(Serialize)]
pub struct Issue {
    title: String,
    url: String,
    labels: Vec<String>,
    author: String,
    created_at: String,
}
#[tauri::command]
pub async fn project_feedback() -> Result<Vec<Issue>, String> {
    let data = get(
        "https://api.github.com/repos/HyacineFengJin/PCL-Linux/issues?state=open&per_page=100",
        2 * 1024 * 1024,
    )
    .await?;
    let list: Vec<serde_json::Value> = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .filter(|v| v.get("pull_request").is_none())
        .filter_map(|v| {
            Some(Issue {
                title: v["title"].as_str()?.to_owned(),
                url: v["html_url"].as_str()?.to_owned(),
                labels: v["labels"]
                    .as_array()?
                    .iter()
                    .filter_map(|x| x["name"].as_str().map(str::to_owned))
                    .collect(),
                author: v["user"]["login"].as_str()?.to_owned(),
                created_at: v["created_at"].as_str()?.to_owned(),
            })
        })
        .collect())
}
#[derive(Serialize)]
pub struct LogRow {
    name: String,
    path: String,
    modified: u64,
    current: bool,
}
#[tauri::command]
pub async fn launcher_logs(state: State<'_, Arc<Shared>>) -> Result<Vec<LogRow>, String> {
    let root = PathBuf::from(state.settings.lock().unwrap().root.clone());
    let current = state.log.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let folder = root.join(".pcl-linux/logs");
        if !folder.exists() {
            return Ok(Vec::new());
        }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let folder = folder.canonicalize().map_err(|e| e.to_string())?;
        if !folder.starts_with(&root) {
            return Err("日志目录超出游戏目录".into());
        }
        let mut rows = Vec::new();
        for item in fs::read_dir(folder).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let path = item.path().canonicalize().map_err(|e| e.to_string())?;
            if !path.starts_with(&root)
                || path.extension().and_then(|s| s.to_str()) != Some("log")
                || !path.is_file()
            {
                continue;
            }
            let modified = item
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            rows.push(LogRow {
                name: item.file_name().to_string_lossy().into_owned(),
                path: path.display().to_string(),
                modified,
                current: current
                    .as_ref()
                    .and_then(|p| p.canonicalize().ok())
                    .as_ref()
                    == Some(&path),
            });
        }
        rows.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn launcher_read_log(
    name: String,
    state: State<'_, Arc<Shared>>,
) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || !name.ends_with(".log") {
        return Err("无效日志名".into());
    }
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(s.settings.lock().unwrap().root.clone())
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let folder = root
            .join(".pcl-linux/logs")
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let path = folder
            .join(name)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !folder.starts_with(&root) || !path.starts_with(&folder) {
            return Err("日志目录超出游戏目录".into());
        }
        let mut data = Vec::new();
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(1024 * 1024)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        Ok(s.accounts
            .redact(String::from_utf8_lossy(&data).into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Deserialize, Serialize)]
pub struct Server {
    name: String,
    ip: String,
    #[serde(default)]
    icon: Option<String>,
}
#[derive(Deserialize)]
struct Servers {
    #[serde(default)]
    servers: Vec<Server>,
}
fn decode_servers(data: &[u8]) -> Result<Vec<Server>, String> {
    let parsed: Servers =
        fastnbt::from_bytes(data).map_err(|e| format!("服务器列表读取失败：{e}"))?;
    Ok(parsed
        .servers
        .into_iter()
        .map(|mut v| {
            v.name = v.name.chars().take(512).collect();
            v.ip = v.ip.chars().take(512).collect();
            v.icon = v
                .icon
                .filter(|i| i.len() < 180000)
                .filter(|i| {
                    use base64::Engine;
                    let value = i.strip_prefix("data:image/png;base64,").unwrap_or(i);
                    base64::engine::general_purpose::STANDARD
                        .decode(value)
                        .is_ok_and(|b| b.starts_with(b"\x89PNG\r\n\x1a\n"))
                })
                .map(|i| {
                    if i.starts_with("data:") {
                        i
                    } else {
                        format!("data:image/png;base64,{i}")
                    }
                });
            v
        })
        .collect())
}
#[tauri::command]
pub async fn instance_servers(
    id: String,
    state: State<'_, Arc<Shared>>,
) -> Result<Vec<Server>, String> {
    let root = PathBuf::from(state.settings.lock().unwrap().root.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let base = ui_data::resource_dir(&root, &id, "server")?;
        let path = base.join("servers.dat");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        if !path.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
            return Err("服务器列表超出游戏目录".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("服务器列表过大".into());
        }
        if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut data = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut data)
                .map_err(|e| e.to_string())?;
            if data.len() > 8 * 1024 * 1024 {
                return Err("服务器列表过大".into());
            }
            decode_servers(&data)
        } else {
            decode_servers(&bytes)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_nbt_preserves_names_and_discards_external_icon() {
        #[derive(Serialize)]
        struct Fixture {
            servers: Vec<Server>,
        }
        let bytes = fastnbt::to_bytes(&Fixture {
            servers: vec![Server {
                name: "Fixture Server".into(),
                ip: "localhost:25565".into(),
                icon: Some("https://example.com/icon.png".into()),
            }],
        })
        .unwrap();
        let rows = decode_servers(&bytes).unwrap();
        assert_eq!(rows[0].name, "Fixture Server");
        assert_eq!(rows[0].ip, "localhost:25565");
        assert!(rows[0].icon.is_none());
        assert!(decode_servers(b"invalid").is_err());
    }
    #[test]
    fn neoforge_versions_keep_game_patch_separate_from_build() {
        assert_eq!(neoforge_game("21.1.234").as_deref(), Some("1.21.1"));
        assert_eq!(neoforge_game("26.1.0.16-beta").as_deref(), Some("26.1"));
        assert_eq!(neoforge_game("26.1.2.1-beta").as_deref(), Some("26.1.2"));
        assert_eq!(
            neoforge_game("0.25w14craftmine.5-beta").as_deref(),
            Some("25w14craftmine")
        );
        assert!(neoforge_game("bad").is_none());
    }
}
