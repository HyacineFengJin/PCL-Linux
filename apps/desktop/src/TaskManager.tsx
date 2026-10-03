import { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  MoreHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import type { DownloadStatus } from "./DownloadPanel";
import type { Api } from "./types";
import "./task-manager.css";
export function useDownloadSpeed(status: DownloadStatus) {
  const sample = useRef<{
    bytes: number;
    time: number;
    version: string | null;
  } | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    const old = sample.current;
    const bytes = status.network_bytes;
    const running = ["downloading", "preparing"].includes(status.stage);
    if (
      bytes === undefined ||
      !running ||
      !old ||
      old.version !== status.version ||
      bytes < old.bytes
    )
      setSpeed(null);
    else if (bytes !== undefined && now - old.time >= 250)
      setSpeed(((bytes! - old.bytes) * 1000) / (now - old.time));
    sample.current = { bytes: bytes || 0, time: now, version: status.version };
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
  const percent =
    status.stage === "complete"
      ? 100
      : status.total > 0
        ? Math.min(100, (status.completed / status.total) * 100)
        : null;
  return (
    <div className="ce-task-statistics">
      <div>
        <span>总进度</span>
        <strong>{percent === null ? "—" : `${percent.toFixed(1)}%`}</strong>
      </div>
      <div>
        <span>下载速度</span>
        <strong>
          {speed === null ? "—" : `${(speed / 1048576).toFixed(2)} MiB/s`}
        </strong>
      </div>
      <div>
        <span>剩余文件</span>
        <strong>
          {status.total > 0
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
}: {
  api: Api;
  status: DownloadStatus;
  native: boolean;
  onNotify: (s: string) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const active = ["downloading", "preparing"].includes(status.stage);
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
            ? 3
            : 0;
  const steps = ["获取原版版本信息", "下载游戏与运行所需文件", "安装游戏"];
  const percent =
    status.total > 0
      ? Math.min(100, (status.completed / status.total) * 100)
      : null;
  async function cancel() {
    setCancelling(true);
    try {
      await api("download_cancel");
      onNotify(`${status.version || "游戏"} 安装正在取消`);
    } catch (e) {
      onNotify(String(e));
    } finally {
      setCancelling(false);
    }
  }
  if (status.stage === "idle")
    return (
      <section className="ce-card ce-task-empty">
        <Download size={36} />
        <p>暂无下载任务</p>
      </section>
    );
  return (
    <section className={`ce-card ce-task-card ${status.stage}`}>
      <div className="ce-task-heading">
        <strong>{status.version} 安装</strong>
        <button
          className="icon-button"
          aria-label="取消安装任务"
          title="取消安装任务"
          disabled={!native || !active || cancelling}
          onClick={cancel}
        >
          <X size={17} />
        </button>
      </div>
      <div className="ce-task-steps">
        {steps.map((label, index) => (
          <div key={label}>
            <span className="ce-task-step-status">
              {current > index || status.stage === "complete" ? (
                <Check size={22} strokeWidth={3} />
              ) : current === index && index === 1 && percent !== null ? (
                `${Math.round(percent)}%`
              ) : (
                <MoreHorizontal size={24} />
              )}
            </span>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p
        className={`ce-task-message ${status.stage === "error" ? "auth-error" : "muted"}`}
        role="status"
      >
        {status.stage === "error" && <TriangleAlert size={16} />}{" "}
        {status.message}
      </p>
    </section>
  );
}
