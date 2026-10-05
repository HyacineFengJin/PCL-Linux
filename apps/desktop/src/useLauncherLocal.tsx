import { useState } from "react";
import { InstanceOperationDialog } from "./instanceOperationUi";
import type { Api } from "./types";
import type { LauncherAction, LauncherEffect } from "./launcherTypes";
import type { useLauncherPreferences } from "./useLauncherPreferences";
import { t, formatDate, formatNumber } from "./i18n";

type Statistics = {
  launcherOpens: number;
  gameSpawns: number;
  lastLauncherOpen: number | null;
  lastGameSpawn: number | null;
};
type Target = "applications" | "desktop";
type ShortcutPlan = {
  revision: string;
  entries: { path: string; alreadyRegistered: boolean }[];
  warnings: string[];
};
type Recovery = {
  operationId: string;
  revision: string;
  path: string;
  createdAt: number;
  warnings: string[];
};
type Modal =
  | { kind: "stats"; value: Statistics }
  | { kind: "shortcut"; recovery: Recovery[] }
  | { kind: "apply"; target: Target | null; plan: ShortcutPlan };
type Launcher = ReturnType<typeof useLauncherPreferences>;
export type LocalTool = "luck" | "shortcuts" | "statistics";
const effects: readonly LauncherEffect[] = [
  "local_diagnostics",
  "debug",
  "stop_using",
];

/** Keep chooser/confirmation ownership at app level: changing sidebar pages
 * cannot lose the prepared revision or replay a withdrawal after a newer plan.
 * All entry writes go through the same launcher operation guard as preferences.
 */
