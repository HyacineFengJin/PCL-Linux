import { MessageKey } from "./i18n";
import { Fragment, useState } from "react";
import { Earth, GitPullRequest, Globe } from "lucide-react";
import type { Api } from "./types";
import type {
  LauncherMenuId,
  LauncherPreferencePanelProps,
} from "./launcherTypes";
import {
  LauncherCard as Card,
  LauncherField as Field,
  LauncherCheck as Check,
  LauncherRange as Range,
  LauncherSelect as Select,
  LauncherRadios as Radios,
  LauncherText as Text,
  useLauncherPreferenceEditor,
} from "./LauncherSettingsControls";

const hidingGroups: {
  labelKey: MessageKey;
  items: { id: LauncherMenuId; labelKey: MessageKey }[];
}[] = [
  {
    labelKey: "hiding.main",
    items: [
      { id: "main.download", labelKey: "nav.download" },
      { id: "main.settings", labelKey: "nav.settings" },
      { id: "main.tools", labelKey: "nav.tools" },
    ],
  },
  {
    labelKey: "hiding.settings",
    items: [
      { id: "settings.launch", labelKey: "nav.launch" },
      { id: "settings.java", labelKey: "nav.java" },
      { id: "settings.manage", labelKey: "nav.manage" },
      { id: "settings.network", labelKey: "nav.network" },
      { id: "settings.personalize", labelKey: "nav.personalize" },
      { id: "settings.language", labelKey: "nav.language" },
      { id: "settings.misc", labelKey: "nav.misc" },
      { id: "settings.update", labelKey: "nav.update" },
      { id: "settings.about", labelKey: "nav.about" },
      { id: "settings.feedback", labelKey: "nav.feedback" },
      { id: "settings.logs", labelKey: "nav.logs" },
    ],
  },
  {
    labelKey: "hiding.tools",
    items: [
      { id: "tools.network", labelKey: "nav.network" },
      { id: "tools.toolbox", labelKey: "nav.toolbox" },
    ],
  },
  {
    labelKey: "hiding.instance",
    items: [
      { id: "instance.modify", labelKey: "nav.modify" },
      { id: "instance.export", labelKey: "nav.export" },
      { id: "instance.saves", labelKey: "nav.saves" },
      { id: "instance.screenshots", labelKey: "nav.screenshots" },
      { id: "instance.mods", labelKey: "nav.mods" },
      { id: "instance.resourcepacks", labelKey: "nav.resourcepacks" },
      { id: "instance.shaderpacks", labelKey: "nav.shaderpacks" },
      { id: "instance.schematics", labelKey: "nav.schematics" },
      { id: "instance.server", labelKey: "nav.server" },
    ],
  },
  {
    labelKey: "hiding.features",
    items: [
      { id: "feature.instance_management", labelKey: "nav.instanceManagement" },
      { id: "feature.mod_updates", labelKey: "nav.modUpdates" },
      { id: "feature.feature_hiding", labelKey: "nav.hiding" },
    ],
  },
];
export const launcherHidingGroups = hidingGroups;

