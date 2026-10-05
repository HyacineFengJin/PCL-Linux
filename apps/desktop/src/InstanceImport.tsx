import { t, formatNumber } from "./i18n";
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
  if (!name.trim()) return t("instance.nameRequired");
  if (name !== name.trim()) return t("instance.nameWhitespace");
  if (
    name === "." ||
    name === ".." ||
    /[\\/:\u0000-\u001f\u007f-\u009f]/.test(name)
  )
    return t("instance.nameCharacters");
  if (name.startsWith(".install-") || name.startsWith(".pcl-"))
    return t("instance.nameReserved");
  if (new TextEncoder().encode(name).length > 120)
    return t("instance.nameLong");
  if (occupiedNames.includes(name)) return t("instance.nameExists");
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
          throw new Error(choice.message || t("ui.pickerUnavailable"));
        if (choice.status !== "selected" || !choice.source)
          throw new Error(t("import.fileMissing"));
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
        if (!result.id) throw new Error(t("import.taskMissing"));
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
          throw new Error(t("import.planChanged"));
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
      title={t("instance.enterName")}
      titleId="ce-instance-import-title"
      busy={!!working}
      committing={working === "start"}
      confirmLabel={
        working === "start"
          ? t("ui.submitting")
          : working === "prepare"
            ? t("ui.checking")
            : visible.plan
              ? t("import.start")
              : t("ui.confirm")
      }
      confirmDisabled={!native || disabled || !!nameError}
      onConfirm={() => void submit()}
      onClose={close}
    >
      <input
        className="ce-field"
        aria-label={t("import.nameLabel")}
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
            <dt>{t("resources.modpacks")}</dt>
            <dd>
              {visible.plan.pack_name} {visible.plan.pack_version}
            </dd>
            <dt>Minecraft</dt>
            <dd>{visible.plan.minecraft}</dd>
            <dt>{t("import.content")}</dt>
            <dd>
              {t("ui.fileCountSize", {
                count: formatNumber(visible.plan.file_count),
                size: instanceOperationSize(visible.plan.bytes),
              })}
            </dd>
            {visible.plan.reused_files > 0 && (
              <>
                <dt>{t("ui.existingFiles")}</dt>
                <dd>
                  {t("import.reuseCount", {
                    count: formatNumber(visible.plan.reused_files),
                  })}
                </dd>
              </>
            )}
          </dl>
          <p>{t("import.help")}</p>
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
