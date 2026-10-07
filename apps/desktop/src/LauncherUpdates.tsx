import { useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import type { LocalizationPreferences, MessageKey } from "./i18n";
import { createTranslator } from "./i18n";
import type { LauncherUpdateView } from "./launcherUpdateTypes";
import { LauncherCard } from "./LauncherSettingsControls";
import launcherIcon from "./assets/game-icons/launcher.png";
import { InstanceOperationDialog } from "./instanceOperationUi";

const stateKeys: Record<LauncherUpdateView["state"], MessageKey> = {
  idle: "updater.idle",
  checking: "updater.checking",
  available: "updater.available",
  latest: "updater.latest",
  no_compatible_release: "updater.noCompatible",
  error: "updater.error",
};
type Operation =
  | "check"
  | "download"
  | "cancel"
  | "discard"
  | "apply"
  | "rollback"
  | "acknowledge"
  | "recover";
type Confirmation = {
  action: "apply" | "rollback" | "acknowledge" | "recover";
  token?: string;
  view: LauncherUpdateView;
};

/** Status reads never own native operations. Cancellation can overlap a pending
 * download IPC; generation checks keep its late reply from undoing cancel UI.
 * The page can unmount while native staging continues, then reload status. */
export function LauncherUpdates({
  api,
  native,
  enabled,
  busy,
  localization,
  onNotify,
}: {
  api: Api;
  native: boolean;
  enabled: boolean;
  busy: boolean;
  localization: LocalizationPreferences;
  onNotify: (message: string) => void;
}) {
  const tr = createTranslator(localization);
  const current = useRef({ tr, onNotify });
  current.current = { tr, onNotify };
  const [view, setView] = useState<LauncherUpdateView | null>(null);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const generation = useRef(0),
    pending = useRef<Operation | null>(null);
  const available = native && enabled;
  useEffect(() => {
    let live = true;
    const epoch = ++generation.current;
    pending.current = null;
    setOperation(null);
    setError("");
    setView(null);
    setConfirmation(null);
    if (!available) return;
    void api<LauncherUpdateView>("launcher_update_status")
      .then((value) => {
        if (live && epoch === generation.current) setView(value);
      })
      .catch((error) => {
        if (live && epoch === generation.current) setError(String(error));
      });
    return () => {
      live = false;
      generation.current++;
    };
  }, [api, available]);
  useEffect(() => {
    if (
      !available ||
      (view?.state !== "checking" &&
        view?.download.state !== "downloading" &&
        !["applying", "rolling_back"].includes(
          view?.installation.state || "",
        ) &&
        !operation)
    )
      return;
    let live = true,
      reading = false;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true;
      const epoch = generation.current;
      void api<LauncherUpdateView>("launcher_update_status")
        .then((value) => {
          if (live && epoch === generation.current) setView(value);
        })
        .catch((error) => {
          if (live && epoch === generation.current) setError(String(error));
        })
        .finally(() => {
          reading = false;
        });
    }, 500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [
    api,
    available,
    view?.state,
    view?.download.state,
    view?.installation.state,
    operation,
  ]);
  async function run(action: Operation, selection?: Confirmation) {
    if (
      !available ||
      busy ||
      (pending.current &&
        !(action === "cancel" && pending.current === "download"))
    )
      return;
    const token = selection?.token || view?.release?.token;
    if (action === "download" && !token) return;
    pending.current = action;
    setOperation(action);
    setError("");
    const epoch = ++generation.current;
    try {
      let next: LauncherUpdateView;
      if (action === "cancel") {
        await api<boolean>("launcher_update_cancel");
        next = await api<LauncherUpdateView>("launcher_update_status");
      } else
        next = await api<LauncherUpdateView>(
          `launcher_update_${action}`,
          ["download", "apply", "rollback", "acknowledge"].includes(action)
            ? { token }
            : undefined,
        );
      if (epoch === generation.current) {
        setView(next);
        if (selection) setConfirmation(null);
      }
    } catch (error) {
      if (epoch === generation.current) {
        setError(String(error));
        // A failed publication may now need recovery. Reload the native status
        // while retaining the original service error and captured confirmation.
        try {
          const next = await api<LauncherUpdateView>("launcher_update_status");
          if (epoch === generation.current) setView(next);
        } catch {
          /* Keep the last status when IPC is unavailable. */
        }
      }
    } finally {
      if (epoch === generation.current) {
        pending.current = null;
        setOperation(null);
      }
    }
  }
  const downloading =
    operation === "download" || view?.download.state === "downloading";
  const checking = operation === "check" || view?.state === "checking";
  const installing =
    ["apply", "rollback", "acknowledge", "recover"].includes(operation || "") ||
    ["applying", "rolling_back"].includes(view?.installation.state || "");
  const blocked = busy || !!operation || downloading || checking || installing;
  const reason = !native
    ? tr.t("updater.desktopOnly")
    : !enabled
      ? tr.t("update.checkUnavailable")
      : "";
  const rollback = view?.installation.rollback;
  const runningInstalled =
    !!view?.installation.disk_build &&
    view.current.version === view.installation.disk_build.version &&
    view.current.commit === view.installation.disk_build.commit;
  function confirm(action: Confirmation["action"]) {
    if (!view || blocked || !available) return;
    setError("");
    setConfirmation({
      action,
      token: action === "apply" ? view.release?.token : rollback?.token,
      view,
    });
  }
  return (
    <>
      <LauncherCard>
        <div className="extra-update" style={{ flexWrap: "wrap" }}>
          <img src={launcherIcon} alt="" />
          <div
            style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}
          >
            <strong>
              {view ? `PCL RH ${view.current.version}` : "PCL RH"}
            </strong>
            <p>{reason || tr.t(stateKeys[view?.state || "idle"])}</p>
            {view && (
              <>
                <p>
                  {view.current.architecture} ·{" "}
                  {tr.t(`updater.install.${view.current.install_channel}`)}
                </p>
                {view.current.commit && (
                  <p>
                    {tr.t("updater.commit", { commit: view.current.commit })}
                  </p>
                )}
                <p>{view.current.executable}</p>
              </>
            )}
            {view?.release && (
              <p>
                {tr.t("updater.release", {
                  version: view.release.version,
                  file: view.release.artifact_name,
                  bytes: tr.formatNumber(view.release.bytes),
                })}
              </p>
            )}
            {view && view.download.state !== "idle" && (
              <p>
                {tr.t(`updater.download.${view.download.state}`, {
                  received: tr.formatNumber(view.download.received_bytes),
                  total: tr.formatNumber(view.download.total_bytes),
                })}
              </p>
            )}
            {view?.plan && (
              <p>
                {view.plan.reason &&
                  tr.t("common.original", { message: view.plan.reason })}
              </p>
            )}
            {view && view.installation.state !== "idle" && (
              <p>{tr.t(`updater.installation.${view.installation.state}`)}</p>
            )}
            {view?.installation.disk_build && (
              <p>
                {tr.t("updater.diskBuild", {
                  version: view.installation.disk_build.version,
                  hash: view.installation.disk_build.sha256,
                })}
              </p>
            )}
            {view?.installation.restart_required && (
              <p>{tr.t("updater.restart")}</p>
            )}
            {[
              view?.message,
              view?.download.message,
              view?.installation.warning,
              error,
            ]
              .filter(Boolean)
              .map((message, index) => (
                <p role={error === message ? "alert" : undefined} key={index}>
                  {tr.t("common.original", { message: message! })}
                </p>
              ))}
          </div>
          <div
            className="extra-update-actions"
            style={{ flexWrap: "wrap", justifyContent: "flex-end" }}
          >
            <button
              className="ce-button primary"
              disabled={!available || blocked}
              title={reason}
              onClick={() => void run("check")}
            >
              {tr.t("update.check")}
            </button>
            {view?.release && (
              <button
                className="ce-button"
                disabled={
                  !available || blocked || view.download.state === "staged"
                }
                onClick={() => void run("download")}
              >
                {tr.t("updater.downloadAction")}
              </button>
            )}
            {downloading && !installing && (
              <button
                className="ce-button"
                disabled={!available || busy || operation === "cancel"}
                onClick={() => void run("cancel")}
              >
                {tr.t("updater.cancel")}
              </button>
            )}
            {view?.download.state === "staged" && (
              <>
                <button
                  className="ce-button"
                  disabled={
                    !available ||
                    blocked ||
                    !view.plan?.can_apply ||
                    !view.release
                  }
                  title={
                    !view.plan?.can_apply
                      ? view.plan?.reason || tr.t("updater.applyUnavailable")
                      : undefined
                  }
                  onClick={() => confirm("apply")}
                >
                  {tr.t("updater.apply")}
                </button>
                <button
                  className="ce-button"
                  disabled={!available || blocked}
                  onClick={() => void run("discard")}
                >
                  {tr.t("updater.discard")}
                </button>
              </>
            )}
            {rollback && (
              <>
                <button
                  className="ce-button"
                  disabled={!available || blocked || !rollback.can_rollback}
                  onClick={() => confirm("rollback")}
                >
                  {tr.t("updater.rollback")}
                </button>
                <button
                  className="ce-button"
                  disabled={!available || blocked || !runningInstalled}
                  title={
                    !runningInstalled
                      ? tr.t("updater.ackRestart")
                      : tr.t("updater.ackHelp")
                  }
                  onClick={() => confirm("acknowledge")}
                >
                  {tr.t("updater.acknowledge")}
                </button>
              </>
            )}
            {view?.installation.state === "recovery_required" && (
              <button
                className="ce-button"
                disabled={!available || blocked}
                onClick={() => confirm("recover")}
              >
                {tr.t("updater.recover")}
              </button>
            )}
            <button
              className="ce-button"
              onClick={() =>
                void api("ui_open_link", {
                  url: "https://github.com/HyacineFengJin/PCL-RH/commits/master/",
                }).catch((error) =>
                  current.current.onNotify(
                    current.current.tr.serviceError(error),
                  ),
                )
              }
            >
              {tr.t("update.changelog")}
            </button>
          </div>
        </div>
      </LauncherCard>
      {confirmation && (
        <InstanceOperationDialog
          title={tr.t(`updater.confirm.${confirmation.action}`)}
          titleId="launcher-update-confirmation"
          busy={blocked}
          committing={installing}
          confirmLabel={tr.t(`updater.action.${confirmation.action}`)}
          cancelLabel={tr.t("common.cancel")}
          confirmDisabled={blocked || !available}
          onConfirm={() => void run(confirmation.action, confirmation)}
          onClose={() => {
            if (!installing) {
              setConfirmation(null);
              setError("");
            }
          }}
        >
          <p className="launcher-setting-summary">
            {tr.t(`updater.help.${confirmation.action}`)}
          </p>
          <dl className="launcher-setting-summary">
            <dt>{tr.t("updater.runningVersion")}</dt>
            <dd>
              {confirmation.view.current.version} ·{" "}
              {confirmation.view.current.commit || "—"}
            </dd>
            <dt>{tr.t("updater.destination")}</dt>
            <dd>
              {confirmation.view.plan?.destination ||
                confirmation.view.current.executable}
            </dd>
            {confirmation.action === "apply" && confirmation.view.plan && (
              <>
                <dt>{tr.t("updater.targetVersion")}</dt>
                <dd>
                  {confirmation.view.plan.version} ·{" "}
                  {confirmation.view.plan.commit}
                </dd>
                <dt>SHA256</dt>
                <dd>{confirmation.view.plan.sha256}</dd>
                <dt>{tr.t("updater.originalHash")}</dt>
                <dd>{confirmation.view.plan.original_sha256 || "—"}</dd>
              </>
            )}
            {confirmation.action === "rollback" &&
              confirmation.view.installation.rollback && (
                <>
                  <dt>{tr.t("updater.targetVersion")}</dt>
                  <dd>
                    {confirmation.view.installation.rollback.original_version}
                  </dd>
                  <dt>{tr.t("updater.diskVersion")}</dt>
                  <dd>
                    {confirmation.view.installation.rollback.applied_version}
                  </dd>
                </>
              )}
            {confirmation.view.installation.disk_build && (
              <>
                <dt>{tr.t("updater.diskVersion")}</dt>
                <dd>{confirmation.view.installation.disk_build.version}</dd>
                <dt>SHA256</dt>
                <dd>{confirmation.view.installation.disk_build.sha256}</dd>
              </>
            )}
          </dl>
          {error && (
            <p className="rd-name-error" role="alert">
              {tr.serviceError(error)}
            </p>
          )}
        </InstanceOperationDialog>
      )}
    </>
  );
}
