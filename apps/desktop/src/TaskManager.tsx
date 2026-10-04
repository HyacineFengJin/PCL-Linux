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
        <span>总进度</span>
        <strong>{percent === null ? "—" : `${percent.toFixed(1)}%`}</strong>
      </div>
      <div>
        <span>下载速度</span>
        <strong>
          {terminalCancelled ||
          speed === null ||
          status.kind === "instance_export" ||
          status.kind === "instance_rename"
            ? "—"
            : `${(speed / 1048576).toFixed(2)} MiB/s`}
        </strong>
      </div>
      <div>
        <span>剩余文件</span>
        <strong>
          {!terminalCancelled && status.total > 0
            ? Math.max(0, status.total - status.completed).toLocaleString(
                "zh-CN",
              )
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
  const action =
    status.kind === "instance_reset"
      ? "重置"
      : status.kind === "instance_export"
        ? "导出"
        : status.kind === "instance_rename"
          ? "改名"
          : "安装";
  const phase =
    status.phase ||
    (status.stage === "downloading" ? "downloading" : "metadata");
  const current =
    phase === "metadata"
      ? 0
      : phase === "downloading"
        ? 1
        : phase === "installing"
          ? 2
          : phase === "complete"
            ? 2
            : 0;
  const steps: DownloadStep[] = status.steps?.length
    ? status.steps
    : ["获取原版版本信息", "下载游戏与运行所需文件", "安装游戏"].map(
        (label, index) => ({
          id: `legacy-${index}`,
          label,
          state:
            status.stage === "complete"
              ? "complete"
              : active && index === current
                ? "running"
                : "pending",
        }),
      );
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
        <p>暂无任务</p>
      </section>
    );
  return (
    <section className={`ce-card ce-task-card ${status.stage}`}>
      <div className="ce-task-heading">
        <strong
          title={status.root_path ? `游戏目录：${status.root_path}` : undefined}
        >
          {status.version} {action}
        </strong>
        <button
          className="icon-button"
          aria-label={cancelling ? "正在清理未完成文件" : `取消${action}任务`}
          title={cancelling ? "正在清理…" : `取消${action}任务`}
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
        {cancelling ? "正在取消并清理未完成文件…" : status.message}
      </p>
    </section>
  );
}
