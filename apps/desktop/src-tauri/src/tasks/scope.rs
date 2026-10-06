//! Coordination footprints, not filesystem authorization. Commands still own
//! their validated descriptors and must recheck their captured target before
//! publication. Physical directory ancestry catches nested roots, symlink or
//! bind aliases; a final-file claim reserves its basename, not the whole folder.

use std::{
    fs,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const MAX_PATH_BYTES: usize = 4096;
const MAX_ANCESTORS: usize = 128;
const MAX_FILES: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    device: u64,
    inode: u64,
}
impl Key {
    fn of(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Ancestor {
    key: Key,
    relative: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Location {
    submitted: PathBuf,
    directory: bool,
    canonical: PathBuf,
    ancestors: Vec<Ancestor>,
    file_key: Option<Key>,
}

#[derive(Clone, Debug)]
enum Claims {
    Global,
    Paths(Vec<Location>),
}

#[derive(Clone, Debug)]
pub struct TaskScope {
    claims: Claims,
}

impl TaskScope {
    pub(super) fn is_global(&self) -> bool {
        matches!(self.claims, Claims::Global)
    }
    /// Conservative scope for existing synchronous/project-wide transactions.
    pub fn global() -> Self {
        Self {
            claims: Claims::Global,
        }
    }

    /// The command supplies a registered, currently available game directory.
    pub fn root(path: &Path) -> Result<Self> {
        Ok(Self {
            claims: Claims::Paths(vec![Location::capture(path, true)?]),
        })
    }

    /// Native selection already validated the existing parent descriptors. A
    /// missing final file is normal; an existing symlink/non-file is refused.
    pub fn files(paths: &[PathBuf]) -> Result<Self> {
        if paths.is_empty() || paths.len() > MAX_FILES {
            return Err("任务文件目标数量无效".into());
        }
        let mut locations = Vec::new();
        for path in paths {
            let location = Location::capture(path, false)?;
            if !locations.contains(&location) {
                locations.push(location);
            }
        }
        Ok(Self {
            claims: Claims::Paths(locations),
        })
    }

    pub(crate) fn conflicts(&self, other: &Self) -> bool {
        match (&self.claims, &other.claims) {
            (Claims::Global, _) | (_, Claims::Global) => true,
            (Claims::Paths(left), Claims::Paths(right)) => {
                left.iter().any(|a| right.iter().any(|b| a.conflicts(b)))
            }
        }
    }

    /// Waiting never silently adopts a different directory/file binding. This
    /// is outside the scheduler mutex; its reserved turn is held until cleanup
    /// publishes terminal state, including when this check refuses the worker.
    pub(super) fn recheck(&self) -> Result<()> {
        if let Claims::Paths(locations) = &self.claims {
            for location in locations {
                if Location::capture(&location.submitted, location.directory)? != *location {
                    return Err("排队任务的目标文件或目录身份已变化，请重新提交".into());
                }
            }
        }
        Ok(())
    }
}

impl Location {
    fn capture(path: &Path, directory: bool) -> Result<Self> {
        if !path.is_absolute()
            || path.as_os_str().as_bytes().len() > MAX_PATH_BYTES
            || path.components().count() > MAX_ANCESTORS
            || path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err("任务目标必须是有界规范绝对路径".into());
        }
        let parent = if directory {
            path
        } else {
            path.parent().ok_or("任务文件缺少父目录")?
        };
        let canonical_parent = fs::canonicalize(parent).map_err(|_| "任务目标目录不可用")?;
        let parent_metadata = fs::metadata(&canonical_parent).map_err(|_| "任务目标目录不可用")?;
        if !parent_metadata.is_dir() {
            return Err("任务目标父路径不是目录".into());
        }
        let canonical = if directory {
            canonical_parent.clone()
        } else {
            canonical_parent.join(path.file_name().ok_or("任务文件缺少文件名")?)
        };
        let file_key = if directory {
            None
        } else {
            match fs::symlink_metadata(&canonical) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    Some(Key::of(&metadata))
                }
                Ok(_) => return Err("任务目标不是独立普通文件路径".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("无法检查任务文件目标".into()),
            }
        };
        let mut ancestors = Vec::new();
        for ancestor in canonical_parent.ancestors() {
            if ancestors.len() >= MAX_ANCESTORS {
                return Err("任务目标目录层级超过限制".into());
            }
            let metadata = fs::metadata(ancestor).map_err(|_| "任务目标目录身份已变化")?;
            if !metadata.is_dir() {
                return Err("任务目标目录身份已变化".into());
            }
            ancestors.push(Ancestor {
                key: Key::of(&metadata),
                relative: canonical
                    .strip_prefix(ancestor)
                    .map_err(|_| "任务目标目录身份已变化")?
                    .to_path_buf(),
            });
        }
        // Capture is observational. Detect a namespace replacement while the
        // ancestry was read; validated source/output FDs remain command-owned.
        if fs::canonicalize(parent).map_err(|_| "任务目标目录身份已变化")? != canonical_parent
            || Key::of(&fs::metadata(&canonical_parent).map_err(|_| "任务目标目录身份已变化")?)
                != Key::of(&parent_metadata)
        {
            return Err("任务目标目录身份已变化".into());
        }
        Ok(Self {
            submitted: path.into(),
            directory,
            canonical,
            ancestors,
            file_key,
        })
    }

    fn conflicts(&self, other: &Self) -> bool {
        if !self.directory
            && !other.directory
            && self.file_key.is_some()
            && self.file_key == other.file_key
        {
            return true;
        }
        self.ancestors.iter().any(|a| {
            other.ancestors.iter().any(|b| {
                a.key == b.key
                    && match (self.directory, other.directory) {
                        (true, true) => {
                            a.relative.starts_with(&b.relative)
                                || b.relative.starts_with(&a.relative)
                        }
                        (true, false) => b.relative.starts_with(&a.relative),
                        (false, true) => a.relative.starts_with(&b.relative),
                        (false, false) => a.relative == b.relative,
                    }
            })
        })
    }
}
