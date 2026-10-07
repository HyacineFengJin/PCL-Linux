import { useEffect, useRef, useState } from "react";
import { CeSelect } from "./CeSelect";
import { t } from "./i18n";
import type {
  LauncherPreferencePatch,
  LauncherPreferenceView,
  LauncherPreferences,
} from "./launcherTypes";

type GameDefaults = LauncherPreferences["game_launch"];
const defaultOptions: GameDefaults = {
  window: { mode: "default" },
  ip: "default",
};
const presets = [
  [854, 480],
  [1280, 720],
  [1920, 1080],
] as const;

/** Global preferences have their own revision. A saved DOM handler may outlive
 * its page or view; it must not replay a draft into the next root's page. */
export function GameLaunchFields({
  field,
  view,
  native,
  busy,
  disabled,
  onPatch,
  onNotify,
}: {
  field: "window" | "ip";
  view?: LauncherPreferenceView;
  native: boolean;
  busy: boolean;
  disabled: boolean;
  onPatch?: (patch: LauncherPreferencePatch) => Promise<LauncherPreferenceView>;
  onNotify: (message: string) => void;
}) {
  const options = view?.preferences.game_launch || defaultOptions;
  const window = options.window;
  const width = window.mode === "custom" ? String(window.width) : "1280";
  const height = window.mode === "custom" ? String(window.height) : "720";
  const [draft, setDraft] = useState({ width, height, custom: false });
  const mounted = useRef(true),
    working = useRef(false);
  const [saving, setSaving] = useState(false);
  const latest = useRef({ view, native, busy, disabled, onPatch, onNotify });
  latest.current = { view, native, busy, disabled, onPatch, onNotify };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setDraft({ width, height, custom: false });
  }, [window.mode, width, height]);
  const unavailable =
    !native ||
    !onPatch ||
    !view?.revision ||
    !!view.warning ||
    disabled ||
    busy ||
    saving;
  const preset =
    window.mode === "custom" &&
    presets.find(([w, h]) => w === window.width && h === window.height);
  const selection = draft.custom
    ? "custom"
    : window.mode === "default"
      ? "default"
      : preset
        ? `${preset[0]}x${preset[1]}`
        : "custom";
  function allowed() {
    const current = latest.current;
    return (
      mounted.current &&
      !working.current &&
      current.native &&
      !current.busy &&
      !current.disabled &&
      !!current.onPatch &&
      !!current.view?.revision &&
      !current.view.warning &&
      current.view.revision === view?.revision
    );
  }
  async function save(patch: Partial<GameDefaults>) {
    const current = latest.current;
    if (!allowed() || !current.onPatch) return;
    working.current = true;
    setSaving(true);
    try {
      await current.onPatch({ game_launch: patch });
    } catch (error) {
      if (mounted.current) latest.current.onNotify(String(error));
    } finally {
      working.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function choose(value: string) {
    if (!allowed()) return;
    if (value === "custom") {
      setDraft({ width, height, custom: true });
      return;
    }
    if (value === "default") {
      setDraft((current) => ({ ...current, custom: false }));
      void save({ window: { mode: "default" } });
      return;
    }
    const preset = presets.find(([w, h]) => value === `${w}x${h}`);
    if (preset) {
      setDraft((current) => ({ ...current, custom: false }));
      void save({
        window: { mode: "custom", width: preset[0], height: preset[1] },
      });
    }
  }
  function saveSize() {
    if (!allowed()) return;
    if (
      !/^\d{3,5}$/.test(draft.width) ||
      !/^\d{3,5}$/.test(draft.height) ||
      Number(draft.width) < 320 ||
      Number(draft.width) > 16384 ||
      Number(draft.height) < 240 ||
      Number(draft.height) > 16384
    ) {
      onNotify(t("settings.sizeInvalid"));
      return;
    }
    void save({
      window: {
        mode: "custom",
        width: Number(draft.width),
        height: Number(draft.height),
      },
    });
  }
  return (
    <>
      {field === "window" && (
        <>
          <label className="ce-settings-row">
            <span>{t("settings.windowSize")}</span>
            <CeSelect
              className="ce-field"
              value={selection}
              disabled={unavailable}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="default">{t("common.default")}</option>
              {presets.map(([w, h]) => (
                <option key={w} value={`${w}x${h}`}>
                  {w} × {h}
                </option>
              ))}
              <option value="custom">{t("settings.custom")}</option>
            </CeSelect>
          </label>
          {selection === "custom" && (
            <div className="ce-settings-row">
              <span>{t("settings.sizePixels")}</span>
              <div className="ce-game-size">
                <input
                  className="ce-field"
                  aria-label={t("settings.sizeWidth")}
                  inputMode="numeric"
                  value={draft.width}
                  maxLength={5}
                  disabled={unavailable}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      width: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveSize();
                  }}
                />
                <span aria-hidden="true">×</span>
                <input
                  className="ce-field"
                  aria-label={t("settings.sizeHeight")}
                  inputMode="numeric"
                  value={draft.height}
                  maxLength={5}
                  disabled={unavailable}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      height: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveSize();
                  }}
                />
                <button
                  type="button"
                  className="ce-button"
                  disabled={unavailable}
                  onClick={saveSize}
                >
                  {t("settings.saveSize")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {field === "ip" && (
        <label className="ce-settings-row">
          <span>{t("settings.ip")}</span>
          <CeSelect
            className="ce-field"
            value={options.ip}
            disabled={unavailable}
            onChange={(event) => {
              const ip = event.target.value;
              if (["default", "ipv4", "ipv6"].includes(ip))
                void save({ ip: ip as GameDefaults["ip"] });
            }}
          >
            <option value="default">{t("settings.javaDefault")}</option>
            <option value="ipv4">{t("settings.ipv4")}</option>
            <option value="ipv6">{t("settings.ipv6")}</option>
          </CeSelect>
        </label>
      )}
    </>
  );
}
