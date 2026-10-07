//! Host layout and Minecraft platform vocabulary. This module describes a
//! target; it does not grant file authority or emulate another platform. Launch
//! and installation use `current()`, while metadata tests pass explicit targets.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperatingSystem {
    Linux,
    Windows,
    MacOs,
}

impl OperatingSystem {
    pub fn minecraft_name(self) -> &'static str {
        match self {
            Self::Linux => "linux",
            Self::Windows => "windows",
            Self::MacOs => "osx",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Architecture {
    X86,
    X86_64,
    Arm32,
    Arm64,
    RiscV64,
    PowerPc64,
    PowerPc64Le,
    S390x,
    LoongArch64,
}

impl Architecture {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value.trim().to_ascii_lowercase().as_str() {
            "x86" | "i386" | "i486" | "i586" | "i686" => Self::X86,
            "amd64" | "x86_64" | "x64" | "x86-64" => Self::X86_64,
            "arm" | "arm32" | "armv7" | "armv7l" => Self::Arm32,
            "aarch64" | "aarch_64" | "arm64" => Self::Arm64,
            "riscv64" => Self::RiscV64,
            "ppc64" | "powerpc64" => Self::PowerPc64,
            "ppc64le" | "powerpc64le" => Self::PowerPc64Le,
            "s390x" => Self::S390x,
            "loongarch64" => Self::LoongArch64,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::X86 => "x86",
            Self::X86_64 => "x86_64",
            Self::Arm32 => "arm",
            Self::Arm64 => "aarch64",
            Self::RiscV64 => "riscv64",
            Self::PowerPc64 => "powerpc64",
            Self::PowerPc64Le => "powerpc64le",
            Self::S390x => "s390x",
            Self::LoongArch64 => "loongarch64",
        }
    }
    pub fn bits(self) -> &'static str {
        match self {
            Self::X86 | Self::Arm32 => "32",
            _ => "64",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Platform {
    pub os: OperatingSystem,
    pub arch: Architecture,
}

impl Platform {
    pub fn current() -> Result<Self, String> {
        let os = match std::env::consts::OS {
            "linux" => OperatingSystem::Linux,
            "windows" => OperatingSystem::Windows,
            "macos" => OperatingSystem::MacOs,
            value => return Err(format!("Unsupported operating system: {value}")),
        };
        let arch = Architecture::parse(std::env::consts::ARCH)
            .ok_or_else(|| format!("Unsupported architecture: {}", std::env::consts::ARCH))?;
        Ok(Self { os, arch })
    }
    pub fn classpath_separator(self) -> &'static str {
        if self.os == OperatingSystem::Windows {
            ";"
        } else {
            ":"
        }
    }
    pub fn java_executable(self) -> &'static str {
        if self.os == OperatingSystem::Windows {
            "java.exe"
        } else {
            "java"
        }
    }
    /// A JDK home and a Mojang macOS bundle have different layouts. Return
    /// bounded candidates, never recursively search an arbitrary game directory.
    pub fn java_paths(self, base: &Path) -> Vec<PathBuf> {
        let mut paths = vec![base.join("bin").join(self.java_executable())];
        if self.os == OperatingSystem::MacOs {
            paths.push(base.join("Contents/Home/bin/java"));
            paths.push(base.join("jre.bundle/Contents/Home/bin/java"));
        }
        paths
    }
    /// Names from Mojang's runtime index, not download/install capabilities.
    /// In particular, an absent Linux ARM runtime must not fall back to x64.
    pub fn mojang_java_platform(self) -> Option<&'static str> {
        use Architecture::*;
        use OperatingSystem::*;
        Some(match (self.os, self.arch) {
            (Linux, X86_64) => "linux",
            (Linux, X86) => "linux-i386",
            (Windows, X86_64) => "windows-x64",
            (Windows, X86) => "windows-x86",
            (Windows, Arm64) => "windows-arm64",
            (MacOs, X86_64) => "mac-os",
            (MacOs, Arm64) => "mac-os-arm64",
            _ => return None,
        })
    }
    pub fn native_filename(self, name: &str) -> bool {
        match self.os {
            OperatingSystem::Windows => name.to_ascii_lowercase().ends_with(".dll"),
            OperatingSystem::MacOs => name.ends_with(".dylib") || name.ends_with(".jnilib"),
            OperatingSystem::Linux => {
                name.ends_with(".so")
                    || name.split_once(".so.").is_some_and(|(_, suffix)| {
                        !suffix.is_empty()
                            && suffix
                                .split('.')
                                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                    })
            }
        }
    }
    /// Only the classifier component is inspected: an artifact or group name
    /// containing "linux" is not evidence of a platform-specific binary.
    pub fn native_artifact(self, coordinate: &str) -> Result<bool, String> {
        Ok(native_target(coordinate)?.is_some_and(|target| target == self))
    }
    pub(crate) fn library_matches(self, coordinate: &str) -> Result<bool, String> {
        Ok(native_target(coordinate)?.is_none_or(|target| target == self))
    }
    pub fn legacy_native_classifier(
        self,
        library: &serde_json::Value,
    ) -> Result<Option<String>, String> {
        let Some(classifier) = library["natives"][self.os.minecraft_name()].as_str() else {
            return Ok(None);
        };
        let classifier = classifier.replace("${arch}", self.arch.bits());
        // Legacy unqualified native jars contain x86/x64 binaries, not ARM.
        // Fail explicitly rather than schedule a wrong binary or omit a required
        // native. Custom classifiers remain governed by their supplied metadata.
        if let Some(target) = native_target(&format!("_:_:_:{classifier}"))? {
            if target.os != self.os
                || (target.arch != self.arch
                    && !(target.arch == Architecture::X86_64
                        && self.arch == Architecture::X86
                        && matches!(
                            classifier.as_str(),
                            "natives-linux" | "natives-windows" | "natives-osx"
                        )))
            {
                return Err(format!(
                    "Native classifier {classifier} does not support {} {}",
                    self.os.minecraft_name(),
                    self.arch.name()
                ));
            }
        }
        Ok(Some(classifier))
    }
}

