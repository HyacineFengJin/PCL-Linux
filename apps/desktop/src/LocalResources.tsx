/** Existing CE local-resource list, selection and local file operations.
 * Update inspection/confirmation is owned by the separate update components. */
import { useEffect, useRef, useState } from "react";
import {
  Box,
  Search,
  ArrowDownUp,
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
import type { Api } from "./types";
import {
  ResourceUpdates,
  ResourceUpdateStatus,
  ResourceUpdateUndo,
} from "./ResourceUpdates";
import { useResourceUpdates } from "./useResourceUpdates";
import type { ResourceFile, ResourceUpdateTarget } from "./resourceUpdateTypes";
const notReady = "此功能尚未开放";
export type LocalResourceDetails = {
  name: string;
  path: string;
  enabled: boolean;
  version?: string;
  description?: string;
  file_name?: string;
  fingerprint?: string | null;
  icon?: string;
  kind: string;
};
type Resource = Omit<LocalResourceDetails, "kind">;
type RemovedResourceOperation = {
  id: string;
  files: string[];
  created_at: number;
};
type ResourceWriteResult = {
  changed: number;
  undo_id: string | null;
  message: string;
};
type ResourceImportResult = {
  status: "complete" | "cancelled" | "unavailable";
  changed: number;
  message?: string;
  undo_id?: string | null;
};
type ResourceRemovalChoice = {
  files: ResourceFile[];
  names: string[];
};
function writableResourceFile(resource: Resource): ResourceFile | null {
  return resource.file_name && resource.fingerprint
    ? {
        file_name: resource.file_name,
        fingerprint: resource.fingerprint,
      }
    : null;
}
export function ResourcePanel({
  id,
  section,
  api,
  onOpen,
  onNotify,
  onResourceDetails,
  disabled,
  mutationDisabled = false,
  instance,
  scopeKey,
  generation,
  native,
  onTaskStart,
}: {
  id: string;
  section: string;
  api: Api;
  onOpen: (s: string) => void;
  onNotify: (s: string) => void;
  onResourceDetails?: (resource: LocalResourceDetails) => void;
  disabled: boolean;
  mutationDisabled?: boolean;
  instance: ResourceUpdateTarget;
  scopeKey: string;
  generation: string;
  native: boolean;
  onTaskStart: (id: string) => void;
}) {
  const [entries, setEntries] = useState<Resource[]>([]),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [descending, setDescending] = useState(false),
    [filter, setFilter] = useState<"all" | "updates">("all"),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Resource | null>(null),
    [working, setWorking] = useState(""),
    [actionError, setActionError] = useState(""),
    [recoveryError, setRecoveryError] = useState(""),
    [removed, setRemoved] = useState<RemovedResourceOperation[]>([]),
    [resourceGeneration, setResourceGeneration] = useState(0),
    [removalChoice, setRemovalChoice] = useState<ResourceRemovalChoice | null>(
      null,
    );
  const alive = useRef(false),
    scopeGeneration = useRef(0),
    readGeneration = useRef(0),
    workingRef = useRef(false),
    removalDialog = useRef<HTMLDivElement>(null),
    currentIdentity = useRef({ id, section, api, scopeKey, generation });
  currentIdentity.current = { id, section, api, scopeKey, generation };
  const admission = useRef({ disabled, mutationDisabled });
  admission.current = { disabled, mutationDisabled };
  const writableKind = ["mods", "resourcepacks", "shaderpacks"].includes(
    section,
  );
  function isCurrent(scope: number) {
    return (
      alive.current &&
      scopeGeneration.current === scope &&
      currentIdentity.current.id === id &&
      currentIdentity.current.section === section &&
      currentIdentity.current.api === api &&
      currentIdentity.current.scopeKey === scopeKey &&
      currentIdentity.current.generation === generation
    );
  }
  async function readResources(scope: number, clearSelection = true) {
    if (!isCurrent(scope)) return;
    const request = ++readGeneration.current;
    setLoading(true);
    setError("");
    setRecoveryError("");
    const [resourcesResult, removedResult] = await Promise.allSettled([
      api<Resource[]>("instance_resources", { id, kind: section }),
      writableKind
        ? api<RemovedResourceOperation[]>("resource_removed", {
            id,
            kind: section,
          })
        : Promise.resolve([] as RemovedResourceOperation[]),
    ]);
    if (!isCurrent(scope) || readGeneration.current !== request) return;
    if (resourcesResult.status === "fulfilled") {
      setEntries(resourcesResult.value);
      setResourceGeneration((current) => current + 1);
      if (clearSelection) setSelected([]);
    } else {
      setError(String(resourcesResult.reason));
    }
    if (removedResult.status === "fulfilled") {
      setRemoved(
        [...removedResult.value].sort((a, b) => b.created_at - a.created_at),
      );
    } else {
      setRecoveryError(String(removedResult.reason));
    }
    setLoading(false);
  }
  useEffect(() => {
    const scope = ++scopeGeneration.current;
    alive.current = true;
    workingRef.current = false;
    setWorking("");
    setLoading(true);
    setEntries([]);
    setError("");
    setQuery("");
    setSelected([]);
    setFilter("all");
    setDetail(null);
    setActionError("");
    setRecoveryError("");
    setRemoved([]);
    setRemovalChoice(null);
    void readResources(scope);
    return () => {
      alive.current = false;
      ++scopeGeneration.current;
      ++readGeneration.current;
    };
  }, [id, section, api, scopeKey, generation]);
  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detail]);
  useEffect(() => {
    if (!removalChoice) return;
    const previous = document.activeElement as HTMLElement | null;
    removalDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [removalChoice]);
  const mutationBlocked =
    disabled || mutationDisabled || !!working || loading || !writableKind;
  const updates = useResourceUpdates({
    api,
    scopeKey,
    instance,
    generation: `${generation}:${resourceGeneration}`,
    files: entries
      .map(writableResourceFile)
      .filter((file): file is ResourceFile => file !== null),
    enabled: section === "mods" && !loading && !error && !recoveryError,
    native,
    disabled: mutationBlocked,
    onTaskStart,
    onNotify,
  });
  const writesDisabled =
    mutationBlocked ||
    !!error ||
    !!recoveryError ||
    updates.busy ||
    !!updates.choice;
  const updateFor = (resource: Resource) =>
    updates.result?.entries.find(
      (entry) =>
        entry.file_name === resource.file_name &&
        entry.fingerprint === resource.fingerprint,
    );
  const filtered = entries
    .filter((v) =>
      [v.name, v.file_name, v.description].some((value) =>
        value?.toLowerCase().includes(query.toLowerCase()),
      ),
    )
    .filter(
      (v) =>
        filter !== "updates" || updateFor(v)?.status === "update_available",
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
  function filesFor(resources: Resource[]): ResourceFile[] | null {
    const files = resources.map(writableResourceFile);
    return resources.length > 0 && files.every((file) => file !== null)
      ? (files as ResourceFile[])
      : null;
  }
  async function writeResources(
    status: string,
    operation: () => Promise<ResourceWriteResult | ResourceImportResult>,
    recovering = false,
  ) {
    const scope = scopeGeneration.current;
    if (
      !isCurrent(scope) ||
      workingRef.current ||
      admission.current.disabled ||
      admission.current.mutationDisabled ||
      (recovering ? mutationBlocked : writesDisabled)
    )
      return;
    workingRef.current = true;
    setWorking(status);
    setActionError("");
    setRemovalChoice(null);
    try {
      const result = await operation();
      if (!isCurrent(scope)) return;
      if ("status" in result && result.status === "cancelled") return;
      if ("status" in result && result.status === "unavailable") {
        const message =
          result.message || "系统文件选择器暂时不可用，请稍后重试。";
        setActionError(message);
        onNotify(message);
        return;
      }
      setSelected([]);
      setDetail(null);
      setWorking("正在重新读取资源…");
      await readResources(scope, false);
      if (isCurrent(scope))
        onNotify(result.message || `已处理 ${result.changed} 个文件`);
    } catch (e) {
      if (isCurrent(scope)) {
        const message = String(e);
        setActionError(message);
        onNotify(message);
      }
    } finally {
      if (isCurrent(scope)) {
        workingRef.current = false;
        setWorking("");
      }
    }
  }
  function setEnabled(resources: Resource[], enabled: boolean) {
    const files = filesFor(resources);
    if (section !== "mods" || !files) return;
    void writeResources(enabled ? "正在启用模组…" : "正在禁用模组…", () =>
      api<ResourceWriteResult>("resource_set_enabled", {
        id,
        kind: section,
        files,
        enabled,
      }),
    );
  }
  function importResources() {
    void writeResources("正在选择并导入本地文件…", () =>
      api<ResourceImportResult>("resource_import", { id, kind: section }),
    );
  }
  function chooseRemoval(resources: Resource[]) {
    const files = filesFor(resources);
    if (
      writesDisabled ||
      workingRef.current ||
      admission.current.disabled ||
      admission.current.mutationDisabled ||
      !isCurrent(scopeGeneration.current) ||
      !files
    )
      return;
    setRemovalChoice({
      files,
      names: resources.map((resource) => resource.name),
    });
  }
  function refreshResources() {
    if (workingRef.current) return;
    setActionError("");
    void readResources(scopeGeneration.current);
  }
  const selectedWritable = !!filesFor(selectedEntries),
    selectedUpdatable =
      section === "mods" &&
      selectedEntries.length > 0 &&
      selectedEntries.every(
        (entry) => updateFor(entry)?.status === "update_available",
      ),
    updateCount = updates.result?.entries.filter(
      (entry) => entry.status === "update_available",
    ).length,
    updateBlocked = mutationBlocked || !!error || !!recoveryError,
    latestRemoval = removed[0],
    operationFeedback = (
      <>
        {working && (
          <p className="ce-resource-operation-status" role="status">
            {working}
          </p>
        )}
        {(actionError || recoveryError) && (
          <div className="ce-resource-operation-error" role="alert">
            <span>{actionError || recoveryError}</span>
            {recoveryError && writableKind && (
              <button
                className="ce-button"
                disabled={mutationBlocked}
                onClick={() =>
                  void writeResources(
                    "正在恢复上次未完成的操作…",
                    () =>
                      api<ResourceWriteResult>("resource_recover", {
                        id,
                        kind: section,
                      }),
                    true,
                  )
                }
              >
                恢复未完成操作
              </button>
            )}
            <button
              className="ce-button"
              onClick={refreshResources}
              disabled={!!working || loading}
            >
              刷新
            </button>
          </div>
        )}
        {section === "mods" && (
          <ResourceUpdateUndo updates={updates} disabled={updateBlocked} />
        )}
      </>
    ),
    toolbar = (
      <section className="ce-card resource-toolbar">
        <button className="ce-button primary" onClick={() => onOpen(section)}>
          打开文件夹
        </button>
        <button
          className="ce-button"
          disabled={writesDisabled}
          title={!writableKind ? notReady : undefined}
          onClick={importResources}
        >
          从文件安装
        </button>
        <button className="ce-button" disabled title={notReady}>
          下载新资源
        </button>
        <button
          className="ce-button"
          disabled={loading || !!error || !filtered.length}
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
        {latestRemoval && writableKind && (
          <button
            className="ce-button"
            disabled={writesDisabled}
            title={`恢复上次删除的 ${latestRemoval.files.length} 个文件`}
            onClick={() =>
              void writeResources("正在恢复已删除的文件…", () =>
                api<ResourceWriteResult>("resource_restore", {
                  id,
                  kind: section,
                  operationId: latestRemoval.id,
                }),
              )
            }
          >
            撤销删除
          </button>
        )}
      </section>
    ),
    removalConfirmation = removalChoice && (
      <div
        className="modal-shade rd-name-shade"
        onClick={() => setRemovalChoice(null)}
      >
        <div
          className="rd-name-dialog ce-resource-remove-dialog"
          ref={removalDialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ce-resource-remove-title"
          aria-describedby="ce-resource-remove-description"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setRemovalChoice(null);
            }
            if (event.key === "Tab") {
              const controls = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              ];
              const first = controls[0],
                last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <h2 id="ce-resource-remove-title">删除资源</h2>
          <p id="ce-resource-remove-description">
            确定删除这 {removalChoice.files.length} 个文件吗？删除后可以通过
            “撤销删除”恢复。
          </p>
          <ul className="ce-resource-remove-files">
            {removalChoice.files.map((file, index) => (
              <li key={file.file_name}>
                <strong>{removalChoice.names[index]}</strong>
                <small>{file.file_name}</small>
              </li>
            ))}
          </ul>
          <div className="rd-name-actions">
            <button
              className="ce-button"
              onClick={() => setRemovalChoice(null)}
            >
              取消
            </button>
            <button
              className="ce-button primary"
              disabled={writesDisabled}
              onClick={() =>
                void writeResources("正在删除资源…", () =>
                  api<ResourceWriteResult>("resource_remove", {
                    id,
                    kind: section,
                    files: removalChoice.files,
                  }),
                )
              }
            >
              删除
            </button>
          </div>
        </div>
      </div>
    );
  if (!loading && !error && !entries.length)
    return (
      <div
        className={
          "ce-local-resources is-empty" + (latestRemoval ? " has-recovery" : "")
        }
      >
        {latestRemoval && toolbar}
        {operationFeedback}
        <div className="ce-state-stage">
          <section className="ce-card ce-state-box">
            <h2>尚未安装资源</h2>
            <p>
              你可以从已经下载好的文件安装资源。
              <br />
              如果你已经安装了资源，可能是实例隔离设置有误，请在设置中调整实例隔离选项。
            </p>
            <div className="ce-actions">
              <button
                className="ce-button primary"
                disabled={writesDisabled}
                title={!writableKind ? notReady : undefined}
                onClick={importResources}
              >
                从文件安装
              </button>
              <button className="ce-button" onClick={() => onOpen(section)}>
                打开文件夹
              </button>
            </div>
          </section>
        </div>
        {removalConfirmation}
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
      {toolbar}
      {operationFeedback}
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
                {updates.phase === "checking"
                  ? " (检查中)"
                  : updateCount !== undefined
                    ? ` (${updateCount})`
                    : ""}
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
          <div className="ce-empty ce-resource-read-error" role="alert">
            <p>{error}</p>
            <button
              className="ce-button"
              disabled={!!working}
              onClick={refreshResources}
            >
              重新读取
            </button>
          </div>
        ) : filter === "updates" && !filtered.length ? (
          <ResourceUpdateStatus
            updates={updates}
            emptyOnly
            onRetry={refreshResources}
            disabled={updateBlocked}
            readonlyCount={
              entries.filter((entry) => !writableResourceFile(entry)).length
            }
          />
        ) : !filtered.length ? (
          <p className="ce-empty">没有找到资源</p>
        ) : (
          <>
            {section === "mods" && (
              <ResourceUpdateStatus
                updates={updates}
                onRetry={refreshResources}
                disabled={updateBlocked}
                readonlyCount={
                  entries.filter((entry) => !writableResourceFile(entry)).length
                }
              />
            )}
            <div
              role="listbox"
              aria-label="本地资源"
              aria-multiselectable="true"
            >
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
                      {updateFor(v)?.status === "update_available" ? (
                        <small className="ce-resource-update-version">
                          {" "}
                          |{" "}
                          {updateFor(v)?.old_version ||
                            v.version ||
                            "已安装版本"}{" "}
                          → {updateFor(v)?.new_version} ↑
                        </small>
                      ) : (
                        (v.version || updateFor(v)?.old_version) && (
                          <small>
                            {" "}
                            | {v.version || updateFor(v)?.old_version}
                          </small>
                        )
                      )}
                      {updateFor(v)?.status === "unknown" && (
                        <small title={updateFor(v)?.reason ?? undefined}>
                          {" "}
                          | 无法识别
                        </small>
                      )}
                      {updateFor(v)?.status === "blocked" && (
                        <small title={updateFor(v)?.reason ?? undefined}>
                          {" "}
                          | 暂不可更新
                        </small>
                      )}
                    </strong>
                    <small>
                      {v.file_name || v.name}
                      {v.description ? `: ${v.description}` : ""}
                    </small>
                    {!v.enabled && <small>已禁用</small>}
                    {writableKind && !writableResourceFile(v) && (
                      <small>只读</small>
                    )}
                  </div>
                  <div
                    className="ce-resource-hover-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span
                      className="ce-resource-action-tip"
                      data-tooltip="详情"
                    >
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
                        section !== "mods"
                          ? "仅模组支持启用和禁用"
                          : !writableResourceFile(v)
                            ? "只读：无法确认普通文件身份"
                            : v.enabled
                              ? "禁用"
                              : "启用"
                      }
                    >
                      <button
                        disabled={
                          writesDisabled ||
                          section !== "mods" ||
                          !writableResourceFile(v)
                        }
                        aria-label={v.name + (v.enabled ? "：禁用" : "：启用")}
                        onClick={() => setEnabled([v], !v.enabled)}
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
                      data-tooltip={
                        !writableKind
                          ? "删除（尚未开放）"
                          : !writableResourceFile(v)
                            ? "只读：无法确认普通文件身份"
                            : "删除（可恢复）"
                      }
                    >
                      <button
                        disabled={writesDisabled || !writableResourceFile(v)}
                        aria-label={v.name + "：删除"}
                        onClick={() => chooseRemoval([v])}
                      >
                        <Trash2 size={15} />
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      {selectedEntries.length > 0 && (
        <div className="ce-resource-selection-bar" aria-label="所选资源操作">
          <div className="ce-resource-selection-count">
            已选择 {selectedEntries.length} 个文件
            {writableKind && !selectedWritable && <span>（包含只读项目）</span>}
          </div>
          <div className="ce-resource-selection-actions">
            <button
              disabled={writesDisabled || !selectedUpdatable}
              title={
                !selectedUpdatable ? "所选模组未全部检测为可更新" : undefined
              }
              onClick={() => {
                const files = filesFor(selectedEntries);
                if (files) updates.open(files);
              }}
            >
              <Upload size={16} />
              更新
            </button>
            <button
              disabled={
                writesDisabled || section !== "mods" || !selectedWritable
              }
              title={
                section !== "mods"
                  ? "仅模组支持启用和禁用"
                  : !selectedWritable
                    ? "所选资源包含只读项目"
                    : undefined
              }
              onClick={() => setEnabled(selectedEntries, true)}
            >
              <CircleCheck size={16} />
              启用
            </button>
            <button
              disabled={
                writesDisabled || section !== "mods" || !selectedWritable
              }
              title={
                section !== "mods"
                  ? "仅模组支持启用和禁用"
                  : !selectedWritable
                    ? "所选资源包含只读项目"
                    : undefined
              }
              onClick={() => setEnabled(selectedEntries, false)}
            >
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
            <button
              disabled={writesDisabled || !selectedWritable}
              title={
                !writableKind
                  ? notReady
                  : !selectedWritable
                    ? "所选资源包含只读项目"
                    : "删除后可以撤销"
              }
              onClick={() => chooseRemoval(selectedEntries)}
            >
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
      {removalConfirmation}
      {updates.choice && (
        <ResourceUpdates
          api={api}
          scopeKey={scopeKey}
          instance={instance}
          files={updates.choice.files}
          generation={`${generation}:${resourceGeneration}`}
          native={native}
          disabled={updateBlocked}
          onTaskStart={onTaskStart}
          onClose={updates.close}
        />
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
