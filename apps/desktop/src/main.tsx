import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Play,
  Download,
  Settings as SettingsIcon,
  Wrench,
  Minus,
  X,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Check,
  RefreshCw,
  Search,
  Box,
  UserRound,
  Info,
  FileText,
  Cpu,
  ArrowLeft,
  TriangleAlert,
  LoaderCircle,
  SlidersHorizontal,
  Square,
  ExternalLink,
} from "lucide-react";
import "./style.css";
import { DownloadPanel, idleDownload } from "./DownloadPanel";
type Instance = {
  id: string;
  minecraft_version: string;
  loader: string;
  java_major: number;
  mod_count: number;
  isolated: boolean;
};
type Settings = {
  root: string;
  player: string;
  memory_gib: number;
  selected: string | null;
  overrides: Record<string, number>;
};
type Status = {
  stage: string;
  message: string;
  version: string | null;
  pid: number | null;
  exit_code: number | null;
};
type AuthState = {
  client_id: string;
  selected: string | null;
  accounts: {
    profile: { id: string; uuid: string; name: string; expires_at: number };
    remembered: boolean;
  }[];
  stage: string;
  message: string;
  challenge: {
    user_code: string;
    verification_uri: string;
    expires_in: number;
  } | null;
  warning: string | null;
};
const emptyAuth: AuthState = {
  client_id: "",
  selected: null,
  accounts: [],
  stage: "idle",
  message: "",
  challenge: null,
  warning: null,
};
type State = {
  settings: Settings;
  instances: Instance[];
  status: Status;
  auth: AuthState;
};
type Inspection = {
  java: string;
  game_dir: string;
  arguments: number;
  log_path: string;
};
const native = isTauri();
let preview: State | undefined;
async function api<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (!preview)
    preview = await fetch("/preview.json").then((r) => {
      if (!r.ok)
        throw new Error("预览数据不存在，请先运行 npm run preview:data");
      return r.json();
    });
  if (command === "bootstrap")
    return { ...preview!, auth: preview!.auth || emptyAuth } as T;
  if (command === "auth_status") return (preview!.auth || emptyAuth) as T;
  if (command === "process_status") return preview!.status as T;
  if (command === "download_catalog") return [] as T;
  if (command === "download_status") return idleDownload as T;
  if (command === "save_settings") {
    preview!.settings = args!.settings as Settings;
    return undefined as T;
  }
  throw new Error("界面预览中不可使用此操作，请打开桌面应用。");
}
function Card({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={"card " + (!open ? "collapsed" : "")}>
      <div className="card-heading">
        <button
          className="card-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {icon}
          <span>{title}</span>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {action}
      </div>
      {open && <div className="card-content">{children}</div>}
    </section>
  );
}
function Cube({ forge = false }: { forge?: boolean }) {
  return (
    <span className={"cube " + (forge ? "forge" : "")}>
      <Box size={25} strokeWidth={1.5} />
    </span>
  );
}
function App() {
  const [data, setData] = useState<State | null>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("launch"),
    [dialog, setDialog] = useState<"versions" | "instance" | "accounts" | null>(
      null,
    ),
    [query, setQuery] = useState(""),
    [toast, setToast] = useState(""),
    [inspection, setInspection] = useState<Inspection | null>(null),
    [checking, setChecking] = useState(false),
    [logs, setLogs] = useState("点击刷新，读取本次启动日志。"),
    [draft, setDraft] = useState<Settings | null>(null),
    [override, setOverride] = useState(6);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [remember, setRemember] = useState(true);
  const [clientId, setClientId] = useState("");
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState("");
  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 4500);
  };
  async function load() {
    try {
      const next = await api<State>("bootstrap");
      if (
        !next.instances.some((i) => i.id === next.settings.selected) &&
        next.instances.length
      )
        next.settings.selected =
          next.instances.find((x) => x.mod_count > 0)?.id ||
          next.instances[0].id;
      next.auth ||= emptyAuth;
      setClientId(next.auth.client_id);
      setData(next);
      setDraft(next.settings);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(
      () =>
        api<Status>("process_status")
          .then((status) => setData((d) => (d ? { ...d, status } : d)))
          .catch(() => {}),
      900,
    );
    const a = setInterval(
      () =>
        api<AuthState>("auth_status")
          .then((auth) => setData((d) => (d ? { ...d, auth } : d)))
          .catch(() => {}),
      1000,
    );
    return () => {
      clearInterval(t);
      clearInterval(a);
    };
  }, []);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDialog(null);
      if (e.key === "Tab") {
        const modal = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!modal) return;
        const items = [
          ...modal.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]',
          ),
        ];
        const visible = items.filter(
          (item) => item.getClientRects().length > 0,
        );
        const first = visible[0],
          last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = setTimeout(
      () =>
        document.querySelector<HTMLElement>('[role="dialog"] button')?.focus(),
      0,
    );
    return () => {
      clearTimeout(t);
      previous?.focus();
    };
  }, [dialog]);
  async function authAction(command: string, args?: Record<string, unknown>) {
    setAuthWorking(true);
    setAuthError("");
    try {
      await api(command, args);
      const auth = await api<AuthState>("auth_status");
      setData((d) => (d ? { ...d, auth } : d));
    } catch (e) {
      setAuthError(String(e));
    } finally {
      setAuthWorking(false);
    }
  }
  const activeAccount = data?.auth.accounts.find(
    (a) => a.profile.id === data.auth.selected,
  );
  const authenticating =
    !!data?.auth.challenge ||
    [
      "preparing",
      "waiting",
      "starting",
      "requesting_code",
      "polling",
      "authenticating",
      "exchanging",
      "refreshing",
    ].includes(data?.auth.stage || "");
  const selected = data?.instances.find((i) => i.id === data.settings.selected),
    busy =
      data?.status.stage === "preparing" || data?.status.stage === "running";
  async function save(cfg: Settings) {
    await api("save_settings", { settings: cfg });
    setData((d) => (d ? { ...d, settings: cfg } : d));
    setDraft(cfg);
  }
  async function pick(id: string) {
    if (!data) return;
    try {
      await save({ ...data.settings, selected: id });
      setDialog(null);
      setInspection(null);
    } catch (e) {
      notify(String(e));
    }
  }
  async function launch() {
    if (!data || !selected || downloadBusy) return;
    try {
      await save(data.settings);
      await api("launch_game", { id: selected.id });
      setData((d) =>
        d
          ? {
              ...d,
              status: {
                ...d.status,
                stage: "preparing",
                message: "正在检查启动环境…",
              },
            }
          : d,
      );
    } catch (e) {
      notify(String(e));
    }
  }
  async function open(kind: string) {
    try {
      await api("open_folder", { kind, id: selected?.id || null });
    } catch (e) {
      notify(String(e));
    }
  }
  async function inspect() {
    if (!selected) return;
    setChecking(true);
    setInspection(null);
    try {
      setInspection(
        await api<Inspection>("inspect_instance", { id: selected.id }),
      );
    } catch (e) {
      notify(String(e));
    } finally {
      setChecking(false);
    }
  }
  async function readLogs() {
    try {
      setLogs(await api<string>("read_log"));
    } catch (e) {
      setLogs(String(e));
    }
  }
  function instanceSettings() {
    if (!selected || !data) return;
    setInspection(null);
    setOverride(
      data.settings.overrides[selected.id] || data.settings.memory_gib,
    );
    setDialog("instance");
  }
  function setPlayer(player: string) {
    setData((d) => (d ? { ...d, settings: { ...d.settings, player } } : d));
  }
  return (
    <div className="app-shell">
      <header
        className="titlebar"
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if (
            native &&
            (e.target as HTMLElement).hasAttribute("data-tauri-drag-region")
          )
            getCurrentWindow().toggleMaximize();
        }}
      >
        <div className="brand" data-tauri-drag-region>
          <span className="wordmark">PCL</span>
          <span className="linux-badge">Linux</span>
        </div>
        <nav aria-label="主导航">
          {[
            { id: "launch", text: "启动", icon: Play },
            { id: "download", text: "下载", icon: Download },
            { id: "settings", text: "设置", icon: SettingsIcon },
            { id: "tools", text: "工具", icon: Wrench },
          ].map((n) => (
            <button
              key={n.id}
              className={tab === n.id ? "active" : ""}
              onClick={() => {
                setTab(n.id);
                if (n.id === "tools") readLogs();
                if (n.id === "settings" && data) setDraft(data.settings);
              }}
            >
              <n.icon size={16} />
              {n.text}
            </button>
          ))}
        </nav>
        <div className="window-buttons">
          <button
            title="最小化"
            aria-label="最小化"
            onClick={() => native && getCurrentWindow().minimize()}
          >
            <Minus size={17} />
          </button>
          <button
            title="关闭启动器"
            aria-label="关闭启动器"
            onClick={() => native && getCurrentWindow().close()}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      {!native && (
        <div className="preview-strip">
          界面预览 · 当前游戏目录的只读快照 · 启动功能请使用桌面应用
        </div>
      )}
      {error ? (
        <div className="initial-error">
          <TriangleAlert />
          <h2>无法读取游戏目录</h2>
          <p>{error}</p>
          <button className="btn" onClick={load}>
            重新读取
          </button>
        </div>
      ) : !data ? (
        <div className="loading">
          <LoaderCircle className="spin" />
          正在读取游戏版本…
        </div>
      ) : (
        <div className="body-layout">
          <aside
            className={tab === "launch" ? "launch-sidebar" : "section-sidebar"}
          >
            {tab === "launch" ? (
              <>
                <div className="account-panel">
                  <div className="avatar" aria-hidden="true">
                    <div className="hair" />
                    <div className="eyes" />
                    <div className="mouth" />
                  </div>
                  <div className="account-heading">
                    {activeAccount ? activeAccount.profile.name : "离线玩家"}{" "}
                    <span
                      className={
                        "small-badge " + (activeAccount ? "premium-badge" : "")
                      }
                    >
                      {activeAccount ? "正版" : "本地"}
                    </span>
                  </div>
                  {!activeAccount && (
                    <>
                      <label className="player-label" htmlFor="player">
                        玩家名称
                      </label>
                      <div className="player-input">
                        <UserRound size={16} />
                        <input
                          id="player"
                          value={data.settings.player}
                          onChange={(e) => setPlayer(e.target.value)}
                          maxLength={16}
                          spellCheck={false}
                        />
                      </div>
                    </>
                  )}
                  <p className="account-note">
                    {activeAccount
                      ? "Microsoft · Minecraft Java 版"
                      : "用于单人游戏与离线服务器"}
                  </p>
                  <button
                    className="btn compact account-manage"
                    onClick={() => setDialog("accounts")}
                  >
                    <UserRound size={14} />
                    管理账号
                  </button>
                </div>
                <div className="launch-controls">
                  {busy ? (
                    <div className="launching-box">
                      <LoaderCircle className="spin" size={30} />
                      <strong>
                        {data.status.stage === "preparing"
                          ? "正在准备游戏"
                          : "游戏正在运行"}
                      </strong>
                      <p>{data.status.message}</p>
                      {data.status.pid && <span>进程 {data.status.pid}</span>}
                      <button
                        className="btn danger"
                        onClick={async () => {
                          if (
                            window.confirm(
                              "确认结束游戏进程？未保存的游戏进度可能丢失。",
                            )
                          )
                            await api("stop_game");
                        }}
                      >
                        结束进程
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className="launch-button"
                        disabled={!selected || !native || downloadBusy}
                        onClick={launch}
                      >
                        <span>
                          <Play size={18} fill="currentColor" />
                          启动游戏
                        </span>
                        <small>
                          {downloadBusy
                            ? "正在安装游戏，请稍候"
                            : selected?.id || "请选择游戏版本"}
                        </small>
                      </button>
                      <div className="launch-secondary">
                        <button
                          className="btn"
                          onClick={() => {
                            setQuery("");
                            setDialog("versions");
                          }}
                        >
                          版本选择
                        </button>
                        <button
                          className="btn"
                          disabled={!selected}
                          onClick={instanceSettings}
                        >
                          版本设置
                        </button>
                      </div>
                    </>
                  )}
                  <div
                    className={
                      "sidebar-status " +
                      (data.status.stage === "error" ? "is-error" : "")
                    }
                  >
                    <i />
                    {data.status.stage === "error"
                      ? "启动遇到问题，请查看日志"
                      : busy
                        ? "请等待游戏完成加载"
                        : data.status.stage === "exited"
                          ? "游戏已退出"
                          : "准备就绪"}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="section-label">
                  {tab === "download"
                    ? "游戏与内容"
                    : tab === "settings"
                      ? "启动器设置"
                      : "实用工具"}
                </div>
                <button className="side-item selected">
                  {tab === "download" ? (
                    <Download size={17} />
                  ) : tab === "settings" ? (
                    <SlidersHorizontal size={17} />
                  ) : (
                    <FileText size={17} />
                  )}{" "}
                  {tab === "download"
                    ? "下载安装"
                    : tab === "settings"
                      ? "启动设置"
                      : "游戏日志"}
                </button>
                <div className="side-bottom">
                  <span className="tiny-dot" /> Linux 原生实验版{" "}
                  <small>0.2.0</small>
                </div>
              </>
            )}
          </aside>
          <main className="content">
            {tab === "launch" && (
              <>
                <div className="page-intro">
                  <span>欢迎回来</span>
                  <h1>开启下一段方块旅程</h1>
                  <p>选择熟悉的世界，然后出发。</p>
                </div>
                {data.status.stage === "error" && (
                  <button
                    className="error-banner"
                    onClick={() => {
                      setTab("tools");
                      readLogs();
                    }}
                  >
                    <TriangleAlert size={18} />
                    <span>{data.status.message}</span>
                    <ChevronRight size={18} />
                  </button>
                )}
                <Card
                  title="当前游戏"
                  icon={<Play size={17} />}
                  action={
                    <button
                      className="text-action"
                      onClick={() => setDialog("versions")}
                    >
                      切换版本 <ChevronRight size={14} />
                    </button>
                  }
                >
                  {selected ? (
                    <>
                      <div className="current-instance">
                        <Cube forge={selected.loader !== "Vanilla"} />
                        <div>
                          <h2>{selected.id}</h2>
                          <p>
                            Minecraft {selected.minecraft_version}{" "}
                            <span>·</span> {selected.loader}
                          </p>
                        </div>
                      </div>
                      <div className="instance-facts">
                        <span>
                          <Box size={14} />
                          {selected.mod_count} 个模组
                        </span>
                        <span>
                          <Cpu size={14} />
                          Java {selected.java_major}
                        </span>
                        <span>
                          <FolderOpen size={14} />
                          {selected.isolated ? "版本独立目录" : "共享游戏目录"}
                        </span>
                      </div>
                      <div className="card-foot">
                        <button onClick={instanceSettings}>
                          管理这个版本 <ChevronRight size={14} />
                        </button>
                        <button onClick={() => open("instance")}>
                          打开文件夹 <FolderOpen size={14} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="muted">
                      没有发现已安装版本，请在设置中选择游戏目录。
                    </p>
                  )}
                </Card>
                <Card title="你的游戏库" icon={<FolderOpen size={17} />}>
                  <div className="library-summary">
                    <strong>
                      {data.instances.length}
                      <small> 个版本</small>
                    </strong>
                    <button
                      className="btn compact"
                      onClick={() => setDialog("versions")}
                    >
                      浏览全部
                    </button>
                  </div>
                  <p className="path-text" title={data.settings.root}>
                    {data.settings.root}
                  </p>
                  <p className="muted">
                    存档、模组与资源保存在各自的游戏目录中。
                  </p>
                </Card>
                <Card title="关于这个版本" icon={<Info size={17} />}>
                  <p className="welcome-copy">PCL 风格，Linux 原生体验。</p>
                  <p className="muted">
                    支持原版下载安装、已有游戏启动与启动日志。正版登录暂未开放；模组加载器自动安装尚未开放。
                  </p>
                  <div className="notice-line">
                    <span className="tiny-dot" /> 独立实验项目 · 非 PCL CE
                    官方发行
                  </div>
                </Card>
              </>
            )}
            {tab === "settings" && draft && (
              <>
                <div className="page-heading">
                  <h1>启动设置</h1>
                  <p>设置会保存在当前项目中，下次打开继续使用。</p>
                </div>
                <Card title="游戏目录" icon={<FolderOpen size={17} />}>
                  <label className="field-label" htmlFor="game-root">
                    Minecraft 数据目录
                  </label>
                  <input
                    className="field"
                    id="game-root"
                    disabled={downloadBusy || busy}
                    value={draft.root}
                    onChange={(e) =>
                      setDraft({ ...draft, root: e.target.value })
                    }
                  />
                  <p className="muted">
                    已有游戏请选择包含 versions、libraries 和 assets
                    的目录；新安装也可使用空文件夹。
                  </p>
                </Card>
                <Card title="Java 与内存" icon={<Cpu size={17} />}>
                  <div className="setting-row">
                    <div>
                      <strong>Java 自动选择</strong>
                      <p className="muted">优先匹配游戏要求的主版本</p>
                    </div>
                    <span className="tag">自动</span>
                  </div>
                  <div className="setting-row">
                    <strong>默认最大内存</strong>
                    <span className="memory-value">
                      {draft.memory_gib}
                      <small> GiB</small>
                    </span>
                  </div>
                  <input
                    aria-label="默认最大内存"
                    className="range"
                    type="range"
                    min="2"
                    max="16"
                    value={draft.memory_gib}
                    onChange={(e) =>
                      setDraft({ ...draft, memory_gib: Number(e.target.value) })
                    }
                  />
                  <div className="range-labels">
                    <span>2 GiB</span>
                    <span>16 GiB</span>
                  </div>
                  <p className="muted">版本设置中的独立内存值会覆盖此项。</p>
                </Card>
                <button
                  className="btn primary"
                  disabled={downloadBusy || busy}
                  onClick={async () => {
                    try {
                      await save(draft);
                      await load();
                      notify("设置已保存");
                    } catch (e) {
                      notify(String(e));
                    }
                  }}
                >
                  <Check size={16} />
                  保存设置
                </button>
              </>
            )}
            <div hidden={tab !== "download"}>
              <DownloadPanel
                api={api}
                native={native}
                installed={data.instances}
                gameBusy={!!busy}
                onInstalled={load}
                onBusyChange={setDownloadBusy}
              />
            </div>
            {tab === "tools" && (
              <>
                <div className="page-heading">
                  <h1>游戏日志</h1>
                  <p>
                    {data.status.version || "本次会话"} · {data.status.message}
                  </p>
                </div>
                <div className="toolbar">
                  <button className="btn compact" onClick={readLogs}>
                    <RefreshCw size={14} />
                    刷新日志
                  </button>
                  <button className="btn compact" onClick={() => open("logs")}>
                    <FolderOpen size={14} />
                    打开日志目录
                  </button>
                </div>
                <pre className="log-view">{logs}</pre>
              </>
            )}
            <footer>
              PCL Linux <span>·</span> 让每一次出发都简单一点
            </footer>
          </main>
        </div>
      )}
      {dialog && data && (
        <div
          className="modal-shade"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === "versions"
                ? "选择游戏版本"
                : dialog === "accounts"
                  ? "管理账号"
                  : "版本设置"
            }
          >
            <div className="modal-heading">
              <h2>
                {dialog === "versions"
                  ? "选择游戏版本"
                  : dialog === "accounts"
                    ? "管理账号"
                    : "版本设置"}
              </h2>
              <button
                aria-label="关闭弹窗"
                className="icon-button"
                onClick={() => setDialog(null)}
              >
                <X size={20} />
              </button>
            </div>
            {dialog === "accounts" ? (
              <div className="account-dialog">
                <p className="muted">
                  选择游戏身份，或添加 Microsoft 正版账号。
                </p>
                {busy && (
                  <div className="auth-notice" role="status">
                    游戏正在准备或运行。退出游戏后即可切换、移除或添加账号，以及修改应用设置。
                  </div>
                )}
                <button
                  className={
                    "version-row " + (!data.auth.selected ? "chosen" : "")
                  }
                  disabled={!native || authWorking || authenticating || busy}
                  onClick={() => authAction("auth_select", { id: null })}
                >
                  <UserRound size={23} />
                  <div>
                    <strong>离线玩家 · {data.settings.player}</strong>
                    <small>单人游戏与离线服务器</small>
                  </div>
                  {!data.auth.selected && <Check size={18} />}
                </button>
                {data.auth.accounts.map((a) => (
                  <div className="saved-account" key={a.profile.id}>
                    <button
                      className={
                        "version-row " +
                        (a.profile.id === data.auth.selected ? "chosen" : "")
                      }
                      disabled={
                        !native || authWorking || authenticating || busy
                      }
                      onClick={() =>
                        authAction("auth_select", { id: a.profile.id })
                      }
                    >
                      <UserRound size={23} />
                      <div>
                        <strong>
                          {a.profile.name}{" "}
                          <span className="small-badge premium-badge">
                            正版
                          </span>
                        </strong>
                        <small>
                          Microsoft ·{" "}
                          {a.remembered ? "已记住登录" : "仅本次会话"}
                        </small>
                      </div>
                      {a.profile.id === data.auth.selected && (
                        <Check size={18} />
                      )}
                    </button>
                    <button
                      className="icon-button"
                      title="移除账号"
                      aria-label={"移除账号 " + a.profile.name}
                      disabled={
                        !native || authWorking || authenticating || busy
                      }
                      onClick={() =>
                        authAction("auth_remove", { id: a.profile.id })
                      }
                    >
                      <X size={17} />
                    </button>
                  </div>
                ))}
                <div className="auth-section">
                  <h3>添加 Microsoft 账号</h3>
                  <p className="muted">
                    在微软官方网页完成登录，并确认拥有 Minecraft Java 版。
                  </p>
                  {!data.auth.client_id && (
                    <div className="auth-notice">
                      此自制版本尚未配置 Microsoft
                      应用。开发者完成应用注册与审核后，才能使用正版登录。
                    </div>
                  )}
                  <label className="remember-login">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      disabled={authWorking || authenticating}
                    />
                    记住登录
                  </label>
                  {data.auth.challenge ? (
                    <div className="device-login">
                      <span>在微软登录网页输入以下设备代码</span>
                      <strong className="device-code">
                        {data.auth.challenge.user_code}
                      </strong>
                      <p>
                        代码有效期约{" "}
                        {Math.ceil(data.auth.challenge.expires_in / 60)}{" "}
                        分钟。网页授权完成后，启动器会继续登录。
                      </p>
                      <div className="toolbar">
                        <button
                          className="btn primary"
                          disabled={!native || authWorking}
                          onClick={() => authAction("auth_open_browser")}
                        >
                          <ExternalLink size={15} />
                          打开微软登录网页
                        </button>
                        <button
                          className="btn"
                          disabled={!native || authWorking}
                          onClick={() => authAction("auth_cancel")}
                        >
                          取消登录
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="toolbar">
                      <button
                        className="btn primary"
                        disabled={
                          !native ||
                          !data.auth.client_id ||
                          authWorking ||
                          authenticating ||
                          busy
                        }
                        onClick={() => authAction("auth_start", { remember })}
                      >
                        {authenticating || authWorking ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <UserRound size={15} />
                        )}
                        登录 Microsoft 账号
                      </button>
                      {authenticating && (
                        <button
                          className="btn"
                          disabled={!native || authWorking}
                          onClick={() => authAction("auth_cancel")}
                        >
                          取消登录
                        </button>
                      )}
                    </div>
                  )}
                  {data.auth.message && (
                    <div
                      role="status"
                      className={
                        "auth-progress " +
                        (data.auth.stage === "error" ? "auth-error" : "")
                      }
                    >
                      {authenticating && (
                        <LoaderCircle size={15} className="spin" />
                      )}
                      {data.auth.message}
                    </div>
                  )}
                  {data.auth.warning && (
                    <div className="auth-notice" role="status">
                      {data.auth.warning}
                    </div>
                  )}
                  {authError && (
                    <p className="auth-error" role="alert">
                      {authError}
                    </p>
                  )}
                  {!native && (
                    <p className="muted">
                      界面预览无法发起真实登录，请使用桌面应用。
                    </p>
                  )}
                </div>
                <details className="auth-settings">
                  <summary>应用注册设置（开发者）</summary>
                  <p className="muted">
                    填写你自行注册并获准用于 Minecraft
                    登录的公开应用编号（Client
                    ID）。这不是密码。没有自己的组织目录的个人 Microsoft
                    账号，可先创建 Azure 免费账号及目录，再注册应用。
                  </p>
                  <label className="field-label" htmlFor="auth-client-id">
                    Microsoft 应用 Client ID
                  </label>
                  <input
                    id="auth-client-id"
                    className="field"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    spellCheck={false}
                    disabled={authWorking || authenticating}
                  />
                  <div className="toolbar">
                    <button
                      className="btn compact primary"
                      disabled={
                        !native ||
                        authWorking ||
                        authenticating ||
                        busy ||
                        !clientId.trim()
                      }
                      onClick={() =>
                        authAction("auth_configure", {
                          clientId: clientId.trim(),
                        })
                      }
                    >
                      <Check size={14} />
                      保存应用编号
                    </button>
                    <button
                      className="btn compact"
                      disabled={!native}
                      onClick={() =>
                        authAction("auth_open_help", { kind: "register" })
                      }
                    >
                      <ExternalLink size={14} />
                      官方应用注册
                    </button>
                    <button
                      className="btn compact"
                      disabled={!native}
                      onClick={() =>
                        authAction("auth_open_help", { kind: "tenant" })
                      }
                    >
                      <ExternalLink size={14} />
                      Azure 免费账号与目录
                    </button>
                    <button
                      className="btn compact"
                      disabled={!native}
                      onClick={() =>
                        authAction("auth_open_help", { kind: "review" })
                      }
                    >
                      <ExternalLink size={14} />
                      Minecraft 审核说明
                    </button>
                  </div>
                </details>
              </div>
            ) : dialog === "versions" ? (
              <>
                <div className="search-box">
                  <Search size={17} />
                  <input
                    autoFocus
                    aria-label="搜索版本"
                    placeholder="搜索版本名称…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button
                    className="icon-button"
                    title="重新扫描"
                    onClick={load}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
                <div className="version-list">
                  {data.instances
                    .filter((v) =>
                      v.id.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((v) => (
                      <button
                        key={v.id}
                        className={
                          "version-row " +
                          (v.id === selected?.id ? "chosen" : "")
                        }
                        onClick={() => pick(v.id)}
                      >
                        <Cube forge={v.loader !== "Vanilla"} />
                        <div>
                          <strong>{v.id}</strong>
                          <small>
                            {v.minecraft_version} · {v.loader} · {v.mod_count}{" "}
                            个模组
                          </small>
                        </div>
                        {v.id === selected?.id ? (
                          <Check size={18} />
                        ) : (
                          <ChevronRight size={16} />
                        )}
                      </button>
                    ))}
                  {!data.instances.some((v) =>
                    v.id.toLowerCase().includes(query.toLowerCase()),
                  ) && <p className="empty">没有找到匹配的版本</p>}
                </div>
                <div className="modal-footer">
                  共 {data.instances.length} 个版本 <span>选择后即可启动</span>
                </div>
              </>
            ) : (
              selected && (
                <div className="instance-dialog">
                  <div className="current-instance">
                    <Cube forge={selected.loader !== "Vanilla"} />
                    <div>
                      <h2>{selected.id}</h2>
                      <p>
                        {selected.minecraft_version} · {selected.loader}
                      </p>
                    </div>
                  </div>
                  <label className="setting-row" htmlFor="instance-memory">
                    <strong>此版本最大内存</strong>
                    <span>
                      <input
                        id="instance-memory"
                        className="number-field"
                        type="number"
                        min="2"
                        max="64"
                        value={override}
                        onChange={(e) => setOverride(Number(e.target.value))}
                      />{" "}
                      GiB
                    </span>
                  </label>
                  <p className="muted">
                    只影响这个版本。Java 根据游戏要求自动选择。
                  </p>
                  <div className="toolbar">
                    <button
                      className="btn primary"
                      onClick={async () => {
                        try {
                          await save({
                            ...data.settings,
                            overrides: {
                              ...data.settings.overrides,
                              [selected.id]: override,
                            },
                          });
                          notify("版本设置已保存");
                          setDialog(null);
                        } catch (e) {
                          notify(String(e));
                        }
                      }}
                    >
                      <Check size={15} />
                      保存
                    </button>
                    <button
                      className="btn"
                      disabled={checking || !native}
                      onClick={inspect}
                    >
                      {checking ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <Check size={15} />
                      )}
                      检查启动环境
                    </button>
                  </div>
                  {inspection && (
                    <div className="check-result">
                      <strong>
                        <Check size={15} />
                        启动参数与依赖检查通过
                      </strong>
                      <p>Java：{inspection.java}</p>
                      <p>游戏目录：{inspection.game_dir}</p>
                      <p>启动参数：{inspection.arguments} 项</p>
                    </div>
                  )}
                </div>
              )
            )}
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Info size={17} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
