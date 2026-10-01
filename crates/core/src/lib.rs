//! Native launch planning for installed Mojang-format instances.
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    pub id: String,
    pub minecraft_version: String,
    pub loader: String,
    pub java_major: u32,
    pub mod_count: usize,
    pub isolated: bool,
}
pub struct LaunchPlan {
    pub java: PathBuf,
    pub args: Vec<String>,
    pub game_dir: PathBuf,
    pub log_path: PathBuf,
    pub version: String,
    secret_token: Option<String>,
}
/// Verified Minecraft identity supplied by the authentication layer.
/// Never expose this value through Debug or serialization.
pub struct OnlineIdentity {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    pub xuid: String,
    pub client_id: String,
}
#[derive(Debug, Serialize)]
struct PublicLaunchPlan<'a> {
    java: &'a Path,
    args: Vec<String>,
    game_dir: &'a Path,
    log_path: &'a Path,
    version: &'a str,
}
impl LaunchPlan {
    fn public_view(&self) -> PublicLaunchPlan<'_> {
        let args = self
            .args
            .iter()
            .map(|arg| match self.secret_token.as_deref() {
                Some(token) if !token.is_empty() => arg.replace(token, "<redacted>"),
                _ => arg.clone(),
            })
            .collect();
        PublicLaunchPlan {
            java: &self.java,
            args,
            game_dir: &self.game_dir,
            log_path: &self.log_path,
            version: &self.version,
        }
    }
}
impl Serialize for LaunchPlan {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        self.public_view().serialize(serializer)
    }
}
impl std::fmt::Debug for LaunchPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.public_view().fmt(f)
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn identifier(id: &str) -> Result<()> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', ':', '\0']) {
        return Err(format!("Unsafe metadata identifier: {id:?}"));
    }
    Ok(())
}
/// Reject traversal and symlink escapes, including when only a parent already exists.
fn safe_join(base: &Path, relative: impl AsRef<Path>) -> Result<PathBuf> {
    let relative = relative.as_ref();
    if relative.as_os_str().is_empty()
        || relative.to_string_lossy().contains(['\\', '\0'])
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("Unsafe metadata path: {}", relative.display()));
    }
    let result = base.join(relative);
    let canonical_base = fs::canonicalize(base).map_err(err)?;
    let mut existing = result.as_path();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or("Invalid metadata path")?
            }
            Err(e) => return Err(err(e)),
        }
    }
    if !fs::canonicalize(existing)
        .map_err(err)?
        .starts_with(canonical_base)
    {
        return Err(format!("Path escapes installation: {}", result.display()));
    }
    Ok(result)
}
fn read_json(path: &Path) -> Result<Value> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{}: {e}", path.display()))
}
fn library_key(v: &Value) -> String {
    let name = text(v, "name");
    let parts: Vec<_> = name.split(':').collect();
    // Version overrides preserve distinct platform classifiers.
    if parts.len() >= 3 {
        format!("{}:{}:{}", parts[0], parts[1], parts.get(3).unwrap_or(&""))
    } else {
        name.to_string()
    }
}
fn merge(mut base: Value, child: Value) -> Value {
    let mut libraries = base["libraries"].as_array().cloned().unwrap_or_default();
    for library in child["libraries"].as_array().into_iter().flatten() {
        let key = library_key(library);
        libraries.retain(|old| library_key(old) != key);
        libraries.push(library.clone());
    }
    let mut arguments = serde_json::Map::new();
    for key in ["game", "jvm"] {
        let mut list = base["arguments"][key]
            .as_array()
            .cloned()
            .unwrap_or_default();
        list.extend(
            child["arguments"][key]
                .as_array()
                .into_iter()
                .flatten()
                .cloned(),
        );
        arguments.insert(key.into(), Value::Array(list));
    }
    let has_arguments = base.get("arguments").is_some() || child.get("arguments").is_some();
    for (k, v) in child.as_object().unwrap() {
        base[k] = v.clone();
    }
    base["libraries"] = libraries.into();
    if has_arguments {
        base["arguments"] = arguments.into();
    }
    base
}
fn metadata(root: &Path, id: &str, visiting: &mut HashSet<String>) -> Result<Value> {
    identifier(id)?;
    if visiting.len() >= 64 || !visiting.insert(id.to_owned()) {
        return Err(format!("Version inheritance cycle or depth limit at {id}"));
    }
    let path = safe_join(root, format!("versions/{id}/{id}.json"))?;
    let mut data = read_json(&path)?;
    if !data.is_object() {
        return Err(format!("Version metadata is not an object: {id}"));
    }
    if let Some(parent) = data.get("inheritsFrom").and_then(Value::as_str) {
        let base = metadata(root, parent, visiting)?;
        // A child may omit its client jar and reuse its parent's.
        if data.get("jar").is_none() {
            data["jar"] = if safe_join(root, format!("versions/{id}/{id}.jar"))?.is_file() {
                Value::String(id.into())
            } else {
                base.get("jar")
                    .cloned()
                    .unwrap_or(Value::String(parent.into()))
            };
        }
        data = merge(base, data);
    }
    visiting.remove(id);
    Ok(data)
}
fn isolated(root: &Path, id: &str) -> Result<bool> {
    let folder = safe_join(root, format!("versions/{id}"))?;
    Ok(["mods", "saves", "config", "options.txt"]
        .iter()
        .any(|name| folder.join(name).exists()))
}
fn required_java(data: &Value) -> u32 {
    data["javaVersion"]["majorVersion"].as_u64().unwrap_or(8) as u32
}
fn game_argument<'a>(data: &'a Value, flag: &str) -> Option<&'a str> {
    data["arguments"]["game"]
        .as_array()?
        .windows(2)
        .find(|pair| pair[0].as_str() == Some(flag))
        .and_then(|pair| pair[1].as_str())
}
fn loader_description(data: &Value) -> String {
    let coordinate_version = |coordinates: &[&str]| -> Option<&str> {
        data["libraries"].as_array()?.iter().find_map(|library| {
            let name = text(library, "name");
            coordinates.iter().find_map(|coordinate| {
                name.strip_prefix(coordinate)
                    .and_then(|tail| tail.strip_prefix(':'))
                    .and_then(|tail| tail.split(':').next())
                    .filter(|version| !version.is_empty())
            })
        })
    };
    // Prefer NeoForge's own identity even if its metadata includes Forge-derived dependencies.
    let (name, version) = if let Some(version) = coordinate_version(&["net.neoforged:neoforge"]) {
        ("NeoForge", Some(version))
    } else if let Some(version) = coordinate_version(&["net.neoforged:forge"]) {
        (
            "NeoForge",
            version.split_once('-').map(|(_, v)| v).or(Some(version)),
        )
    } else if let Some(version) = game_argument(data, "--fml.neoForgeVersion") {
        ("NeoForge", Some(version))
    } else if let Some(version) = game_argument(data, "--fml.forgeVersion") {
        ("Forge", Some(version))
    } else if let Some(version) =
        coordinate_version(&["net.minecraftforge:forge", "net.minecraftforge:fmlloader"])
    {
        (
            "Forge",
            version.split_once('-').map(|(_, v)| v).or(Some(version)),
        )
    } else if let Some(version) = coordinate_version(&["net.fabricmc:fabric-loader"]) {
        ("Fabric", Some(version))
    } else if let Some(version) = coordinate_version(&["org.quiltmc:quilt-loader"]) {
        ("Quilt", Some(version))
    } else {
        ("Vanilla", None)
    };
    match version {
        Some(version) => format!("{name} {version}"),
        None => name.into(),
    }
}
fn java_compatible(major: u32, required: u32, exact: bool) -> bool {
    if exact {
        major == required
    } else {
        major >= required
    }
}
pub fn scan_instances(root: &Path) -> Result<Vec<Instance>> {
    let root = fs::canonicalize(root).map_err(err)?;
    let versions = safe_join(&root, "versions")?;
    if !versions.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in fs::read_dir(versions).map_err(err)? {
        let entry = entry.map_err(err)?;
        let id = entry.file_name().to_string_lossy().into_owned();
        identifier(&id)?;
        if !safe_join(&root, format!("versions/{id}/{id}.json"))?.is_file() {
            continue;
        }
        let data = metadata(&root, &id, &mut HashSet::new())?;
        let loader = loader_description(&data);
        let isolated = isolated(&root, &id)?;
        let folder = if isolated {
            safe_join(&root, format!("versions/{id}"))?
        } else {
            root.clone()
        };
        let mods = safe_join(&folder, "mods")?;
        let mod_count = if mods.is_dir() {
            fs::read_dir(mods)
                .map_err(err)?
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path().is_file() && e.path().extension().is_some_and(|ext| ext == "jar")
                })
                .count()
        } else {
            0
        };
        let minecraft_version = data["arguments"]["game"]
            .as_array()
            .and_then(|args| {
                args.windows(2)
                    .find(|w| w[0].as_str() == Some("--fml.mcVersion"))
                    .and_then(|w| w[1].as_str())
            })
            .or_else(|| data["clientVersion"].as_str())
            .or_else(|| data["inheritsFrom"].as_str())
            .unwrap_or_else(|| text(&data, "id"))
            .to_string();
        result.push(Instance {
            id,
            minecraft_version,
            loader: loader.into(),
            java_major: required_java(&data),
            mod_count,
            isolated,
        });
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}
struct RuleContext {
    arch: &'static str,
    release: String,
}
impl RuleContext {
    fn current() -> Self {
        Self {
            arch: std::env::consts::ARCH,
            release: fs::read_to_string("/proc/sys/kernel/osrelease")
                .unwrap_or_default()
                .trim()
                .into(),
        }
    }
    fn matches(&self, rule: &Value) -> Result<bool> {
        let os = &rule["os"];
        if os["name"].as_str().is_some_and(|name| name != "linux") {
            return Ok(false);
        }
        for (field, value) in [("arch", self.arch), ("version", self.release.as_str())] {
            if let Some(pattern) = os[field].as_str() {
                let regex =
                    Regex::new(pattern).map_err(|e| format!("Invalid OS rule regex: {e}"))?;
                if !regex.is_match(value) {
                    return Ok(false);
                }
            }
        }
        // All feature flags are false for the ordinary offline launch mode.
        Ok(!rule["features"]
            .as_object()
            .into_iter()
            .flatten()
            .any(|(_, v)| v.as_bool().unwrap_or(true)))
    }
    fn allowed(&self, entry: &Value) -> Result<bool> {
        let Some(rules) = entry.get("rules").and_then(Value::as_array) else {
            return Ok(true);
        };
        let mut allow = false;
        for rule in rules {
            if self.matches(rule)? {
                allow = text(rule, "action") == "allow";
            }
        }
        Ok(allow)
    }
    fn library_allowed(&self, lib: &Value) -> Result<bool> {
        let name = text(lib, "name");
        if self.arch == "x86_64"
            && ["linux-aarch", "linux-arm"]
                .iter()
                .any(|s| name.contains(s))
        {
            return Ok(false);
        }
        if self.arch == "aarch64"
            && (name.contains("linux-x86") || name.ends_with(":natives-linux"))
        {
            return Ok(false);
        }
        self.allowed(lib)
    }
}
fn maven_path(name: &str) -> Result<String> {
    let (name, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let p: Vec<_> = name.split(':').collect();
    if !(3..=4).contains(&p.len()) {
        return Err(format!("Invalid Maven coordinate: {name}"));
    }
    for component in p.iter().chain(std::iter::once(&extension)) {
        identifier(component)?;
    }
    let classifier = p.get(3).map(|c| format!("-{c}")).unwrap_or_default();
    Ok(format!(
        "{}/{}/{}/{}-{}{classifier}.{extension}",
        p[0].replace('.', "/"),
        p[1],
        p[2],
        p[1],
        p[2]
    ))
}
fn library_path(root: &Path, artifact: &Value, name: &str) -> Result<PathBuf> {
    let relative = if let Some(p) = artifact["path"].as_str() {
        p.into()
    } else {
        maven_path(name)?
    };
    safe_join(root, format!("libraries/{relative}"))
}
fn extract_natives(archive: &Path, target: &Path, excludes: &[Value]) -> Result<()> {
    let file = fs::File::open(archive).map_err(err)?;
    let mut jar = zip::ZipArchive::new(file).map_err(|e| format!("{}: {e}", archive.display()))?;
    for i in 0..jar.len() {
        let mut entry = jar.by_index(i).map_err(err)?;
        if excludes
            .iter()
            .filter_map(Value::as_str)
            .any(|prefix| entry.name().starts_with(prefix))
        {
            continue;
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe native archive entry: {}", entry.name()))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            continue;
        }
        let Some(name) = enclosed.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        let shared_object = name.ends_with(".so")
            || name.split_once(".so.").is_some_and(|(_, suffix)| {
                !suffix.is_empty()
                    && suffix
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            });
        if !shared_object {
            continue;
        }
        if entry.size() > 256 * 1024 * 1024 {
            return Err("Native archive entry exceeds 256 MiB".into());
        }
        let path = safe_join(target, name)?;
        // Never truncate an inode that a running JVM may have mmap'ed. Each
        // concurrent plan writes a unique same-directory file and atomically
        // replaces the directory entry only after extraction succeeds. Existing
        // mappings keep their complete old inode; failed copies clean up on drop.
        let mut output = tempfile::NamedTempFile::new_in(target).map_err(err)?;
        std::io::copy(&mut entry, &mut output).map_err(err)?;
        output.persist(&path).map_err(err)?;
    }
    Ok(())
}
fn java_major(path: &Path) -> Option<u32> {
    let mut child = Command::new(path)
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
        if start.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Regex::new(r#"version "(?:1\.)?(\d+)"#)
        .ok()?
        .captures(&text)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}
fn choose_java(project: &Path, required: u32, exact: bool) -> Result<PathBuf> {
    let mut candidates = vec![];
    for base in [project.to_path_buf(), project.join("PCL-Linux")] {
        for runtime in ["runtime", "runtime-21", "runtime-25"] {
            candidates.push(base.join(runtime).join("bin/java"));
        }
    }
    if let Some(path) = std::env::var_os("JAVA_HOME") {
        candidates.push(PathBuf::from(path).join("bin/java"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join("java")));
    }
    if let Ok(entries) = fs::read_dir("/usr/lib/jvm") {
        candidates.extend(
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path().join("bin/java")),
        );
    }
    let mut seen = HashSet::new();
    let mut suitable = vec![];
    for path in candidates {
        if let Ok(path) = fs::canonicalize(path) {
            if seen.insert(path.clone()) {
                if let Some(major) = java_major(&path) {
                    if java_compatible(major, required, exact) {
                        suitable.push((major, path));
                    }
                }
            }
        }
    }
    suitable.sort_by_key(|(major, _)| *major);
    suitable.into_iter().next().map(|(_,path)| path).ok_or_else(|| {
        let requirement = if exact { format!("Java {required} is required for this Forge/NeoForge instance; newer major releases are not selected automatically") } else { format!("Java {required} or newer is required") };
        format!("{requirement}. Put a matching runtime in the project or set JAVA_HOME.")
    })
}
fn expand(
    raw: &[Value],
    replacements: &BTreeMap<&str, String>,
    context: &RuleContext,
) -> Result<Vec<String>> {
    let mut result = vec![];
    for entry in raw {
        let value = if entry.is_object() {
            if !context.allowed(entry)? {
                continue;
            }
            &entry["value"]
        } else {
            entry
        };
        let list = if let Some(list) = value.as_array() {
            list.clone()
        } else {
            vec![value.clone()]
        };
        for v in list {
            let mut s = v.as_str().ok_or("Invalid argument metadata")?.to_string();
            for (key, value) in replacements {
                s = s.replace(&format!("${{{key}}}"), value);
            }
            if s.contains("${") {
                return Err(format!("Unsupported launch placeholder: {s}"));
            }
            result.push(s);
        }
    }
    Ok(result)
}
/// Complete metadata may repeat a jar through several library declarations.
/// Keep the first occurrence of each exact path, without collapsing different
/// versions/classifiers or changing module-related JVM arguments.
fn deduplicate_launch_paths(classpath: &mut Vec<PathBuf>, native_jars: &mut Vec<(PathBuf, Value)>) {
    let mut seen = HashSet::new();
    classpath.retain(|path| seen.insert(path.clone()));
    seen.clear();
    native_jars.retain(|(path, _)| seen.insert(path.clone()));
}

pub fn build_launch_plan(
    root: &Path,
    project: &Path,
    id: &str,
    player: &str,
    memory_gib: u32,
) -> Result<LaunchPlan> {
    build_launch_plan_inner(root, project, id, player, memory_gib, None)
}

pub fn build_launch_plan_authenticated(
    root: &Path,
    project: &Path,
    id: &str,
    identity: &OnlineIdentity,
    memory_gib: u32,
) -> Result<LaunchPlan> {
    if identity.uuid.len() != 32
        || !identity.uuid.chars().all(|c| c.is_ascii_hexdigit())
        || identity.access_token.is_empty()
        || identity.client_id.is_empty()
        || !identity.xuid.chars().all(|c| c.is_ascii_digit())
    {
        return Err("Invalid authenticated Minecraft identity".into());
    }
    build_launch_plan_inner(
        root,
        project,
        id,
        &identity.name,
        memory_gib,
        Some(identity),
    )
    .map_err(|error| error.replace(&identity.access_token, "<redacted>"))
}
fn build_launch_plan_inner(
    root: &Path,
    project: &Path,
    id: &str,
    player: &str,
    memory_gib: u32,
    online: Option<&OnlineIdentity>,
) -> Result<LaunchPlan> {
    identifier(id)?;
    if !Regex::new(r"^[A-Za-z0-9_]{3,16}$")
        .unwrap()
        .is_match(player)
    {
        return Err(
            "Offline player name must contain 3–16 ASCII letters, digits or underscores".into(),
        );
    }
    if !(2..=64).contains(&memory_gib) {
        return Err("Memory must be between 2 and 64 GiB".into());
    }
    let root = fs::canonicalize(root).map_err(err)?;
    let data = metadata(&root, id, &mut HashSet::new())?;
    let context = RuleContext::current();
    let mut classpath = vec![];
    let mut native_jars = vec![];
    let mut missing = vec![];
    for lib in data["libraries"].as_array().into_iter().flatten() {
        if !context.library_allowed(lib)? {
            continue;
        }
        let name = text(lib, "name");
        let artifact = &lib["downloads"]["artifact"];
        if !artifact.is_null() || lib.get("downloads").is_none() {
            let path = library_path(&root, artifact, name)?;
            if !path.is_file() {
                missing.push(path.display().to_string());
            } else {
                // Modern native artifacts remain on the classpath as well as being extracted.
                classpath.push(path.clone());
                if name.contains("natives-linux")
                    || name.contains("linux-x86_64")
                    || name.contains("linux-aarch_64")
                {
                    native_jars.push((path, lib.clone()));
                }
            }
        }
        if let Some(classifier) = lib["natives"]["linux"].as_str() {
            let classifier = classifier.replace(
                "${arch}",
                if cfg!(target_pointer_width = "64") {
                    "64"
                } else {
                    "32"
                },
            );
            let native = &lib["downloads"]["classifiers"][&classifier];
            let path = library_path(&root, native, &format!("{name}:{classifier}"))?;
            if !path.is_file() {
                missing.push(path.display().to_string());
            } else {
                native_jars.push((path, lib.clone()));
            }
        }
    }
    let jar_id = data["jar"].as_str().unwrap_or(id);
    identifier(jar_id)?;
    let jar = safe_join(&root, format!("versions/{jar_id}/{jar_id}.jar"))?;
    if jar.is_file() {
        classpath.push(jar);
    } else {
        missing.push(jar.display().to_string());
    }
    deduplicate_launch_paths(&mut classpath, &mut native_jars);
    let asset_id = data["assetIndex"]["id"]
        .as_str()
        .or_else(|| data["assets"].as_str())
        .unwrap_or("");
    if !asset_id.is_empty() {
        identifier(asset_id)?;
        let index = safe_join(&root, format!("assets/indexes/{asset_id}.json"))?;
        if !index.is_file() {
            missing.push(index.display().to_string());
        } else {
            let index_data = read_json(&index)?;
            for object in index_data["objects"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, v)| v)
            {
                let hash = text(object, "hash");
                if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Invalid asset object hash".into());
                }
                let object_path =
                    safe_join(&root, format!("assets/objects/{}/{}", &hash[..2], hash))?;
                if !object_path.is_file() {
                    missing.push(object_path.display().to_string());
                }
            }
        }
    }
    let logging = &data["logging"]["client"];
    let log_config = if let Some(log_id) = logging["file"]["id"].as_str() {
        identifier(log_id)?;
        let path = safe_join(&root, format!("assets/log_configs/{log_id}"))?;
        if !path.is_file() {
            missing.push(path.display().to_string());
        }
        Some(path)
    } else {
        None
    };
    if !missing.is_empty() {
        return Err(format!(
            "Missing {} installed dependencies (downloads are not available in phase 1):\n{}{}",
            missing.len(),
            missing
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n"),
            if missing.len() > 12 { "\n…" } else { "" }
        ));
    }
    let loader = loader_description(&data);
    let exact_java = loader.starts_with("Forge ") || loader.starts_with("NeoForge ");
    let java = choose_java(project, required_java(&data), exact_java)?;
    let natives = safe_join(&root, format!(".pcl-linux/natives/{id}"))?;
    fs::create_dir_all(&natives).map_err(err)?;
    for (path, lib) in native_jars {
        extract_natives(
            &path,
            &natives,
            lib["extract"]["exclude"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )?;
    }
    let game_dir = if isolated(&root, id)? {
        safe_join(&root, format!("versions/{id}"))?
    } else {
        root.clone()
    };
    let mut uuid = md5::compute(format!("OfflinePlayer:{player}")).0;
    uuid[6] = (uuid[6] & 0x0f) | 0x30;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    let uuid = uuid.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut replacements = BTreeMap::from([
        ("auth_player_name", player.into()),
        ("version_name", id.into()),
        ("game_directory", game_dir.display().to_string()),
        ("assets_root", root.join("assets").display().to_string()),
        ("assets_index_name", asset_id.into()),
        ("auth_uuid", uuid),
        ("auth_access_token", "0".into()),
        ("clientid", "0".into()),
        ("auth_xuid", "0".into()),
        ("user_type", "legacy".into()),
        ("user_properties", "{}".into()),
        ("auth_session", "0".into()),
        (
            "version_type",
            data["type"].as_str().unwrap_or("release").into(),
        ),
        ("natives_directory", natives.display().to_string()),
        ("launcher_name", "PCL-Linux".into()),
        ("launcher_version", "0.1.0".into()),
        (
            "classpath",
            classpath
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(":"),
        ),
        ("classpath_separator", ":".into()),
        (
            "library_directory",
            root.join("libraries").display().to_string(),
        ),
    ]);
    replacements.insert(
        "game_assets",
        root.join("assets/virtual/legacy").display().to_string(),
    );
    if let Some(identity) = online {
        replacements.insert("auth_uuid", identity.uuid.clone());
        replacements.insert("auth_access_token", identity.access_token.clone());
        replacements.insert("clientid", identity.client_id.clone());
        replacements.insert("client_id", identity.client_id.clone());
        replacements.insert("auth_xuid", identity.xuid.clone());
        replacements.insert("user_type", "msa".into());
        replacements.insert(
            "auth_session",
            format!("token:{}:{}", identity.access_token, identity.uuid),
        );
    }
    let raw_game = data["arguments"]["game"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            text(&data, "minecraftArguments")
                .split_whitespace()
                .map(|s| Value::String(s.into()))
                .collect()
        });
    let raw_jvm = data["arguments"]["jvm"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            vec![
                "-Djava.library.path=${natives_directory}".into(),
                "-cp".into(),
                "${classpath}".into(),
            ]
        });
    let mut args = vec![format!("-Xmx{memory_gib}G")];
    args.extend(expand(&raw_jvm, &replacements, &context)?);
    if let Some(path) = log_config {
        args.push(text(logging, "argument").replace("${path}", &path.display().to_string()));
    }
    let main = text(&data, "mainClass");
    if main.is_empty() {
        return Err("Version has no mainClass".into());
    }
    args.push(main.into());
    args.extend(expand(&raw_game, &replacements, &context)?);
    let log_path = safe_join(&root, format!(".pcl-linux/logs/{id}.log"))?;
    Ok(LaunchPlan {
        java,
        args,
        game_dir,
        log_path,
        version: id.into(),
        secret_token: online.map(|identity| identity.access_token.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn repeated_gson_and_native_paths_keep_first_order_and_distinct_versions() {
        let gson = PathBuf::from("libraries/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar");
        let older_gson = PathBuf::from("libraries/com/google/code/gson/gson/2.10/gson-2.10.jar");
        let native = PathBuf::from("libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar");
        let second_native = PathBuf::from(
            "libraries/org/lwjgl/lwjgl-glfw/3.3.3/lwjgl-glfw-3.3.3-natives-linux.jar",
        );
        let client = PathBuf::from("versions/Example Instance/Example Instance.jar");
        let expected = vec![
            gson.clone(),
            native.clone(),
            older_gson.clone(),
            client.clone(),
        ];
        let mut classpath = vec![
            gson.clone(),
            native.clone(),
            gson,
            older_gson,
            native.clone(),
            client,
        ];
        let first_metadata = json!({"extract":{"exclude":["META-INF/"]}});
        let mut natives = vec![
            (native.clone(), first_metadata.clone()),
            (second_native.clone(), json!({})),
            (native.clone(), json!({"duplicate":true})),
        ];
        deduplicate_launch_paths(&mut classpath, &mut natives);
        assert_eq!(classpath, expected);
        assert_eq!(
            natives,
            vec![(native, first_metadata), (second_native, json!({}))]
        );
    }
    #[test]
    fn loader_versions_use_concrete_metadata() {
        assert_eq!(
            loader_description(&json!({"arguments":{"game":["--fml.forgeVersion","47.4.18"]}})),
            "Forge 47.4.18"
        );
        assert_eq!(
            loader_description(
                &json!({"libraries":[{"name":"net.minecraftforge:fmlloader:1.20.1-47.3.0"}]})
            ),
            "Forge 47.3.0"
        );
        assert_eq!(
            loader_description(
                &json!({"libraries":[{"name":"net.fabricmc:fabric-loader:0.16.0"}]})
            ),
            "Fabric 0.16.0"
        );
        assert_eq!(
            loader_description(
                &json!({"libraries":[{"name":"net.neoforged:neoforge:21.1.1"},{"name":"net.minecraftforge:fmlloader:1.20.1-47.3.0"}]})
            ),
            "NeoForge 21.1.1"
        );
        assert_eq!(
            loader_description(
                &json!({"libraries":[{"name":"net.minecraftforge:mergetool:1.1.1"}]})
            ),
            "Vanilla"
        );
    }
    #[test]
    fn forge_java_policy_rejects_newer_major() {
        assert!(java_compatible(17, 17, true));
        assert!(!java_compatible(25, 17, true));
        assert!(!java_compatible(8, 17, true));
        assert!(java_compatible(25, 17, false));
    }
    #[test]
    fn rules_obey_order_os_and_false_features() {
        let context = RuleContext {
            arch: "x86_64",
            release: "6.8.0".into(),
        };
        assert!(context.allowed(&json!({})).unwrap());
        assert!(!context.allowed(&json!({"rules":[]})).unwrap());
        assert!(context.allowed(&json!({"rules":[{"action":"allow","os":{"name":"linux","arch":"x86_64","version":"^6"}}]})).unwrap());
        assert!(!context
            .allowed(
                &json!({"rules":[{"action":"allow"},{"action":"disallow","os":{"name":"linux"}}]})
            )
            .unwrap());
        assert!(!context
            .allowed(&json!({"rules":[{"action":"allow","features":{"is_demo_user":true}}]}))
            .unwrap());
        assert!(context
            .allowed(&json!({"rules":[{"action":"allow","features":{"is_demo_user":false}}]}))
            .unwrap());
        assert!(!context
            .library_allowed(&json!({"name":"x:y:1:natives-linux-arm64"}))
            .unwrap());
    }
    #[test]
    fn child_replaces_library_version_but_keeps_classifiers() {
        let merged = merge(
            json!({"libraries":[{"name":"a:b:1"},{"name":"a:b:1:natives-linux"}],"arguments":{"game":["base"]}}),
            json!({"libraries":[{"name":"a:b:2"}],"arguments":{"game":["child"]}}),
        );
        assert_eq!(
            merged["libraries"],
            json!([{"name":"a:b:1:natives-linux"},{"name":"a:b:2"}])
        );
        assert_eq!(merged["arguments"]["game"], json!(["base", "child"]));
    }
    #[test]
    fn traversal_and_symlink_escape_rejected() {
        let root = tempfile::tempdir().unwrap();
        for relative in ["../outside", "/absolute", "x/../../outside", "x\\y"] {
            assert!(safe_join(root.path(), relative).is_err());
        }
        for id in ["../x", "..", "/tmp/a", "a\\b"] {
            assert!(identifier(id).is_err());
        }
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(safe_join(root.path(), "escape/file").is_err());
        assert!(safe_join(root.path(), "new/nested/file").is_ok());
    }
    #[test]
    fn inheritance_cycle_is_reported() {
        let root = tempfile::tempdir().unwrap();
        for (id, parent) in [("a", "b"), ("b", "a")] {
            let folder = root.path().join("versions").join(id);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join(format!("{id}.json")),
                json!({"id":id,"inheritsFrom":parent}).to_string(),
            )
            .unwrap();
        }
        assert!(metadata(root.path(), "a", &mut HashSet::new())
            .unwrap_err()
            .contains("cycle"));
    }
    #[test]
    fn inherited_client_jar_is_selected() {
        let root = tempfile::tempdir().unwrap();
        for (id, data) in [
            ("base", json!({"id":"base","mainClass":"Main"})),
            ("child", json!({"id":"child","inheritsFrom":"base"})),
        ] {
            let folder = root.path().join("versions").join(id);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join(format!("{id}.json")), data.to_string()).unwrap();
        }
        fs::write(root.path().join("versions/base/base.jar"), "").unwrap();
        assert_eq!(
            metadata(root.path(), "child", &mut HashSet::new()).unwrap()["jar"],
            "base"
        );
    }
    #[test]
    fn modern_nested_natives_are_flattened() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("native.jar");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        zip.start_file(
            "linux/x64/liblwjgl.so",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"native").unwrap();
        zip.start_file("META-INF/no.so", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"excluded").unwrap();
        zip.start_file(
            "linux/x64/liblwjgl.so.sha1",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"not a shared library").unwrap();
        zip.finish().unwrap();
        let target = root.path().join("natives");
        fs::create_dir(&target).unwrap();
        let library = target.join("liblwjgl.so");
        fs::write(&library, b"old native library still used by a JVM").unwrap();
        let mut old_handle = fs::File::open(&library).unwrap();
        use std::os::unix::fs::MetadataExt;
        let old_inode = old_handle.metadata().unwrap().ino();
        extract_natives(&archive, &target, &[json!("META-INF/")]).unwrap();
        assert_eq!(fs::read(&library).unwrap(), b"native");
        assert_ne!(fs::metadata(&library).unwrap().ino(), old_inode);
        let mut old_contents = Vec::new();
        std::io::Read::read_to_end(&mut old_handle, &mut old_contents).unwrap();
        assert_eq!(old_contents, b"old native library still used by a JVM");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
        assert!(!target.join("no.so").exists());
        assert!(!target.join("liblwjgl.so.sha1").exists());
    }
    #[cfg(unix)]
    #[test]
    fn authenticated_fixture_has_real_process_arguments_but_safe_output() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("minecraft");
        let version = root.join("versions/fixture");
        fs::create_dir_all(&version).unwrap();
        let java = fixture.path().join("runtime/bin/java");
        fs::create_dir_all(java.parent().unwrap()).unwrap();
        fs::write(
            &java,
            "#!/bin/sh\nprintf 'openjdk version \"21.0.1\"\\n' >&2\n",
        )
        .unwrap();
        fs::set_permissions(&java, fs::Permissions::from_mode(0o755)).unwrap();
        let arguments = json!([
            "--username",
            "${auth_player_name}",
            "--uuid",
            "${auth_uuid}",
            "--accessToken",
            "${auth_access_token}",
            "--userType",
            "${user_type}",
            "--xuid",
            "${auth_xuid}",
            "--clientId",
            "${clientid}",
            "--session",
            "${auth_session}",
            "--embedded=prefix:${auth_access_token}:suffix"
        ]);
        fs::write(version.join("fixture.json"), json!({"id":"fixture","mainClass":"Main","javaVersion":{"majorVersion":21},"arguments":{"game":arguments,"jvm":[]},"libraries":[]}).to_string()).unwrap();
        fs::write(version.join("fixture.jar"), "").unwrap();
        let identity = OnlineIdentity {
            name: "RealPlayer".into(),
            uuid: "1234567890abcdef1234567890abcdef".into(),
            access_token: "mc-token-secret".into(),
            xuid: "12345".into(),
            client_id: "project-client".into(),
        };
        let online =
            build_launch_plan_authenticated(&root, fixture.path(), "fixture", &identity, 4)
                .unwrap();
        for expected in [
            "RealPlayer",
            &identity.uuid,
            &identity.access_token,
            "msa",
            "12345",
            "project-client",
            &format!("token:{}:{}", identity.access_token, identity.uuid),
        ] {
            assert!(online.args.iter().any(|arg| arg == expected));
        }
        assert!(online
            .args
            .contains(&"--embedded=prefix:mc-token-secret:suffix".into()));
        assert!(!serde_json::to_string(&online)
            .unwrap()
            .contains(&identity.access_token));
        assert!(!format!("{online:?}").contains(&identity.access_token));
        let offline =
            build_launch_plan(&root, fixture.path(), "fixture", "OfflinePlayer", 4).unwrap();
        assert!(offline.args.contains(&"legacy".into()));
        assert!(offline.args.contains(&"0".into()));
        assert!(!offline.args.contains(&"msa".into()));
        let json = serde_json::to_value(&offline).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 5);
        assert_eq!(json["args"], serde_json::to_value(&offline.args).unwrap());
        // Even errors caused by mixed known and unknown placeholders must be safe.
        fs::write(version.join("fixture.json"), json!({"id":"fixture","mainClass":"Main","arguments":{"game":["${auth_access_token}-${unknown}"],"jvm":[]},"libraries":[]}).to_string()).unwrap();
        let error = build_launch_plan_authenticated(&root, fixture.path(), "fixture", &identity, 4)
            .unwrap_err();
        assert!(!error.contains(&identity.access_token));
    }
}
