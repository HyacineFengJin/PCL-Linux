import { Fragment, useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import {
  InstanceOperationDialog,
  instanceOperationSize,
  useInstanceOperationScope,
} from "./instanceOperationUi";
import {
  checkResourceUpdatePlan,
  resourceUpdateFiles,
  type ResourceFile,
  type ResourceUpdatePlan,
  type ResourceUpdateTarget,
} from "./resourceUpdateTypes";
import type { useResourceUpdates } from "./useResourceUpdates";
import "./resource-details.css";
import "./instance-operations.css";
import "./resource-updates.css";

type DialogState = {
  scope: object;
  plan: ResourceUpdatePlan | null;
  error: string;
};

/** Existing CE confirmation structure. Planning can be dismissed locally; start
 * is the admission boundary and hands cancellation/cleanup to the task owner. */
export function ResourceUpdates({
  api,
  scopeKey,
  instance,
  files,
  generation,
  native,
  disabled,
  onTaskStart,
  onClose,
}: {
  api: Api;
  scopeKey: string;
  instance: ResourceUpdateTarget;
  files: ResourceFile[];
  generation: string;
  native: boolean;
  disabled: boolean;
  onTaskStart: (id: string) => void;
  onClose: () => void;
}) {
  const root = useInstanceOperationScope(api, scopeKey, native, disabled);
  const identity = JSON.stringify([
    instance.id,
    instance.minecraft_version,
    instance.loader,
    generation,
    resourceUpdateFiles(files),
  ]);
  const owner = useRef({ root: root.scope, identity });
  if (owner.current.root !== root.scope || owner.current.identity !== identity)
    owner.current = { root: root.scope, identity };
  const scope = owner.current;
  const closed = useRef<object | null>(null);
  const current = () =>
    root.current() && owner.current === scope && closed.current !== scope;
  const [dialog, setDialogState] = useState<DialogState | null>(null);
  const dialogRef = useRef(dialog);
  const operation = useRef<{ scope: object; kind: "prepare" | "start" } | null>(
    null,
  );
  const [activity, setActivity] = useState<typeof operation.current>(null);
  const callbacks = useRef({ onTaskStart, onClose });
  callbacks.current = { onTaskStart, onClose };
  const mountRequest = useRef<object | null>(null);
  const working = activity?.scope === scope ? activity.kind : null;
  const visible = dialog?.scope === scope ? dialog : null;
  function setDialog(next: DialogState | null) {
    dialogRef.current = next;
    setDialogState(next);
  }
  function close() {
    if (
      !current() ||
      (operation.current?.scope === scope && operation.current.kind === "start")
    )
      return;
    closed.current = scope;
    operation.current = null;
    setActivity(null);
    setDialog(null);
    callbacks.current.onClose();
  }
  async function prepare() {
    if (!current() || operation.current?.scope === scope) return;
    const next = { scope, plan: null, error: "" };
    if (!root.allowed() || !scopeKey || !files.length) {
      setDialog({
        ...next,
        error: !native
          ? "模组更新需要在桌面应用中操作"
          : disabled
            ? "当前操作结束后可重新检查更新"
            : "请选择可更新的模组文件",
      });
      return;
    }
    const token = { scope, kind: "prepare" as const };
    operation.current = token;
    setActivity(token);
    setDialog(next);
    const ownsReply = () =>
      current() && operation.current === token && dialogRef.current === next;
    try {
      const plan = await api<ResourceUpdatePlan>("resource_update_plan", {
        id: instance.id,
        files: resourceUpdateFiles(files),
      });
      if (!ownsReply()) return;
      checkResourceUpdatePlan(plan, scopeKey, instance, files);
      setDialog({ ...next, plan });
    } catch (error) {
      if (ownsReply()) setDialog({ ...next, error: String(error) });
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || !current() || mountRequest.current === scope) return;
      mountRequest.current = scope;
      void prepare();
    });
    return () => {
      disposed = true;
    };
  }, [scope]);
  async function submit() {
    if (!current() || !root.allowed() || operation.current?.scope === scope)
      return;
    const previous = dialogRef.current;
    if (!previous || previous.scope !== scope || !previous.plan) {
      await prepare();
      return;
    }
    const token = { scope, kind: "start" as const };
    operation.current = token;
    setActivity(token);
    try {
      checkResourceUpdatePlan(previous.plan, scopeKey, instance, files);
      const result = await api<{ id: string }>("resource_update_start", {
        id: instance.id,
        files: resourceUpdateFiles(files),
        revision: previous.plan.revision,
      });
      if (
        !current() ||
        operation.current !== token ||
        dialogRef.current !== previous
      )
        return;
      closed.current = scope;
      setDialog(null);
      callbacks.current.onTaskStart(result.id);
      callbacks.current.onClose();
    } catch (error) {
      if (
        current() &&
        operation.current === token &&
        dialogRef.current === previous
      )
        setDialog({ scope, plan: null, error: String(error) });
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  if (closed.current === scope) return null;
  const plan = visible?.plan;
  return (
    <div className="ce-resource-update-dialog">
      <InstanceOperationDialog
        title="更新模组"
        titleId="ce-resource-update-title"
        busy={!!working}
        committing={working === "start"}
        confirmLabel={
          working === "start"
            ? "正在提交…"
            : working === "prepare"
              ? "正在检查…"
              : plan
                ? "开始更新"
                : "重新检查"
        }
        confirmDisabled={!native || disabled || !scopeKey || !files.length}
        onConfirm={() => void submit()}
        onClose={close}
      >
        <div className="ce-resource-update-content">
          <dl>
            <dt>目标实例</dt>
            <dd>{instance.id}</dd>
            <dt>Minecraft</dt>
            <dd>{instance.minecraft_version}</dd>
            <dt>模组加载器</dt>
            <dd>{instance.loader}</dd>
            {plan && (
              <>
                <dt>更新内容</dt>
                <dd>
                  替换 {plan.replacements.length} 个文件，新增{" "}
                  {plan.adds.length} 个文件，复用 {plan.reuse.length} 个文件
                </dd>
                <dt>下载大小</dt>
                <dd>{instanceOperationSize(plan.download_bytes)}</dd>
                <dt>总大小</dt>
                <dd>{instanceOperationSize(plan.total_bytes)}</dd>
              </>
            )}
          </dl>
          {plan && (
            <>
              <p>所选更新与必要前置</p>
              <dl>
                {plan.replacements.map((file) => (
                  <Fragment key={file.old_file_name}>
                    <dt>{file.required ? "必要前置更新" : "所选更新"}</dt>
                    <dd>
                      {file.title}
                      <br />
                      {file.old_version} → {file.new_version}
                      <br />
                      {file.old_file_name} → {file.new_file_name}（
                      {instanceOperationSize(file.size)}）
                      <br />
                      {file.enabled ? "保持启用" : "保持禁用"}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              {plan.adds.length > 0 && (
                <>
                  <p>新增前置资源</p>
                  <dl>
                    {plan.adds.map((file) => (
                      <Fragment key={`${file.kind}:${file.file_name}`}>
                        <dt>{file.required ? "必要前置" : "新增文件"}</dt>
                        <dd>
                          {file.title}
                          <br />
                          {file.file_name}（{instanceOperationSize(file.size)}
                          ）；
                          {file.kind === "mods" ? "新增为启用状态" : "新增文件"}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
              {plan.reuse.length > 0 && (
                <>
                  <p>复用已有文件</p>
                  <dl>
                    {plan.reuse.map((file) => (
                      <Fragment key={`${file.kind}:${file.file_name}`}>
                        <dt>{file.required ? "必要前置" : "已有文件"}</dt>
                        <dd>
                          {file.title}
                          <br />
                          {file.existing_file_name ?? file.file_name}（
                          {instanceOperationSize(file.size)}
                          ）；
                          {file.kind === "mods"
                            ? "保持原文件与启用状态"
                            : "保持原文件"}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
              <p>确认后将替换所选旧文件。更新成功后可撤销本次更新。</p>
              {plan.warnings.map((warning, index) => (
                <p className="ce-instance-plan-warning" key={index}>
                  {warning}
                </p>
              ))}
            </>
          )}
          {working === "prepare" && (
            <p className="rd-inline-status" role="status">
              正在检查更新文件、必要前置与兼容性…
            </p>
          )}
          {visible?.error && (
            <p className="rd-name-error" role="alert">
              {visible.error}
            </p>
          )}
        </div>
      </InstanceOperationDialog>
    </div>
  );
}

export function ResourceUpdateStatus({
  updates,
  emptyOnly = false,
  onRetry,
  disabled,
  readonlyCount = 0,
}: {
  updates: ReturnType<typeof useResourceUpdates>;
  emptyOnly?: boolean;
  onRetry: () => void;
  disabled: boolean;
  readonlyCount?: number;
}) {
  const entries = updates.result?.entries ?? [];
  const available = entries.filter(
    (entry) => entry.status === "update_available",
  ).length;
  const unknown =
    entries.filter((entry) => entry.status === "unknown").length +
    readonlyCount;
  const blocked = entries.filter((entry) => entry.status === "blocked").length;
  const unchanged = entries.filter(
    (entry) => entry.status === "up_to_date",
  ).length;
  const message =
    updates.phase === "checking"
      ? "正在检查模组更新…"
      : updates.phase === "error"
        ? "更新检测失败"
        : updates.phase === "idle"
          ? "尚未检查模组更新"
          : available
            ? `检测到 ${available} 个可更新模组`
            : unchanged
              ? "已识别模组没有兼容更新"
              : unknown && !blocked
                ? "无法识别已安装模组"
                : blocked && !unknown
                  ? "这些模组暂不可更新"
                  : "没有可确认的更新";
  return (
    <div
      className={
        emptyOnly ? "ce-resource-updates-state" : "ce-resource-update-status"
      }
      role={updates.error ? "alert" : "status"}
    >
      <strong>{message}</strong>
      {updates.phase === "ready" && (
        <p>
          {unchanged} 个已识别模组无兼容更新，{unknown} 个无法识别，{blocked}{" "}
          个暂不可更新
        </p>
      )}
      {updates.error && <p>{updates.error}</p>}
      {updates.result?.warnings.map((warning, index) => (
        <p key={index}>{warning}</p>
      ))}
      <button
        className="ce-button"
        disabled={disabled || updates.busy}
        onClick={onRetry}
      >
        {updates.phase === "ready" ? "重新检查" : "检查更新"}
      </button>
    </div>
  );
}

export function ResourceUpdateUndo({
  updates,
  disabled,
}: {
  updates: ReturnType<typeof useResourceUpdates>;
  disabled: boolean;
}) {
  const entry = updates.history[0];
  if (!entry && !updates.historyError && !updates.restoring) return null;
  return (
    <div
      className="ce-resource-operation-error ce-resource-update-undo"
      role={updates.historyError ? "alert" : "status"}
    >
      <span>
        {updates.restoring
          ? "正在提交撤销更新…"
          : updates.historyError || `上次更新：${entry.files.join("、")}`}
      </span>
      {entry && (
        <button
          className="ce-button"
          disabled={disabled || updates.busy || !!updates.historyError}
          onClick={() => void updates.undo(entry)}
        >
          撤销更新
        </button>
      )}
      {updates.historyError && (
        <button
          className="ce-button"
          disabled={disabled || updates.busy}
          onClick={() => void updates.readHistory()}
        >
          刷新
        </button>
      )}
    </div>
  );
}
