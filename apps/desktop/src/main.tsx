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
  Rocket,
  Coffee,
  BookMarked,
  Palette,
  Globe,
  MonitorCog,
  MessageCircle,
  ScrollText,
  Layers,
  Puzzle,
  Sparkles,
  Blocks,
  Heart,
  Gauge,
  Trophy,
  Cat,
  FlaskConical,
  Gift,
  FolderInput,
  PackagePlus,
  Image,
  Server,
  ArrowRight,
  Link2,
  Waypoints,
} from "lucide-react";
import { DownloadPanel, idleDownload } from "./DownloadPanel";
import defaultSkin from "./assets/game-icons/steve.png";
import { Toolbox } from "./Toolbox";
import { SettingsPanel } from "./SettingsPanel";
import {
  InstancePanel,
  InstanceSelection,
  instancePages,
  InstanceIcon,
} from "./InstancesPanel";
import "./style.css";
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
let preview:
  | (State & {
      catalog?: unknown[];
      system?: unknown;
      java?: unknown[];
      resources?: unknown[];
      modrinth?: unknown;
    })
  | undefined;
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
  if (command === "download_catalog") return (preview!.catalog || []) as T;
  if (command === "modrinth_search") return preview!.modrinth as T;
  if (command === "system_info") return preview!.system as T;
  if (command === "java_list") return (preview!.java || []) as T;
  if (command === "instance_resources") return (preview!.resources || []) as T;
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
  const [screen, setScreen] = useState<"home" | "versions" | "instance">(
    "home",
  );
  const [instancePage, setInstancePage] = useState("overview");
  const [settingsPage, setSettingsPage] = useState("launch");
  const [downloadPage, setDownloadPage] = useState("minecraft");
  const [downloadBusy, setDownloadBusy] = useState(false);
  useEffect(() => {
    document.querySelector(".content")?.scrollTo({ top: 0 });
  }, [tab, screen, instancePage, settingsPage, downloadPage]);
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
      setScreen("home");
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
    setInstancePage("overview");
    setScreen("instance");
  }
  function setPlayer(player: string) {
    setData((d) => (d ? { ...d, settings: { ...d.settings, player } } : d));
  }
  const downloadItems = [
    { id: "minecraft", label: "Minecraft", icon: Blocks },
    { id: "mods", label: "模组", group: "社区资源", icon: Puzzle },
    { id: "modpacks", label: "整合包", icon: Box, disabled: true },
    { id: "datapacks", label: "数据包", icon: FileText, disabled: true },
    { id: "resourcepacks", label: "资源包", icon: Layers, disabled: true },
    { id: "shaders", label: "光影包", icon: Sparkles, disabled: true },
    { id: "worlds", label: "世界", icon: Globe, disabled: true },
    { id: "favorites", label: "收藏夹", icon: Heart, disabled: true },
    {
      id: "installer-minecraft",
      label: "Minecraft",
      group: "安装包",
      icon: Box,
      disabled: true,
    },
    { id: "OptiFine", label: "OptiFine", icon: Gauge, disabled: true },
    { id: "Forge", label: "Forge", icon: Trophy, disabled: true },
    { id: "NeoForge", label: "NeoForge", icon: Cat, disabled: true },
    { id: "Cleanroom", label: "Cleanroom", icon: FlaskConical, disabled: true },
    { id: "Fabric", label: "Fabric", icon: ScrollText, disabled: true },
    {
      id: "Legacy Fabric",
      label: "Legacy Fabric",
      icon: ScrollText,
      disabled: true,
    },
    { id: "LabyMod", label: "LabyMod", icon: Box, disabled: true },
    { id: "LiteLoader", label: "LiteLoader", icon: Box, disabled: true },
  ];
  const settingsItems = [
    { id: "launch", label: "启动", group: "游戏", icon: Rocket },
    { id: "java", label: "Java", icon: Coffee },
    { id: "manage", label: "管理", icon: BookMarked, disabled: true },
    {
      id: "network",
      label: "联机",
      group: "工具",
      icon: Waypoints,
      disabled: true,
    },
    {
      id: "personalize",
      label: "个性化",
      group: "启动器",
      icon: Palette,
      disabled: true,
    },
    { id: "language", label: "语言", icon: Globe, disabled: true },
    { id: "misc", label: "杂项", icon: MonitorCog, disabled: true },
    {
      id: "about",
      label: "软件信息",
      group: "关于",
      icon: Info,
      disabled: true,
    },
    { id: "update", label: "软件更新", icon: RefreshCw, disabled: true },
    { id: "feedback", label: "反馈", icon: MessageCircle, disabled: true },
    { id: "logs", label: "查看日志", icon: ScrollText },
  ];
  function menu(
    items: {
      id: string;
      label: string;
      group?: string;
      icon: React.ElementType;
      disabled?: boolean;
    }[],
    value: string,
    choose: (s: string) => void,
  ) {
    return items.map((item) => (
      <React.Fragment key={item.id}>
        {item.group && <div className="section-label">{item.group}</div>}
        <button
          className={"side-item " + (value === item.id ? "selected" : "")}
          disabled={item.disabled}
          title={item.disabled ? "此页面尚未开放" : undefined}
          onClick={() => choose(item.id)}
        >
          <item.icon size={19} />
          <span>{item.label}</span>
        </button>
      </React.Fragment>
    ));
  }
  return (
    <div
      className={
        "app-shell ce-shell " +
        (screen !== "home"
          ? screen === "versions"
            ? "selection-shell"
            : "instance-shell"
          : `${tab}-shell`)
      }
    >
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
        {screen === "home" ? (
          <>
            <div className="brand" data-tauri-drag-region>
              <span className="wordmark">PCL</span>
              <span className="ce-badge">CE</span>
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
                    if (n.id === "settings" && data) setDraft(data.settings);
                  }}
                >
                  <n.icon size={17} />
                  {n.text}
                </button>
              ))}
            </nav>
          </>
        ) : (
          <button className="back-heading" onClick={() => setScreen("home")}>
            <ArrowLeft size={20} />
            <span>
              {screen === "versions"
                ? "实例选择"
                : `实例设置 - ${selected?.id || ""}`}
            </span>
          </button>
        )}
        <div className="window-buttons">
          <button
            title="最小化"
            aria-label="最小化"
            onClick={() => native && getCurrentWindow().minimize()}
          >
            <Minus size={18} />
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
      {error ? (
        <div className="initial-error">
          <TriangleAlert />
          <h2>无法读取游戏目录</h2>
          <p>{error}</p>
          <button className="ce-button" onClick={load}>
            重新读取
          </button>
        </div>
      ) : !data ? (
        <div className="loading">
          <LoaderCircle className="spin" />
          正在读取游戏实例…
        </div>
      ) : (
        <div className="body-layout">
          <aside
            className={
              screen === "home" && tab === "launch"
                ? "launch-sidebar"
                : "section-sidebar"
            }
          >
            {screen === "versions" ? (
              <>
                <div className="section-label">文件夹列表</div>
                <button
                  className="folder-entry selected"
                  title={data.settings.root}
                >
                  <strong>
                    {data.settings.root.split("/").filter(Boolean).at(-1)}
                  </strong>
                  <small>{data.settings.root}</small>
                </button>
                <div className="section-label folder-label">添加或导入</div>
                <button
                  className="side-item"
                  disabled
                  title="多目录管理尚未开放"
                >
                  <FolderInput size={19} />
                  添加已有文件夹
                </button>
                <button
                  className="side-item"
                  disabled
                  title="整合包导入尚未开放"
                >
                  <PackagePlus size={19} />
                  导入整合包
                </button>
              </>
            ) : screen === "instance" ? (
              menu(
                instancePages.map((p) => ({
                  ...p,
                  icon:
                    p.id === "settings"
                      ? SettingsIcon
                      : p.id === "modify"
                        ? Wrench
                        : p.icon || Box,
                  disabled:
                    p.unavailable ||
                    !["overview", "settings", "mods"].includes(p.id),
                })),
                instancePage,
                setInstancePage,
              )
            ) : tab === "launch" ? (
              <>
                <button
                  className="account-panel"
                  onClick={() => setDialog("accounts")}
                  aria-label="管理账号"
                >
                  <span
                    className="avatar"
                    aria-hidden="true"
                    style={{
                      backgroundImage: `url(${defaultSkin}),url(${defaultSkin})`,
                    }}
                  />
                  <span className="account-heading">
                    {activeAccount?.profile.name || data.settings.player}
                  </span>
                  <span className="account-kind">
                    {activeAccount ? "正版验证" : "离线登录"}
                  </span>
                </button>
                <div className="launch-controls">
                  <button
                    className="launch-button"
                    disabled={!native || !selected || downloadBusy || checking}
                    onClick={() =>
                      busy
                        ? api("stop_game").catch((e) => notify(String(e)))
                        : launch()
                    }
                  >
                    <span>
                      {busy
                        ? data.status.stage === "preparing"
                          ? "正在启动"
                          : "结束游戏"
                        : "启动游戏"}
                    </span>
                    <small>
                      {busy
                        ? data.status.message
                        : selected?.id || "请选择游戏实例"}
                    </small>
                  </button>
                  <div className="launch-secondary">
                    <button
                      className="ce-button"
                      disabled={!!busy || downloadBusy}
                      onClick={() => {
                        setQuery("");
                        setScreen("versions");
                      }}
                    >
                      实例选择
                    </button>
                    <button
                      className="ce-button"
                      disabled={!selected || !!busy || downloadBusy}
                      onClick={instanceSettings}
                    >
                      实例设置
                    </button>
                  </div>
                </div>
              </>
            ) : tab === "download" ? (
              menu(downloadItems, downloadPage, setDownloadPage)
            ) : tab === "settings" ? (
              menu(settingsItems, settingsPage, (id) => {
                setSettingsPage(id);
                if (id === "logs") void readLogs();
              })
            ) : (
              <>
                <div className="section-label">联机</div>
                <button className="side-item" disabled title="联机功能暂不实现">
                  <Link2 size={19} />
                  大厅
                </button>
                <div className="section-label">奇妙小工具</div>
                <button className="side-item selected">
                  <Gift size={19} />
                  百宝箱
                </button>
              </>
            )}
          </aside>
          <main className="content">
            <div hidden={screen !== "home" || tab !== "download"}>
              <DownloadPanel
                section={downloadPage}
                api={api}
                native={native}
                installed={data.instances}
                gameBusy={!!busy}
                onInstalled={load}
                onBusyChange={setDownloadBusy}
              />
            </div>
            {screen === "versions" ? (
              <InstanceSelection
                instances={data.instances}
                query={query}
                setQuery={setQuery}
                disabled={!!busy || downloadBusy}
                onPick={pick}
              />
            ) : screen === "instance" && selected ? (
              <InstancePanel
                instance={selected}
                section={instancePage}
                settings={data.settings}
                api={api}
                onSave={save}
                onOpen={open}
                onInspect={launch}
                onNotify={notify}
                disabled={!!busy || downloadBusy}
              />
            ) : screen === "home" ? (
              <>
                {tab === "launch" && data.status.stage === "error" && (
                  <button
                    className="error-banner"
                    onClick={() => {
                      setTab("settings");
                      setSettingsPage("logs");
                      void readLogs();
                    }}
                  >
                    <TriangleAlert size={18} />
                    <span>{data.status.message}</span>
                    <ChevronRight size={18} />
                  </button>
                )}
                {tab === "settings" &&
                  (settingsPage === "logs" ? (
                    <>
                      <div className="toolbar">
                        <button className="ce-button" onClick={readLogs}>
                          <RefreshCw size={16} />
                          刷新
                        </button>
                        <button
                          className="ce-button"
                          onClick={() => open("logs")}
                        >
                          <FolderOpen size={16} />
                          打开日志文件夹
                        </button>
                      </div>
                      <pre className="log-view">{logs}</pre>
                    </>
                  ) : (
                    <SettingsPanel
                      section={settingsPage}
                      settings={data.settings}
                      api={api}
                      native={native}
                      onSave={save}
                      disabled={!!busy || downloadBusy}
                      onInstances={instanceSettings}
                      onNotify={notify}
                    />
                  ))}
                {tab === "tools" && (
                  <Toolbox onOpen={open} root={data.settings.root} />
                )}
              </>
            ) : null}
          </main>
        </div>
      )}
      {dialog === "accounts" && data && (
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
            aria-label={"管理账号"}
          >
            <div className="modal-heading">
              <h2>管理账号</h2>
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
                <label className="ce-row">
                  <span>离线玩家名</span>
                  <input
                    className="ce-field"
                    value={data.settings.player}
                    disabled={!!busy}
                    onChange={(e) => setPlayer(e.target.value)}
                    onBlur={() =>
                      save(data.settings).catch((e) => notify(String(e)))
                    }
                  />
                </label>
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
            ) : null}
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