fn native_target(coordinate: &str) -> Result<Option<Platform>, String> {
    use Architecture::*;
    use OperatingSystem::*;
    let name = coordinate
        .split_once('@')
        .map_or(coordinate, |(name, _)| name);
    let parts: Vec<_> = name.split(':').collect();
    if parts.len() != 4 {
        return Ok(None);
    }
    let classifier = parts[3];
    let (os, arch) = match classifier {
        "natives-linux" | "linux-x86_64" | "natives-linux-x86_64" | "natives-linux-64" => {
            (Linux, X86_64)
        }
        "natives-linux-x86" | "linux-x86" | "natives-linux-32" => (Linux, X86),
        "natives-linux-arm32" | "linux-arm32" => (Linux, Arm32),
        "natives-linux-arm64" | "natives-linux-aarch_64" | "linux-aarch_64" | "linux-aarch64" => {
            (Linux, Arm64)
        }
        "natives-windows" | "natives-windows-64" | "windows-x86_64" => (Windows, X86_64),
        "natives-windows-x86" | "natives-windows-32" | "windows-x86" => (Windows, X86),
        "natives-windows-arm64" | "windows-aarch_64" => (Windows, Arm64),
        // Mojang's freetype "patch" artifact is an x64 Mach-O, not universal.
        "natives-macos"
        | "natives-macos-patch"
        | "natives-osx"
        | "natives-osx-64"
        | "osx-x86_64" => (MacOs, X86_64),
        "natives-osx-32" => (MacOs, X86),
        "natives-macos-arm64" | "natives-osx-arm64" | "osx-aarch_64" => (MacOs, Arm64),
        _ => {
            if [
                "natives-linux",
                "natives-windows",
                "natives-macos",
                "natives-osx",
                "linux",
                "windows",
                "osx",
                "macos",
            ]
            .iter()
            .any(|prefix| {
                classifier == *prefix
                    || classifier
                        .strip_prefix(prefix)
                        .is_some_and(|tail| tail.starts_with('-'))
            }) {
                return Err(format!("Unsupported native classifier: {classifier}"));
            }
            return Ok(None);
        }
    };
    Ok(Some(Platform { os, arch }))
}

/// Win32 treats these as device names or aliases even below an ordinary
/// directory. Checking normal components prevents ADS/device interpretation.
#[cfg(any(windows, test))]
pub(crate) fn windows_reserved_component(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    name.ends_with(['.', ' '])
        || name.contains(['<', '>', ':', '"', '|', '?', '*'])
        || name.chars().any(|c| c <= '\u{1f}')
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

/// OS-version evidence is read without a shell or a potentially blocking child.
/// Unknown versions stay empty; version-constrained rules cannot match them.
pub(crate) fn os_version() -> String {
    host_version::read().unwrap_or_default()
}

#[cfg(target_os = "linux")]
mod host_version {
    pub fn read() -> Option<String> {
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .map(|v| v.trim().into())
    }
}
#[cfg(target_os = "macos")]
mod host_version {
    pub fn read() -> Option<String> {
        let mut bytes = [0u8; 128];
        let mut size = bytes.len();
        // kern.osproductversion follows Java's macOS product version, rather
        // than Darwin's kernel release. Fixed buffer bounds the native read.
        let result = unsafe {
            libc::sysctlbyname(
                c"kern.osproductversion".as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 || size == 0 || size > bytes.len() {
            return None;
        }
        std::ffi::CStr::from_bytes_with_nul(&bytes[..size])
            .ok()?
            .to_str()
            .ok()
            .map(str::to_owned)
    }
}
#[cfg(target_os = "windows")]
mod host_version {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut Version) -> i32;
    }
    pub fn read() -> Option<String> {
        let mut version = Version {
            size: std::mem::size_of::<Version>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        // GetVersionEx can report a compatibility version without an application
        // manifest. RtlGetVersion returns the native NT major/minor/build tuple.
        (unsafe { RtlGetVersion(&mut version) } >= 0)
            .then(|| format!("{}.{}.{}", version.major, version.minor, version.build))
    }
}
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod host_version {
    pub fn read() -> Option<String> {
        None
    }
}

#[cfg(test)]
#[path = "platform_tests.rs"]
mod tests;
