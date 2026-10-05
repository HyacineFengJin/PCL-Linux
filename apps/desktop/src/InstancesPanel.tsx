import { useEffect, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  Search,
  Flame,
  Layers,
  Globe,
  Image,
  Server,
  Puzzle,
  Sparkles,
  Blocks,
  Play,
  Settings as SettingsIcon,
  Signal,
  FolderOpen,
} from "lucide-react";
import { Collapse } from "./Collapse";
import { InstanceOperations } from "./InstanceOperations";
import { JavaSelect } from "./JavaSelect";
import { InstanceDelete } from "./InstanceTrash";
import { ResourcePanel, type LocalResourceDetails } from "./LocalResources";
export type { LocalResourceDetails } from "./LocalResources";
import commandIcon from "./assets/game-icons/command.png";
import lampTexture from "./assets/game-icons/redstone-lamp.png";
import grassIcon from "./assets/game-icons/grass.png";
import neoForgeIcon from "./assets/game-icons/neoforge.png";
import forgeIcon from "./assets/game-icons/forge.png";
import steveIcon from "./assets/game-icons/steve.png";
import type {
  Api,
  Instance,
  InstanceMetadata,
  MetaView,
  Settings,
} from "./types";

export const instancePages = [
  { id: "overview", label: "概览", group: "游戏本体", icon: Blocks },
  { id: "settings", label: "设置", icon: null },
  { id: "modify", label: "修改", icon: null },
  { id: "export", label: "导出", icon: Box },
  { id: "saves", label: "存档", group: "游戏资源", icon: Globe },
  { id: "screenshots", label: "截图", icon: Image },
  { id: "mods", label: "模组", icon: Puzzle },
  { id: "resourcepacks", label: "资源包", icon: Layers },
  { id: "shaderpacks", label: "光影包", icon: Sparkles },
  { id: "litematics", label: "投影原理图", icon: Blocks },
  { id: "server", label: "服务器", icon: Server, unavailable: true },
];
const notReady = "此功能尚未开放";
const defaultMetadata: InstanceMetadata = {
  description: "",
  favorite: false,
  icon: "auto",
  category: "auto",
};
const categoryGroups: Record<
  Exclude<InstanceMetadata["category"], "auto">,
  string
