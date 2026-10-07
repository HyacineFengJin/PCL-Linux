//! A deliberately separate settings-only transfer schema. New runtime state or
//! secrets added to the in-process model cannot silently become export fields.
//! Exported paths and URLs are references, never file contents or executable
//! home page markup. Import only validates and persists these preferences.
use super::model::*;
use pcl_core::launch_options::LaunchOptions;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(super) const EXPORT_FORMAT: &str = "pcl-launcher-settings";
pub(super) const EXPORT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LauncherSettingsExport {
    pub format: String,
    pub schema_version: u32,
    pub preferences: ExportPreferences,
}

/// Each transferable field is named explicitly. There are no accounts, game
/// roots, instance selections, Java/runtime identifiers, task history or CDKs.
/// Proxy URLs survive backup only because all userinfo/query/fragment forms are
/// rejected by the same validation applied to updates and imports.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportPreferences {
    pub appearance: AppearancePreferences,
    pub background: BackgroundPreferences,
    pub title: TitlePreferences,
    pub home: HomePreferences,
    pub navigation: NavigationPreferences,
    pub localization: LocalizationPreferences,
    pub announcement_mode: AnnouncementMode,
    pub animation: AnimationPreferences,
    pub realtime_log_line_limit: u32,
    pub disable_hardware_acceleration: bool,
    pub local_diagnostics_enabled: bool,
    pub network: NetworkPreferences,
    #[serde(default)]
    pub management: ManagementPreferences,
    pub advanced: AdvancedPreferences,
    pub updates: UpdatePreferences,
    pub auto_select_installed: bool,
    pub launch_visibility: LaunchVisibility,
    #[serde(default)]
    pub game_launch: LaunchOptions,
}

impl LauncherSettingsExport {
    pub(super) fn from_preferences(value: &LauncherPreferences) -> Self {
        Self {
            format: EXPORT_FORMAT.into(),
            schema_version: EXPORT_SCHEMA_VERSION,
            preferences: ExportPreferences {
                appearance: value.appearance.clone(),
                background: value.background.clone(),
                title: value.title.clone(),
                home: value.home.clone(),
                navigation: value.navigation.clone(),
                localization: value.localization.clone(),
                announcement_mode: value.announcement_mode,
                animation: value.animation.clone(),
                realtime_log_line_limit: value.realtime_log_line_limit,
                disable_hardware_acceleration: value.disable_hardware_acceleration,
                local_diagnostics_enabled: value.local_diagnostics_enabled,
                network: value.network.clone(),
                management: value.management.clone(),
                advanced: value.advanced.clone(),
                updates: value.updates.clone(),
                auto_select_installed: value.auto_select_installed,
                launch_visibility: value.launch_visibility,
                game_launch: value.game_launch.clone(),
            },
        }
    }
    pub(super) fn into_preferences(self) -> Result<LauncherPreferences, String> {
        if self.format != EXPORT_FORMAT || self.schema_version != EXPORT_SCHEMA_VERSION {
            return Err("这不是受支持的 PCL 启动器设置备份（版本 1）".into());
        }
        let value = self.preferences;
        let preferences = LauncherPreferences {
            appearance: value.appearance,
            background: value.background,
            title: value.title,
            home: value.home,
            navigation: value.navigation,
            localization: value.localization,
            announcement_mode: value.announcement_mode,
            animation: value.animation,
            realtime_log_line_limit: value.realtime_log_line_limit,
            disable_hardware_acceleration: value.disable_hardware_acceleration,
            local_diagnostics_enabled: value.local_diagnostics_enabled,
            network: value.network,
            management: value.management,
            advanced: value.advanced,
            updates: value.updates,
            auto_select_installed: value.auto_select_installed,
            launch_visibility: value.launch_visibility,
            game_launch: value.game_launch,
        };
        preferences.validate()?;
        Ok(preferences)
    }
}

pub(super) fn parse_import(bytes: &[u8]) -> Result<LauncherPreferences, String> {
    if bytes.is_empty() || bytes.len() > super::MAX_IMPORT_BYTES {
        return Err("设置备份不能为空或超过 64 KiB".into());
    }
    serde_json::from_slice::<LauncherSettingsExport>(bytes)
        .map_err(|error| format!("设置备份格式无效：{error}"))?
        .into_preferences()
}

/// The chooser returns a path, not authority to follow a substituted symlink.
/// This boundary reads one independent stable regular file with the same byte
/// limit as the parser. Import previews do not persist or resolve its contents.
pub fn read_settings_file(path: &Path) -> Result<Vec<u8>, String> {
    let (parent_path, name) = split_target(path)?;
    let parent = super::io::Directory::open_preferences(parent_path)?;
    let bytes = parent
        .read_bytes(name)?
        .ok_or("选择的设置备份文件已不存在")?;
    if super::io::Directory::open_preferences(parent_path)?.identity()? != parent.identity()? {
        return Err("设置备份所在目录在读取期间已被替换".into());
    }
    Ok(bytes)
}

pub fn preview_import(bytes: &[u8]) -> Result<LauncherPreferences, String> {
    parse_import(bytes)
}

/// Exports the captured revision into a newly chosen .json filename. Existing
/// files are never overwritten, including a file created after the dialog.
pub fn export_to_file(
    store: &super::LauncherPreferencesStore,
    revision: &str,
    path: &Path,
) -> Result<(), String> {
    let (parent_path, name) = split_target(path)?;
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("启动器设置只能导出为 .json 文件".into());
    }
    let bytes = store.export_settings(revision)?;
    let parent = super::io::Directory::open_preferences(parent_path)?;
    parent.publish_anonymous(parent_path, name, &bytes)
}

fn split_target(path: &Path) -> Result<(&Path, &str), String> {
    let text = path.to_str().ok_or("设置备份路径不是有效的 UTF-8")?;
    if text.len() > 4096 || text.chars().any(char::is_control) || !path.is_absolute() {
        return Err("设置备份需要长度不超过 4096 字节的绝对路径".into());
    }
    let parent = path.parent().ok_or("设置备份没有有效的目标目录")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("设置备份没有有效的文件名")?;
    if name.is_empty() || matches!(name, "." | "..") {
        return Err("设置备份文件名无效".into());
    }
    Ok((parent, name))
}
