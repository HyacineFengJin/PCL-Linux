import { useEffect, useRef, useState } from "react";
import type { Api, InstanceImportChoice, InstanceImportPlan } from "./types";
import {
  InstanceOperationDialog,
  instanceOperationSize,
  useInstanceOperationScope,
} from "./instanceOperationUi";
import "./instance-operations.css";

export function instanceImportNameError(
  name: string,
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
  if (name.startsWith(".install-") || name.startsWith(".pcl-"))
    return "实例名称使用了保留前缀，请修改名称";
  if (new TextEncoder().encode(name).length > 120)
    return "实例名称过长，请缩短到 120 字节以内";
  if (occupiedNames.includes(name))
    return "此游戏目录中已存在同名实例，请修改名称";
  return "";
}

type ImportDraft = {
  scope: object;
  source: string;
  name: string;
  plan: InstanceImportPlan | null;
  error: string;
};

/** Local ZIP import uses a native source choice and a fresh read plan. Only the
 * checked revision can reach start; edited names invalidate prior confirmation. */
export function InstanceImport({
  api,
  scopeKey,
  native,
  disabled,
  occupiedNames,
  onTaskStart,
  onClose,
  onNotify,
}: {
  api: Api;
  scopeKey: string;
  native: boolean;
  disabled: boolean;
  occupiedNames: string[];
  onTaskStart: (id: string) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const { scope, current, allowed } = useInstanceOperationScope(
    api,
    scopeKey,
    native,
    disabled,
  );
  const [draft, setDraftState] = useState<ImportDraft | null>(null);
  const draftRef = useRef<ImportDraft | null>(null);
  const closed = useRef<object | null>(null);
  const operation = useRef<{
    scope: object;
    kind: "pick" | "prepare" | "start";
    token: symbol;
  } | null>(null);
  const [activity, setActivity] = useState<typeof operation.current>(null);
  const names = useRef(occupiedNames);
  names.current = occupiedNames;
  const callbacks = useRef({ onTaskStart, onClose, onNotify });
  callbacks.current = { onTaskStart, onClose, onNotify };
  function setDraft(next: ImportDraft | null) {
    draftRef.current = next;
    setDraftState(next);
  }
  const visible = draft?.scope === scope ? draft : null;
  const working = activity?.scope === scope ? activity.kind : null;
  function close() {
    if (
      !current() ||
      closed.current === scope ||
      (operation.current?.scope === scope && operation.current.kind === "start")
    )
      return;
    operation.current = null;
    closed.current = scope;
    setActivity(null);
    setDraft(null);
    callbacks.current.onClose();
  }
  useEffect(() => {
    const token = { scope, kind: "pick" as const, token: Symbol() };
    operation.current = token;
    setActivity(token);
    // Defer the picker until the mount effect survives StrictMode cleanup.
    void Promise.resolve().then(async () => {
      if (operation.current !== token) return;
      if (!allowed()) {
        close();
        return;
      }
      try {
        const choice = await api<InstanceImportChoice>("instance_import_pick");
        if (!current() || operation.current !== token) return;
        if (choice.status === "cancelled") {
          close();
          return;
        }
        if (choice.status === "unavailable")
          throw new Error(
            choice.message || "系统文件选择器暂时不可用，请稍后重试",
          );
        if (choice.status !== "selected" || !choice.source)
          throw new Error("未收到选择的 ZIP 文件，请重新选择");
        setDraft({
          scope,
          source: choice.source,
          name: choice.suggested_name || "",
          plan: null,
          error: "",
        });
      } catch (error) {
        if (current() && operation.current === token) {
          callbacks.current.onNotify(String(error));
          close();
        }
      } finally {
        if (operation.current === token) {
          operation.current = null;
          if (current()) setActivity(null);
        }
      }
    });
    return () => {
      if (operation.current === token) operation.current = null;
    };
  }, [scope]);
  async function submit() {
    const submitted = draftRef.current;
    if (
      !allowed() ||
      !submitted ||
      submitted.scope !== scope ||
      operation.current?.scope === scope ||
      instanceImportNameError(submitted.name, names.current)
    )
      return;
    const token = {
      scope,
      kind: submitted.plan ? ("start" as const) : ("prepare" as const),
      token: Symbol(),
    };
    operation.current = token;
    setActivity(token);
    const ownsReply = () =>
      current() &&
      draftRef.current === submitted &&
      operation.current === token;
    try {
      if (submitted.plan) {
        const result = await api<{ id: string }>("instance_import_start", {
          source: submitted.source,
          name: submitted.name,
          revision: submitted.plan.revision,
        });
        if (!ownsReply()) return;
        if (!result.id) throw new Error("未收到导入任务，请重新检查后重试");
        setDraft(null);
        closed.current = scope;
        callbacks.current.onTaskStart(result.id);
        callbacks.current.onClose();
      } else {
        const plan = await api<InstanceImportPlan>("instance_import_prepare", {
          source: submitted.source,
          name: submitted.name,
        });
        if (!ownsReply()) return;
        if (plan.name !== submitted.name || !plan.revision)
          throw new Error("导入计划与当前名称不一致，请重新检查");
        setDraft({ ...submitted, plan, error: "" });
      }
    } catch (error) {
      if (ownsReply())
        setDraft({ ...submitted, plan: null, error: String(error) });
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  if (!visible) return null;
  const nameError = instanceImportNameError(visible.name, occupiedNames);
  return (
    <InstanceOperationDialog
      title="输入实例名称"
      titleId="ce-instance-import-title"
      busy={!!working}
      committing={working === "start"}
      confirmLabel={
        working === "start"
          ? "正在提交…"
          : working === "prepare"
            ? "正在检查…"
            : visible.plan
              ? "开始导入"
              : "确定"
      }
      confirmDisabled={!native || disabled || !!nameError}
      onConfirm={() => void submit()}
      onClose={close}
    >
      <input
        className="ce-field"
        aria-label="导入实例名称"
        value={visible.name}
        disabled={working === "start"}
        onChange={(event) => {
          const previous = draftRef.current;
          if (
            !current() ||
            !previous ||
            previous.scope !== scope ||
            (operation.current?.scope === scope &&
              operation.current.kind === "start")
          )
            return;
          setDraft({
            ...previous,
            name: event.target.value,
            plan: null,
            error: "",
          });
        }}
      />
      {(visible.error || nameError) && (
        <p className="rd-name-error" role="alert">
          {visible.error || nameError}
        </p>
      )}
      {visible.plan && (
        <>
          <dl>
            <dt>整合包</dt>
            <dd>
              {visible.plan.pack_name} {visible.plan.pack_version}
            </dd>
            <dt>Minecraft</dt>
            <dd>{visible.plan.minecraft}</dd>
            <dt>导入内容</dt>
            <dd>
              {visible.plan.file_count.toLocaleString("zh-CN")} 个文件，
              {instanceOperationSize(visible.plan.bytes)}
            </dd>
            {visible.plan.reused_files > 0 && (
              <>
                <dt>已有文件</dt>
                <dd>
                  {visible.plan.reused_files.toLocaleString("zh-CN")}{" "}
                  个文件可复用
                </dd>
              </>
            )}
          </dl>
          <p>将创建新的实例文件夹。导入完成后可在实例列表中选择它。</p>
          {visible.plan.warnings.map((warning, index) => (
            <p key={index} className="ce-instance-plan-warning">
              {warning}
            </p>
          ))}
        </>
      )}
    </InstanceOperationDialog>
  );
}