export function useLauncherLocal(
  api: Api,
  native: boolean,
  launcher: Launcher,
  notify: (message: string) => void,
) {
  const [modal, setModal] = useState<Modal | null>(null);
  const [error, setError] = useState("");
  async function tool(action: LocalTool) {
    if (action === "luck") {
      const date = new Date();
      const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      let hash = 2166136261;
      for (const ch of day) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
      notify(t("local.luck", { score: formatNumber((hash >>> 0) % 101) }));
      return;
    }
    try {
      await launcher.run(async () => {
        setError("");
        if (action === "statistics") {
          setModal({
            kind: "stats",
            value: await api<Statistics>("launcher_statistics"),
          });
        } else {
          setModal({
            kind: "shortcut",
            recovery: await api<Recovery[]>("launcher_shortcut_recovery"),
          });
        }
      });
    } catch (e) {
      notify(String(e));
    }
  }
  async function prepare(target: Target | null) {
    try {
      await launcher.run(async () => {
        const plan = await api<ShortcutPlan>("launcher_shortcut_plan", {
          target,
        });
        setError("");
        setModal({ kind: "apply", target, plan });
      });
    } catch (e) {
      setError(String(e));
    }
  }
  async function action(action: LauncherAction) {
    if (action !== "stop_using") throw new Error(t("local.unknown"));
    await launcher.run(async () => {
      const plan = await api<ShortcutPlan>("launcher_shortcut_plan", {
        target: null,
      });
      setError("");
      setModal({ kind: "apply", target: null, plan });
    });
  }
  async function apply() {
    if (modal?.kind !== "apply") return;
    const submitted = modal;
    try {
      await launcher.run(async () => {
        if (submitted.target || submitted.plan.entries.length) {
          await api("launcher_shortcut_apply", {
            target: submitted.target,
            revision: submitted.plan.revision,
          });
        }
        if (submitted.target) {
          setModal(null);
          notify(t("local.created"));
        } else {
          // Native admission rechecks that no game/auth/writer appeared while
          // the confirmation was open; close is not a browser-only simulation.
          await api("launcher_finish_using");
          setModal(null);
        }
      });
    } catch (e) {
      setError(String(e));
    }
  }
  async function restore(row: Recovery) {
    try {
      await launcher.run(async () => {
        await api("launcher_shortcut_restore", {
          operationId: row.operationId,
          revision: row.revision,
        });
        const recovery = await api<Recovery[]>("launcher_shortcut_recovery");
        setError("");
        setModal({ kind: "shortcut", recovery });
        notify(t("local.restored"));
      });
    } catch (e) {
      setError(String(e));
    }
  }
  const busy = launcher.busy;
  const title =
    modal?.kind === "stats"
      ? t("local.countTitle")
      : modal?.kind === "apply" && !modal.target
        ? t("local.stopTitle")
        : t("toolbox.shortcut");
  const ui = modal ? (
    <InstanceOperationDialog
      title={title}
      titleId="launcher-local-dialog"
      busy={busy}
      committing={busy}
      confirmLabel={
        modal.kind === "apply"
          ? modal.target
            ? t("local.create")
            : t("local.removeClose")
          : t("local.close")
      }
      confirmDisabled={busy}
      onConfirm={() => (modal.kind === "apply" ? void apply() : setModal(null))}
      onClose={() => {
        if (!busy) {
          setModal(null);
          setError("");
        }
      }}
    >
      {modal.kind === "stats" && (
        <dl className="launcher-setting-summary">
          <dt>{t("local.opens")}</dt>
          <dd>{formatNumber(modal.value.launcherOpens)}</dd>
          <dt>{t("local.spawns")}</dt>
          <dd>{formatNumber(modal.value.gameSpawns)}</dd>
          <dt>{t("local.lastOpen")}</dt>
          <dd>
            {modal.value.lastLauncherOpen
              ? formatDate(modal.value.lastLauncherOpen * 1000)
              : t("local.noRecord")}
          </dd>
          <dt>{t("local.lastGame")}</dt>
          <dd>
            {modal.value.lastGameSpawn
              ? formatDate(modal.value.lastGameSpawn * 1000)
              : t("local.noRecord")}
          </dd>
        </dl>
      )}
      {modal.kind === "shortcut" && (
        <>
          <div className="ce-actions">
            <button
              type="button"
              className="ce-button"
              disabled={busy || !native}
              onClick={() => void prepare("applications")}
            >
              {t("local.applications")}
            </button>
            <button
              type="button"
              className="ce-button"
              disabled={busy || !native}
              onClick={() => void prepare("desktop")}
            >
              {t("local.desktop")}
            </button>
          </div>
          {modal.recovery.length > 0 && (
            <>
              <h3>{t("local.recovery")}</h3>
              {modal.recovery.map((row) => (
                <div className="launcher-setting-summary" key={row.operationId}>
                  <p>{row.path}</p>
                  <p>{formatDate(row.createdAt * 1000)}</p>
                  {row.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                  <button
                    type="button"
                    className="ce-button"
                    disabled={busy || !row.revision || row.warnings.length > 0}
                    onClick={() => void restore(row)}
                  >
                    {t("local.restore")}
                  </button>
                </div>
              ))}
            </>
          )}
        </>
      )}
      {modal.kind === "apply" && (
        <>
          <p className="launcher-setting-summary">
            {modal.target ? t("local.createHelp") : t("local.stopHelp")}
          </p>
          {modal.plan.entries.map((entry) => (
            <p className="launcher-setting-summary" key={entry.path}>
              {entry.path}
              {modal.target && entry.alreadyRegistered
                ? t("local.registered")
                : ""}
            </p>
          ))}
          {!modal.target && modal.plan.entries.length === 0 && (
            <p>{t("local.none")}</p>
          )}
          {modal.plan.warnings.map((warning, index) => (
            <p className="launcher-setting-summary" key={index}>
              {warning}
            </p>
          ))}
        </>
      )}
      {error && (
        <p className="rd-name-error" role="alert">
          {error}
        </p>
      )}
    </InstanceOperationDialog>
  ) : null;
  return {
    tool,
    action,
    effects,
    ui,
    handles: (action: LauncherAction) => action === "stop_using",
  };
}
