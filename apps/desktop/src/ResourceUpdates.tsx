import { t, formatNumber, type MessageKey } from "./i18n";
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
  errorKey?: MessageKey;
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
        errorKey: !native
          ? "updates.desktop"
          : disabled
            ? "updates.busy"
            : "updates.selectFiles",
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
        title={t("updates.title")}
        titleId="ce-resource-update-title"
        busy={!!working}
        committing={working === "start"}
        confirmLabel={
          working === "start"
            ? t("ui.submitting")
            : working === "prepare"
              ? t("ui.checking")
              : plan
                ? t("updates.start")
                : t("ui.recheck")
        }
        confirmDisabled={!native || disabled || !scopeKey || !files.length}
        onConfirm={() => void submit()}
        onClose={close}
      >
        <div className="ce-resource-update-content">
          <dl>
            <dt>{t("resourceInstall.target")}</dt>
            <dd>{instance.id}</dd>
            <dt>Minecraft</dt>
            <dd>{instance.minecraft_version}</dd>
            <dt>{t("resourceInstall.loader")}</dt>
            <dd>{instance.loader}</dd>
            {plan && (
              <>
                <dt>{t("updates.content")}</dt>
                <dd>
                  {t("updates.planCounts", {
                    replaced: formatNumber(plan.replacements.length),
                    added: formatNumber(plan.adds.length),
                    reused: formatNumber(plan.reuse.length),
                  })}
                </dd>
                <dt>{t("resourceInstall.downloadSize")}</dt>
                <dd>{instanceOperationSize(plan.download_bytes)}</dd>
                <dt>{t("resourceInstall.totalSize")}</dt>
                <dd>{instanceOperationSize(plan.total_bytes)}</dd>
              </>
            )}
          </dl>
          {plan && (
            <>
              <p>{t("updates.selectedDependencies")}</p>
              <dl>
                {plan.replacements.map((file) => (
                  <Fragment key={file.old_file_name}>
                    <dt>
                      {file.required
                        ? t("updates.requiredUpdate")
                        : t("updates.selectedUpdate")}
                    </dt>
                    <dd>
                      {file.title}
                      <br />
                      {file.old_version} → {file.new_version}
                      <br />
                      {file.old_file_name} → {file.new_file_name}（
                      {instanceOperationSize(file.size)}）
                      <br />
                      {file.enabled
                        ? t("updates.keepEnabled")
                        : t("updates.keepDisabled")}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              {plan.adds.length > 0 && (
                <>
                  <p>{t("updates.newDependencies")}</p>
                  <dl>
                    {plan.adds.map((file) => (
                      <Fragment key={`${file.kind}:${file.file_name}`}>
                        <dt>
                          {file.required
                            ? t("updates.required")
                            : t("updates.newFile")}
                        </dt>
                        <dd>
                          {file.title}
                          <br />
                          {file.file_name}（{instanceOperationSize(file.size)}
                          ）；
                          {file.kind === "mods"
                            ? t("updates.newEnabled")
                            : t("updates.newFile")}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
              {plan.reuse.length > 0 && (
                <>
                  <p>{t("updates.reuse")}</p>
                  <dl>
                    {plan.reuse.map((file) => (
                      <Fragment key={`${file.kind}:${file.file_name}`}>
                        <dt>
                          {file.required
                            ? t("updates.required")
                            : t("ui.existingFiles")}
                        </dt>
                        <dd>
                          {file.title}
                          <br />
                          {file.existing_file_name ?? file.file_name}（
                          {instanceOperationSize(file.size)}
                          ）；
                          {file.kind === "mods"
                            ? t("updates.keepOriginalState")
                            : t("updates.keepOriginal")}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
              <p>{t("updates.confirmHelp")}</p>
              {plan.warnings.map((warning, index) => (
                <p className="ce-instance-plan-warning" key={index}>
                  {warning}
                </p>
              ))}
            </>
          )}
          {working === "prepare" && (
            <p className="rd-inline-status" role="status">
              {t("updates.checking")}
            </p>
          )}
          {(visible?.error || visible?.errorKey) && (
            <p className="rd-name-error" role="alert">
              {visible?.errorKey ? t(visible.errorKey) : visible?.error}
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
      ? t("updates.scanning")
      : updates.phase === "error"
        ? t("updates.failed")
        : updates.phase === "idle"
          ? t("updates.unchecked")
          : available
            ? t("updates.available", { count: formatNumber(available) })
            : unchanged
              ? t("updates.noCompatible")
              : unknown && !blocked
                ? t("updates.unrecognized")
                : blocked && !unknown
                  ? t("updates.blocked")
                  : t("updates.noConfirmed");
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
          {t("updates.summary", {
            unchanged: formatNumber(unchanged),
            unknown: formatNumber(unknown),
            blocked: formatNumber(blocked),
          })}
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
        {updates.phase === "ready" ? t("ui.recheck") : t("updates.check")}
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
          ? t("updates.undoSubmitting")
          : updates.historyError ||
            t("updates.last", { files: entry.files.join(", ") })}
      </span>
      {entry && (
        <button
          className="ce-button"
          disabled={disabled || updates.busy || !!updates.historyError}
          onClick={() => void updates.undo(entry)}
        >
          {t("updates.undo")}
        </button>
      )}
      {updates.historyError && (
        <button
          className="ce-button"
          disabled={disabled || updates.busy}
          onClick={() => void updates.readHistory()}
        >
          {t("ui.refresh")}
        </button>
      )}
    </div>
  );
}
