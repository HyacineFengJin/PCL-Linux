import { useEffect, useState } from "react";
import {
  Box,
  ChevronDown,
  Search,
  ArrowDownUp,
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
  Info,
  FolderOpen,
  CircleMinus,
  CircleCheck,
  Trash2,
  Heart,
  Share2,
  Upload,
  X,
} from "lucide-react";
import { Collapse } from "./Collapse";
import { InstanceOperations } from "./InstanceOperations";
import commandIcon from "./assets/game-icons/command.png";
import lampTexture from "./assets/game-icons/redstone-lamp.png";
import grassIcon from "./assets/game-icons/grass.png";
import neoForgeIcon from "./assets/game-icons/neoforge.png";
import forgeIcon from "./assets/game-icons/forge.png";
import type { Api, Instance, Settings } from "./types";

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
export function InstanceIcon({ loader = "Vanilla" }: { loader?: string }) {
  const icon =
    loader === "Vanilla"
      ? grassIcon
      : loader.startsWith("NeoForge")
        ? neoForgeIcon
        : loader.startsWith("Forge")
          ? forgeIcon
          : null;
  return (
    <span className="instance-icon" aria-hidden="true">
      {icon ? <img src={icon} alt="" /> : <Box size={29} strokeWidth={1.4} />}
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
  const groups = [...new Set(instances.map((v) => v.loader.split(" ")[0]))];
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
        const entries = instances.filter(
          (v) =>
            v.loader.split(" ")[0] === group &&
            v.id.toLowerCase().includes(query.toLowerCase()),
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
                {group === "Vanilla" ? "原版" : group} 实例 ({entries.length})
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
                    <InstanceIcon loader={v.loader} />
                    <div className="ce-resource-text">
                      <strong>{v.id}</strong>
                      <Tags instance={v} />
                    </div>
                  </button>
                ))}
              </div>
            </Collapse>
          </section>
        );
      })}
      {!instances.some((v) =>
        v.id.toLowerCase().includes(query.toLowerCase()),
      ) && <section className="ce-card ce-empty">没有找到游戏实例</section>}
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
  disabled,
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
  disabled: boolean;
}) {
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
          <InstanceIcon loader={instance.loader} />
          <div>
            <div>{instance.id}</div>
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
              <select className="ce-field" disabled title={notReady}>
                <option>自动</option>
              </select>
            </label>
            <label className="ce-row">
              <span>分类</span>
              <select className="ce-field" disabled title={notReady}>
                <option>自动</option>
              </select>
            </label>
            <div className="ce-actions">
              <button className="ce-button" disabled title={notReady}>
                修改实例名
              </button>
              <button className="ce-button" disabled title={notReady}>
                修改实例描述
              </button>
              <button className="ce-button" disabled title={notReady}>
                加入收藏夹
              </button>
            </div>
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
            <button className="ce-button danger" disabled title={notReady}>
              删除实例
            </button>
            <button className="ce-button" disabled title={notReady}>
              修补核心
            </button>
          </div>
        </section>
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
            <label className="ce-row">
              <span>游戏 Java</span>
              <select className="ce-field" disabled title={notReady}>
                <option>跟随全局设置</option>
              </select>
            </label>
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
      <InstanceOperations instance={instance} section={section} api={api} />
    );
  return (
    <ResourcePanel
      id={instance.id}
      section={section}
      api={api}
      onOpen={onOpen}
      onResourceDetails={onResourceDetails}
    />
  );
}
export type LocalResourceDetails = {
  name: string;
  path: string;
  enabled: boolean;
  version?: string;
  description?: string;
  file_name?: string;
  icon?: string;
  kind: string;
};
type Resource = Omit<LocalResourceDetails, "kind">;
function ResourcePanel({
  id,
  section,
  api,
  onOpen,
  onResourceDetails,
}: {
  id: string;
  section: string;
  api: Api;
  onOpen: (s: string) => void;
  onResourceDetails?: (resource: LocalResourceDetails) => void;
}) {
  const [entries, setEntries] = useState<Resource[]>([]),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [descending, setDescending] = useState(false),
    [filter, setFilter] = useState<"all" | "updates">("all"),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Resource | null>(null);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setEntries([]);
    setError("");
    setQuery("");
    setSelected([]);
    setFilter("all");
    setDetail(null);
    api<Resource[]>("instance_resources", { id, kind: section })
      .then((v) => {
        if (live) setEntries(v);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, section, api]);
  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detail]);
  const filtered = entries
    .filter((v) =>
      [v.name, v.file_name, v.description].some((value) =>
        value?.toLowerCase().includes(query.toLowerCase()),
      ),
    )
    .sort(
      (a, b) => a.name.localeCompare(b.name, "zh-CN") * (descending ? -1 : 1),
    );
  const selectedEntries = entries.filter((entry) =>
    selected.includes(entry.path),
  );
  const allVisibleSelected =
    filtered.length > 0 &&
    filtered.every((entry) => selected.includes(entry.path));
  function toggleSelection(path: string) {
    setSelected((old) =>
      old.includes(path) ? old.filter((v) => v !== path) : [...old, path],
    );
  }
  function openDetails(resource: Resource) {
    if (onResourceDetails) onResourceDetails({ ...resource, kind: section });
    else setDetail(resource);
  }
  if (!loading && !error && !entries.length)
    return (
      <div className="ce-state-stage">
        <section className="ce-card ce-state-box">
          <h2>尚未安装资源</h2>
          <p>
            你可以从已经下载好的文件安装资源。
            <br />
            如果你已经安装了资源，可能是实例隔离设置有误，请在设置中调整实例隔离选项。
          </p>
          <div className="ce-actions">
            <button className="ce-button primary" disabled title={notReady}>
              从文件安装
            </button>
            <button className="ce-button" onClick={() => onOpen(section)}>
              打开文件夹
            </button>
          </div>
        </section>
      </div>
    );
  return (
    <div className="ce-local-resources">
      <label className="ce-card ce-searchbar">
        <Search size={17} />
        <input
          placeholder="搜索资源：名称 / 描述 / 标签"
          aria-label="搜索资源"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <section className="ce-card resource-toolbar">
        <button className="ce-button primary" onClick={() => onOpen(section)}>
          打开文件夹
        </button>
        <button className="ce-button" disabled title={notReady}>
          从文件安装
        </button>
        <button className="ce-button" disabled title={notReady}>
          下载新资源
        </button>
        <button
          className="ce-button"
          disabled={
            loading || !!error || !filtered.length || filter === "updates"
          }
          onClick={() =>
            setSelected((old) =>
              allVisibleSelected
                ? old.filter((path) => !filtered.some((v) => v.path === path))
                : [...new Set([...old, ...filtered.map((v) => v.path)])],
            )
          }
        >
          {allVisibleSelected ? "取消全选" : "全选"}
        </button>
        <button className="ce-button" disabled title={notReady}>
          导出信息
        </button>
      </section>
      <section className="ce-card resource-list">
        <div className="resource-list-heading">
          <div className="resource-tabs">
            <button
              className={filter === "all" ? "ce-pill" : ""}
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              全部 ({entries.length})
            </button>
            {section === "mods" && (
              <button
                className={filter === "updates" ? "ce-pill" : ""}
                aria-pressed={filter === "updates"}
                onClick={() => {
                  setFilter("updates");
                  setSelected([]);
                }}
              >
                可更新
              </button>
            )}
          </div>
          <button
            onClick={() => setDescending(!descending)}
            title={
              descending ? "当前降序，点击改为升序" : "当前升序，点击改为降序"
            }
          >
            <ArrowDownUp size={17} />
            排序：资源名称
          </button>
        </div>
        {loading ? (
          <p className="ce-empty">正在读取资源…</p>
        ) : error ? (
          <p className="ce-empty" role="alert">
            {error}
          </p>
        ) : filter === "updates" ? (
          <div className="ce-resource-updates-state" role="status">
            <strong>模组更新检测尚未开放</strong>
            <p>暂时无法判断哪些模组可更新。</p>
          </div>
        ) : !filtered.length ? (
          <p className="ce-empty">没有找到资源</p>
        ) : (
          <div role="listbox" aria-label="本地资源" aria-multiselectable="true">
            {filtered.map((v) => (
              <div
                className={
                  "resource-row ce-local-resource-row " +
                  (!v.enabled ? "resource-disabled " : "") +
                  (selected.includes(v.path) ? "is-selected" : "")
                }
                key={v.path}
                role="option"
                tabIndex={0}
                aria-selected={selected.includes(v.path)}
                onClick={() => toggleSelection(v.path)}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    toggleSelection(v.path);
                  }
                }}
              >
                <span className="resource-icon">
                  {v.icon ? (
                    <img src={v.icon} alt="" />
                  ) : (
                    <Box size={29} strokeWidth={1.6} />
                  )}
                </span>
                <div className="ce-resource-text">
                  <strong>
                    {v.name}
                    {v.version && <small> | {v.version}</small>}
                  </strong>
                  <small>
                    {v.file_name || v.name}
                    {v.description ? `: ${v.description}` : ""}
                  </small>
                  {!v.enabled && <small>已禁用</small>}
                </div>
                <div
                  className="ce-resource-hover-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="ce-resource-action-tip" data-tooltip="详情">
                    <button
                      aria-label={v.name + "：详情"}
                      onClick={() => openDetails(v)}
                    >
                      <Info size={15} />
                    </button>
                  </span>
                  <span
                    className="ce-resource-action-tip"
                    data-tooltip="打开文件位置"
                  >
                    <button
                      aria-label={v.name + "：打开所在文件夹"}
                      onClick={() => onOpen(section)}
                    >
                      <FolderOpen size={15} />
                    </button>
                  </span>
                  <span
                    className="ce-resource-action-tip"
                    data-tooltip={
                      (v.enabled ? "禁用" : "启用") + "（尚未开放）"
                    }
                  >
                    <button
                      disabled
                      aria-label={v.name + (v.enabled ? "：禁用" : "：启用")}
                    >
                      {v.enabled ? (
                        <CircleMinus size={15} />
                      ) : (
                        <CircleCheck size={15} />
                      )}
                    </button>
                  </span>
                  <span
                    className="ce-resource-action-tip"
                    data-tooltip="删除（尚未开放）"
                  >
                    <button disabled aria-label={v.name + "：删除"}>
                      <Trash2 size={15} />
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {selectedEntries.length > 0 && (
        <div className="ce-resource-selection-bar" aria-label="所选资源操作">
          <div className="ce-resource-selection-count">
            已选择 {selectedEntries.length} 个文件
          </div>
          <div className="ce-resource-selection-actions">
            <button disabled title="模组更新尚未开放">
              <Upload size={16} />
              更新
            </button>
            <button disabled title="启用资源尚未开放">
              <CircleCheck size={16} />
              启用
            </button>
            <button disabled title="禁用资源尚未开放">
              <CircleMinus size={16} />
              禁用
            </button>
            <button disabled title={notReady}>
              <Heart size={16} />
              收藏
            </button>
            <button disabled title={notReady}>
              <Share2 size={16} />
              分享所选
            </button>
            <button disabled title="删除资源尚未开放">
              <Trash2 size={16} />
              删除
            </button>
            <button onClick={() => setSelected([])}>
              <X size={16} />
              取消选择
            </button>
          </div>
        </div>
      )}
      {detail && (
        <div
          className="ce-local-detail-backdrop"
          onClick={() => setDetail(null)}
        >
          <section
            className="ce-card ce-local-detail"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ce-local-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ce-local-detail-heading">
              <h2 id="ce-local-detail-title">资源详情</h2>
              <button
                autoFocus
                aria-label="关闭资源详情"
                onClick={() => setDetail(null)}
              >
                <X size={18} />
              </button>
            </div>
            <strong>{detail.name}</strong>
            {detail.version && <p>版本：{detail.version}</p>}
            {detail.description && <p>{detail.description}</p>}
            <p>文件：{detail.file_name || detail.name}</p>
            <p>状态：{detail.enabled ? "已启用" : "已禁用"}</p>
            <p className="ce-local-detail-path">{detail.path}</p>
            <button
              className="ce-button primary"
              onClick={() => onOpen(section)}
            >
              打开所在文件夹
            </button>
          </section>
        </div>
      )}
    </div>
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
