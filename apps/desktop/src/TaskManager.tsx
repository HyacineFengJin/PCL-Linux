import { t, formatNumber } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  MoreHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import type { DownloadStatus, DownloadStep } from "./DownloadPanel";
import type { Api } from "./types";
import "./task-manager.css";
export function instanceTaskAction(kind: DownloadStatus["kind"]) {
  return kind === "resource_save"
    ? t("task.resourceSave")
    : kind === "launcher_logs"
      ? t("task.launcherLogs")
      : kind === "instance_reset"
        ? t("ui.reset")
        : kind === "instance_export"
          ? t("nav.export")
          : kind === "instance_rename"
            ? t("ui.rename")
            : kind === "instance_import"
              ? t("ui.import")
              : kind === "instance_delete"
                ? t("ui.delete")
                : kind === "instance_restore"
                  ? t("ui.restore")
                  : kind === "resource_update_restore"
                    ? t("task.modRestore")
                    : kind === "resource_update"
                      ? t("nav.modUpdates")
                      : kind === "resource_download"
                        ? t("task.resourceInstall")
                        : t("ui.install");
}
export function useDownloadSpeed(status: DownloadStatus) {
  const sample = useRef<{
    bytes: number;
    time: number;
    task: string | null;
  } | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    const old = sample.current;
    const bytes = status.network_bytes;
    const running = ["downloading", "preparing", "processing"].includes(
      status.stage,
    );
    const task =
      status.task_id || `${status.root_id || ""}:${status.version || ""}`;
    if (bytes === undefined || !running) {
      setSpeed(null);
      sample.current = null;
    } else if (!old || old.task !== task || bytes < old.bytes) {
      setSpeed(null);
      sample.current = { bytes, time: now, task };
    } else if (now - old.time >= 250) {
      setSpeed(((bytes - old.bytes) * 1000) / (now - old.time));
      sample.current = { bytes, time: now, task };
    }
  }, [status]);
  return speed;
}
export function TaskStatistics({
  status,
  speed,
}: {
  status: DownloadStatus;
  speed: number | null;
}) {
  const terminalCancelled =
    status.stage === "cancelled" || status.stage === "idle";
  const progress = Number.isFinite(status.progress)
    ? status.progress!
    : status.total > 0
      ? status.completed / status.total
      : null;
  const percent = terminalCancelled
    ? null
    : status.stage === "complete"
      ? 100
      : progress === null
        ? null
        : Math.max(0, Math.min(99.9, progress * 100));
  return (
    <div className="ce-task-statistics">
      <div>
        <span>{t("task.progress")}</span>
        <strong>
          {percent === null
            ? "—"
            : `${formatNumber(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
        </strong>
      </div>
      <div>
        <span>{t("task.speed")}</span>
        <strong>
          {terminalCancelled ||
          speed === null ||
          status.kind === "instance_export" ||
          status.kind === "instance_rename" ||
          status.kind === "instance_import" ||
          status.kind === "instance_delete" ||
          status.kind === "instance_restore" ||
          status.kind === "resource_update_restore" ||
          status.kind === "launcher_logs"
            ? "—"
            : `${formatNumber(speed / 1048576, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MiB/s`}
        </strong>
      </div>
      <div>
        <span>{t("task.remaining")}</span>
        <strong>
          {!terminalCancelled && status.total > 0
            ? formatNumber(Math.max(0, status.total - status.completed))
            : "—"}
        </strong>
      </div>
    </div>
  );
}
export function TaskManager({
  api,
  status,
  native,
  onNotify,
  onStatusChange,
  onCancelled,
}: {
  api: Api;
  status: DownloadStatus;
  native: boolean;
  onNotify: (s: string) => void;
  onStatusChange?: (status: DownloadStatus) => void;
  onCancelled?: (status: DownloadStatus) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const cancelPending = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({
    api,
    status,
    native,
    onNotify,
    onStatusChange,
    onCancelled,
  });
  latest.current = {
    api,
    status,
    native,
    onNotify,
    onStatusChange,
    onCancelled,
  };
  const notifiedCancellation = useRef<string | null>(null);
  const requestedCancellation = useRef<string | null>(null);
  const taskKey =
    status.task_id ||
    `${status.root_id || status.root_path || ""}:${status.version || ""}`;
  const currentTask = useRef(taskKey);
  currentTask.current = taskKey;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    cancelPending.current = false;
    requestedCancellation.current = null;
    setCancelling(false);
  }, [taskKey, api]);
  function finishCancellation(next: DownloadStatus) {
    const key =
      next.task_id ||
      `${next.root_id || next.root_path || ""}:${next.version || ""}`;
    if (
      next.stage !== "cancelled" ||
      requestedCancellation.current !== key ||
      key !== currentTask.current ||
      notifiedCancellation.current === key
    )
      return;
    notifiedCancellation.current = key;
    latest.current.onCancelled?.(next);
  }
  useEffect(() => {
    if (status.stage === "cancelled") finishCancellation(status);
  }, [status]);
  const active = ["downloading", "preparing", "processing"].includes(
    status.stage,
  );
  const action = instanceTaskAction(status.kind);
  const cancelAction =
    status.kind === "resource_download" ? t("task.resourceDownload") : action;
  const phase =
    status.phase ||
    (status.stage === "downloading" ? "downloading" : "metadata");
  const current =
    status.kind === "resource_update_restore"
      ? phase === "resource-update-restore-apply"
        ? 1
        : 0
      : status.kind === "instance_import"
        ? Math.max(
            0,
            [
              "import-check",
              "import-extract",
              "import-commit",
              "import-cleanup",
            ].indexOf(phase),
          )
        : status.kind === "instance_delete" ||
            status.kind === "instance_restore"
          ? phase === "committing"
            ? 1
            : 0
          : status.kind === "resource_save" ||
              status.kind === "resource_download" ||
              status.kind === "resource_update"
            ? (status.kind === "resource_save" && phase === "committing") ||
              phase === "save-publish" ||
              phase === "resource-publish" ||
              phase === "resource-update-publish" ||
              phase === "installing"
              ? 2
              : status.stage === "downloading"
                ? 1
                : 0
            : phase === "metadata"
              ? 0
              : phase === "downloading"
                ? 1
                : phase === "installing"
                  ? 2
                  : phase === "complete"
                    ? 2
                    : 0;
  const fallbackLabels =
    status.kind === "resource_save"
      ? [
          t("task.resourceMetadata"),
          t("task.downloadVerify"),
          t("task.savePublish"),
        ]
      : status.kind === "launcher_logs"
        ? []
        : status.kind === "instance_import"
          ? [
              t("task.importCheck"),
              t("task.importExtract"),
              t("task.importPublish"),
              t("task.importCleanup"),
            ]
          : status.kind === "instance_delete" ||
              status.kind === "instance_restore"
            ? [
                t("task.instanceCheck"),
                t("task.instanceMove"),
                t("task.instanceRecord"),
              ]
            : status.kind === "resource_update_restore"
              ? [t("task.updateUndoCheck"), t("task.updateUndoApply")]
              : status.kind === "resource_update"
                ? [
                    t("task.updateCheck"),
                    t("task.downloadVerify"),
                    t("task.updateApply"),
                  ]
                : status.kind === "resource_download"
                  ? [
                      t("task.resourceMetadata"),
                      t("task.downloadVerify"),
                      t("task.resourceApply"),
                    ]
                  : [
                      t("task.minecraftMetadata"),
                      t("task.minecraftDownload"),
                      t("task.minecraftInstall"),
                    ];
  const steps: DownloadStep[] = status.steps?.length
    ? status.steps
    : fallbackLabels.map((label, index) => ({
        id: `legacy-${index}`,
        label,
        state:
          status.stage === "complete"
            ? "complete"
            : active && index === current
              ? "running"
              : "pending",
      }));
  async function cancel() {
    if (
      !native ||
      !mounted.current ||
      !latest.current.native ||
      !active ||
      !["downloading", "preparing", "processing"].includes(
        latest.current.status.stage,
      ) ||
      currentTask.current !== taskKey ||
      latest.current.api !== api ||
      status.can_cancel === false ||
      latest.current.status.can_cancel === false ||
      cancelPending.current
    )
      return;
    const target = taskKey;
    const targetApi = api;
    cancelPending.current = true;
    requestedCancellation.current = target;
    setCancelling(true);
    try {
      const next = await api<DownloadStatus>("download_cancel", {
        taskId: status.task_id ?? null,
      });
      if (
        !mounted.current ||
        currentTask.current !== target ||
        latest.current.api !== targetApi
      )
        return;
      const returnedTask =
        next.task_id ||
        `${next.root_id || next.root_path || ""}:${next.version || ""}`;
      if (returnedTask !== target) return;
      if (
        ["complete", "error"].includes(latest.current.status.stage) &&
        next.stage !== latest.current.status.stage
      )
        return;
      latest.current.onStatusChange?.(next);
      finishCancellation(next);
    } catch (e) {
      if (
        mounted.current &&
        currentTask.current === target &&
        latest.current.api === targetApi
      )
        latest.current.onNotify(String(e));
    } finally {
      if (
        mounted.current &&
        currentTask.current === target &&
        latest.current.api === targetApi
      ) {
        cancelPending.current = false;
        setCancelling(false);
      }
    }
  }
  if (status.stage === "idle" || status.stage === "cancelled")
    return (
      <section className="ce-card ce-task-empty">
        <Download size={36} />
        <p>{t("task.empty")}</p>
      </section>
    );
  return (
    <section className={`ce-card ce-task-card ${status.stage}`}>
      <div className="ce-task-heading">
        <strong
          title={
            status.root_path
              ? t("task.root", { path: status.root_path })
              : undefined
          }
        >
          {status.version} {action}
        </strong>
        <button
          className="icon-button"
          aria-label={
            cancelling
              ? t("task.cleanupPending")
              : t("task.cancel", { action: cancelAction })
          }
          title={
            cancelling
              ? t("task.cleanup")
              : t("task.cancel", { action: cancelAction })
          }
          disabled={
            !native || !active || status.can_cancel === false || cancelling
          }
          onClick={cancel}
        >
          {cancelling ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <X size={17} />
          )}
        </button>
      </div>
      <div className="ce-task-steps">
        {steps.map((step) => (
          <div key={step.id} className={`ce-task-step ${step.state}`}>
            <span className="ce-task-step-status">
              {step.state === "complete" ? (
                <Check size={22} strokeWidth={3} />
              ) : step.state === "running" && status.stage === "error" ? (
                <TriangleAlert size={18} />
              ) : step.state === "running" && Number.isFinite(step.progress) ? (
                `${Math.round(Math.max(0, Math.min(1, step.progress!)) * 100)}%`
              ) : (
                <MoreHorizontal size={24} />
              )}
            </span>
            <span>{step.label}</span>
          </div>
        ))}
      </div>
      <p
        className={`ce-task-message ${status.stage === "error" ? "auth-error" : "muted"}`}
        role="status"
      >
        {status.stage === "error" && <TriangleAlert size={16} />}{" "}
        {cancelling ? t("task.cancelling") : status.message}
      </p>
      {status.error && status.error !== status.message && (
        <p className="ce-task-message auth-error" role="alert">
          {t("task.originalWarning", { message: status.error })}
        </p>
      )}
    </section>
  );
}
