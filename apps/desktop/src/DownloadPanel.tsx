import { useEffect, useRef, useState } from "react";
import {
  Box,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";

export type DownloadStatus = {
  stage:
    "idle" | "preparing" | "downloading" | "complete" | "error" | "cancelled";
  message: string;
  version: string | null;
  completed: number;
  total: number;
  bytes_done: number;
  bytes_total: number;
  result?: {
    id: string;
    java_major: number;
    files_downloaded: number;
    files_reused: number;
  } | null;
};
type VersionEntry = { id: string; kind: string; release_time: string };
export const idleDownload: DownloadStatus = {
  stage: "idle",
  message: "",
  version: null,
  completed: 0,
  total: 0,
  bytes_done: 0,
  bytes_total: 0,
};
const active = (status: DownloadStatus) =>
  ["preparing", "downloading"].includes(status.stage);
const kindName = (kind: string) =>
  kind === "release" ? "正式版" : kind === "snapshot" ? "快照版" : "旧版";
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DownloadPanel({
  api,
  native,
  installed,
  gameBusy,
  onInstalled,
  onBusyChange,
}: {
  api: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  native: boolean;
  installed: { id: string }[];
  gameBusy: boolean;
  onInstalled: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("release");
  const [choice, setChoice] = useState<VersionEntry | null>(null);
  const [status, setStatus] = useState<DownloadStatus>(idleDownload);
  const [working, setWorking] = useState(false);
  const completed = useRef("");
  const starting = useRef(false);
  const confirmation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (choice)
      confirmation.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
  }, [choice]);
  const callbacks = useRef({ onInstalled, onBusyChange });
  callbacks.current = { onInstalled, onBusyChange };
  async function loadCatalog(refresh = false) {
    setLoading(true);
    setError("");
    try {
      setCatalog(await api<VersionEntry[]>("download_catalog", { refresh }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadCatalog();
  }, []);
  useEffect(() => {
    let disposed = false;
    let polling = false;
    async function poll() {
      if (polling || starting.current) return;
      polling = true;
      try {
        const next = await api<DownloadStatus>("download_status");
        if (disposed || starting.current) return;
        setStatus(next);
        callbacks.current.onBusyChange(active(next));
        if (active(next)) completed.current = "";
        if (
          next.stage === "complete" &&
          next.version &&
          completed.current !== next.version
        ) {
          completed.current = next.version;
          await callbacks.current.onInstalled();
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  const busy = active(status) || working;
  const ids = new Set(installed.map((item) => item.id));
  const visible = catalog.filter(
    (entry) =>
      entry.id.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "old"
          ? !["release", "snapshot"].includes(entry.kind)
          : entry.kind === filter)),
  );
  const progress =
    status.total > 0
      ? status.completed / status.total
      : status.bytes_total > 0
        ? status.bytes_done / status.bytes_total
        : null;
  async function start() {
    if (!choice || gameBusy || busy || !native) return;
    starting.current = true;
    setWorking(true);
    setError("");
    callbacks.current.onBusyChange(true);
    try {
      await api("download_start", { id: choice.id });
      completed.current = "";
      const next = await api<DownloadStatus>("download_status");
      setStatus(next);
      callbacks.current.onBusyChange(active(next));
      setChoice(null);
    } catch (e) {
      setError(String(e));
      callbacks.current.onBusyChange(false);
    } finally {
      starting.current = false;
      setWorking(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>下载安装</h1>
        <p>从 Minecraft 官方目录选择原版 Java 版，安装到当前游戏目录。</p>
        <p className="download-compatibility">
          部分早期版本暂不支持自动安装，遇到不受支持的版本时会显示原因。
        </p>
      </div>
      {!native && (
        <div className="auth-notice">
          请在桌面应用中获取版本目录并下载安装。
        </div>
      )}
      {gameBusy && (
        <div className="auth-notice">
          游戏正在准备或运行，请结束游戏后再安装新版本。
        </div>
      )}
      {(status.stage !== "idle" || working) && (
        <section className={`card download-task ${status.stage}`}>
          <div className="card-heading">
            <span className="download-heading">
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : status.stage === "complete" ? (
                <Check size={17} />
              ) : status.stage === "error" ? (
                <TriangleAlert size={17} />
              ) : (
                <Download size={17} />
              )}
              {busy
                ? "正在安装"
                : status.stage === "complete"
                  ? "安装完成"
                  : status.stage === "cancelled"
                    ? "安装已取消"
                    : "安装遇到问题"}
              {status.version && ` · ${status.version}`}
            </span>
            {busy && (
              <button
                className="btn compact"
                disabled={working}
                onClick={async () => {
                  try {
                    await api("download_cancel");
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                <X size={13} />
                取消安装
              </button>
            )}
          </div>
          <div className="card-content">
            <p className="muted" role="status">
              {status.message || "正在准备安装…"}
            </p>
            {busy && (
              <>
                <div
                  className={`download-progress ${progress === null ? "indeterminate" : ""}`}
                  role="progressbar"
                  aria-label="安装进度"
                  aria-valuenow={
                    progress === null
                      ? undefined
                      : Math.round(Math.min(1, progress) * 100)
                  }
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <i
                    style={
                      progress === null
                        ? undefined
                        : {
                            width: `${Math.min(100, Math.max(0, progress * 100))}%`,
                          }
                    }
                  />
                </div>
                <div className="download-progress-details">
                  <span>
                    {status.total > 0
                      ? `${status.completed} / ${status.total} 项`
                      : "正在处理安装文件"}
                  </span>
                  <span>
                    {status.bytes_total > 0
                      ? `${size(status.bytes_done)} / ${size(status.bytes_total)}`
                      : status.bytes_done > 0
                        ? `已下载 ${size(status.bytes_done)}`
                        : progress === null
                          ? "请稍候"
                          : ""}
                  </span>
                </div>
              </>
            )}
            {status.stage === "complete" && (
              <p className="muted">
                版本已加入游戏库，可返回启动页开始游戏。
                {status.result &&
                  `运行此版本需要 Java ${status.result.java_major}。`}
              </p>
            )}
          </div>
        </section>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={17} />
          <span>{error}</span>
          <button
            className="icon-button"
            onClick={() => setError("")}
            aria-label="关闭提示"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {choice && (
        <section className="card download-confirm" ref={confirmation}>
          <div className="card-heading">
            <span className="download-heading">安装 {choice.id}</span>
            <button
              className="icon-button"
              aria-label="取消选择"
              onClick={() => setChoice(null)}
            >
              <X size={15} />
            </button>
          </div>
          <div className="card-content">
            <p className="muted">
              将下载原版游戏及其运行所需的文件。完成后会自动选择这个版本。
            </p>
            <button
              className="btn primary"
              disabled={busy || gameBusy || !native || ids.has(choice.id)}
              onClick={start}
            >
              <Download size={15} />
              确认安装
            </button>
          </div>
        </section>
      )}
      <section className="card">
        <div className="card-heading">
          <span className="download-heading">
            <Download size={17} />
            Minecraft 原版
          </span>
          <button
            className="text-action"
            disabled={loading || busy || !native}
            onClick={() => void loadCatalog(true)}
          >
            <RefreshCw size={13} />
            刷新目录
          </button>
        </div>
        <div className="card-content download-catalog">
          <div className="download-filters">
            {[
              ["release", "正式版"],
              ["snapshot", "快照版"],
              ["old", "旧版"],
              ["all", "全部"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "selected" : ""}
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
              >
                {label}
              </button>
            ))}
            <span>{installed.length} 个已安装版本</span>
          </div>
          <label className="search-box download-search">
            <Search size={15} />
            <input
              aria-label="搜索可安装版本"
              placeholder="搜索版本，例如 1.21"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="version-list download-version-list">
            {loading ? (
              <div className="download-empty">
                <LoaderCircle className="spin" size={22} />
                <p>正在获取官方版本目录…</p>
              </div>
            ) : visible.length ? (
              visible.map((entry) => (
                <button
                  key={entry.id}
                  className={`version-row ${choice?.id === entry.id ? "chosen" : ""}`}
                  disabled={busy || gameBusy || ids.has(entry.id)}
                  onClick={() => setChoice(entry)}
                >
                  <span className="cube">
                    <Box size={22} strokeWidth={1.5} />
                  </span>
                  <div>
                    <strong>{entry.id}</strong>
                    <small>
                      {kindName(entry.kind)} ·{" "}
                      {new Date(entry.release_time).toLocaleDateString("zh-CN")}
                    </small>
                  </div>
                  {ids.has(entry.id) ? (
                    <span className="tag">已安装</span>
                  ) : (
                    <Download size={16} />
                  )}
                </button>
              ))
            ) : (
              <div className="download-empty">
                <Box size={30} strokeWidth={1.3} />
                <p>
                  {native
                    ? catalog.length
                      ? "没有符合条件的版本"
                      : "暂未获取到版本目录"
                    : "版本目录将在桌面应用中显示"}
                </p>
                {native && !catalog.length && (
                  <button className="btn compact" onClick={() => void loadCatalog(true)}>
                    重新获取
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
