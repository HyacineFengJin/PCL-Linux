import { t, formatNumber, type MessageKey } from "./i18n";
import { Fragment, useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import {
  checkResourceInstallPlan,
  resourceInstallRequest,
  type ResourceInstallPlan,
  type ResourceInstallRequest,
  type ResourceInstallTarget,
} from "./resourceInstallPlan";
import {
  InstanceOperationDialog,
  instanceOperationSize,
  useInstanceOperationScope,
} from "./instanceOperationUi";
import "./resource-details.css";
import "./instance-operations.css";

type DialogState = {
  scope: object;
  plan: ResourceInstallPlan | null;
  error: string;
  errorKey?: MessageKey;
};

/** The caller fixes the current root, instance and selected provider file.
 * Read cancellation stays local; start admission transfers cleanup to the
 * shared task service, so closing is blocked until its task ID is received. */
export function ResourceInstall({
  api,
  scopeKey,
  selectedInstance,
  request,
  contextKey,
  native,
  disabled,
  onTaskStart,
  onClose,
}: {
  api: Api;
  scopeKey: string;
  selectedInstance: ResourceInstallTarget | null;
  request: ResourceInstallRequest;
  contextKey?: string | number;
  native: boolean;
  disabled: boolean;
  onTaskStart: (id: string) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const root = useInstanceOperationScope(api, scopeKey, native, disabled);
  const identity = JSON.stringify([
    selectedInstance?.id,
    selectedInstance?.minecraft_version,
    selectedInstance?.loader,
    request.project_id,
    request.version_id,
    request.file_name,
    contextKey,
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
  const operation = useRef<{
    scope: object;
    kind: "prepare" | "start";
  } | null>(null);
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
    if (
      !root.allowed() ||
      !selectedInstance ||
      !scopeKey ||
      !request.project_id ||
      !request.version_id
    ) {
      setDialog({
        ...next,
        errorKey: !native
          ? "resourceInstall.desktop"
          : !selectedInstance
            ? "resourceInstall.selectTarget"
            : disabled
              ? "resourceInstall.taskBusy"
              : "resourceInstall.invalidTarget",
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
      const plan = await api<ResourceInstallPlan>("resource_install_plan", {
        id: selectedInstance.id,
        request: resourceInstallRequest(request),
      });
      if (!ownsReply()) return;
      checkResourceInstallPlan(plan, scopeKey, selectedInstance, request);
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
    const token = {};
    mountRequest.current = token;
    // StrictMode may discard the first mount. Deferring prevents duplicate
    // provider reads; every reply is also tied to the full selection identity.
    void Promise.resolve().then(() => {
      if (mountRequest.current === token && current()) void prepare();
    });
    return () => {
      if (mountRequest.current === token) mountRequest.current = null;
    };
  }, [scope]);
  async function submit() {
    const submitted = dialogRef.current;
    if (
      !current() ||
      !root.allowed() ||
      !selectedInstance ||
      operation.current?.scope === scope
    )
      return;
    if (!submitted || submitted.scope !== scope || !submitted.plan) {
      await prepare();
      return;
    }
    const token = { scope, kind: "start" as const };
    operation.current = token;
    setActivity(token);
    const ownsReply = () =>
      current() &&
      operation.current === token &&
      dialogRef.current === submitted;
    try {
      const result = await api<{ id: string }>("resource_install_start", {
        id: selectedInstance.id,
        request: resourceInstallRequest(request),
        revision: submitted.plan.revision,
      });
      if (!ownsReply()) return;
      if (!result.id) throw new Error(t("resourceInstall.taskMissing"));
      closed.current = scope;
      setDialog(null);
      callbacks.current.onTaskStart(result.id);
      callbacks.current.onClose();
    } catch (error) {
      if (ownsReply()) setDialog({ scope, plan: null, error: String(error) });
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (current()) setActivity(null);
      }
    }
  }
  if (closed.current === scope) return null;
  const plan = visible?.plan;
  const required = plan?.files.filter((file) => file.required) ?? [];
  const selected = plan?.files.filter((file) => !file.required) ?? [];
  const reused = plan?.files.filter((file) => file.reused).length ?? 0;
  return (
    <div className="rd-resource-install">
      <InstanceOperationDialog
        title={t("resource.install")}
        titleId="ce-resource-install-title"
        busy={!!working}
        committing={working === "start"}
        confirmLabel={
          working === "start"
            ? t("ui.submitting")
            : working === "prepare"
              ? t("ui.checking")
              : plan
                ? t("resourceInstall.start")
                : t("ui.recheck")
        }
        confirmDisabled={!native || disabled || !selectedInstance || !scopeKey}
        onConfirm={() => void submit()}
        onClose={close}
      >
        {/* The plan may contain many dependencies or long filenames. Its own
         * scroll area keeps the existing confirmation actions in view. */}
        <div className="rd-resource-install-content">
          <dl>
            <dt>{t("resourceInstall.target")}</dt>
            <dd>{selectedInstance?.id ?? t("resourceInstall.noTarget")}</dd>
            <dt>Minecraft</dt>
            <dd>{selectedInstance?.minecraft_version ?? "—"}</dd>
            <dt>{t("resourceInstall.loader")}</dt>
            <dd>{selectedInstance?.loader ?? "—"}</dd>
            {plan && (
              <>
                <dt>{t("ui.file")}</dt>
                <dd>
                  {t("resourceInstall.filesCount", {
                    count: formatNumber(plan.files.length),
                    reused: formatNumber(reused),
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
              <p>{t("resourceInstall.selectedFile")}</p>
              <dl>
                {selected.map((file) => (
                  <Fragment key={JSON.stringify([file.kind, file.file_name])}>
                    <dt>{t("ui.resource")}</dt>
                    <dd>
                      {file.title}
                      <br />
                      {file.file_name}（{instanceOperationSize(file.size)}）
                      {file.reused &&
                        t("resourceInstall.reuseFile", {
                          name: file.existing_file_name ?? file.file_name,
                        })}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              {required.length > 0 && (
                <>
                  <p>
                    <strong>
                      {t("resourceInstall.requiredCount", {
                        count: formatNumber(required.length),
                      })}
                    </strong>
                  </p>
                  <dl>
                    {required.map((file) => (
                      <Fragment
                        key={JSON.stringify([file.kind, file.file_name])}
                      >
                        <dt>{t("resourceInstall.dependency")}</dt>
                        <dd>
                          {file.title}
                          <br />
                          {file.file_name}（{instanceOperationSize(file.size)}）
                          {file.reused
                            ? t("resourceInstall.reuseFile", {
                                name: file.existing_file_name ?? file.file_name,
                              })
                            : t("resourceInstall.alongside")}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
              {plan.warnings.map((warning, index) => (
                <p className="ce-instance-plan-warning" key={index}>
                  {warning}
                </p>
              ))}
            </>
          )}
          {working === "prepare" && (
            <p className="rd-inline-status" role="status">
              {t("resourceInstall.checking")}
            </p>
          )}
          {(visible?.error || visible?.errorKey) && (
            <p className="rd-name-error" role="status">
              {visible?.errorKey ? t(visible.errorKey) : visible?.error}
            </p>
          )}
        </div>
      </InstanceOperationDialog>
    </div>
  );
}
