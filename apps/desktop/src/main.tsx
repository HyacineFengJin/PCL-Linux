import "./style.css";
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
  Earth,
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
  ShieldCheck,
  Network,
  Unplug,
  Shirt,
  Pencil,
  Users,
  UserPlus,
  Pickaxe,
  MoreHorizontal,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import {
  DownloadPanel,
  idleDownload,
  type DownloadStatus,
} from "./DownloadPanel";
import defaultSkin from "./assets/game-icons/steve.png";
import { Toolbox } from "./Toolbox";
import { SettingsPanel } from "./SettingsPanel";
import {
  InstancePanel,
  InstanceSelection,
  instancePages,
  InstanceIcon,
} from "./InstancesPanel";
import { ResourceDetails, type ResourceSummary } from "./ResourceDetails";
import { InstanceImport } from "./InstanceImport";
import { InstanceTrash } from "./InstanceTrash";
import {
  TaskManager,
  TaskStatistics,
  useDownloadSpeed,
  instanceTaskAction,
} from "./TaskManager";
import "./account-interactions.css";
import { ExtraSettings } from "./ExtraSettings";
import type {
  Api,
  Instance,
  InstanceMetadata,
  JavaAddResult,
  MetaView,
  RootSummary,
  Settings,
} from "./types";
import "./roots.css";
type Status = {
  stage: string;
  message: string;
  version: string | null;
  pid: number | null;
  exit_code: number | null;
  root_id?: string | null;
  root_path?: string | null;
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
  roots?: RootSummary[];
  scan_issues?: { id: string; message: string }[];
  scan_error?: string | null;
  reset_recovery_error?: string | null;
  rename_recovery_error?: string | null;
  rename_recovery_root_id?: string | null;
  import_recovery_error?: string | null;
  resource_install_recovery_error?: string | null;
  delete_recovery_error?: string | null;
  delete_recovery_root_id?: string | null;
  config_warning?: string | null;
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
const resourceWrites = new Set([
  "resource_set_enabled",
  "resource_remove",
  "resource_restore",
  "resource_import",
  "resource_recover",
  "resource_install_start",
  "resource_update_start",
  "resource_update_restore",
  "resource_install_recover",
  "instance_metadata_update",
  "instance_reset_start",
  "instance_reset_recover",
  "instance_rename_start",
  "instance_rename_recover",
  "instance_export_start",
  "instance_export_config_save",
  "instance_import_start",
  "instance_import_recover",
  "instance_delete_start",
  "instance_restore_start",
  "instance_delete_recover",
]);
const rootCommands = new Set([
  "java_catalog",
  "java_add",
  "launch_game",
  "inspect_instance",
  "open_folder",
  "instance_resources",
  "instance_servers",
  "launcher_logs",
  "launcher_read_log",
  "resource_set_enabled",
  "resource_remove",
  "resource_restore",
  "resource_import",
  "resource_removed",
  "resource_recover",
  "resource_install_plan",
  "resource_update_check",
  "resource_update_plan",
  "resource_update_history",
  "resource_install_start",
  "resource_update_start",
  "resource_update_restore",
  "resource_install_recover",
  "instance_metadata_update",
  "instance_metadata_read",
  "instance_reset_plan",
  "instance_reset_start",
  "instance_reset_recover",
  "instance_rename_prepare",
  "instance_rename_start",
  "instance_rename_recover",
  "instance_export_plan",
  "instance_export_start",
  "instance_export_config_read",
  "instance_export_config_save",
  "instance_import_pick",
  "instance_import_prepare",
  "instance_import_start",
  "instance_import_recover",
  "instance_delete_prepare",
  "instance_delete_start",
  "instance_deleted_list",
  "instance_restore_start",
  "instance_delete_recover",
]);
type PreviewRoot = {
  settings: Settings;
  instances: Instance[];
  resources: unknown[];
  servers: unknown;
  logs: unknown;
  log_contents?: Record<string, string>;
  scan_issues: { id: string; message: string }[];
  scan_error?: string | null;
  recovery_error?: string | null;
};
const previewRoots = new Map<string, PreviewRoot>();
type PreviewResource = {
  name: string;
  file_name: string;
  path: string;
  enabled: boolean;
  fingerprint?: string | null;
};
type PreviewRemoval = {
  id: string;
  files: PreviewResource[];
  created_at: number;
};
const previewRemovals = new Map<string, PreviewRemoval[]>();
let previewResourceSequence = 0;
let previewMetadataSequence = 0;
const defaultInstanceMetadata: InstanceMetadata = {
  description: "",
  favorite: false,
  icon: "auto",
  category: "auto",
};
function previewInstances(
  instances: Instance[],
  root: RootSummary,
): Instance[] {
  return instances.map((instance) => ({
    ...instance,
    metadata: { ...defaultInstanceMetadata, ...instance.metadata },
    metadata_revision:
      instance.metadata_revision ||
      `preview-meta:${JSON.stringify([root.id, root.path, instance.id])}:0`,
  }));
}
let preview:
  | (State & {
      catalog?: unknown[];
      system?: unknown;
      java?: unknown[];
      resources?: unknown[];
      modrinth?: unknown;
      loader_catalog?: unknown;
      launcher_logs?: unknown;
      instance_servers?: unknown;
      contributors?: unknown;
      resource_details?: Record<string, unknown>;
      resource_dependencies?: Record<string, unknown>;
      loader_candidates?: Record<string, unknown>;
      download_status?: DownloadStatus;
      root_data?: Record<string, Partial<PreviewRoot>>;
    })
  | undefined;
function normalizedState(value: State): State {
  const roots = value.roots?.length
    ? value.roots
    : [
        {
          id: value.settings.root_id || "legacy-root",
          name:
            value.settings.root.split(/[\\/]/).filter(Boolean).at(-1) ||
            "Minecraft",
          path: value.settings.root,
          selected: value.settings.selected,
          available: true,
        },
      ];
  const rootId =
    roots.find((root) => root.id === value.settings.root_id)?.id ||
    roots.find((root) => root.path === value.settings.root)?.id ||
    roots[0].id;
  return {
    ...value,
    roots,
    settings: {
      ...value.settings,
      root_id: rootId,
      java: value.settings.java || { mode: "auto" },
      java_paths: value.settings.java_paths || [],
      java_overrides: value.settings.java_overrides || {},
    },
    scan_issues: value.scan_issues || [],
    auth: value.auth || emptyAuth,
  };
}
function preparePreviewRoots() {
  if (!preview || previewRoots.size) return;
  preview = { ...preview, ...normalizedState(preview) };
  for (const root of preview.roots!) {
    const selected = root.id === preview.settings.root_id;
    const stored = preview.root_data?.[root.id];
    previewRoots.set(root.id, {
      settings: {
        ...preview.settings,
        selected: selected ? preview.settings.selected : root.selected,
        overrides: selected
          ? { ...preview.settings.overrides }
          : { ...root.overrides },
        java_overrides: selected
          ? { ...preview.settings.java_overrides }
          : { ...root.java_overrides },
        ...stored?.settings,
        root_id: root.id,
        root: root.path,
      },
      instances: previewInstances(
        stored?.instances || (selected ? preview.instances : []),
        root,
      ),
      resources: stored?.resources || (selected ? preview.resources || [] : []),
      servers:
        stored?.servers || (selected ? preview.instance_servers || [] : []),
      logs: stored?.logs || (selected ? preview.launcher_logs || [] : []),
      log_contents: stored?.log_contents,
      scan_issues:
        stored?.scan_issues || (selected ? preview.scan_issues || [] : []),
      scan_error: stored?.scan_error || (selected ? preview.scan_error : null),
      recovery_error: stored?.recovery_error,
    });
    if (selected) preview.instances = previewRoots.get(root.id)!.instances;
  }
}
function selectPreviewRoot(id: string) {
  const root = preview!.roots!.find((item) => item.id === id);
  const stored = previewRoots.get(id);
  if (!root || !stored) throw new Error("游戏目录不存在");
  const old = previewRoots.get(preview!.settings.root_id!);
  if (old) old.settings = { ...preview!.settings };
  preview = {
    ...preview!,
    settings: {
      ...stored.settings,
      player: preview!.settings.player,
      memory_gib: preview!.settings.memory_gib,
    },
    roots: preview!.roots!.map((item) => ({
      ...item,
      selected: previewRoots.has(item.id)
        ? previewRoots.get(item.id)!.settings.selected
        : item.selected,
    })),
    instances: root.available ? stored.instances : [],
    resources: root.available ? stored.resources : [],
    instance_servers: root.available ? stored.servers : [],
    scan_issues: stored.scan_issues,
    scan_error: root.available
      ? stored.scan_error
      : root.error || "游戏目录暂不可用",
  };
  return normalizedState(preview);
}
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
  preparePreviewRoots();
  if (
    command === "instance_metadata_update" ||
    command === "instance_metadata_read"
  ) {
    const rootId = String(args?.rootId || preview!.settings.root_id);
    const root = preview!.roots!.find((item) => item.id === rootId);
    const stored = previewRoots.get(rootId);
    if (!root?.available || !stored) throw new Error("游戏目录暂不可用");
    if (
      command === "instance_metadata_update" &&
      (["preparing", "running"].includes(preview!.status.stage) ||
        ["preparing", "downloading", "processing"].includes(
          preview!.download_status?.stage || "",
        ))
    )
      throw new Error("请在游戏和文件操作结束后修改实例信息");
    const instance = stored.instances.find((item) => item.id === args?.id);
    if (!instance) throw new Error("未找到所选实例");
    if (command === "instance_metadata_read")
      return {
        ...defaultInstanceMetadata,
        ...instance.metadata,
        revision: instance.metadata_revision,
      } as T;
    if (instance.metadata_revision !== args?.revision)
      throw new Error("实例信息已变化，请重新读取后再保存");
    const patch = args?.patch as Partial<InstanceMetadata>;
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some(
        (key) => !["description", "favorite", "icon", "category"].includes(key),
      ) ||
      !Object.values(patch).some((value) => value !== undefined)
    )
      throw new Error("实例信息修改参数无效");
    if (patch.description !== undefined) {
      if (typeof patch.description !== "string")
        throw new Error("实例描述无效");
      const description = patch.description.replace(/\r\n/g, "\n");
      if (
        Array.from(description).length > 4096 ||
        /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(description)
      )
        throw new Error("实例描述过长或包含无效字符");
      patch.description = description.trim();
    }
    if (patch.favorite !== undefined && typeof patch.favorite !== "boolean")
      throw new Error("收藏设置无效");
    if (
      patch.icon !== undefined &&
      !["auto", "grass", "forge", "neoforge", "command", "steve"].includes(
        patch.icon,
      )
    )
      throw new Error("实例图标无效");
    if (
      patch.category !== undefined &&
      !["auto", "vanilla", "forge", "neoforge", "fabric", "quilt"].includes(
        patch.category,
      )
    )
      throw new Error("实例分类无效");
    instance.metadata = {
      ...defaultInstanceMetadata,
      ...instance.metadata,
      ...patch,
    };
    instance.metadata_revision = `preview-meta:${JSON.stringify([root.id, root.path, instance.id])}:${++previewMetadataSequence}`;
    return { ...instance.metadata, revision: instance.metadata_revision } as T;
  }
  if (command === "bootstrap") return normalizedState(preview!) as T;
  if (command === "roots_list") return preview!.roots as T;
  if (command === "root_pick")
    return {
      status: "unavailable",
      message: "界面预览中不能选择本机文件夹，请打开桌面应用。",
    } as T;
  if (command === "root_select")
    return selectPreviewRoot(String(args?.id)) as T;
  if (command === "root_update") {
    const id = String(args?.id);
    const roots = [...preview!.roots!];
    const index = roots.findIndex((root) => root.id === id);
    if (index < 0) throw new Error("游戏目录不存在");
    if (args?.name !== undefined) {
      const name = String(args.name).trim();
      if (!name) throw new Error("请输入文件夹名称");
      roots[index] = { ...roots[index], name };
    }
    if (typeof args?.position === "number") {
      const [root] = roots.splice(index, 1);
      roots.splice(Math.max(0, Math.min(roots.length, args.position)), 0, root);
    }
    preview = { ...preview!, roots };
    return normalizedState(preview) as T;
  }
  if (command === "root_remove") {
    const id = String(args?.id);
    const roots = preview!.roots!;
    if (roots.length <= 1) throw new Error("请至少保留一个游戏目录");
    if (!roots.some((root) => root.id === id))
      throw new Error("游戏目录不存在");
    if (
      (["preparing", "running"].includes(preview!.status.stage) &&
        preview!.status.root_id === id) ||
      (["preparing", "downloading", "processing"].includes(
        preview!.download_status?.stage || "",
      ) &&
        preview!.download_status?.root_id === id)
    )
      throw new Error("此目录正在使用，请等待任务结束");
    preview = { ...preview!, roots: roots.filter((root) => root.id !== id) };
    previewRoots.delete(id);
    return (
      preview!.settings.root_id === id
        ? selectPreviewRoot(preview!.roots![0].id)
        : normalizedState(preview!)
    ) as T;
  }
  if (command === "auth_status") return (preview!.auth || emptyAuth) as T;
  if (command === "process_status") return preview!.status as T;
  if (command === "download_catalog") return (preview!.catalog || []) as T;
  if (
    command === "launcher_logs" ||
    command === "instance_servers" ||
    command === "instance_resources"
  ) {
    const rootId = String(args?.rootId || preview!.settings.root_id);
    const root = preview!.roots!.find((item) => item.id === rootId);
    const stored = previewRoots.get(rootId);
    if (!root?.available || !stored) return [] as T;
    return (
      command === "launcher_logs"
        ? stored.logs
        : command === "instance_servers"
          ? stored.servers
          : stored.resources
    ) as T;
  }
  if (command === "launcher_read_log") {
    const rootId = String(args?.rootId || preview!.settings.root_id);
    const stored = previewRoots.get(rootId)?.log_contents?.[String(args?.name)];
    if (stored !== undefined) return stored as T;
  }
  if (command === "loader_catalog") {
    const catalogs = preview!.loader_catalog;
    return (
      Array.isArray(catalogs)
        ? catalogs
        : (catalogs as Record<string, unknown> | undefined)?.[
            String(args?.loader)
          ] || []
    ) as T;
  }
  if (command === "loader_candidates")
    return (preview!.loader_candidates?.[
      `${args?.loader}:${args?.minecraft}`
    ] || []) as T;
  if (command === "resource_details") {
    const item = preview!.resource_details?.[String(args?.projectId)];
    if (!item) throw new Error("此资源的详情预览数据尚未准备");
    return item as T;
  }
  if (command === "resource_dependencies")
    return (preview!.resource_dependencies?.[String(args?.versionId)] || {
      version_id: args?.versionId,
      dependencies: [],
      truncated: false,
    }) as T;
  if (command === "upstream_contributors")
    return (preview!.contributors || []) as T;
  if (command === "project_feedback") return [] as T;
  if (command === "modrinth_search") {
    const catalogs = preview!.modrinth as Record<string, unknown> | undefined;
    return (
      catalogs?.hits
        ? catalogs
        : catalogs?.[String(args?.projectType || "mod")] || { hits: [] }
    ) as T;
  }
  if (command === "system_info") return preview!.system as T;
  if (command === "java_catalog")
    return { runtimes: preview!.java || [], unavailable: [] } as T;
  if (command === "download_status")
    return (preview!.download_status || idleDownload) as T;
  if (command === "resource_import")
    return {
      status: "unavailable",
      changed: 0,
      message: "界面预览中不能选择本机文件，请打开桌面应用。",
    } as T;
  if (
    [
      "resource_removed",
      "resource_set_enabled",
      "resource_remove",
      "resource_restore",
      "resource_recover",
    ].includes(command)
  ) {
    const rootId = String(args?.rootId || preview!.settings.root_id);
    const root = preview!.roots!.find((item) => item.id === rootId);
    const stored = previewRoots.get(rootId);
    if (!root?.available || !stored) throw new Error("游戏目录暂不可用");
    const kind = String(args?.kind);
    const key = `${rootId}:${args?.id}:${kind}`;
    const removed = previewRemovals.get(key) || [];
    if (command === "resource_removed") {
      if (stored.recovery_error) throw new Error(stored.recovery_error);
      return removed.map((operation) => ({
        ...operation,
        files: operation.files.map((file) => file.file_name),
      })) as T;
    }
    if (["preparing", "running"].includes(preview!.status.stage))
      throw new Error("请在游戏退出后修改资源文件");
    if (
      ["preparing", "downloading", "processing"].includes(
        preview!.download_status?.stage || "",
      )
    )
      throw new Error("已有文件写入任务，请等待完成或取消");
    if (!["mods", "resourcepacks", "shaderpacks"].includes(kind))
      throw new Error("此资源类型暂不支持修改");
    if (command === "resource_recover") {
      stored.recovery_error = null;
      return {
        changed: 0,
        undo_id: null,
        message: "已恢复未完成的资源操作，请检查资源列表",
      } as T;
    }
    const entries = stored.resources as PreviewResource[];
    if (command === "resource_restore") {
      const operation = removed.find((item) => item.id === args?.operationId);
      if (!operation) throw new Error("未找到可恢复的删除记录");
      if (
        operation.files.some((file) =>
          entries.some((existing) => existing.file_name === file.file_name),
        )
      )
        throw new Error("恢复位置已有同名文件，请先处理冲突");
      stored.resources = [...entries, ...operation.files];
      previewRemovals.set(
        key,
        removed.filter((item) => item.id !== operation.id),
      );
      return {
        changed: operation.files.length,
        undo_id: null,
        message: "已恢复所选资源",
      } as T;
    }
    const files = args?.files as { file_name: string; fingerprint: string }[];
    if (
      !files?.length ||
      new Set(files.map((file) => file.file_name)).size !== files.length
    )
      throw new Error("所选文件列表无效，请刷新后重试");
    const selected = files.map((file) => {
      const current = entries.find(
        (entry) => entry.file_name === file.file_name,
      );
      if (
        !current ||
        !current.fingerprint ||
        current.fingerprint !== file.fingerprint
      )
        throw new Error("资源文件已变化，请刷新列表后重试");
      return current;
    });
    if (command === "resource_remove") {
      const operation = {
        id: `preview-resource-${++previewResourceSequence}`,
        files: selected.map((file) => ({ ...file })),
        created_at: Date.now(),
      };
      previewRemovals.set(key, [operation, ...removed]);
      stored.resources = entries.filter((file) => !selected.includes(file));
      return {
        changed: selected.length,
        undo_id: operation.id,
        message: "已移除所选资源，可撤销删除",
      } as T;
    }
    if (kind !== "mods") throw new Error("仅模组支持启用或禁用");
    const enabled = args?.enabled === true;
    const plan = selected
      .filter((file) => file.enabled !== enabled)
      .map((file) => ({
        file,
        name: enabled
          ? file.file_name.replace(/\.disabled$/, "")
          : `${file.file_name}.disabled`,
      }));
    if (
      plan.some((item) => entries.some((file) => file.file_name === item.name))
    )
      throw new Error("目标已有同名文件，请先处理冲突");
    stored.resources = entries.map((file) => {
      const item = plan.find((candidate) => candidate.file === file);
      return item
        ? {
            ...file,
            file_name: item.name,
            path: file.path.replace(/[^/]+$/, item.name),
            enabled,
            fingerprint: `preview-${++previewResourceSequence}`,
          }
        : file;
    });
    return {
      changed: plan.length,
      undo_id: null,
      message: enabled ? "已启用所选模组" : "已禁用所选模组",
    } as T;
  }
  if (command === "save_settings") {
    const settings = args!.settings as Settings;
    const rootId = settings.root_id || preview!.settings.root_id!;
    const root = preview!.roots!.find((item) => item.id === rootId);
    if (
      !root ||
      rootId !== preview!.settings.root_id ||
      root.path !== settings.root
    )
      throw new Error("请在实例选择中管理游戏目录");
    previewRoots.get(rootId)!.settings = { ...settings, root_id: rootId };
    preview = {
      ...preview!,
      settings: { ...settings, root_id: rootId },
      roots: preview!.roots!.map((item) =>
        item.id === rootId
          ? {
              ...item,
              selected: settings.selected,
              overrides: settings.overrides,
            }
          : item,
      ),
    };
    return { ...preview!.settings } as T;
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
    [dialog, setDialog] = useState<
      "versions" | "instance" | "accounts" | "account-type" | null
    >(null),
    [query, setQuery] = useState(""),
    [toast, setToast] = useState(""),
    [inspection, setInspection] = useState<Inspection | null>(null),
    [checking, setChecking] = useState(false),
    [draft, setDraft] = useState<Settings | null>(null),
    [override, setOverride] = useState(6);
  const [screen, setScreen] = useState<
    "home" | "versions" | "instance" | "resource" | "tasks"
  >("home");
  const [resource, setResource] = useState<ResourceSummary | null>(null);
  const [resourceOrigin, setResourceOrigin] = useState<"home" | "instance">(
    "home",
  );
  const [taskOrigin, setTaskOrigin] = useState<
    "home" | "versions" | "instance" | "resource"
  >("home");
  const [downloadStatus, setDownloadStatus] =
    useState<DownloadStatus>(idleDownload);
  const downloadSnapshot = React.useRef<DownloadStatus>(idleDownload);
  const previousDownloadTasks = React.useRef(new Set<string>());
  const acceptDownloadStatus = React.useCallback((next: DownloadStatus) => {
    const old = downloadSnapshot.current;
    const terminal = (value: DownloadStatus) =>
      ["complete", "error", "cancelled"].includes(value.stage);
    if (old.task_id && !next.task_id && !terminal(old)) return;
    if (old.task_id && next.task_id && old.task_id !== next.task_id) {
      if (previousDownloadTasks.current.has(next.task_id)) return;
      previousDownloadTasks.current.add(old.task_id);
      if (previousDownloadTasks.current.size > 64) {
        const first = previousDownloadTasks.current.values().next().value;
        if (first) previousDownloadTasks.current.delete(first);
      }
    }
    if (old.task_id === next.task_id && terminal(old) && !terminal(next))
      return;
    downloadSnapshot.current = next;
    setDownloadStatus(next);
  }, []);
  const speed = useDownloadSpeed(downloadStatus);
  const [accountType, setAccountType] = useState("");
  const [profileList, setProfileList] = useState(false);
  const [rootWorking, setRootWorking] = useState(false);
  const rootWorkingRef = React.useRef(false);
  const stateRequest = React.useRef(0);
  const [rootMenu, setRootMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [rootDialog, setRootDialog] = useState<{
    mode: "rename" | "remove";
    root: RootSummary;
  } | null>(null);
  const [rootName, setRootName] = useState("");
  const [rootError, setRootError] = useState("");
  const [resourceTarget, setResourceTarget] = useState<{
    id: string | null;
  } | null>(null);
  const resourceBusy = resourceTarget !== null;
  const rootId = data?.settings.root_id || null;
  const rootKey = `${rootId || ""}:${data?.settings.root || ""}`;
  const contextKey = React.useRef(rootKey);
  contextKey.current = rootKey;
  const viewContext = React.useRef({
    screen,
    rootKey,
    selected: data?.settings.selected,
    rootId,
    roots: data?.roots,
    deletionRoot: data?.delete_recovery_root_id,
  });
  viewContext.current = {
    screen,
    rootKey,
    selected: data?.settings.selected,
    rootId,
    roots: data?.roots,
    deletionRoot: data?.delete_recovery_root_id,
  };
  const [instanceImport, setInstanceImport] = useState<{
    rootKey: string;
    epoch: number;
  } | null>(null);
  const importEntry = React.useRef(instanceImport);
  importEntry.current = instanceImport;
  const archiveRecovery = React.useRef<symbol | null>(null);
  const archiveAdmission = React.useRef({
    blocked: true,
    rootAvailable: false,
  });
  function acceptJavaRegistration(
    capturedContext: string,
    revision: unknown,
    result: JavaAddResult,
  ) {
    const saved = result.settings;
    if (result.status !== "selected" || !saved || typeof revision !== "string")
      return false;
    const targetKey = `${saved.root_id || ""}:${saved.root}`;
    if (targetKey !== capturedContext) return false;
    const currentSubmission = (current: Settings) =>
      `${current.root_id || ""}:${current.root}` === targetKey &&
      (current.revision === revision || current.revision === saved.revision);
    // A native chooser can finish after its panel unmounts. The application
    // owns the committed registry/token; a stale view only loses its notices.
    setData((current) =>
      current && currentSubmission(current.settings)
        ? { ...current, settings: saved }
        : current,
    );
    if (contextKey.current === targetKey)
      setDraft((current) =>
        current && currentSubmission(current) ? saved : current,
      );
    return true;
  }
  const rootApi = React.useMemo<Api>(
    () =>
      async <T,>(
        command: string,
        args?: Record<string, unknown>,
      ): Promise<T> => {
        const target = { id: rootId };
        const capturedContext = contextKey.current;
        if (resourceWrites.has(command)) setResourceTarget(target);
        try {
          const result = await api<T>(
            command,
            rootCommands.has(command) ? { ...args, rootId } : args,
          );
          if (
            command === "java_add" &&
            acceptJavaRegistration(
              capturedContext,
              args?.revision,
              result as JavaAddResult,
            )
          )
            // Invalidate older in-flight bootstrap reads, including when the
            // original Java panel has gone away. Root navigation owns its own
            // newer bootstrap while rootWorkingRef is set.
            await load();
          if (
            [
              "instance_import_recover",
              "instance_delete_recover",
              "resource_install_recover",
            ].includes(command) ||
            (["instance_reset_recover", "instance_rename_recover"].includes(
              command,
            ) &&
              contextKey.current === capturedContext)
          )
            await load();
          return result;
        } finally {
          if (resourceWrites.has(command))
            setResourceTarget((current) =>
              current === target ? null : current,
            );
        }
      },
    [rootId],
  );
  const taskApi = React.useMemo<Api>(
    () => (command, args) =>
      api(
        command,
        command === "download_cancel"
          ? { ...args, taskId: downloadStatus.task_id ?? null }
          : args,
      ),
    [downloadStatus.task_id],
  );
  function showResource(
    next: ResourceSummary,
    origin: "home" | "instance" = "home",
  ) {
    setResource(next);
    setResourceOrigin(origin);
    setScreen("resource");
  }
  function showTasks() {
    if (screen !== "tasks") setTaskOrigin(screen);
    setScreen("tasks");
  }
  async function showInstanceTask(id: string) {
    const capturedRoot = contextKey.current;
    const capturedNavigation = taskNavigation.current.epoch;
    setDownloadBusy(true);
    try {
      const next = await api<DownloadStatus>("download_status");
      if (next.task_id !== id) return;
      acceptDownloadStatus(next);
      setDownloadBusy(
        ["preparing", "downloading", "processing"].includes(
          downloadSnapshot.current.stage,
        ),
      );
      if (
        contextKey.current === capturedRoot &&
        taskNavigation.current.epoch === capturedNavigation
      )
        showTasks();
    } catch (e) {
      notify(String(e));
    }
  }
  async function recoverInstanceReset() {
    if (!native || busy || downloadBusy || resourceBusy || !rootAvailable)
      return;
    try {
      await rootApi("instance_reset_recover");
      notify("已恢复未完成的实例重置");
    } catch (e) {
      notify(String(e));
    }
  }
  async function recoverResourceInstall() {
    const targetRoot = viewContext.current.rootId;
    if (
      !native ||
      archiveAdmission.current.blocked ||
      rootWorkingRef.current ||
      archiveRecovery.current ||
      !targetRoot ||
      contextKey.current !== rootKey ||
      !viewContext.current.roots?.some(
        (root) => root.id === targetRoot && root.available,
      )
    )
      return;
    const token = Symbol();
    archiveRecovery.current = token;
    const target = { id: targetRoot };
    setResourceTarget(target);
    try {
      await api("resource_install_recover", { rootId: targetRoot });
      await load();
      notify("已恢复未完成的资源安装或更新");
    } catch (error) {
      await load();
      notify(String(error));
    } finally {
      if (archiveRecovery.current === token) archiveRecovery.current = null;
      setResourceTarget((current) => (current === target ? null : current));
    }
  }
  async function recoverInstanceRename() {
    const recoveryRoot = data?.rename_recovery_root_id;
    if (!native || busy || downloadBusy || resourceBusy || !recoveryRoot)
      return;
    const target = { id: recoveryRoot };
    setResourceTarget(target);
    try {
      const result = await api<{ message?: string }>(
        "instance_rename_recover",
        {
          rootId: recoveryRoot,
        },
      );
      await load();
      notify(result.message || "已恢复未完成的实例重命名");
    } catch (e) {
      await load();
      notify(String(e));
    } finally {
      setResourceTarget((current) => (current === target ? null : current));
    }
  }
  async function recoverInstanceArchives(kind: "import" | "delete") {
    const recoveryRoot =
      kind === "delete"
        ? viewContext.current.deletionRoot
        : viewContext.current.rootId;
    if (
      !native ||
      archiveAdmission.current.blocked ||
      rootWorkingRef.current ||
      archiveRecovery.current ||
      contextKey.current !== rootKey ||
      !recoveryRoot ||
      !viewContext.current.roots?.some(
        (root) => root.id === recoveryRoot && root.available,
      )
    )
      return;
    const token = Symbol();
    archiveRecovery.current = token;
    const target = { id: recoveryRoot };
    setResourceTarget(target);
    try {
      // A global deletion marker can belong to a different browsed root.
      // Capture its owner for recovery, then bootstrap the current projection.
      await api(`instance_${kind}_recover`, { rootId: recoveryRoot });
      await load();
      notify(
        kind === "delete"
          ? "已恢复未完成的实例删除或恢复"
          : "已恢复未完成的实例导入",
      );
    } catch (error) {
      await load();
      notify(String(error));
    } finally {
      if (archiveRecovery.current === token) archiveRecovery.current = null;
      setResourceTarget((current) => (current === target ? null : current));
    }
  }
  function openInstanceImport() {
    if (
      !native ||
      archiveAdmission.current.blocked ||
      rootWorkingRef.current ||
      !archiveAdmission.current.rootAvailable ||
      importEntry.current ||
      viewContext.current.screen !== "versions" ||
      taskNavigation.current.epoch !== navigationEpoch ||
      contextKey.current !== rootKey
    )
      return;
    const choice = { rootKey, epoch: taskNavigation.current.epoch };
    importEntry.current = choice;
    setInstanceImport(choice);
  }
  function finishTaskCancellation(next: DownloadStatus) {
    if (downloadSnapshot.current.task_id !== next.task_id) return;
    const instanceTask = [
      "instance_reset",
      "instance_export",
      "instance_rename",
      "instance_import",
      "instance_delete",
      "instance_restore",
      "resource_download",
      "resource_update",
      "resource_update_restore",
    ].includes(next.kind || "");
    notify(`${next.version || "游戏"} ${instanceTaskAction(next.kind)}已取消`);
    if (!instanceTask) {
      setTab("download");
      setDownloadPage("minecraft");
      setTaskOrigin("home");
    }
    setScreen((current) =>
      current === "tasks" ? (instanceTask ? taskOrigin : "home") : current,
    );
  }
  const [instancePage, setInstancePage] = useState("overview");
  const [settingsPage, setSettingsPage] = useState("launch");
  const [downloadPage, setDownloadPage] = useState("minecraft");
  const taskNavigation = React.useRef({ key: "", epoch: 0 });
  const resourceNavigation =
    screen === "resource"
      ? `${resource?.source || ""}:${resource?.project_id || resource?.local_path || ""}`
      : "";
  const navigationKey = `${rootKey}:${screen}:${tab}:${instancePage}:${data?.settings.selected || ""}:${resourceNavigation}`;
  if (taskNavigation.current.key !== navigationKey) {
    taskNavigation.current = {
      key: navigationKey,
      epoch: taskNavigation.current.epoch + 1,
    };
  }
  const navigationEpoch = taskNavigation.current.epoch;
  useEffect(() => {
    const choice = importEntry.current;
    if (
      !choice ||
      (choice.rootKey === rootKey &&
        choice.epoch === navigationEpoch &&
        screen === "versions")
    )
      return;
    importEntry.current = null;
    setInstanceImport((current) => (current === choice ? null : current));
  }, [rootKey, navigationEpoch, screen]);
  const contentRef = React.useRef<HTMLElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [screen, tab, settingsPage, downloadPage, instancePage, !!data]);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [remember, setRemember] = useState(true);
  const [clientId, setClientId] = useState("");
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState("");
  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 4500);
  };
  function applyState(snapshot: State) {
    const next = normalizedState(snapshot);
    const previous = viewContext.current;
    const missingInstance =
      previous.rootKey ===
        `${next.settings.root_id || ""}:${next.settings.root}` &&
      !!previous.selected &&
      !next.instances.some((instance) => instance.id === previous.selected);
    if (
      !next.instances.some((i) => i.id === next.settings.selected) &&
      next.instances.length
    )
      next.settings.selected =
        next.instances.find((x) => x.mod_count > 0)?.id || next.instances[0].id;
    if (!next.instances.length) next.settings.selected = null;
    // Removing the physical instance invalidates its details even if another
    // instance becomes selected. The task's back destination must agree too.
    if (missingInstance) {
      setScreen((current) => (current === "instance" ? "versions" : current));
      setTaskOrigin((current) =>
        current === "instance" ? "versions" : current,
      );
    }
    setClientId(next.auth.client_id);
    setData(next);
    setDraft(next.settings);
    setError("");
  }
  async function load() {
    if (rootWorkingRef.current) return;
    const request = ++stateRequest.current;
    try {
      const next = await api<State>("bootstrap");
      if (request === stateRequest.current) applyState(next);
    } catch (e) {
      if (request === stateRequest.current) setError(String(e));
    }
  }
  async function rootAction(command: string, args: Record<string, unknown>) {
    if (rootWorkingRef.current) return;
    rootWorkingRef.current = true;
    setRootWorking(true);
    setRootError("");
    setRootMenu(null);
    const request = ++stateRequest.current;
    try {
      const next = await api<State>(command, args);
      if (request === stateRequest.current) applyState(next);
      setRootDialog(null);
    } catch (e) {
      if (rootDialog) setRootError(String(e));
      else notify(String(e));
    } finally {
      rootWorkingRef.current = false;
      setRootWorking(false);
    }
  }
  async function addRoot() {
    if (rootWorkingRef.current) return;
    rootWorkingRef.current = true;
    setRootWorking(true);
    setRootMenu(null);
    const request = ++stateRequest.current;
    try {
      const choice = await api<{
        status: "selected" | "cancelled" | "unavailable";
        path?: string;
        message?: string;
      }>("root_pick");
      if (choice.status === "cancelled") return;
      if (choice.status !== "selected" || !choice.path) {
        notify(choice.message || "暂时无法打开文件夹选择窗口");
        return;
      }
      const registered = await api<{ root: RootSummary; bootstrap: State }>(
        "root_register",
        { path: choice.path },
      );
      if (request === stateRequest.current) applyState(registered.bootstrap);
      const next = await api<State>("root_select", { id: registered.root.id });
      if (request === stateRequest.current) applyState(next);
    } catch (e) {
      notify(String(e));
    } finally {
      rootWorkingRef.current = false;
      setRootWorking(false);
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
    setInspection(null);
    setChecking(false);
    setResource(null);
    setQuery("");
    setRootMenu(null);
    setInstanceImport(null);
    importEntry.current = null;
    setInstancePage("overview");
    setScreen((current) =>
      ["instance", "resource"].includes(current) ? "versions" : current,
    );
    setTaskOrigin((current) =>
      ["instance", "resource"].includes(current) ? "versions" : current,
    );
  }, [rootKey]);
  useEffect(() => {
    if (!rootMenu) return;
    const close = () => setRootMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [rootMenu]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDialog(null);
        setRootMenu(null);
        if (!rootWorkingRef.current) setRootDialog(null);
      }
      if (e.key === "Tab") {
        const modal = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!modal) return;
        const items = [
          ...modal.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
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
    if (!dialog && !rootDialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(
            '[role="dialog"] input, [role="dialog"] button',
          )
          ?.focus(),
      0,
    );
    return () => {
      clearTimeout(t);
      previous?.focus();
    };
  }, [dialog, rootDialog]);
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
  const processInRoot =
    !!data &&
    (data.status.root_id
      ? data.status.root_id === rootId
      : data.status.root_path
        ? data.status.root_path === data.settings.root
        : true);
  const boundGame =
    !!busy && processInRoot && data?.status.version === selected?.id;
  const installInRoot =
    downloadBusy &&
    (downloadStatus.root_id
      ? downloadStatus.root_id === rootId
      : downloadStatus.root_path
        ? downloadStatus.root_path === data?.settings.root
        : true);
  const rootOccupied =
    (!!busy && processInRoot) ||
    installInRoot ||
    (resourceBusy && resourceTarget?.id === rootId);
  const selectedRoot = data?.roots?.find((root) => root.id === rootId);
  const rootAvailable = selectedRoot?.available !== false;
  const instanceRecoveryBlocked =
    !!data?.rename_recovery_error ||
    !!data?.reset_recovery_error ||
    !!data?.import_recovery_error ||
    !!data?.delete_recovery_error ||
    !!data?.resource_install_recovery_error;
  archiveAdmission.current = {
    blocked: !!busy || downloadBusy || resourceBusy || rootWorking,
    rootAvailable: rootAvailable && !instanceRecoveryBlocked,
  };
  async function save(cfg: Settings) {
    const settings = { ...cfg, root_id: cfg.root_id || rootId };
    const targetKey = `${settings.root_id || ""}:${settings.root}`;
    const saved = await api<Settings>("save_settings", { settings });
    const currentSubmission = (current: Settings) =>
      `${current.root_id || ""}:${current.root}` === targetKey &&
      (current.revision === settings.revision ||
        current.revision === saved.revision);
    setData((d) =>
      d && currentSubmission(d.settings) ? { ...d, settings: saved } : d,
    );
    if (contextKey.current === targetKey)
      setDraft((current) =>
        current && currentSubmission(current) ? saved : current,
      );
  }
  async function pick(id: string) {
    if (!data || rootWorking) return;
    const targetKey = rootKey;
    try {
      await save({ ...data.settings, selected: id });
      if (contextKey.current !== targetKey) return;
      setDialog(null);
      setScreen("home");
      setInspection(null);
    } catch (e) {
      notify(String(e));
    }
  }
  async function launch() {
    if (
      !data ||
      !selected ||
      busy ||
      downloadBusy ||
      resourceBusy ||
      rootWorking ||
      !rootAvailable
    )
      return;
    const targetKey = rootKey;
    try {
      await save(data.settings);
      await rootApi("launch_game", { id: selected.id });
      setData((d) =>
        d && contextKey.current === targetKey
          ? {
              ...d,
              status: {
                ...d.status,
                stage: "preparing",
                message: "正在检查启动环境…",
                version: selected.id,
                root_id: rootId,
                root_path: data.settings.root,
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
      await rootApi("open_folder", { kind, id: selected?.id || null });
    } catch (e) {
      notify(String(e));
    }
  }
  async function inspect() {
    if (!selected) return;
    const targetKey = rootKey;
    setChecking(true);
    setInspection(null);
    try {
      const result = await rootApi<Inspection>("inspect_instance", {
        id: selected.id,
      });
      if (contextKey.current === targetKey) setInspection(result);
    } catch (e) {
      notify(String(e));
    } finally {
      if (contextKey.current === targetKey) setChecking(false);
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
  function rootOptions(id: string, x: number, y: number) {
    if (rootWorking) return;
    setRootMenu({
      id,
      x: Math.max(8, Math.min(x, window.innerWidth - 210)),
      y: Math.max(56, Math.min(y, window.innerHeight - 184)),
    });
  }
  function editRoot(root: RootSummary, mode: "rename" | "remove") {
    setRootMenu(null);
    setRootName(root.name);
    setRootError("");
    setRootDialog({ root, mode });
  }
  const menuRoot = data?.roots?.find((root) => root.id === rootMenu?.id);
  const menuRootIndex =
    data?.roots?.findIndex((root) => root.id === rootMenu?.id) ?? -1;
  const menuRootOccupied =
    !!menuRoot &&
    ((!!busy &&
      (data?.status.root_id === menuRoot.id ||
        data?.status.root_path === menuRoot.path ||
        (!data?.status.root_id &&
          !data?.status.root_path &&
          menuRoot.id === rootId))) ||
      (downloadBusy &&
        (downloadStatus.root_id === menuRoot.id ||
          downloadStatus.root_path === menuRoot.path ||
          (!downloadStatus.root_id &&
            !downloadStatus.root_path &&
            menuRoot.id === rootId))) ||
      (resourceBusy && resourceTarget?.id === menuRoot.id));
  const downloadItems = [
    { id: "minecraft", label: "Minecraft", icon: Blocks },
    { id: "mods", label: "模组", group: "社区资源", icon: Puzzle },
    { id: "modpacks", label: "整合包", icon: Box },
    { id: "datapacks", label: "数据包", icon: FileText },
    { id: "resourcepacks", label: "资源包", icon: Layers },
    { id: "shaders", label: "光影包", icon: Sparkles },
    { id: "worlds", label: "世界", icon: Globe },
    { id: "favorites", label: "收藏夹", icon: Heart },
    {
      id: "installer-minecraft",
      label: "Minecraft",
      group: "安装包",
      icon: Box,
    },
    { id: "OptiFine", label: "OptiFine", icon: Gauge },
    { id: "Forge", label: "Forge", icon: Trophy },
    { id: "NeoForge", label: "NeoForge", icon: Cat },
    { id: "Cleanroom", label: "Cleanroom", icon: FlaskConical },
    { id: "Fabric", label: "Fabric", icon: ScrollText },
    {
      id: "Legacy Fabric",
      label: "Legacy Fabric",
      icon: ScrollText,
    },
    { id: "LabyMod", label: "LabyMod", icon: Box },
    { id: "LiteLoader", label: "LiteLoader", icon: Box },
  ];
  const settingsItems = [
    { id: "launch", label: "启动", group: "游戏", icon: Rocket },
    { id: "java", label: "Java", icon: Coffee },
    { id: "manage", label: "管理", icon: BookMarked },
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
    },
    { id: "language", label: "语言", icon: Earth },
    { id: "misc", label: "杂项", icon: MonitorCog },
    {
      id: "about",
      label: "软件信息",
      group: "关于",
      icon: Info,
    },
    { id: "update", label: "软件更新", icon: RefreshCw },
    { id: "feedback", label: "反馈", icon: MessageCircle },
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
            : screen === "resource"
              ? "resource-shell"
              : screen === "tasks"
                ? "tasks-shell"
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
          <button
            className="back-heading"
            onClick={() =>
              setScreen(
                screen === "resource"
                  ? resourceOrigin
                  : screen === "tasks"
                    ? taskOrigin
                    : "home",
              )
            }
          >
            <ArrowLeft size={20} />
            <span>
              {screen === "versions"
                ? "实例选择"
                : screen === "resource"
                  ? `资源下载 - ${resource?.title || ""}`
                  : screen === "tasks"
                    ? "任务管理"
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
            {screen === "tasks" ? (
              <TaskStatistics status={downloadStatus} speed={speed} />
            ) : screen === "resource" ? null : screen === "versions" ? (
              <>
                <div className="section-label">文件夹列表</div>
                {data.roots?.map((root) => (
                  <div
                    className="ce-root-entry"
                    key={root.id}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      rootOptions(root.id, event.clientX, event.clientY);
                    }}
                  >
                    <button
                      className={`folder-entry ${root.id === rootId ? "selected" : ""} ${root.available ? "" : "unavailable"}`}
                      title={
                        root.error ? `${root.path}\n${root.error}` : root.path
                      }
                      aria-pressed={root.id === rootId}
                      disabled={rootWorking}
                      onClick={() =>
                        void rootAction("root_select", { id: root.id })
                      }
                    >
                      <strong>{root.name}</strong>
                      <small>{root.path}</small>
                      {!root.available && <small>暂不可用</small>}
                    </button>
                    <button
                      className="icon-button ce-root-options"
                      aria-label={`管理文件夹 ${root.name}`}
                      title="管理文件夹"
                      disabled={rootWorking}
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        rootOptions(root.id, rect.right, rect.top);
                      }}
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </div>
                ))}
                <div className="section-label folder-label">添加或导入</div>
                <button
                  className="side-item"
                  disabled={rootWorking}
                  onClick={() => void addRoot()}
                >
                  <FolderInput size={19} />
                  添加已有文件夹
                </button>
                <button
                  className="side-item"
                  disabled={
                    !native ||
                    archiveAdmission.current.blocked ||
                    !archiveAdmission.current.rootAvailable ||
                    !!instanceImport
                  }
                  title={
                    !native
                      ? "请在桌面应用中导入本地 ZIP"
                      : "导入由本应用导出的 ZIP"
                  }
                  onClick={openInstanceImport}
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
                  disabled: p.unavailable && p.id !== "server",
                })),
                instancePage,
                setInstancePage,
              )
            ) : tab === "launch" ? (
              <>
                {profileList ? (
                  <div className="ce-profile-list">
                    <button
                      className="ce-profile-list-row"
                      disabled={!!busy}
                      onClick={() => {
                        if (native)
                          void authAction("auth_select", { id: null });
                        setProfileList(false);
                      }}
                    >
                      <span
                        className="ce-profile-list-avatar"
                        style={{
                          backgroundImage: `url(${defaultSkin}),url(${defaultSkin})`,
                        }}
                      />
                      <span>
                        <strong>{data.settings.player}</strong>
                        <small>离线验证</small>
                      </span>
                    </button>
                    {data.auth.accounts.map((account) => (
                      <button
                        key={account.profile.id}
                        className="ce-profile-list-row"
                        disabled={!!busy}
                        onClick={() => {
                          if (native)
                            void authAction("auth_select", {
                              id: account.profile.id,
                            });
                          setProfileList(false);
                        }}
                      >
                        <span
                          className="ce-profile-list-avatar"
                          style={{
                            backgroundImage: `url(${defaultSkin}),url(${defaultSkin})`,
                          }}
                        />
                        <span>
                          <strong>{account.profile.name}</strong>
                          <small>正版验证</small>
                        </span>
                      </button>
                    ))}
                    <button
                      className="ce-button ce-profile-create"
                      title="新建档案"
                      aria-label="新建档案"
                      onClick={() => {
                        setAccountType("");
                        setDialog("account-type");
                      }}
                    >
                      <UserPlus size={16} />
                    </button>
                  </div>
                ) : data.status.stage !== "preparing" || !boundGame ? (
                  <div className="ce-profile-current">
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
                    <div className="ce-profile-actions">
                      <button
                        className="icon-button"
                        title="获取与修改皮肤（尚未开放）"
                        aria-label="获取与修改皮肤"
                        disabled
                      >
                        <Shirt size={17} />
                      </button>
                      <button
                        className="icon-button"
                        title="修改信息"
                        aria-label="修改信息"
                        onClick={() => setDialog("accounts")}
                      >
                        <Pencil size={17} />
                      </button>
                      <button
                        className="icon-button"
                        title="选择档案"
                        aria-label="选择档案"
                        onClick={() => setProfileList(true)}
                      >
                        <Users size={17} />
                      </button>
                    </div>
                  </div>
                ) : null}
                {data.status.stage === "preparing" && boundGame && (
                  <div className="ce-launch-preparing">
                    <Pickaxe size={30} />
                    <h2>正在启动</h2>
                    <p>{data.status.message}</p>
                    <small>
                      验证方式：{activeAccount ? "正版验证" : "离线验证"}
                    </small>
                    <div className="download-progress indeterminate">
                      <i />
                    </div>
                  </div>
                )}
                <div className="launch-controls">
                  <button
                    className="launch-button"
                    disabled={
                      !native ||
                      (!boundGame &&
                        (!selected ||
                          downloadBusy ||
                          resourceBusy ||
                          checking ||
                          rootWorking ||
                          !rootAvailable ||
                          instanceRecoveryBlocked ||
                          !!busy))
                    }
                    onClick={() =>
                      boundGame
                        ? api("stop_game").catch((e) => notify(String(e)))
                        : launch()
                    }
                  >
                    <span>
                      {boundGame
                        ? data.status.stage === "preparing"
                          ? "取消"
                          : "结束游戏"
                        : "启动游戏"}
                    </span>
                    <small>
                      {boundGame
                        ? data.status.message
                        : busy
                          ? "其他实例正在准备或运行"
                          : selected?.id || "请选择游戏实例"}
                    </small>
                  </button>
                  <div className="launch-secondary">
                    <button
                      className="ce-button"
                      disabled={rootWorking}
                      onClick={() => {
                        setQuery("");
                        setScreen("versions");
                      }}
                    >
                      实例选择
                    </button>
                    <button
                      className="ce-button"
                      disabled={!selected || rootWorking}
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
          <main className="content" ref={contentRef}>
            {data.import_recovery_error && screen !== "tasks" && (
              <section className="error-banner" role="alert">
                <TriangleAlert size={17} />
                <span>{data.import_recovery_error}</span>
                <button
                  className="ce-button"
                  disabled={
                    !native ||
                    archiveAdmission.current.blocked ||
                    !rootAvailable
                  }
                  onClick={() => void recoverInstanceArchives("import")}
                >
                  恢复实例导入
                </button>
              </section>
            )}
            {data.delete_recovery_error && screen !== "tasks" && (
              <section className="error-banner" role="alert">
                <TriangleAlert size={17} />
                <span>{data.delete_recovery_error}</span>
                <button
                  className="ce-button"
                  title={
                    data.roots?.find(
                      (root) => root.id === data.delete_recovery_root_id,
                    )?.path
                  }
                  disabled={
                    !native ||
                    archiveAdmission.current.blocked ||
                    !data.delete_recovery_root_id ||
                    !data.roots?.some(
                      (root) =>
                        root.id === data.delete_recovery_root_id &&
                        root.available,
                    )
                  }
                  onClick={() => void recoverInstanceArchives("delete")}
                >
                  恢复实例删除
                </button>
              </section>
            )}
            {data.rename_recovery_error && screen !== "tasks" && (
              <section className="error-banner" role="alert">
                <TriangleAlert size={17} />
                <span>{data.rename_recovery_error}</span>
                <button
                  className="ce-button"
                  title={
                    data.roots?.find(
                      (root) => root.id === data.rename_recovery_root_id,
                    )?.path
                  }
                  disabled={
                    !native ||
                    !!busy ||
                    downloadBusy ||
                    resourceBusy ||
                    !data.rename_recovery_root_id ||
                    !data.roots?.some(
                      (root) =>
                        root.id === data.rename_recovery_root_id &&
                        root.available,
                    )
                  }
                  onClick={() => void recoverInstanceRename()}
                >
                  恢复实例重命名
                </button>
              </section>
            )}
            {data.resource_install_recovery_error && screen !== "tasks" && (
              <section className="error-banner" role="alert">
                <TriangleAlert size={17} />
                <span>{data.resource_install_recovery_error}</span>
                <button
                  className="ce-button"
                  disabled={
                    !native ||
                    archiveAdmission.current.blocked ||
                    !rootAvailable
                  }
                  onClick={() => void recoverResourceInstall()}
                >
                  恢复资源安装或更新
                </button>
              </section>
            )}
            {data.reset_recovery_error && screen !== "tasks" && (
              <section className="error-banner" role="alert">
                <TriangleAlert size={17} />
                <span>{data.reset_recovery_error}</span>
                <button
                  className="ce-button"
                  disabled={
                    !native ||
                    !!busy ||
                    downloadBusy ||
                    resourceBusy ||
                    !rootAvailable
                  }
                  onClick={() => void recoverInstanceReset()}
                >
                  恢复实例重置
                </button>
              </section>
            )}
            <div hidden={screen !== "home" || tab !== "download"}>
              <DownloadPanel
                visible={screen === "home" && tab === "download"}
                section={downloadPage}
                api={api}
                rootId={rootId}
                rootAvailable={rootAvailable && !rootWorking}
                native={native}
                installed={data.instances}
                gameBusy={!!busy || resourceBusy || instanceRecoveryBlocked}
                onInstalled={load}
                onBusyChange={setDownloadBusy}
                onStatusChange={acceptDownloadStatus}
                onResourceDetails={showResource}
                onTaskStart={showTasks}
              />
            </div>
            <div
              key={`${rootKey}:${screen}:${tab}:${instancePage}:${settingsPage}`}
              className="ce-page-enter ce-main-page"
            >
              {screen === "resource" && resource ? (
                <ResourceDetails
                  key={`${rootKey}:${resource.source}:${resource.project_id || resource.local_path}`}
                  api={rootApi}
                  resource={resource}
                  onNotify={notify}
                  scopeKey={rootId || ""}
                  selectedInstance={selected || null}
                  native={native}
                  disabled={
                    !!busy ||
                    downloadBusy ||
                    resourceBusy ||
                    rootWorking ||
                    !rootAvailable ||
                    instanceRecoveryBlocked
                  }
                  onTaskStart={showInstanceTask}
                />
              ) : screen === "tasks" ? (
                <TaskManager
                  key={downloadStatus.task_id || "legacy-task"}
                  api={taskApi}
                  status={downloadStatus}
                  native={native}
                  onNotify={notify}
                  onStatusChange={acceptDownloadStatus}
                  onCancelled={finishTaskCancellation}
                />
              ) : screen === "versions" ? (
                <>
                  <InstanceTrash
                    api={rootApi}
                    scopeKey={rootId || data.settings.root}
                    native={native}
                    disabled={
                      archiveAdmission.current.blocked ||
                      !archiveAdmission.current.rootAvailable
                    }
                    onTaskStart={showInstanceTask}
                    refreshKey={`${data.settings.revision || ""}:${downloadStatus.task_id || ""}:${downloadStatus.stage}`}
                  />
                  {data.config_warning && (
                    <div className="error-banner" role="alert">
                      <TriangleAlert size={17} />
                      <span>{data.config_warning}</span>
                    </div>
                  )}
                  {(data.scan_error || selectedRoot?.error) && (
                    <div className="error-banner" role="alert">
                      <TriangleAlert size={17} />
                      <span>{data.scan_error || selectedRoot?.error}</span>
                    </div>
                  )}
                  {!!data.scan_issues?.length && (
                    <div className="auth-notice" role="status">
                      <p>部分实例无法读取：</p>
                      {data.scan_issues.map((issue, index) => (
                        <p key={`${issue.id}:${index}`}>
                          {issue.id}：{issue.message}
                        </p>
                      ))}
                    </div>
                  )}
                  <InstanceSelection
                    key={rootKey}
                    instances={data.instances}
                    query={query}
                    setQuery={setQuery}
                    disabled={rootWorking}
                    onPick={pick}
                  />
                </>
              ) : screen === "instance" && selected ? (
                <InstancePanel
                  key={`${rootKey}:${selected.id}`}
                  instance={selected}
                  section={instancePage}
                  settings={data.settings}
                  api={rootApi}
                  native={native}
                  onTaskStart={showInstanceTask}
                  occupiedNames={data.instances.map((instance) => instance.id)}
                  onSave={save}
                  onOpen={open}
                  onInspect={launch}
                  onNotify={notify}
                  onMetadataChange={(id: string, meta: MetaView) => {
                    if (contextKey.current !== rootKey) return;
                    setData((current) => {
                      if (
                        !current ||
                        `${current.settings.root_id || ""}:${current.settings.root}` !==
                          rootKey
                      )
                        return current;
                      const { revision, ...metadata } = meta;
                      return {
                        ...current,
                        instances: current.instances.map((instance) =>
                          instance.id === id
                            ? {
                                ...instance,
                                metadata,
                                metadata_revision: revision,
                              }
                            : instance,
                        ),
                      };
                    });
                  }}
                  onResourceDetails={(r) =>
                    showResource(
                      {
                        project_id: "",
                        title: r.name,
                        description: r.description || "",
                        icon_url: r.icon || null,
                        categories: [],
                        display_categories: [],
                        versions: [selected.minecraft_version],
                        source: "local",
                        file_name: r.file_name,
                        local_path: r.path,
                        local_version: r.version,
                        enabled: r.enabled,
                        local_minecraft_version: selected.minecraft_version,
                        local_loader: selected.loader,
                        project_type: r.kind === "mods" ? "mod" : r.kind,
                      },
                      "instance",
                    )
                  }
                  disabled={rootOccupied || rootWorking}
                  mutationDisabled={
                    !!busy ||
                    downloadBusy ||
                    resourceBusy ||
                    rootWorking ||
                    !rootAvailable ||
                    instanceRecoveryBlocked
                  }
                />
              ) : screen === "home" ? (
                <>
                  {tab === "launch" &&
                    processInRoot &&
                    data.status.stage === "error" && (
                      <button
                        className="error-banner"
                        onClick={() => {
                          setTab("settings");
                          setSettingsPage("logs");
                        }}
                      >
                        <TriangleAlert size={18} />
                        <span>{data.status.message}</span>
                        <ChevronRight size={18} />
                      </button>
                    )}
                  {tab === "settings" &&
                    (["launch", "java"].includes(settingsPage) ? (
                      <SettingsPanel
                        section={settingsPage}
                        settings={data.settings}
                        key={rootKey}
                        api={rootApi}
                        native={native}
                        onSave={save}
                        onRefresh={load}
                        disabled={
                          !!busy ||
                          downloadBusy ||
                          resourceBusy ||
                          rootWorking ||
                          instanceRecoveryBlocked
                        }
                        onInstances={instanceSettings}
                        onNotify={notify}
                      />
                    ) : (
                      <ExtraSettings
                        key={`${rootKey}:${settingsPage}`}
                        section={settingsPage}
                        settings={data.settings}
                        api={rootApi}
                        onOpen={open}
                        onNotify={notify}
                      />
                    ))}
                  {tab === "tools" && (
                    <Toolbox onOpen={open} root={data.settings.root} />
                  )}
                </>
              ) : null}
            </div>
          </main>
        </div>
      )}
      {!["idle", "cancelled"].includes(downloadStatus.stage) &&
        screen !== "tasks" && (
          <button
            className="ce-task-entry"
            title="任务管理"
            aria-label="任务管理"
            onClick={showTasks}
          >
            <Download size={23} />
          </button>
        )}
      {data &&
        instanceImport &&
        instanceImport.rootKey === rootKey &&
        screen === "versions" &&
        instanceImport.epoch === taskNavigation.current.epoch && (
          <InstanceImport
            key={`${instanceImport.rootKey}:${instanceImport.epoch}`}
            api={rootApi}
            scopeKey={rootId || data.settings.root}
            native={native}
            disabled={
              archiveAdmission.current.blocked ||
              !archiveAdmission.current.rootAvailable
            }
            occupiedNames={data.instances.map((instance) => instance.id)}
            onTaskStart={showInstanceTask}
            onNotify={notify}
            onClose={() =>
              setInstanceImport((current) =>
                current === instanceImport ? null : current,
              )
            }
          />
        )}
      {rootMenu && menuRoot && (
        <div
          className="ce-root-menu"
          role="menu"
          aria-label={`管理文件夹 ${menuRoot.name}`}
          style={{ left: rootMenu.x, top: rootMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button role="menuitem" onClick={() => editRoot(menuRoot, "rename")}>
            <Pencil size={16} />
            重命名
          </button>
          <button
            role="menuitem"
            disabled={rootWorking || menuRootIndex <= 0}
            onClick={() =>
              void rootAction("root_update", {
                id: menuRoot.id,
                position: menuRootIndex - 1,
              })
            }
          >
            <ArrowUp size={16} />
            上移
          </button>
          <button
            role="menuitem"
            disabled={
              rootWorking || menuRootIndex >= (data?.roots?.length || 0) - 1
            }
            onClick={() =>
              void rootAction("root_update", {
                id: menuRoot.id,
                position: menuRootIndex + 1,
              })
            }
          >
            <ArrowDown size={16} />
            下移
          </button>
          <button
            role="menuitem"
            disabled={
              rootWorking || (data?.roots?.length || 0) <= 1 || menuRootOccupied
            }
            title={
              menuRootOccupied ? "此目录正在使用，请等待任务结束" : undefined
            }
            onClick={() => editRoot(menuRoot, "remove")}
          >
            <X size={16} />
            移除文件夹
          </button>
        </div>
      )}
      {rootDialog && (
        <div
          className="modal-shade rd-name-shade"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !rootWorking)
              setRootDialog(null);
          }}
        >
          <form
            className="rd-name-dialog ce-root-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ce-root-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              if (rootDialog.mode === "rename" && !rootName.trim()) {
                setRootError("请输入文件夹名称");
                return;
              }
              void rootAction(
                rootDialog.mode === "rename" ? "root_update" : "root_remove",
                rootDialog.mode === "rename"
                  ? { id: rootDialog.root.id, name: rootName.trim() }
                  : { id: rootDialog.root.id },
              );
            }}
          >
            <h2 id="ce-root-dialog-title">
              {rootDialog.mode === "rename" ? "重命名文件夹" : "移除文件夹"}
            </h2>
            {rootDialog.mode === "rename" ? (
              <input
                className="ce-field"
                aria-label="文件夹名称"
                value={rootName}
                maxLength={128}
                disabled={rootWorking}
                onChange={(event) => setRootName(event.target.value)}
              />
            ) : (
              <p>从文件夹列表移除“{rootDialog.root.name}”，游戏文件会保留。</p>
            )}
            {rootError && (
              <p className="rd-name-error" role="alert">
                {rootError}
              </p>
            )}
            <div className="rd-name-actions">
              <button
                className="ce-button"
                type="submit"
                disabled={rootWorking}
              >
                {rootWorking
                  ? "正在保存…"
                  : rootDialog.mode === "rename"
                    ? "确定"
                    : "移除"}
              </button>
              <button
                className="ce-button"
                type="button"
                disabled={rootWorking}
                onClick={() => setRootDialog(null)}
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}
      {dialog === "account-type" && (
        <div
          className="modal-shade"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <section
            className="ce-account-type-modal"
            role="dialog"
            aria-modal="true"
            aria-label="新建档案 - 选择验证类型"
          >
            <h2>新建档案 - 选择验证类型</h2>
            <div className="ce-account-types">
              {[
                { id: "premium", name: "正版验证", icon: ShieldCheck },
                { id: "third-party", name: "第三方验证", icon: Network },
                { id: "offline", name: "离线验证", icon: Unplug },
              ].map((item) => (
                <button
                  key={item.id}
                  className={accountType === item.id ? "selected" : ""}
                  disabled={item.id === "third-party"}
                  title={
                    item.id === "third-party" ? "第三方验证尚未接入" : undefined
                  }
                  onClick={() => setAccountType(item.id)}
                >
                  <item.icon size={24} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
            <div className="ce-account-type-footer">
              <button
                className="ce-button"
                disabled={!accountType}
                onClick={() => setDialog("accounts")}
              >
                继续
              </button>
              <button className="ce-button" onClick={() => setDialog(null)}>
                取消
              </button>
            </div>
          </section>
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
