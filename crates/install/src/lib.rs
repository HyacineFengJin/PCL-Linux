//! Verified installation of versions from Mojang's official catalog.
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
type Result<T> = std::result::Result<T, String>;
const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MAX_METADATA: u64 = 32 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub id: String,
    #[serde(rename(deserialize = "type"))]
    pub kind: String,
    #[serde(rename(deserialize = "releaseTime"))]
    pub release_time: String,
}
#[derive(Clone, Serialize)]
pub struct Progress {
    pub stage: String,
    pub message: String,
    pub completed: u64,
    pub total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}
#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub id: String,
    pub java_major: u32,
    pub files_downloaded: u64,
    pub files_reused: u64,
}
pub struct Installer {
    client: Client,
    #[cfg(test)]
    endpoint: Option<String>,
}
#[derive(Clone)]
struct Download {
    url: String,
    hash: String,
    size: u64,
    relative: String,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn network_error(e: reqwest::Error) -> String {
    use std::error::Error;
    let e = e.without_url();
    let mut details = e.to_string();
    let mut source = e.source();
    for _ in 0..8 {
        let Some(reason) = source else {
            break;
        };
        details.push_str(": ");
        details.push_str(&reason.to_string());
        source = reason.source();
    }
    details
}
fn retry_wait(cancel: &AtomicBool, attempt: u32) -> Result<()> {
    for _ in 0..attempt * 10 {
        check(cancel)?;
        std::thread::sleep(Duration::from_millis(100));
    }
    check(cancel)
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("安装已取消".into())
    } else {
        Ok(())
    }
}
fn hash_valid(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|c| c.is_ascii_hexdigit())
}
fn verify(path: &Path, hash: &str, size: u64, cancel: &AtomicBool) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut f = fs::File::open(path).map_err(error)?;
    if f.metadata().map_err(error)?.len() != size {
        return Ok(false);
    }
    let mut digest = Sha1::new();
    let mut buf = [0; 65536];
    loop {
        check(cancel)?;
        let n = f.read(&mut buf).map_err(error)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(format!("{:x}", digest.finalize()).eq_ignore_ascii_case(hash))
}
impl Installer {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(error)?,
            #[cfg(test)]
            endpoint: None,
        })
    }
    fn manifest_url(&self) -> &str {
        #[cfg(test)]
        if let Some(url) = &self.endpoint {
            return url;
        }
        MANIFEST
    }
    fn url(&self, raw: &str) -> Result<Url> {
        let url = Url::parse(raw).map_err(error)?;
        #[cfg(test)]
        if self.endpoint.is_some() && url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
        {
            return Ok(url);
        }
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || !matches!(
                url.host_str(),
                Some(
                    "piston-meta.mojang.com"
                        | "piston-data.mojang.com"
                        | "launchermeta.mojang.com"
                        | "launcher.mojang.com"
                        | "libraries.minecraft.net"
                        | "resources.download.minecraft.net"
                )
            )
        {
            return Err("下载地址不是受信任的 Mojang 官方 HTTPS 地址".into());
        }
        Ok(url)
    }
    fn bytes(&self, raw_url: &str, limit: u64, cancel: &AtomicBool) -> Result<Vec<u8>> {
        let url = self.url(raw_url)?;
        let host = url.host_str().unwrap_or("官方服务器").to_owned();
        let mut last = String::new();
        for attempt in 0..3 {
            check(cancel)?;
            if attempt > 0 {
                retry_wait(cancel, attempt)?;
            }
            let mut response = match self.client.get(url.clone()).send() {
                Ok(response) => response,
                Err(e) => {
                    last = format!("读取 {host} 的版本信息失败：{}", network_error(e));
                    continue;
                }
            };
            let status = response.status();
            if !status.is_success() {
                last = format!("读取 {host} 的版本信息失败：HTTP {status}");
                if !status.is_server_error() && status.as_u16() != 429 {
                    return Err(last);
                }
                continue;
            }
            let mut out = Vec::new();
            let mut buf = [0; 65536];
            let body = (|| {
                loop {
                    check(cancel)?;
                    let n = response
                        .read(&mut buf)
                        .map_err(|e| format!("读取 {host} 的版本信息中断：{e}"))?;
                    if n == 0 {
                        break;
                    }
                    if out.len() as u64 + n as u64 > limit {
                        return Err("版本信息超过允许的大小".into());
                    }
                    out.extend_from_slice(&buf[..n]);
                }
                Ok(())
            })();
            match body {
                Ok(()) => return Ok(out),
                Err(e) if e == "版本信息超过允许的大小" => return Err(e),
                Err(e) => {
                    check(cancel)?;
                    last = e;
                }
            }
        }
        Err(format!("{last}（已尝试 3 次，请检查网络后重试）"))
    }
    fn manifest(&self, cancel: &AtomicBool) -> Result<Value> {
        serde_json::from_slice(&self.bytes(self.manifest_url(), MAX_METADATA, cancel)?)
            .map_err(error)
    }
    pub fn catalog(&self) -> Result<Vec<VersionEntry>> {
        let data = self.manifest(&AtomicBool::new(false))?;
        serde_json::from_value(data["versions"].clone()).map_err(error)
    }
    fn download(
        &self,
        root: &Path,
        d: &Download,
        cancel: &AtomicBool,
        done: &AtomicU64,
        total: u64,
        bytes: &AtomicU64,
        byte_total: u64,
        cb: &(impl Fn(Progress) + Send + Sync),
    ) -> Result<bool> {
        check(cancel)?;
        let path = pcl_core::safe_join(root, &d.relative)?;
        if verify(&path, &d.hash, d.size, cancel)? {
            done.fetch_add(1, Ordering::Relaxed);
            bytes.fetch_add(d.size, Ordering::Relaxed);
            cb(Progress {
                stage: "downloading".into(),
                message: "正在校验已安装文件".into(),
                completed: done.load(Ordering::Relaxed),
                total,
                bytes_done: bytes.load(Ordering::Relaxed),
                bytes_total: byte_total,
            });
            return Ok(false);
        }
        let url = self.url(&d.url)?;
        fs::create_dir_all(path.parent().ok_or("下载文件路径无效")?).map_err(error)?;
        let path = pcl_core::safe_join(root, &d.relative)?;
        let mut last = String::new();
        for _ in 0..3 {
            check(cancel)?;
            let mut transferred = 0;
            let result = (|| {
                let mut response = self
                    .client
                    .get(url.clone())
                    .send()
                    .map_err(network_error)?
                    .error_for_status()
                    .map_err(network_error)?;
                let mut file =
                    tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(error)?;
                let mut digest = Sha1::new();
                let mut buf = [0; 65536];
                loop {
                    check(cancel)?;
                    let n = response.read(&mut buf).map_err(error)?;
                    if n == 0 {
                        break;
                    }
                    if transferred + n as u64 > d.size {
                        return Err("下载文件超过官方声明的大小".into());
                    }
                    file.write_all(&buf[..n]).map_err(error)?;
                    transferred += n as u64;
                    digest.update(&buf[..n]);
                    bytes.fetch_add(n as u64, Ordering::Relaxed);
                    cb(Progress {
                        stage: "downloading".into(),
                        message: download_message(&d.relative).into(),
                        completed: done.load(Ordering::Relaxed),
                        total,
                        bytes_done: bytes.load(Ordering::Relaxed),
                        bytes_total: byte_total,
                    });
                }
                if transferred != d.size
                    || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&d.hash)
                {
                    return Err(format!("文件 SHA1 或大小校验失败：{}", d.relative));
                }
                file.as_file().sync_all().map_err(error)?;
                pcl_core::safe_join(root, &d.relative)?;
                file.persist(&path).map_err(error)?;
                Ok(())
            })();
            match result {
                Ok(()) => {
                    done.fetch_add(1, Ordering::Relaxed);
                    cb(Progress {
                        stage: "downloading".into(),
                        message: download_message(&d.relative).into(),
                        completed: done.load(Ordering::Relaxed),
                        total,
                        bytes_done: bytes.load(Ordering::Relaxed),
                        bytes_total: byte_total,
                    });
                    return Ok(true);
                }
                Err(e) => {
                    bytes.fetch_sub(transferred.min(d.size), Ordering::Relaxed);
                    last = e;
                }
            }
        }
        Err(last)
    }
    pub fn install(
        &self,
        root: &Path,
        id: &str,
        cancel: &AtomicBool,
        on_progress: impl Fn(Progress) + Send + Sync,
    ) -> Result<InstallResult> {
        check(cancel)?;
        pcl_core::identifier(id)?;
        on_progress(Progress {
            stage: "metadata".into(),
            message: id.into(),
            completed: 0,
            total: 0,
            bytes_done: 0,
            bytes_total: 0,
        });
        let manifest = self.manifest(cancel)?;
        let entry = manifest["versions"]
            .as_array()
            .ok_or("Invalid catalog")?
            .iter()
            .find(|v| v["id"].as_str() == Some(id))
            .ok_or("所选版本不在 Mojang 官方版本目录中")?;
        let hash = entry["sha1"]
            .as_str()
            .filter(|h| hash_valid(h))
            .ok_or("Catalog lacks version SHA1")?;
        let raw = self.bytes(
            entry["url"].as_str().ok_or("Catalog lacks URL")?,
            MAX_METADATA,
            cancel,
        )?;
        if !format!("{:x}", Sha1::digest(&raw)).eq_ignore_ascii_case(hash) {
            return Err("版本信息 SHA1 校验失败".into());
        }
        let metadata: Value = serde_json::from_slice(&raw).map_err(error)?;
        if metadata["id"].as_str() != Some(id) || metadata.get("inheritsFrom").is_some() {
            return Err("原版版本信息中的版本标识无效".into());
        }
        fs::create_dir_all(root).map_err(error)?;
        let root = fs::canonicalize(root).map_err(error)?;
        let version = pcl_core::safe_join(&root, format!("versions/{id}"))?;
        if version.exists() {
            return Err("该版本目录已存在，请选择其他版本或安装目录".into());
        }
        let versions = pcl_core::safe_join(&root, "versions")?;
        fs::create_dir_all(&versions).map_err(error)?;
        let temporary = tempfile::Builder::new()
            .prefix(".install-")
            .tempdir_in(&versions)
            .map_err(error)?;
        let temp_relative = temporary
            .path()
            .strip_prefix(&root)
            .map_err(error)?
            .to_string_lossy()
            .into_owned();
        let mut downloads = vec![artifact(
            &metadata["downloads"]["client"],
            format!("{temp_relative}/{id}.jar"),
        )?];
        let index_id = metadata["assetIndex"]["id"]
            .as_str()
            .ok_or("Version lacks asset index")?;
        pcl_core::identifier(index_id)?;
        let index = artifact(
            &metadata["assetIndex"],
            format!("assets/indexes/{index_id}.json"),
        )?;
        let index_raw = self.bytes(&index.url, MAX_METADATA, cancel)?;
        if index_raw.len() as u64 != index.size
            || !format!("{:x}", Sha1::digest(&index_raw)).eq_ignore_ascii_case(&index.hash)
        {
            return Err("资源索引 SHA1 或大小校验失败".into());
        }
        let asset_data: Value = serde_json::from_slice(&index_raw).map_err(error)?;
        if asset_data["virtual"].as_bool() == Some(true)
            || asset_data["map_to_resources"].as_bool() == Some(true)
        {
            return Err("暂不支持旧版本的虚拟资源或 resources 资源布局".into());
        }
        downloads.push(index);
        let mut natives = vec![];
        for lib in metadata["libraries"]
            .as_array()
            .ok_or("Version lacks libraries")?
        {
            if !pcl_core::library_allowed(lib)? {
                continue;
            }
            if lib.get("downloads").is_none() {
                return Err("暂不支持缺少官方校验信息的旧版本依赖库".into());
            }
            let art = &lib["downloads"]["artifact"];
            if !art.is_null() {
                let d = artifact(
                    art,
                    format!(
                        "libraries/{}",
                        art["path"].as_str().ok_or("Library lacks path")?
                    ),
                )?;
                if ["natives-linux", "linux-x86_64", "linux-aarch_64"]
                    .iter()
                    .any(|marker| lib["name"].as_str().unwrap_or("").contains(marker))
                {
                    natives.push((
                        d.relative.clone(),
                        lib["extract"]["exclude"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    ));
                }
                downloads.push(d);
            }
            if let Some(class) = lib["natives"]["linux"].as_str() {
                let class = class.replace(
                    "${arch}",
                    if cfg!(target_pointer_width = "64") {
                        "64"
                    } else {
                        "32"
                    },
                );
                let art = &lib["downloads"]["classifiers"][class];
                let d = artifact(
                    art,
                    format!(
                        "libraries/{}",
                        art["path"].as_str().ok_or("Native library lacks path")?
                    ),
                )?;
                natives.push((
                    d.relative.clone(),
                    lib["extract"]["exclude"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                ));
                downloads.push(d);
            }
        }
        if let Some(file) = metadata["logging"]["client"].get("file") {
            let name = file["id"].as_str().ok_or("Logging config lacks ID")?;
            pcl_core::identifier(name)?;
            downloads.push(artifact(file, format!("assets/log_configs/{name}"))?);
        }
        for obj in asset_data["objects"]
            .as_object()
            .ok_or("Invalid asset objects")?
            .values()
        {
            let hash = obj["hash"]
                .as_str()
                .filter(|h| hash_valid(h))
                .ok_or("Invalid asset hash")?;
            downloads.push(Download {
                url: format!(
                    "https://resources.download.minecraft.net/{}/{hash}",
                    &hash[..2]
                ),
                hash: hash.into(),
                size: obj["size"].as_u64().ok_or("Invalid asset size")?,
                relative: format!("assets/objects/{}/{hash}", &hash[..2]),
            });
        }
        let mut fingerprints = std::collections::HashMap::new();
        for d in &downloads {
            if let Some(previous) =
                fingerprints.insert(d.relative.clone(), (d.hash.clone(), d.size))
            {
                if previous != (d.hash.clone(), d.size) {
                    return Err("版本信息包含相互冲突的文件路径".into());
                }
            }
        }
        let mut seen = std::collections::HashMap::new();
        downloads.retain(|d| {
            if seen.contains_key(&d.relative) {
                false
            } else {
                seen.insert(d.relative.clone(), (d.hash.clone(), d.size));
                true
            }
        });
        for d in &downloads {
            self.url(&d.url)?;
            pcl_core::safe_join(&root, &d.relative)?;
        }
        let total = downloads.len() as u64;
        let byte_total = downloads
            .iter()
            .try_fold(0u64, |n, d| n.checked_add(d.size))
            .ok_or("下载文件总大小超出范围")?;
        let done = AtomicU64::new(0);
        let bytes = AtomicU64::new(0);
        let downloaded = AtomicU64::new(0);
        let next = AtomicU64::new(0);
        let failure = Mutex::new(None);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| loop {
                    if failure.lock().unwrap().is_some() {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed) as usize;
                    let Some(d) = downloads.get(i) else {
                        break;
                    };
                    match self.download(
                        &root,
                        d,
                        cancel,
                        &done,
                        total,
                        &bytes,
                        byte_total,
                        &on_progress,
                    ) {
                        Ok(true) => {
                            downloaded.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(false) => {}
                        Err(e) => {
                            *failure.lock().unwrap() = Some(e);
                            break;
                        }
                    }
                });
            }
        });
        if let Some(e) = failure.into_inner().map_err(error)? {
            return Err(e);
        }
        check(cancel)?;
        let native_dir = temporary.path().join("natives");
        fs::create_dir(&native_dir).map_err(error)?;
        for (path, excludes) in natives {
            check(cancel)?;
            pcl_core::extract_natives(&pcl_core::safe_join(&root, path)?, &native_dir, &excludes)?;
        }
        check(cancel)?;
        fs::write(temporary.path().join(format!("{id}.json")), raw).map_err(error)?;
        // An empty reservation prevents racing installers from replacing a completed version.
        pcl_core::safe_join(&root, format!("versions/{id}"))?;
        fs::create_dir(&version).map_err(|e| format!("无法创建版本目录（可能已存在）：{e}"))?;
        let publish = (|| {
            fs::rename(
                temporary.path().join(format!("{id}.jar")),
                version.join(format!("{id}.jar")),
            )
            .map_err(error)?;
            fs::rename(&native_dir, version.join("natives")).map_err(error)?;
            check(cancel)?;
            fs::rename(
                temporary.path().join(format!("{id}.json")),
                version.join(format!("{id}.json")),
            )
            .map_err(error)
        })();
        if let Err(e) = publish {
            let _ = fs::remove_dir_all(&version);
            return Err(e);
        }
        on_progress(Progress {
            stage: "complete".into(),
            message: id.into(),
            completed: total,
            total,
            bytes_done: byte_total,
            bytes_total: byte_total,
        });
        let count = downloaded.load(Ordering::Relaxed);
        Ok(InstallResult {
            id: id.into(),
            java_major: metadata["javaVersion"]["majorVersion"]
                .as_u64()
                .unwrap_or(8) as u32,
            files_downloaded: count,
            files_reused: total - count,
        })
    }
}
fn download_message(relative: &str) -> &'static str {
    if relative.starts_with("libraries/") {
        "正在下载游戏依赖库"
    } else if relative.starts_with("assets/log_configs/") {
        "正在下载日志配置"
    } else if relative.starts_with("assets/") {
        "正在下载游戏资源"
    } else {
        "正在下载游戏客户端"
    }
}
fn artifact(v: &Value, relative: String) -> Result<Download> {
    Ok(Download {
        url: v["url"].as_str().ok_or("Download lacks URL")?.into(),
        hash: v["sha1"]
            .as_str()
            .filter(|h| hash_valid(h))
            .ok_or("Download lacks valid SHA1")?
            .into(),
        size: v["size"].as_u64().ok_or("Download lacks size")?,
        relative,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::HashMap, net::TcpListener, sync::Arc, thread};
    struct Server {
        url: String,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    fn server(legacy: bool, bad_metadata: bool) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let desc = |path: &str, bytes: &[u8]| json!({"url":format!("{base}/{path}"),"size":bytes.len(),"sha1":format!("{:x}",Sha1::digest(bytes))});
        let index = serde_json::to_vec(&json!({"objects":{},"virtual":legacy})).unwrap();
        let mut index_desc = desc("index", &index);
        index_desc["id"] = json!("fixture-index");
        let mut lib = desc("library", b"library");
        lib["path"] = json!("org/example/library/1/library-1.jar");
        let mut log = desc("logging", b"logging");
        log["id"] = json!("client.xml");
        let metadata=serde_json::to_vec(&json!({"id":"fixture","javaVersion":{"majorVersion":21},"downloads":{"client":desc("client",b"client")},"assetIndex":index_desc,"libraries":[{"name":"org.example:library:1","downloads":{"artifact":lib}}],"logging":{"client":{"file":log}}})).unwrap();
        let catalog=serde_json::to_vec(&json!({"versions":[{"id":"fixture","type":"release","releaseTime":"2024-01-01T00:00:00Z","url":format!("{base}/metadata"),"sha1":if bad_metadata {"0000000000000000000000000000000000000000".into()} else {format!("{:x}",Sha1::digest(&metadata))}}]})).unwrap();
        let routes: HashMap<String, Vec<u8>> = [
            ("catalog", catalog),
            ("metadata", metadata),
            ("index", index),
            ("client", b"client".to_vec()),
            ("library", b"library".to_vec()),
            ("logging", b"logging".to_vec()),
        ]
        .into_iter()
        .map(|(p, b)| (format!("/{p}"), b))
        .collect();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut buf = [0; 4096];
                        let n = stream.read(&mut buf).unwrap_or(0);
                        let request = String::from_utf8_lossy(&buf[..n]);
                        let path = request.split_whitespace().nth(1).unwrap_or("");
                        if let Some(body) = routes.get(path) {
                            write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                            stream.write_all(body).unwrap();
                        } else {
                            stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                                .unwrap();
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("{e}"),
                }
            }
        });
        Server {
            url: format!("{base}/catalog"),
            stop,
            worker: Some(worker),
        }
    }
    fn installer(server: &Server) -> Installer {
        let mut i = Installer::new().unwrap();
        i.endpoint = Some(server.url.clone());
        i
    }
    #[test]
    fn empty_install_and_existing_version_are_safe() {
        let server = server(false, false);
        let i = installer(&server);
        let root = tempfile::tempdir().unwrap();
        let cancelled = AtomicBool::new(false);
        let progress = Mutex::new(vec![]);
        assert_eq!(i.catalog().unwrap()[0].id, "fixture");
        let result = i
            .install(root.path(), "fixture", &cancelled, |p| {
                progress.lock().unwrap().push(p)
            })
            .unwrap();
        assert_eq!(result.java_major, 21);
        assert_eq!(result.files_downloaded, 4);
        assert_eq!(
            fs::read(root.path().join("versions/fixture/fixture.jar")).unwrap(),
            b"client"
        );
        assert!(root.path().join("versions/fixture/fixture.json").exists());
        let entries = progress.into_inner().unwrap();
        assert!(entries
            .iter()
            .any(|p| p.stage == "downloading" && p.completed == p.total));
        assert!(entries
            .iter()
            .filter(|p| p.stage == "downloading")
            .all(|p| !p.message.contains('/')));
        let empty_root = tempfile::tempdir().unwrap();
        fs::create_dir_all(empty_root.path().join("versions/fixture")).unwrap();
        assert!(i
            .install(empty_root.path(), "fixture", &cancelled, |_| {})
            .unwrap_err()
            .contains("已存在"));
        assert_eq!(
            fs::read_dir(empty_root.path().join("versions/fixture"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            entries.last().unwrap().bytes_done,
            entries.last().unwrap().bytes_total
        );
        assert!(i
            .install(root.path(), "fixture", &cancelled, |_| {})
            .unwrap_err()
            .contains("已存在"));
        assert_eq!(
            fs::read(root.path().join("versions/fixture/fixture.jar")).unwrap(),
            b"client"
        );
    }
    #[test]
    fn cancellation_cleans_version_and_cached_files_are_verified() {
        let server = server(false, false);
        let i = installer(&server);
        let root = tempfile::tempdir().unwrap();
        let cancelled = AtomicBool::new(false);
        assert!(i
            .install(root.path(), "fixture", &cancelled, |p| {
                if p.stage == "downloading" {
                    cancelled.store(true, Ordering::Relaxed);
                }
            })
            .is_err());
        assert!(!root.path().join("versions/fixture").exists());
        assert_eq!(
            fs::read_dir(root.path().join("versions")).unwrap().count(),
            0
        );
        cancelled.store(false, Ordering::Relaxed);
        let library = root
            .path()
            .join("libraries/org/example/library/1/library-1.jar");
        fs::create_dir_all(library.parent().unwrap()).unwrap();
        fs::write(&library, b"corrupt").unwrap();
        i.install(root.path(), "fixture", &cancelled, |_| {})
            .unwrap();
        assert_eq!(fs::read(library).unwrap(), b"library");
    }
    #[test]
    fn rejects_unverified_metadata_legacy_and_symlink_escape() {
        for (legacy, bad, expected) in [(true, false, "暂不支持"), (false, true, "版本信息 SHA1")]
        {
            let server = server(legacy, bad);
            let root = tempfile::tempdir().unwrap();
            assert!(installer(&server)
                .install(root.path(), "fixture", &AtomicBool::new(false), |_| {})
                .unwrap_err()
                .contains(expected));
            assert!(!root.path().join("versions/fixture").exists());
        }
        let server = server(false, false);
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("libraries")).unwrap();
        assert!(installer(&server)
            .install(root.path(), "fixture", &AtomicBool::new(false), |_| {})
            .is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    #[test]
    fn metadata_retries_server_failures_and_reports_transport_reason() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/catalog", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            for status in ["503 Service Unavailable", "200 OK"] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0; 4096];
                stream.read(&mut buf).unwrap();
                let body = if status.starts_with("200") {
                    "{\"versions\":[]}"
                } else {
                    ""
                };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        let mut i = Installer::new().unwrap();
        i.endpoint = Some(url.clone());
        assert!(i.catalog().unwrap().is_empty());
        worker.join().unwrap();
        let err = i
            .client
            .get(format!("{url}?token=private-value"))
            .send()
            .unwrap_err();
        let message = network_error(err);
        assert!(message.contains("Connection refused") || message.contains("connect"));
        assert!(!message.contains("private-value"));
    }
    #[test]
    fn metadata_retry_wait_is_cancellable() {
        let cancelled = AtomicBool::new(false);
        let started = std::time::Instant::now();
        thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(30));
                cancelled.store(true, Ordering::Relaxed);
            });
            assert!(retry_wait(&cancelled, 2).unwrap_err().contains("取消"));
        });
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn rejects_urls_and_paths() {
        let i = Installer::new().unwrap();
        for url in [
            "http://libraries.minecraft.net/x",
            "https://example.org/x",
            "https://libraries.minecraft.net.evil.org/x",
            "https://user@libraries.minecraft.net/x",
            "https://libraries.minecraft.net:8443/x",
        ] {
            assert!(i.url(url).is_err(), "{url}");
        }
        assert!(i.url("https://libraries.minecraft.net/x").is_ok());
        assert!(artifact(
            &json!({"url":"https://libraries.minecraft.net/x","size":1,"sha1":"../bad"}),
            "x".into()
        )
        .is_err());
    }
}
