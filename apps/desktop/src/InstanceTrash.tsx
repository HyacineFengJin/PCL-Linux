import { useEffect, useRef, useState } from "react";
import type { Api, InstanceDeletedEntry, InstanceDeletePlan } from "./types";
import {
  InstanceOperationDialog,
  instanceOperationSize,
  useInstanceOperationScope,
} from "./instanceOperationUi";
import "./instance-operations.css";

type TaskProps = {
  api: Api;
  scopeKey: string;
  native: boolean;
  disabled: boolean;
  onTaskStart: (id: string) => void;
};

/** The existing overview action prepares the whole physical instance range.
 * Read cancellation is local; admitted writes move to the shared task manager. */
export function InstanceDelete({
  id,
  api,
  scopeKey,
  native,
  disabled,
  onTaskStart,
}: TaskProps & { id: string }) {
  const { scope, current, allowed } = useInstanceOperationScope(
    api,
    `${scopeKey}:${id}`,
    native,
    disabled,
  );
  const [dialog, setDialogState] = useState<{
    scope: object;
    plan: InstanceDeletePlan | null;
    error: string;
  } | null>(null);
  const dialogRef = useRef(dialog);
  const operation = useRef<{ scope: object; kind: "prepare" | "start" } | null>(
    null,
  );
  const [activity, setActivity] = useState<typeof operation.current>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const callback = useRef(onTaskStart);
  callback.current = onTaskStart;
  function setDialog(next: typeof dialog) {
    dialogRef.current = next;
    setDialogState(next);
  }
  const visible = dialog?.scope === scope ? dialog : null;
  const working = activity?.scope === scope ? activity.kind : null;
  function close() {
    if (
      !current() ||
      (operation.current?.scope === scope && operation.current.kind === "start")
    )
      return;
    operation.current = null;
    setActivity(null);
    setDialog(null);
    trigger.current?.focus();
  }
  async function prepare() {
    if (!allowed() || operation.current?.scope === scope) return;
    const token = { scope, kind: "prepare" as const };
    const next = { scope, plan: null, error: "" };
    setDialog(next);
    operation.current = token;
    setActivity(token);
    try {
      const plan = await api<InstanceDeletePlan>("instance_delete_prepare", {
        id,
      });
      if (
        !current() ||
        operation.current !== token ||
        dialogRef.current !== next
      )
        return;
      if (plan.id !== id || plan.root_id !== scopeKey || !plan.revision)
        throw new Error("删除计划与当前实例或游戏目录不一致，请重新检查");
      setDialog({ ...next, plan });
    } catch (error) {
      if (
        current() &&
        operation.current === token &&
        dialogRef.current === next
      )
        setDialog({ ...next, error: String(error) });
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  async function start() {
    const submitted = dialogRef.current;
    if (
      !allowed() ||
      !submitted ||
      submitted.scope !== scope ||
      operation.current?.scope === scope
    )
      return;
    if (!submitted.plan) {
      await prepare();
      return;
    }
    const token = { scope, kind: "start" as const };
    operation.current = token;
    setActivity(token);
    try {
      const result = await api<{ id: string }>("instance_delete_start", {
        id: submitted.plan.id,
        revision: submitted.plan.revision,
      });
      if (
        !current() ||
        operation.current !== token ||
        dialogRef.current !== submitted
      )
        return;
      if (!result.id) throw new Error("未收到删除任务，请重新检查后重试");
      setDialog(null);
      callback.current(result.id);
    } catch (error) {
      // A rejected revision is discarded; a retry must describe a fresh range.
      if (
        current() &&
        operation.current === token &&
        dialogRef.current === submitted
      )
        setDialog({ scope, plan: null, error: String(error) });
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  return (
    <>
      <button
        ref={trigger}
        className="ce-button danger"
        disabled={!native || disabled || !!visible || !!working}
        title={!native ? "请在桌面应用中删除实例" : "删除实例后可以撤销恢复"}
        onClick={() => {
          if (
            !allowed() ||
            dialogRef.current?.scope === scope ||
            operation.current?.scope === scope
          )
            return;
          void prepare();
        }}
      >
        删除实例
      </button>
      {visible && (
        <InstanceOperationDialog
          title="删除实例"
          titleId="ce-instance-delete-title"
          busy={!!working}
          committing={working === "start"}
          confirmLabel={
            working === "start"
              ? "正在提交…"
              : working === "prepare"
                ? "正在检查…"
                : visible.plan
                  ? "删除"
                  : "重新检查"
          }
          confirmDisabled={!native || disabled}
          onConfirm={() => void start()}
          onClose={close}
        >
          {visible.plan ? (
            <>
              <p>
                将整个实例文件夹移入可恢复区，包括该文件夹内的存档、模组与配置。删除后可在实例列表中点击“撤销删除”恢复。
              </p>
              <dl>
                <dt>实例</dt>
                <dd>{visible.plan.id}</dd>
                <dt>文件夹</dt>
                <dd>versions/{visible.plan.id}</dd>
                <dt>删除内容</dt>
                <dd>
                  {visible.plan.total_files.toLocaleString("zh-CN")} 个文件，
                  {instanceOperationSize(visible.plan.total_bytes)}
                </dd>
              </dl>
              <p>游戏目录中的共享资源与其他实例会保留。</p>
            </>
          ) : (
            !visible.error && <p role="status">正在检查实例内容…</p>
          )}
          {visible.error && (
            <p className="rd-name-error" role="alert">
              {visible.error}
            </p>
          )}
        </InstanceOperationDialog>
      )}
    </>
  );
}

/** Persistent undo records stay visible on conflicts. Refresh replaces only the
 * owning root's read snapshot; restore submits the exact record revision. */
export function InstanceTrash({
  api,
  scopeKey,
  native,
  disabled,
  onTaskStart,
  refreshKey = 0,
}: TaskProps & { refreshKey?: string | number }) {
  const { scope, current, readable, allowed } = useInstanceOperationScope(
    api,
    scopeKey,
    native,
    disabled,
  );
  type Snapshot = {
    scope: object;
    entries: InstanceDeletedEntry[];
    error: string;
    loading: boolean;
  };
  const [snapshot, setSnapshot] = useState<Snapshot>({
    scope,
    entries: [],
    error: "",
    loading: true,
  });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const readEpoch = useRef(0);
  const operation = useRef<{ scope: object; operationId: string } | null>(null);
  const [activity, setActivity] = useState<typeof operation.current>(null);
  const callback = useRef(onTaskStart);
  callback.current = onTaskStart;
  const visible =
    snapshot.scope === scope
      ? snapshot
      : { scope, entries: [], error: "", loading: true };
  const working = activity?.scope === scope ? activity : null;
  async function read() {
    if (!readable()) return;
    const epoch = ++readEpoch.current;
    setSnapshot((old) => ({
      scope,
      entries: old.scope === scope ? old.entries : [],
      error: "",
      loading: true,
    }));
    try {
      const entries = await api<InstanceDeletedEntry[]>(
        "instance_deleted_list",
      );
      if (!current() || readEpoch.current !== epoch) return;
      if (entries.some((entry) => entry.root_id !== scopeKey))
        throw new Error("删除记录与当前游戏目录不一致，请刷新重试");
      setSnapshot({
        scope,
        entries: [...entries].sort((a, b) => b.created_ms - a.created_ms),
        error: "",
        loading: false,
      });
    } catch (error) {
      if (current() && readEpoch.current === epoch)
        setSnapshot((old) => ({
          scope,
          entries: old.scope === scope ? old.entries : [],
          error: String(error),
          loading: false,
        }));
    }
  }
  useEffect(() => {
    void read();
    return () => {
      ++readEpoch.current;
    };
  }, [scope, native, refreshKey]);
  async function restore(entry: InstanceDeletedEntry) {
    const saved =
      latest.current.scope === scope
        ? latest.current.entries.find(
            (candidate) => candidate.operation_id === entry.operation_id,
          )
        : null;
    if (
      !allowed() ||
      operation.current?.scope === scope ||
      latest.current.loading ||
      latest.current.error ||
      !saved?.can_restore ||
      !saved.revision ||
      saved.revision !== entry.revision
    )
      return;
    const token = { scope, operationId: entry.operation_id };
    operation.current = token;
    setActivity(token);
    try {
      const result = await api<{ id: string }>("instance_restore_start", {
        operationId: saved.operation_id,
        revision: saved.revision,
      });
      if (!current() || operation.current !== token) return;
      if (!result.id) throw new Error("未收到恢复任务，请刷新后重试");
      callback.current(result.id);
    } catch (error) {
      if (current() && operation.current === token)
        setSnapshot((old) =>
          old.scope === scope ? { ...old, error: String(error) } : old,
        );
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  if (!native || (!visible.entries.length && !visible.error)) return null;
  return (
    <div className="ce-instance-trash" aria-busy={visible.loading || !!working}>
      {visible.error && (
        <div className="auth-notice ce-instance-trash-error" role="alert">
          <span>{visible.error}</span>
          <button
            className="ce-button"
            disabled={visible.loading || !!working}
            onClick={() => {
              if (current() && operation.current?.scope !== scope) void read();
            }}
          >
            刷新
          </button>
        </div>
      )}
      {visible.entries.map((entry) => (
        <div
          className="auth-notice ce-instance-trash-entry"
          key={entry.operation_id}
          role="status"
        >
          <span>
            {entry.state === "deleted"
              ? `已删除实例 ${entry.id}。`
              : `实例 ${entry.id} 的删除或恢复操作尚未完成。`}
            {entry.warning || "可撤销删除，恢复实例文件夹。"}
          </span>
          <button
            className="ce-button"
            disabled={
              disabled ||
              visible.loading ||
              !!visible.error ||
              !!working ||
              !entry.can_restore ||
              !entry.revision
            }
            onClick={() => void restore(entry)}
          >
            {working?.operationId === entry.operation_id
              ? "正在提交…"
              : "撤销删除"}
          </button>
          {entry.warning && (
            <button
              className="ce-button"
              disabled={visible.loading || !!working}
              onClick={() => {
                if (current() && operation.current?.scope !== scope)
                  void read();
              }}
            >
              刷新
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