export function LauncherPersonalize(
  props: LauncherPreferencePanelProps & { api: Api; revealHidden?: boolean },
) {
  const editor = useLauncherPreferenceEditor(props);
  const {
    translator: tr,
    prefs: p,
    disabled,
    reason,
    patch,
    action,
    actionDisabled,
    actionReason,
  } = editor;
  const [editingRemote, setEditingRemote] = useState(false);
  const fontOptions = (current: string) =>
    [...new Set(["", current, ...(props.fontFamilies || [])])].map((value) => ({
      value,
      label: value || tr.t("common.default"),
    }));
  function hide(id: LauncherMenuId, checked: boolean) {
    const ids = p.navigation.hidden_menu_ids;
    patch("navigation", {
      navigation: {
        hidden_menu_ids: checked
          ? [...new Set([...ids, id])]
          : ids.filter((value) => value !== id),
      },
    });
  }
  return (
    <div className="extra-settings extra-personalize">
      {editor.view.warning && (
        <p className="extra-paragraph" role="alert">
          {tr.t("common.storeWarning", { warning: editor.view.warning })}
        </p>
      )}
      {editor.view.runtime_warning && (
        <p className="extra-paragraph" role="status">
          {tr.t("common.runtimeWarning", {
            warning: editor.view.runtime_warning,
          })}
        </p>
      )}
      <Card title={tr.t("personalize.basic")}>
        <Field label={tr.t("personalize.opacity")}>
          <Range
            formatNumber={tr.formatNumber}
            label={tr.t("personalize.opacity")}
            value={p.appearance.opacity_percent}
            min={20}
            max={100}
            unit="%"
            disabled={disabled("appearance")}
            reason={reason("appearance")}
            onCommit={(opacity_percent) =>
              patch("appearance", { appearance: { opacity_percent } })
            }
          />
        </Field>
        <div className="extra-blue-notice">
          <p>{tr.t("personalize.projectNotice")}</p>
          <button
            className="ce-button primary"
            onClick={() =>
              void props
                .api("ui_open_link", {
                  url: "https://github.com/HyacineFengJin/PCL-Linux",
                })
                .catch((e) => props.onNotify(tr.serviceError(e)))
            }
          >
            {tr.t("personalize.project")}
          </button>
        </div>
        <div className="extra-themes">
          <Field label={tr.t("personalize.theme")}>
            <Select
              label={tr.t("personalize.theme")}
              value={p.appearance.theme}
              options={[
                { value: "system", label: tr.t("personalize.systemTheme") },
                { value: "light", label: tr.t("personalize.light") },
                { value: "dark", label: tr.t("personalize.dark") },
              ]}
              disabled={disabled("appearance")}
              reason={reason("appearance")}
              onChange={(theme) =>
                patch("appearance", { appearance: { theme } })
              }
            />
          </Field>
          <Field label={tr.t("personalize.lightPalette")}>
            <Select
              label={tr.t("personalize.lightPalette")}
              value={p.appearance.light_palette}
              options={[{ value: "blue", label: tr.t("personalize.blue") }]}
              disabled={disabled("appearance")}
              reason={reason("appearance")}
              onChange={(light_palette) =>
                patch("appearance", { appearance: { light_palette } })
              }
            />
          </Field>
          <Field label={tr.t("personalize.darkPalette")}>
            <Select
              label={tr.t("personalize.darkPalette")}
              value={p.appearance.dark_palette}
              options={[{ value: "blue", label: tr.t("personalize.blue") }]}
              disabled={disabled("appearance")}
              reason={reason("appearance")}
              onChange={(dark_palette) =>
                patch("appearance", { appearance: { dark_palette } })
              }
            />
          </Field>
        </div>
        <Check
          value={p.appearance.show_logo}
          disabled={disabled("appearance")}
          reason={reason("appearance")}
          onChange={(show_logo) =>
            patch("appearance", { appearance: { show_logo } })
          }
        >
          {tr.t("personalize.logo")}
        </Check>
        <Check
          value={p.appearance.lock_window_size}
          disabled={disabled("window_lock")}
          reason={reason(
            "window_lock",
            tr.t("personalize.windowLockUnavailable"),
          )}
          onChange={(lock_window_size) =>
            patch("window_lock", { appearance: { lock_window_size } })
          }
        >
          {tr.t("personalize.windowLock")}
        </Check>
        <Check
          value={p.appearance.launch_tips}
          disabled={disabled("launch_tips")}
          reason={reason("launch_tips", tr.t("personalize.tipsUnavailable"))}
          onChange={(launch_tips) =>
            patch("launch_tips", { appearance: { launch_tips } })
          }
        >
          {tr.t("personalize.tips")}
        </Check>
        <Check
          value={p.appearance.advanced_materials}
          disabled={disabled("appearance")}
          reason={reason("appearance")}
          onChange={(advanced_materials) =>
            patch("appearance", { appearance: { advanced_materials } })
          }
        >
          {tr.t("personalize.materials")}
        </Check>
      </Card>
      <Card title={tr.t("personalize.fonts")}>
        <div className="extra-fields extra-font-fields">
          <Field label={tr.t("personalize.global")}>
            <Select
              label={tr.t("personalize.globalFont")}
              value={p.appearance.global_font}
              options={fontOptions(p.appearance.global_font)}
              disabled={disabled("fonts")}
              reason={reason("fonts", tr.t("personalize.fontUnavailable"))}
              onChange={(global_font) =>
                patch("fonts", { appearance: { global_font } })
              }
            />
          </Field>
          <Field label="MOTD">
            <Select
              label={tr.t("personalize.motdFont")}
              value={p.appearance.motd_font}
              options={fontOptions(p.appearance.motd_font)}
              disabled={disabled("fonts")}
              reason={reason("fonts", tr.t("personalize.motdUnavailable"))}
              onChange={(motd_font) =>
                patch("fonts", { appearance: { motd_font } })
              }
            />
          </Field>
        </div>
      </Card>
      <Card title={tr.t("personalize.background")}>
        <Check
          value={p.background.color_overlay}
          disabled={disabled("background")}
          reason={reason(
            "background",
            tr.t("personalize.backgroundUnavailable"),
          )}
          onChange={(color_overlay) =>
            patch("background", { background: { color_overlay } })
          }
        >
          {tr.t("personalize.overlay")}
        </Check>
        <div className="ce-actions extra-actions">
          <button
            className="ce-button"
            disabled={actionDisabled("background")}
            title={actionReason(
              "background",
              tr.t("personalize.backgroundFolderUnavailable"),
            )}
            onClick={() => action("background", "open_background_folder")}
          >
            {tr.t("common.openFolder")}
          </button>
          <button
            className="ce-button"
            disabled={actionDisabled("background")}
            title={actionReason(
              "background",
              tr.t("personalize.backgroundReadUnavailable"),
            )}
            onClick={() => action("background", "refresh_background")}
          >
            {tr.t("personalize.refreshBackground")}
          </button>
        </div>
      </Card>
      <Card title={tr.t("personalize.music")}>
        <div className="ce-actions extra-actions">
          <button
            className="ce-button"
            disabled={actionDisabled("music")}
            title={actionReason(
              "music",
              tr.t("personalize.musicFolderUnavailable"),
            )}
            onClick={() => action("music", "open_music_folder")}
          >
            {tr.t("common.openFolder")}
          </button>
          <button
            className="ce-button"
            disabled={actionDisabled("music")}
            title={actionReason("music", tr.t("personalize.musicUnavailable"))}
            onClick={() => action("music", "refresh_music")}
          >
            {tr.t("personalize.refreshMusic")}
          </button>
        </div>
      </Card>
      <Card title={tr.t("personalize.title")}>
        <Radios
          label={tr.t("personalize.title")}
          value={p.title.mode}
          options={[
            { value: "none", label: tr.t("common.none") },
            { value: "default", label: tr.t("common.default") },
            { value: "text", label: tr.t("personalize.text") },
            {
              value: "image",
              label: tr.t("personalize.image"),
              disabled: !p.title.image_path && !props.onLauncherAction,
              reason: tr.t("personalize.titlePickerUnavailable"),
            },
          ]}
          disabled={disabled("title")}
          reason={reason("title", tr.t("personalize.titleUnavailable"))}
          onChange={(mode) => {
            if (mode === "image" && !p.title.image_path)
              action("title", "pick_title_image");
            else patch("title", { title: { mode } });
          }}
        />
        {p.title.mode === "text" && (
          <Field label={tr.t("personalize.titleText")}>
            <Text
              label={tr.t("personalize.titleText")}
              value={p.title.text}
              disabled={disabled("title")}
              reason={reason("title")}
              onCommit={(text) => patch("title", { title: { text } })}
            />
          </Field>
        )}
        {p.title.mode === "image" && (
          <Field label={tr.t("personalize.titleImage")}>
            <div className="ce-inline">
              <input
                className="ce-field"
                aria-label={tr.t("personalize.titleImagePath")}
                value={p.title.image_path}
                readOnly
              />
              <button
                className="ce-button"
                disabled={actionDisabled("title")}
                onClick={() => action("title", "pick_title_image")}
              >
                {tr.t("personalize.chooseImage")}
              </button>
            </div>
          </Field>
        )}
      </Card>
      <Card title={tr.t("personalize.home")}>
        <Radios
          label={tr.t("personalize.home")}
          value={p.home.mode}
          options={[
            { value: "blank", label: tr.t("personalize.blank") },
            { value: "preset", label: tr.t("personalize.preset") },
            {
              value: "local",
              label: tr.t("personalize.local"),
              disabled: !p.home.local_path && !props.onLauncherAction,
              reason: tr.t("personalize.homePickerUnavailable"),
            },
            { value: "remote", label: tr.t("personalize.remote") },
          ]}
          disabled={disabled("home")}
          reason={reason("home", tr.t("personalize.homeUnavailable"))}
          onChange={(mode) => {
            if (mode === "local" && !p.home.local_path)
              action("home", "pick_home_file");
            else if (mode === "remote" && !p.home.remote_url)
              setEditingRemote(true);
            else {
              setEditingRemote(false);
              patch("home", { home: { mode } });
            }
          }}
        />
        {p.home.mode === "local" && (
          <Field label={tr.t("personalize.homeFile")}>
            <div className="ce-inline">
              <input
                className="ce-field"
                aria-label={tr.t("personalize.homePath")}
                value={p.home.local_path}
                readOnly
              />
              <button
                className="ce-button"
                disabled={actionDisabled("home")}
                onClick={() => action("home", "pick_home_file")}
              >
                {tr.t("common.chooseFile")}
              </button>
            </div>
          </Field>
        )}
        {(p.home.mode === "remote" || editingRemote) && (
          <Field label={tr.t("personalize.homeUrl")}>
            <Text
              label={tr.t("personalize.homeUrl")}
              value={p.home.remote_url}
              placeholder="https://example.org/launcher-home.json"
              disabled={disabled("home")}
              reason={reason("home")}
              onCommit={(remote_url) => {
                patch("home", { home: { remote_url, mode: "remote" } });
                setEditingRemote(false);
              }}
            />
          </Field>
        )}
        {p.home.mode !== "blank" && (
          <div className="ce-actions extra-actions">
            <button
              className="ce-button"
              disabled={actionDisabled("home")}
              title={reason("home")}
              onClick={() => action("home", "refresh_home")}
            >
              {tr.t("personalize.refreshHome")}
            </button>
          </div>
        )}
      </Card>
      {(!p.navigation.hidden_menu_ids.includes("feature.feature_hiding") ||
        props.revealHidden) && (
        <Card title={tr.t("nav.hiding")}>
          <p className="extra-paragraph">{tr.t("hiding.help")}</p>
          {hidingGroups.map((group) => (
            <div className="extra-hide-row" key={group.labelKey}>
              <span>{tr.t(group.labelKey)}</span>
              <div>
                {group.items.map((item, index) => (
                  <Fragment key={item.id}>
                    {(((group.labelKey === "hiding.settings" ||
                      group.labelKey === "hiding.instance") &&
                      index === 5) ||
                      (group.labelKey === "hiding.instance" &&
                        index === 8)) && (
                      <span className="extra-hide-spacer" aria-hidden="true" />
                    )}
                    <Check
                      value={p.navigation.hidden_menu_ids.includes(item.id)}
                      disabled={disabled("navigation")}
                      reason={reason("navigation", tr.t("hiding.unavailable"))}
                      onChange={(checked) => hide(item.id, checked)}
                    >
                      {tr.t(item.labelKey)}
                    </Check>
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export function LauncherLanguage(
  props: LauncherPreferencePanelProps & { api: Api },
) {
  const {
    translator: tr,
    prefs: p,
    disabled,
    reason,
    patch,
  } = useLauncherPreferenceEditor(props);
  const languages = [
    { value: "system" as const, label: tr.t("language.system") },
    { value: "zh-CN" as const, label: tr.t("language.zhCN") },
    { value: "en-US" as const, label: tr.t("language.enUS") },
  ];
  return (
    <div className="extra-settings extra-language">
      <Card title={tr.t("nav.language")}>
        <div className="extra-fields extra-language-fields">
          <Field label={tr.t("language.interface")}>
            <Select
              label={tr.t("language.interface")}
              value={p.localization.language}
              options={languages}
              disabled={disabled("localization")}
              reason={reason("localization", tr.t("language.unavailable"))}
              onChange={(language) =>
                patch("localization", { localization: { language } })
              }
            />
          </Field>
          <Field label={tr.t("language.region")}>
            <Select
              label={tr.t("language.region")}
              value={p.localization.region}
              options={languages.map((o) => ({
                ...o,
                label:
                  o.value === "system"
                    ? tr.t("language.systemRegion")
                    : o.label,
              }))}
              disabled={disabled("localization")}
              reason={reason(
                "localization",
                tr.t("language.regionUnavailable"),
              )}
              onChange={(region) =>
                patch("localization", { localization: { region } })
              }
            />
          </Field>
        </div>
        <div className="extra-language-banner">
          <Earth className="extra-language-globe" />
          <h3>
            {tr.t("language.bannerLead")}
            <br />
            <strong>PCL Linux</strong>
            <br />
            {tr.t("language.bannerEnd")}
          </h3>
          <p>{tr.t("language.maintained")}</p>
          <p>{tr.t("language.contribute")}</p>
          <p>{tr.t("language.thanks")}</p>
        </div>
        <div className="extra-language-links">
          <button
            className="ce-text-button"
            onClick={() =>
              void props
                .api("ui_open_link", {
                  url: "https://github.com/HyacineFengJin/PCL-Linux/issues",
                })
                .catch((e) => props.onNotify(tr.serviceError(e)))
            }
          >
            <Globe size={16} />
            {tr.t("language.feedback")}
          </button>
          <button
            className="ce-text-button"
            onClick={() =>
              void props
                .api("ui_open_link", {
                  url: "https://github.com/HyacineFengJin/PCL-Linux/pulls",
                })
                .catch((e) => props.onNotify(tr.serviceError(e)))
            }
          >
            <GitPullRequest size={16} />
            {tr.t("language.pullRequest")}
          </button>
        </div>
      </Card>
    </div>
  );
}
