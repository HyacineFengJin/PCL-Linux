import { useState } from "react";
import type { LauncherPreferencePanelProps } from "./launcherTypes";
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

export function LauncherMisc(props: LauncherPreferencePanelProps) {
  const {
    translator: tr,
    prefs: p,
    view,
    disabled,
    reason,
    patch,
    action,
    actionDisabled,
    actionReason,
  } = useLauncherPreferenceEditor(props);
  const [editingProxy, setEditingProxy] = useState(false);
  return (
    <div className="extra-settings extra-misc">
      {view.warning && (
        <p className="extra-paragraph" role="alert">
          {tr.t("common.storeWarning", { warning: view.warning })}
        </p>
      )}
      {view.runtime_warning && (
        <p className="extra-paragraph" role="status">
          {tr.t("common.runtimeWarning", { warning: view.runtime_warning })}
        </p>
      )}
      <Card title={tr.t("misc.system")}>
        <div className="extra-fields">
          <Field label={tr.t("misc.announcements")}>
            <Select
              label={tr.t("misc.announcements")}
              value={p.announcement_mode}
              options={[
                { value: "all", label: tr.t("misc.announcementsAll") },
                {
                  value: "important",
                  label: tr.t("misc.announcementsImportant"),
                },
                { value: "none", label: tr.t("misc.announcementsNone") },
              ]}
              disabled={disabled("announcements")}
              reason={reason(
                "announcements",
                tr.t("misc.announcementsUnavailable"),
              )}
              onChange={(announcement_mode) =>
                patch("announcements", { announcement_mode })
              }
            />
          </Field>
          <Field label={tr.t("misc.fps")}>
            <Range
              formatNumber={tr.formatNumber}
              label={tr.t("misc.fps")}
              value={p.animation.fps_limit}
              min={1}
              max={240}
              unit=" fps"
              disabled={disabled("animations")}
              reason={reason("animations", tr.t("misc.fpsUnavailable"))}
              onCommit={(fps_limit) =>
                patch("animations", { animation: { fps_limit } })
              }
            />
          </Field>
          <Field label={tr.t("misc.logLines")}>
            <Range
              formatNumber={tr.formatNumber}
              label={tr.t("misc.logLines")}
              value={p.realtime_log_line_limit}
              min={100}
              max={100000}
              step={100}
              disabled={disabled("log_limit")}
              reason={reason("log_limit", tr.t("misc.logLinesUnavailable"))}
              onCommit={(realtime_log_line_limit) =>
                patch("log_limit", { realtime_log_line_limit })
              }
            />
          </Field>
        </div>
        <p className="extra-paragraph extra-muted">{tr.t("misc.fpsHelp")}</p>
        <div className="extra-inline-checks">
          <Check
            value={p.disable_hardware_acceleration}
            disabled={disabled("hardware_acceleration")}
            reason={reason(
              "hardware_acceleration",
              tr.t("misc.hardwareUnavailable"),
            )}
            onChange={(disable_hardware_acceleration) =>
              patch("hardware_acceleration", { disable_hardware_acceleration })
            }
          >
            {tr.t("misc.disableHardware")}
          </Check>
          <Check
            value={p.local_diagnostics_enabled}
            disabled={disabled("local_diagnostics")}
            reason={reason(
              "local_diagnostics",
              tr.t("misc.diagnosticsUnavailable"),
            )}
            onChange={(local_diagnostics_enabled) =>
              patch("local_diagnostics", { local_diagnostics_enabled })
            }
          >
            {tr.t("misc.diagnostics")}
          </Check>
        </div>
        <p className="extra-paragraph extra-muted">
          {tr.t("misc.diagnosticsHelp")}
        </p>
        {view.hardware_acceleration_restart_required && (
          <p className="extra-paragraph" role="status">
            {tr.t("misc.hardwareRestart")}
          </p>
        )}
        <div className="ce-actions extra-actions">
          <button
            className="ce-button"
            disabled={actionDisabled("settings_transfer")}
            title={actionReason(
              "settings_transfer",
              tr.t("misc.exportUnavailable"),
            )}
            onClick={() => action("settings_transfer", "export_settings")}
          >
            {tr.t("misc.export")}
          </button>
          <button
            className="ce-button"
            disabled={actionDisabled("settings_transfer")}
            title={actionReason(
              "settings_transfer",
              tr.t("misc.importUnavailable"),
            )}
            onClick={() => action("settings_transfer", "import_settings")}
          >
            {tr.t("misc.import")}
          </button>
          <button
            className="ce-button danger"
            disabled={actionDisabled("stop_using")}
            title={actionReason("stop_using", tr.t("misc.stopUnavailable"))}
            onClick={() => action("stop_using", "stop_using")}
          >
            {tr.t("misc.stop")}
          </button>
        </div>
      </Card>
      <Card title={tr.t("misc.network")}>
        <Check
          value={p.network.doh_enabled}
          disabled={disabled("doh")}
          reason={reason("doh", tr.t("misc.dohUnavailable"))}
          onChange={(doh_enabled) => patch("doh", { network: { doh_enabled } })}
        >
          {tr.t("misc.doh")}
        </Check>
        <Field label={tr.t("misc.proxy")}>
          <Radios
            label={tr.t("misc.proxy")}
            value={p.network.proxy_mode}
            options={[
              { value: "none", label: tr.t("misc.noProxy") },
              { value: "system", label: tr.t("misc.systemProxy") },
              { value: "custom", label: tr.t("misc.customProxy") },
            ]}
            disabled={disabled("network_proxy")}
            reason={reason("network_proxy", tr.t("misc.proxyUnavailable"))}
            onChange={(proxy_mode) => {
              if (proxy_mode === "custom" && !p.network.custom_proxy_url)
                setEditingProxy(true);
              else {
                setEditingProxy(false);
                patch("network_proxy", { network: { proxy_mode } });
              }
            }}
          />
        </Field>
        {(p.network.proxy_mode === "custom" || editingProxy) && (
          <Field label={tr.t("misc.proxyUrl")}>
            <Text
              label={tr.t("misc.proxyUrl")}
              value={p.network.custom_proxy_url}
              placeholder="http://127.0.0.1:8080"
              disabled={disabled("network_proxy")}
              reason={reason("network_proxy")}
              onCommit={(custom_proxy_url) => {
                patch("network_proxy", {
                  network: { custom_proxy_url, proxy_mode: "custom" },
                });
                setEditingProxy(false);
              }}
            />
          </Field>
        )}
        {editingProxy && (
          <p className="extra-paragraph extra-muted">
            {tr.t("misc.proxyHelp")}
          </p>
        )}
      </Card>
      <Card title={tr.t("misc.debugOptions")} collapse>
        <Field label={tr.t("misc.animationSpeed")}>
          <Range
            formatNumber={tr.formatNumber}
            label={tr.t("misc.animationSpeed")}
            value={p.animation.speed_percent}
            min={10}
            max={400}
            unit="%"
            disabled={disabled("animations")}
            reason={reason(
              "animations",
              tr.t("misc.animationSpeedUnavailable"),
            )}
            onCommit={(speed_percent) =>
              patch("animations", { animation: { speed_percent } })
            }
          />
        </Field>
        <div className="extra-debug-checks">
          <Check
            value={p.advanced.forbid_download_copy}
            disabled={disabled("download_copy")}
            reason={reason("download_copy", tr.t("misc.copyUnavailable"))}
            onChange={(forbid_download_copy) =>
              patch("download_copy", { advanced: { forbid_download_copy } })
            }
          >
            {tr.t("misc.forbidCopy")}
          </Check>
          <Check
            value={p.advanced.debug_mode}
            disabled={disabled("debug")}
            reason={reason("debug", tr.t("misc.debugUnavailable"))}
            onChange={(debug_mode) =>
              patch("debug", { advanced: { debug_mode } })
            }
          >
            {tr.t("misc.debug")}
          </Check>
          <Check
            value={p.advanced.artificial_delay_ms > 0}
            disabled={disabled("artificial_delay")}
            reason={reason("artificial_delay", tr.t("misc.delayUnavailable"))}
            onChange={(enabled) =>
              patch("artificial_delay", {
                advanced: { artificial_delay_ms: enabled ? 250 : 0 },
              })
            }
          >
            {tr.t("misc.delay")}
          </Check>
        </div>
        <p className="launcher-setting-summary">{tr.t("misc.delayHelp")}</p>
        {p.advanced.artificial_delay_ms > 0 && (
          <Field label={tr.t("misc.delayTime")}>
            <Range
              formatNumber={tr.formatNumber}
              label={tr.t("misc.delayTime")}
              value={p.advanced.artificial_delay_ms}
              min={0}
              max={5000}
              step={50}
              unit=" ms"
              disabled={disabled("artificial_delay")}
              reason={reason("artificial_delay")}
              onCommit={(artificial_delay_ms) =>
                patch("artificial_delay", { advanced: { artificial_delay_ms } })
              }
            />
          </Field>
        )}
      </Card>
    </div>
  );
}