> = {
  vanilla: "Vanilla",
  forge: "Forge",
  neoforge: "NeoForge",
  fabric: "Fabric",
  quilt: "Quilt",
};
const builtInIcons = {
  grass: grassIcon,
  forge: forgeIcon,
  neoforge: neoForgeIcon,
  command: commandIcon,
  steve: steveIcon,
};
type MetadataScope = {
  api: Api;
  id: string;
  section: string;
  root: string;
};
type RenamePlan = {
  revision: string;
  id: string;
  new_name: string;
  dependent_instances: string[];
};
type RenameDialog = {
  scope: MetadataScope;
  draft: string;
  plan: RenamePlan | null;
  error: string;
};
export function instanceRenameNameError(
  name: string,
  current: string,
  occupiedNames: string[],
): string {
  if (!name.trim()) return "请输入实例名称";
  if (name !== name.trim()) return "实例名称不能以空白字符开头或结尾";
  if (
    name === "." ||
    name === ".." ||
    /[\\/:\u0000-\u001f\u007f-\u009f]/.test(name)
  )
    return "实例名称不能包含路径分隔符、冒号或控制字符";
  if (name.startsWith(".install-")) return "实例名称不能使用 .install- 前缀";
  if (new TextEncoder().encode(name).length > 120)
    return "实例名称过长，请缩短到 120 字节以内";
  if (name === current) return "请输入与当前实例不同的名称";
  if (occupiedNames.includes(name))
    return "此游戏目录中已存在同名实例，请修改名称";
  return "";
}
export function InstanceIcon({
  loader = "Vanilla",
  icon = "auto",
}: {
  loader?: string;
  icon?: InstanceMetadata["icon"];
}) {
  const automaticIcon =
    loader === "Vanilla"
      ? grassIcon
      : loader.startsWith("NeoForge")
        ? neoForgeIcon
        : loader.startsWith("Forge")
          ? forgeIcon
          : null;
  const image = icon === "auto" ? automaticIcon : builtInIcons[icon];
  return (
    <span className="instance-icon" aria-hidden="true">
      {image ? <img src={image} alt="" /> : <Box size={29} strokeWidth={1.4} />}
    </span>
  );
}
function Tags({ instance }: { instance: Instance }) {
  return (
    <div className="instance-tags">
      <span>{instance.minecraft_version}</span>
      {instance.loader !== "Vanilla" && <span>{instance.loader}</span>}
    </div>
  );
}
export function InstanceSelection({
  instances,
  query,
  setQuery,
  onPick,
  disabled,
}: {
  instances: Instance[];
  query: string;
  setQuery: (q: string) => void;
  onPick: (id: string) => void;
  disabled: boolean;
}) {
  const groupFor = (instance: Instance) => {
    const category = instance.metadata?.category || "auto";
    return category === "auto"
      ? instance.loader.split(" ")[0]
      : categoryGroups[category];
  };
  const search = query.toLowerCase();
  const matches = (instance: Instance) =>
    instance.id.toLowerCase().includes(search) ||
    (instance.metadata?.description || "").toLowerCase().includes(search);
  const visible = instances.filter(matches);
  const groups = [
    ...(visible.some((v) => v.metadata?.favorite) ? ["favorites"] : []),
    ...new Set(visible.filter((v) => !v.metadata?.favorite).map(groupFor)),
  ];
  const [collapsed, setCollapsed] = useState<string[]>([]);
  return (
    <>
      <label className="ce-card ce-searchbar">
        <Search size={17} />
        <input
          autoFocus
          placeholder="搜索游戏实例"
          aria-label="搜索游戏实例"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {groups.map((group) => {
        const entries = visible.filter((v) =>
          group === "favorites"
            ? v.metadata?.favorite
            : !v.metadata?.favorite && groupFor(v) === group,
        );
        if (!entries.length) return null;
        const isOpen = !collapsed.includes(group);
        return (
          <section className="ce-card instance-group" key={group}>
            <button
              className="ce-collapse"
              onClick={() =>
                setCollapsed((old) =>
                  isOpen ? [...old, group] : old.filter((v) => v !== group),
                )
              }
              aria-expanded={isOpen}
            >
              <strong>
                {group === "favorites"
                  ? "收藏夹"
                  : `${group === "Vanilla" ? "原版" : group} 实例`}{" "}
                ({entries.length})
              </strong>
              <ChevronDown
                size={17}
                className={`ce-disclosure-arrow ${isOpen ? "is-open" : ""}`}
              />
            </button>
            <Collapse open={isOpen}>
              <div className="instance-group-list">
                {entries.map((v) => (
                  <button
                    className="resource-row"
                    key={v.id}
                    disabled={disabled}
                    onClick={() => onPick(v.id)}
                  >
                    <InstanceIcon loader={v.loader} icon={v.metadata?.icon} />
                    <div className="ce-resource-text">
                      <strong className="ce-instance-title">
                        <span>{v.id}</span>
                        {v.metadata?.description && (
                          <small
                            className="ce-instance-description"
                            title={v.metadata.description}
                          >
                            {v.metadata.description}
                          </small>
                        )}
                      </strong>
                      <Tags instance={v} />
                    </div>
                  </button>
                ))}
              </div>
            </Collapse>
          </section>
        );
      })}
      {!visible.length && (
        <section className="ce-card ce-empty">没有找到游戏实例</section>
      )}
    </>
  );
}
export function InstancePanel({
  instance,
  section,
  settings,
  api,
  onSave,
  onOpen,
  onInspect,
  onNotify,
  onResourceDetails,
  onMetadataChange,
  disabled,
  mutationDisabled,
  native,
  onTaskStart,
  occupiedNames = [],
}: {
  instance: Instance;
  section: string;
  settings: Settings;
  api: Api;
  onSave: (s: Settings) => Promise<void>;
  onOpen: (kind: string) => void;
  onInspect: () => void;
  onNotify: (s: string) => void;
  onResourceDetails?: (resource: LocalResourceDetails) => void;
  onMetadataChange?: (id: string, meta: MetaView) => void;
  disabled: boolean;
  mutationDisabled?: boolean;
  native: boolean;
  onTaskStart: (id: string) => void;
  occupiedNames?: string[];
}) {
  const rootScope = settings.root_id || settings.root;
  const metadataScope = useRef<MetadataScope>({
    api,
    id: instance.id,
    section,
    root: rootScope,
  });
  if (
    metadataScope.current.api !== api ||
    metadataScope.current.id !== instance.id ||
    metadataScope.current.section !== section ||
    metadataScope.current.root !== rootScope
  ) {
    metadataScope.current = { api, id: instance.id, section, root: rootScope };
  }
  const currentMetadataScope = metadataScope.current;
  const metadataLive = useRef(true);
  const metadataWorkingRef = useRef<symbol | null>(null);
  const [metadataActivity, setMetadataActivity] = useState<
    "save" | "read" | null
  >(null);
  const metadataWorking = metadataActivity !== null;
  const [savedMetadata, setSavedMetadata] = useState<{
    api: Api;
    id: string;
    root: string;
    sourceRevision?: string;
    meta: MetaView;
  } | null>(null);
  const [metadataFailure, setMetadataFailure] = useState<{
    scope: MetadataScope;
    message: string;
  } | null>(null);
  const [descriptionDialog, setDescriptionDialog] = useState<{
    scope: MetadataScope;
    draft: string;
    revision: string;
  } | null>(null);
  const descriptionButton = useRef<HTMLButtonElement>(null);
  const restoreDescriptionFocus = useRef<MetadataScope | null>(null);
  const [renameDialog, setRenameDialogState] = useState<RenameDialog | null>(
    null,
  );
  const renameDialogRef = useRef<RenameDialog | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const renameOperation = useRef<{
    token: symbol;
    scope: MetadataScope;
    kind: "prepare" | "start";
  } | null>(null);
  const [renameActivity, setRenameActivity] = useState<{
    token: symbol;
    scope: MetadataScope;
    kind: "prepare" | "start";
  } | null>(null);
  const renameOpen = renameDialog?.scope === currentMetadataScope;
  const renameWorking = renameActivity?.scope === currentMetadataScope;
  const renameDisabled =
    !native || disabled || !!mutationDisabled || metadataWorking;
  const renameAvailability = useRef(renameDisabled);
  renameAvailability.current = renameDisabled;
  const renameNameError =
    renameOpen && renameDialog
      ? instanceRenameNameError(renameDialog.draft, instance.id, occupiedNames)
      : "";
  function setRenameDialog(next: RenameDialog | null) {
    renameDialogRef.current = next;
    setRenameDialogState(next);
  }
  function closeRename() {
    if (
      !metadataLive.current ||
      metadataScope.current !== currentMetadataScope ||
      renameDialogRef.current?.scope !== currentMetadataScope
    )
      return;
    if (
      renameOperation.current?.scope === currentMetadataScope &&
      renameOperation.current.kind === "start"
    )
      return;
    if (renameOperation.current?.scope === currentMetadataScope) {
      renameOperation.current = null;
      setRenameActivity(null);
    }
    setRenameDialog(null);
    if (metadataScope.current === currentMetadataScope)
      renameButton.current?.focus();
  }
  async function submitRename() {
    const dialog = renameDialogRef.current;
    if (
      !dialog ||
      currentMetadataScope !== metadataScope.current ||
      dialog.scope !== currentMetadataScope ||
      dialog.scope !== metadataScope.current ||
      !metadataLive.current ||
      renameAvailability.current ||
      instanceRenameNameError(dialog.draft, dialog.scope.id, occupiedNames) ||
      renameOperation.current?.scope === dialog.scope
    )
      return;
    const operation = {
      token: Symbol(),
      scope: dialog.scope,
      kind: dialog.plan ? ("start" as const) : ("prepare" as const),
    };
    renameOperation.current = operation;
    setRenameActivity(operation);
    const isCurrent = () =>
      metadataLive.current &&
      metadataScope.current === dialog.scope &&
      renameDialogRef.current === dialog;
    try {
      if (dialog.plan) {
        const { revision, id, new_name } = dialog.plan;
        const result = await api<{ id: string }>("instance_rename_start", {
          plan: { revision, id, new_name },
        });
        if (!isCurrent()) return;
        if (!result.id) throw new Error("未收到重命名任务，请重新检查后重试");
        setRenameDialog(null);
        onTaskStart(result.id);
      } else {
        const plan = await api<RenamePlan>("instance_rename_prepare", {
          id: dialog.scope.id,
          newName: dialog.draft,
        });
        if (!isCurrent()) return;
        if (
          plan.id !== dialog.scope.id ||
          plan.new_name !== dialog.draft ||
          !plan.revision
        )
          throw new Error("重命名计划与当前实例不一致，请重新检查");
        setRenameDialog({ ...dialog, plan, error: "" });
      }
    } catch (error) {
      if (isCurrent())
        setRenameDialog({ ...dialog, plan: null, error: String(error) });
    } finally {
      if (renameOperation.current?.token === operation.token) {
        renameOperation.current = null;
        if (metadataLive.current)
          setRenameActivity((old) =>
            old?.token === operation.token ? null : old,
          );
      }
    }
  }
  const hasSavedMetadata =
    savedMetadata?.api === api &&
    savedMetadata.id === instance.id &&
    savedMetadata.root === rootScope &&
    (savedMetadata.sourceRevision === instance.metadata_revision ||
      savedMetadata.meta.revision === instance.metadata_revision);
  const metadata = hasSavedMetadata
    ? savedMetadata.meta
    : instance.metadata || defaultMetadata;
  const metadataRevision = hasSavedMetadata
    ? savedMetadata.meta.revision
    : instance.metadata_revision;
  const metadataError =
    metadataFailure?.scope === currentMetadataScope
      ? metadataFailure.message
      : "";
  const descriptionOpen = descriptionDialog?.scope === currentMetadataScope;
  const metadataReadOnly = !metadataRevision;
  const metadataWritesDisabled =
    disabled ||
    !!mutationDisabled ||
    metadataReadOnly ||
    metadataWorking ||
    renameOpen ||
    renameWorking;
  const metadataReadOnlyMessage =
    "当前实例个性化信息仅可查看，请重新加载实例列表后再试。";
  useEffect(() => {
    metadataLive.current = true;
    return () => {
      metadataLive.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      !descriptionOpen &&
      !metadataWorking &&
      restoreDescriptionFocus.current
    ) {
      if (restoreDescriptionFocus.current === currentMetadataScope) {
        descriptionButton.current?.focus();
      }
      restoreDescriptionFocus.current = null;
    }
  }, [descriptionOpen, metadataWorking, currentMetadataScope]);
  function closeDescription() {
    if (metadataWorkingRef.current) return;
    setDescriptionDialog(null);
    descriptionButton.current?.focus();
  }
  function acceptMetadata(meta: MetaView) {
    setSavedMetadata({
      api,
      id: instance.id,
      root: rootScope,
      sourceRevision: instance.metadata_revision,
      meta,
    });
    onMetadataChange?.(instance.id, meta);
  }
  async function reloadMetadata() {
    if (
      metadataWorkingRef.current ||
      currentMetadataScope !== metadataScope.current
    )
      return;
    const operation = Symbol();
    metadataWorkingRef.current = operation;
    setMetadataActivity("read");
    const isCurrent = () =>
      metadataLive.current && metadataScope.current === currentMetadataScope;
    try {
      const meta = await api<MetaView>("instance_metadata_read", {
        id: instance.id,
      });
      if (!isCurrent()) return;
      acceptMetadata(meta);
      setMetadataFailure(null);
      if (descriptionOpen)
        restoreDescriptionFocus.current = currentMetadataScope;
      setDescriptionDialog(null);
      onNotify("已重新读取实例个性化信息");
    } catch (error) {
      if (isCurrent()) {
        setMetadataFailure({
          scope: currentMetadataScope,
          message: String(error),
        });
      }
    } finally {
      if (metadataWorkingRef.current === operation) {
        metadataWorkingRef.current = null;
        if (metadataLive.current) setMetadataActivity(null);
      }
    }
  }
  async function updateMetadata(
    patch: Partial<InstanceMetadata>,
    successMessage: string,
    expectedRevision = metadataRevision,
  ) {
    if (
      metadataWritesDisabled ||
      metadataWorkingRef.current ||
      currentMetadataScope !== metadataScope.current ||
      !expectedRevision
    )
      return;
    const operation = Symbol();
    metadataWorkingRef.current = operation;
    setMetadataActivity("save");
    setMetadataFailure(null);
    const isCurrent = () =>
      metadataLive.current && metadataScope.current === currentMetadataScope;
    try {
      const meta = await api<MetaView>("instance_metadata_update", {
        id: instance.id,
        revision: expectedRevision,
        patch,
      });
      if (!isCurrent()) return;
      acceptMetadata(meta);
      if (patch.description !== undefined) {
        restoreDescriptionFocus.current = currentMetadataScope;
        setDescriptionDialog(null);
      }
      onNotify(successMessage);
    } catch (error) {
      if (isCurrent()) {
        setMetadataFailure({
          scope: currentMetadataScope,
          message: String(error),
        });
      }
    } finally {
      if (metadataWorkingRef.current === operation) {
        metadataWorkingRef.current = null;
        if (metadataLive.current) setMetadataActivity(null);
      }
    }
  }
  const [memory, setMemory] = useState(
    settings.overrides[instance.id] || settings.memory_gib,
  );
  const [mode, setMode] = useState(
    settings.overrides[instance.id] ? "custom" : "global",
  );
  const [system, setSystem] = useState<{
    total_memory_bytes: number;
    available_memory_bytes: number;
  } | null>(null);
  useEffect(() => {
    setMemory(settings.overrides[instance.id] || settings.memory_gib);
    setMode(settings.overrides[instance.id] ? "custom" : "global");
  }, [instance.id, settings]);
  useEffect(() => {
    let live = true;
    api<{ total_memory_bytes: number; available_memory_bytes: number }>(
      "system_info",
    )
      .then((v) => {
        if (live) setSystem(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  async function saveMemory(nextMode = mode, nextMemory = memory) {
    const overrides = { ...settings.overrides };
    if (nextMode === "global") delete overrides[instance.id];
    else overrides[instance.id] = nextMemory;
    try {
      await onSave({ ...settings, overrides });
    } catch (e) {
      onNotify(String(e));
    }
  }
  if (section === "overview")
    return (
      <>
        <section className="ce-card instance-summary">
          <InstanceIcon loader={instance.loader} icon={metadata.icon} />
          <div className="ce-instance-summary-text">
            <div className="ce-instance-title">
              <span>{instance.id}</span>
              {metadata.description && (
                <small
                  className="ce-instance-description"
                  title={metadata.description}
                >
                  {metadata.description}
                </small>
              )}
            </div>
            <Tags instance={instance} />
          </div>
        </section>
        <section className="ce-card">
          <h2 className="ce-card-title">实例信息</h2>
          <div className="instance-info">
            <div>
              <span className="info-block">
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <image
                    href={lampTexture}
                    width="16"
                    height="16"
                    transform="matrix(1,-.5,1,.5,0,8)"
                  />
                  <image
                    href={lampTexture}
                    width="16"
                    height="16"
                    transform="matrix(1,.5,0,1,0,8)"
                  />
                  <image
                    href={lampTexture}
                    width="16"
                    height="16"
                    transform="matrix(1,-.5,0,1,16,16)"
                    style={{ filter: "brightness(.8)" }}
                  />
                </svg>
              </span>
              <div>
                启动次数<small>—</small>
              </div>
            </div>
            <div>
              <span className="info-block command">
                <img src={commandIcon} alt="" />
              </span>
              <div>
                整合包版本<small>—</small>
              </div>
            </div>
            <div>
              <InstanceIcon />
              <div>
                Minecraft<small>{instance.minecraft_version}</small>
              </div>
            </div>
            {instance.loader !== "Vanilla" && (
              <div>
                <InstanceIcon loader={instance.loader} />
                <div>
                  {instance.loader.split(" ")[0]}
                  <small>{instance.loader.split(" ").slice(1).join(" ")}</small>
                </div>
              </div>
            )}
          </div>
        </section>
        <section className="ce-card">
          <h2 className="ce-card-title">个性化</h2>
          <div className="instance-personalization">
            <label className="ce-row">
              <span>图标</span>
              <select
                className="ce-field"
                aria-label="实例图标"
                value={metadata.icon}
                disabled={metadataWritesDisabled}
                title={metadataReadOnly ? metadataReadOnlyMessage : undefined}
                onChange={(event) =>
                  void updateMetadata(
                    { icon: event.target.value as InstanceMetadata["icon"] },
                    "已保存实例图标",
                  )
                }
              >
                <option value="auto">自动</option>
                <option value="grass">草方块</option>
                <option value="forge">Forge</option>
                <option value="neoforge">NeoForge</option>
                <option value="command">命令方块</option>
                <option value="steve">Steve</option>
              </select>
            </label>
            <label className="ce-row">
              <span>分类</span>
              <select
                className="ce-field"
                aria-label="实例分类"
                value={metadata.category}
                disabled={metadataWritesDisabled}
                title={metadataReadOnly ? metadataReadOnlyMessage : undefined}
                onChange={(event) =>
                  void updateMetadata(
                    {
                      category: event.target
                        .value as InstanceMetadata["category"],
                    },
                    "已保存实例分类",
                  )
                }
              >
                <option value="auto">自动</option>
                <option value="vanilla">原版</option>
                <option value="forge">Forge</option>
                <option value="neoforge">NeoForge</option>
                <option value="fabric">Fabric</option>
                <option value="quilt">Quilt</option>
              </select>
            </label>
            <div className="ce-actions">
              <button
                className="ce-button"
                ref={renameButton}
                disabled={renameDisabled || renameOpen || renameWorking}
                title={
                  !native ? "请在桌面应用中修改实例名" : "修改实例文件夹的名称"
                }
                onClick={() => {
                  if (
                    renameAvailability.current ||
                    renameWorking ||
                    renameOpen ||
                    metadataScope.current !== currentMetadataScope
                  )
                    return;
                  setRenameDialog({
                    scope: currentMetadataScope,
                    draft: instance.id,
                    plan: null,
                    error: "",
                  });
                }}
              >
                修改实例名
              </button>
              <button
                className="ce-button"
                ref={descriptionButton}
                disabled={metadataWritesDisabled}
                title={metadataReadOnly ? metadataReadOnlyMessage : undefined}
                onClick={() => {
                  if (
                    metadataWritesDisabled ||
                    metadataWorkingRef.current ||
                    currentMetadataScope !== metadataScope.current ||
                    !metadataRevision
                  )
                    return;
                  setMetadataFailure(null);
                  setDescriptionDialog({
                    scope: currentMetadataScope,
                    draft: metadata.description,
                    revision: metadataRevision,
                  });
                }}
              >
                修改实例描述
              </button>
              <button
                className="ce-button"
                disabled={metadataWritesDisabled}
                title={metadataReadOnly ? metadataReadOnlyMessage : undefined}
                onClick={() =>
                  void updateMetadata(
                    { favorite: !metadata.favorite },
                    metadata.favorite ? "已从收藏夹移除实例" : "已加入收藏夹",
                  )
                }
              >
                {metadata.favorite ? "移出收藏夹" : "加入收藏夹"}
              </button>
            </div>
            {(metadataReadOnly || metadataError) && !descriptionOpen && (
              <div
                className={`ce-instance-metadata-status ${metadataError ? "is-error" : ""}`}
              >
                <span role={metadataError ? "alert" : undefined}>
                  {metadataError || metadataReadOnlyMessage}
                </span>
                <button
                  className="ce-button"
                  disabled={metadataWorking}
                  onClick={() => void reloadMetadata()}
                >
                  {metadataActivity === "read" ? "正在读取…" : "重新读取"}
                </button>
              </div>
            )}
          </div>
        </section>
        <section className="ce-card">
          <h2 className="ce-card-title">快捷方式</h2>
          <div className="ce-actions">
            <button className="ce-button" onClick={() => onOpen("instance")}>
              实例文件夹
            </button>
            <button className="ce-button" onClick={() => onOpen("saves")}>
              存档文件夹
            </button>
            <button className="ce-button" onClick={() => onOpen("mods")}>
              模组文件夹
            </button>
          </div>
        </section>
        <section className="ce-card">
          <h2 className="ce-card-title">高级管理</h2>
          <div className="ce-actions advanced-actions">
            <button className="ce-button" disabled title={notReady}>
              导出启动脚本
            </button>
            <button
              className="ce-button"
              disabled={disabled}
              onClick={onInspect}
              title="检查启动环境与依赖"
            >
              测试游戏
            </button>
            <button className="ce-button" disabled title={notReady}>
              补全文件
            </button>
            <button className="ce-button" disabled title={notReady}>
              重置
            </button>
            <InstanceDelete
              id={instance.id}
              api={api}
              scopeKey={rootScope}
              native={native}
              disabled={
                disabled ||
                !!mutationDisabled ||
                metadataWorking ||
                !!renameOpen ||
                !!renameWorking ||
                !!descriptionOpen
              }
              onTaskStart={onTaskStart}
            />
            <button className="ce-button" disabled title={notReady}>
              修补核心
            </button>
          </div>
        </section>
        {descriptionOpen && descriptionDialog && (
          <div
            className="modal-shade rd-name-shade"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeDescription();
            }}
          >
            <form
              className="rd-name-dialog ce-instance-description-dialog"
              role="dialog"
              aria-modal="true"
              aria-busy={metadataWorking}
              aria-labelledby="ce-instance-description-title"
              aria-describedby="ce-instance-description-hint"
              onSubmit={(event) => {
                event.preventDefault();
                if (descriptionDialog.scope !== metadataScope.current) return;
                void updateMetadata(
                  { description: descriptionDialog.draft },
                  descriptionDialog.draft ? "已保存实例描述" : "已清除实例描述",
                  descriptionDialog.revision,
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeDescription();
                }
                if (event.key === "Tab") {
                  event.stopPropagation();
                  const controls = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>(
                      "textarea:not(:disabled), button:not(:disabled)",
                    ),
                  ];
                  const first = controls[0],
                    last = controls[controls.length - 1];
                  if (!first) event.preventDefault();
                  else if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              }}
            >
              <h2 id="ce-instance-description-title">修改实例描述</h2>
              <textarea
                autoFocus
                className="ce-field"
                aria-label="实例描述"
                maxLength={4096}
                rows={4}
                value={descriptionDialog.draft}
                disabled={metadataWritesDisabled}
                onChange={(event) => {
                  const draft = event.target.value;
                  setDescriptionDialog((old) =>
                    old?.scope === currentMetadataScope
                      ? { ...old, draft }
                      : old,
                  );
                  setMetadataFailure(null);
                }}
              />
              <p id="ce-instance-description-hint">
                最多 4096 个字符，留空可清除描述。
              </p>
              {metadataError && (
                <>
                  <p className="rd-name-error" role="alert">
                    {metadataError}
                  </p>
                  <p>重新读取会关闭编辑窗口并载入已保存的描述。</p>
                </>
              )}
              <div className="rd-name-actions">
                <button
                  className="ce-button"
                  type="submit"
                  disabled={metadataWritesDisabled}
                >
                  {metadataActivity === "read"
                    ? "正在读取…"
                    : metadataWorking
                      ? "正在保存…"
                      : "确定"}
                </button>
                {metadataError && (
                  <button
                    className="ce-button"
                    type="button"
                    disabled={metadataWorking}
                    onClick={() => void reloadMetadata()}
                  >
                    {metadataActivity === "read" ? "正在读取…" : "重新读取"}
                  </button>
                )}
                <button
                  className="ce-button"
                  type="button"
                  disabled={metadataWorking}
                  onClick={closeDescription}
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}
        {renameOpen && renameDialog && (
          <div
            className="modal-shade rd-name-shade"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeRename();
            }}
          >
            <form
              className="rd-name-dialog ce-instance-rename-dialog"
              role="dialog"
              aria-modal="true"
              aria-busy={renameWorking}
              aria-labelledby="ce-instance-rename-title"
              aria-describedby="ce-instance-rename-hint"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeRename();
                }
                if (event.key === "Tab") {
                  event.stopPropagation();
                  const controls = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>(
                      "input:not(:disabled), button:not(:disabled)",
                    ),
                  ];
                  const first = controls[0],
                    last = controls[controls.length - 1];
                  if (!first) event.preventDefault();
                  else if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              }}
            >
              <h2 id="ce-instance-rename-title">修改实例名</h2>
              <input
                autoFocus
                className="ce-field"
                aria-label="新的实例名称"
                value={renameDialog.draft}
                disabled={
                  renameActivity?.scope === currentMetadataScope &&
                  renameActivity.kind === "start"
                }
                onChange={(event) => {
                  const current = renameDialogRef.current;
                  if (
                    !current ||
                    currentMetadataScope !== metadataScope.current ||
                    current.scope !== currentMetadataScope ||
                    current.scope !== metadataScope.current ||
                    (renameOperation.current?.scope === current.scope &&
                      renameOperation.current.kind === "start")
                  )
                    return;
                  setRenameDialog({
                    ...current,
                    draft: event.target.value,
                    plan: null,
                    error: "",
                  });
                }}
              />
              <p id="ce-instance-rename-hint">
                修改物理实例名和对应的版本文件；模组、配置和存档会保留。
              </p>
              {(renameDialog.error ||
                (renameDialog.draft !== instance.id && renameNameError)) && (
                <p className="rd-name-error" role="alert">
                  {renameDialog.error || renameNameError}
                </p>
              )}
              {renameDialog.plan && (
                <div className="ce-instance-rename-plan">
                  <p>
                    {renameDialog.plan.id} → {renameDialog.plan.new_name}
                  </p>
                  <p>
                    将更新 {renameDialog.plan.dependent_instances.length}{" "}
                    个引用此实例的版本。
                  </p>
                  {!!renameDialog.plan.dependent_instances.length && (
                    <ul>
                      {renameDialog.plan.dependent_instances
                        .slice(0, 5)
                        .map((id) => (
                          <li key={id}>{id}</li>
                        ))}
                      {renameDialog.plan.dependent_instances.length > 5 && (
                        <li>
                          另有{" "}
                          {renameDialog.plan.dependent_instances.length - 5}{" "}
                          个版本
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              <div className="rd-name-actions">
                <button
                  type="submit"
                  className="ce-button primary"
                  disabled={
                    renameDisabled || renameWorking || !!renameNameError
                  }
                >
                  {renameWorking
                    ? renameActivity?.kind === "start"
                      ? "正在提交…"
                      : "正在检查…"
                    : renameDialog.plan
                      ? "确定改名"
                      : "检查改名"}
                </button>
                <button
                  type="button"
                  className="ce-button"
                  disabled={
                    renameActivity?.scope === currentMetadataScope &&
                    renameActivity.kind === "start"
                  }
                  onClick={closeRename}
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}
      </>
    );
  if (section === "settings") {
    const allocation = mode === "global" ? settings.memory_gib : memory;
    const used = system
      ? system.total_memory_bytes - system.available_memory_bytes
      : 0;
    const gib = (bytes: number) => (bytes / 1073741824).toFixed(1);
    return (
      <>
        <section className="ce-card">
          <h2 className="ce-card-title">启动选项</h2>
          <div className="instance-launch-fields">
            <label className="ce-row">
              <span>实例隔离</span>
              <select
                className="ce-field"
                value={instance.isolated ? "开启" : "关闭"}
                disabled
                title={notReady}
              >
                <option>开启</option>
                <option>关闭</option>
              </select>
            </label>
            <label className="ce-row">
              <span>游戏窗口标题</span>
              <select className="ce-field" disabled title={notReady}>
                <option>跟随全局设置</option>
              </select>
            </label>
            <label className="ce-check">
              <input type="checkbox" disabled title={notReady} />
              默认窗口标题
            </label>
            <label className="ce-row">
              <span>自定义信息</span>
              <input
                className="ce-field"
                placeholder="跟随全局设置"
                disabled
                title={notReady}
              />
            </label>
            <JavaSelect
              instance={instance}
              settings={settings}
              api={api}
              native={native}
              disabled={disabled || !!mutationDisabled}
              onSave={onSave}
              onNotify={onNotify}
            />
          </div>
        </section>
        <section className="ce-card ce-memory-card">
          <h2 className="ce-card-title">游戏内存</h2>
          {system &&
            allocation * 1073741824 > system.available_memory_bytes && (
              <div className="ce-memory-warning">
                你给游戏分配的内存过多，这可能引发游戏崩溃。建议优先考虑「自动分配」选项！
              </div>
            )}
          <label className="ce-memory-mode">
            <input
              type="radio"
              name="instance-memory"
              checked={mode === "global"}
              disabled={disabled}
              onChange={() => {
                setMode("global");
                void saveMemory("global");
              }}
            />
            跟随全局设置
          </label>
          <label className="ce-memory-mode">
            <input
              type="radio"
              name="instance-memory"
              checked={false}
              readOnly
              disabled
              title={notReady}
            />
            自动配置
          </label>
          <div className="ce-memory-custom">
            <label className="ce-memory-mode">
              <input
                type="radio"
                name="instance-memory"
                checked={mode === "custom"}
                disabled={disabled}
                onChange={() => {
                  setMode("custom");
                  void saveMemory("custom");
                }}
              />
              自定义
            </label>
            <input
              type="range"
              aria-label="实例内存 GiB"
              min="2"
              max={Math.max(14, memory)}
              value={memory}
              disabled={disabled || mode !== "custom"}
              onChange={(e) => setMemory(Number(e.target.value))}
              onPointerUp={() => void saveMemory()}
              onKeyUp={() => void saveMemory()}
              onBlur={() => {
                if (mode === "custom") void saveMemory();
              }}
            />
          </div>
          <div className="ce-memory-labels">
            <span>已使用内存</span>
            <span>游戏分配</span>
          </div>
          <div className="ce-memory-bar">
            <span
              style={{
                width: system
                  ? `${Math.min(100, (used / system.total_memory_bytes) * 100)}%`
                  : "0%",
              }}
            />
          </div>
          <div className="ce-memory-values">
            <span>
              {system
                ? `${gib(used)} GiB / ${gib(system.total_memory_bytes)} GiB`
                : "内存信息暂不可用"}
            </span>
            <span>
              {allocation.toFixed(1)} GiB
              {system
                ? ` (可用 ${gib(system.available_memory_bytes)} GiB)`
                : ""}
            </span>
          </div>
        </section>
        <section className="ce-card">
          <h2 className="ce-card-title">服务器</h2>
          <div className="instance-launch-fields">
            <label className="ce-row">
              <span>限制验证方式</span>
              <select className="ce-field" disabled title={notReady}>
                <option>无限制</option>
              </select>
            </label>
            <label className="ce-row">
              <span>自动进入服务器</span>
              <input className="ce-field" disabled title={notReady} />
            </label>
          </div>
        </section>
      </>
    );
  }
  if (section === "server") return <ServerPanel id={instance.id} api={api} />;
  if (section === "modify" || section === "export")
    return (
      <InstanceOperations
        instance={instance}
        section={section}
        api={api}
        scopeKey={rootScope}
        native={native}
        busy={disabled || !!mutationDisabled}
        onTaskStart={onTaskStart}
        onNotify={onNotify}
      />
    );
  return (
    <ResourcePanel
      id={instance.id}
      section={section}
      api={api}
      onOpen={onOpen}
      onNotify={onNotify}
      onResourceDetails={onResourceDetails}
      disabled={disabled}
      mutationDisabled={mutationDisabled}
      instance={instance}
      scopeKey={rootScope}
      generation={settings.revision || ""}
      native={native}
      onTaskStart={onTaskStart}
    />
  );
}
type ServerEntry = { name: string; ip: string; icon?: string };
function ServerPanel({ id, api }: { id: string; api: Api }) {
  const [servers, setServers] = useState<ServerEntry[]>([]),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    api<ServerEntry[]>("instance_servers", { id })
      .then((v) => {
        if (live) setServers(v);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [id, api, refresh]);
  return (
    <div className="ce-server-panel">
      <section className="ce-card">
        <h2 className="ce-card-title">快捷操作</h2>
        <div className="ce-actions">
          <button
            className="ce-button primary"
            onClick={() => setRefresh((v) => v + 1)}
            title="重新读取本地服务器列表；在线状态检测尚未开放"
          >
            刷新所有服务器
          </button>
          <button className="ce-button" disabled title={notReady}>
            添加新服务器
          </button>
        </div>
      </section>
      {error ? (
        <p className="ce-empty">{error}</p>
      ) : !servers.length ? (
        <p className="ce-empty">暂无服务器</p>
      ) : (
        servers.map((v, i) => (
          <section className="ce-card ce-server-row" key={v.ip + i}>
            {v.icon ? (
              <img src={v.icon} alt="" />
            ) : (
              <span className="ce-server-icon">
                <Server size={25} />
              </span>
            )}
            <div className="ce-server-info">
              <strong>{v.name}</strong>
              <small>
                <Signal size={14} />
                未检测状态
              </small>
            </div>
            <span className="ce-server-message">{v.ip}</span>
            <button disabled title={notReady} aria-label={"加入 " + v.name}>
              <Play size={16} />
            </button>
            <button disabled title={notReady} aria-label={"设置 " + v.name}>
              <SettingsIcon size={16} />
            </button>
          </section>
        ))
      )}
    </div>
  );
}
