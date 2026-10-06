import { t, formatNumber } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type {
  Api,
  InstanceImportChoice,
  InstanceImportPlan,
  InstancePackImportPlan,
} from "./types";
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
  // Retain the last readonly preview while editing, but retire its checked
  // revision. Native prepare must adopt the exact next name/optional paths.
  pack: InstancePackImportPlan | null;
  optionalPaths: string[];
  error: string;
};

function isPackPlan(
  plan: InstanceImportPlan | null,
): plan is InstancePackImportPlan {
  return !!plan && [
    "modrinth", "curseforge", "mcbbs", "hmcl", "multimc", "ready_game",
  ].includes(plan.format || "");
}

function checkImportPlan(plan: InstanceImportPlan, name: string) {
  if (plan.name !== name || typeof plan.revision !== "string" || !plan.revision)
    throw new Error(t("import.planChanged"));
  if (plan.format === undefined) return;
  // Unknown formats cannot fall through to the old ZIP writer. A true flag
  // alone is insufficient: native authority must be a one-use pack token.
  if (
    !isPackPlan(plan) || typeof plan.installable !== "boolean" || !plan.preview ||
    (plan.installable && (
      !plan.revision.startsWith("pack-confirm-v1:") || plan.preview.blockers?.length !== 0
    ))
  )
    throw new Error(t("import.invalidPlan"));
  const preview = plan.preview;
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (
    !Array.isArray(preview.files) ||
    !Array.isArray(preview.dependencies) ||
    !Array.isArray(preview.blockers) ||
    !Array.isArray(plan.warnings) ||
    plan.warnings.some((warning) => typeof warning !== "string") ||
    (preview.summary !== undefined && typeof preview.summary !== "string") ||
    ![
      plan.file_count,
      plan.bytes,
      plan.reused_files,
      preview.required_files,
      preview.optional_files,
      preview.excluded_files,
      preview.download_bytes,
      preview.override_files,
      preview.override_bytes,
      preview.client_overrides,
      preview.shadowed_files,
    ].every(count) ||
    preview.files.some(
      (file) =>
        typeof file.path !== "string" ||
        !file.path ||
        !count(file.size) ||
        !["required", "optional", "unsupported"].includes(file.client) ||
        typeof file.selected !== "boolean" ||
        typeof file.overridden !== "boolean" ||
        (file.client === "unsupported" && file.selected),
    ) ||
    preview.dependencies.some(
      (dependency) =>
        typeof dependency.id !== "string" ||
        typeof dependency.version !== "string" ||
        typeof dependency.supported !== "boolean",
    ) ||
    preview.blockers.some((blocker) => typeof blocker !== "string")
  )
    throw new Error(t("import.invalidPlan"));
}

/** All formats share the CE name/confirmation dialog. Only an unchanged native
 * checked plan may be submitted; closing/editing retires this view ownership. */
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
          pack: null,
          optionalPaths: [],
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
    const canStart = !!submitted.plan && (submitted.plan.format === undefined || (isPackPlan(submitted.plan) && submitted.plan.installable));
    const token = {
      scope,
      kind: canStart ? ("start" as const) : ("prepare" as const),
      token: Symbol(),
    };
    operation.current = token;
    setActivity(token);
    const ownsReply = () =>
      current() &&
      draftRef.current === submitted &&
      operation.current === token;
    try {
      if (canStart && submitted.plan) {
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
          ...(submitted.pack
            ? { optionalPaths: [...submitted.optionalPaths] }
            : {}),
        });
        if (!ownsReply()) return;
        checkImportPlan(plan, submitted.name);
        setDraft({
          ...submitted,
          plan,
          pack: isPackPlan(plan) ? plan : null,
          optionalPaths: isPackPlan(plan)
            ? plan.preview.files
                .filter((file) => file.client === "optional" && file.selected)
                .map((file) => file.path)
            : [],
          error: "",
        });
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
  const preview = visible.pack?.preview;
  const displayedPlan = visible.plan ?? visible.pack;
  function selectOptional(path: string, selected: boolean) {
    const previous = draftRef.current;
    if (
      !allowed() ||
      !previous ||
      previous.scope !== scope ||
      !previous.pack?.preview.files.some(
        (file) => file.path === path && file.client === "optional",
      ) ||
      (operation.current?.scope === scope && operation.current.kind === "start")
    )
      return;
    const optionalPaths = previous.optionalPaths.filter(
      (item) => item !== path,
    );
    if (selected) optionalPaths.push(path);
    setDraft({ ...previous, optionalPaths, plan: null, error: "" });
  }
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
            : visible.plan && (!isPackPlan(visible.plan) || visible.plan.installable)
              ? t("import.start")
              : preview
                ? t("ui.recheck")
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
      {preview && !visible.pack?.installable && (
        <p className="ce-instance-plan-warning">{t("import.mrpackReadonly")}</p>
      )}
      {preview && !visible.plan && (
        <p className="ce-instance-plan-warning" role="status">
          {t("import.previewStale")}
        </p>
      )}
      {displayedPlan && (
        <div className={preview ? "ce-mrpack-preview" : "ce-import-preview"}>
          <dl>
            {preview && (
              <>
                <dt>{t("import.format")}</dt>
                <dd>{({
                  modrinth: "Modrinth (.mrpack / .zip)",
                  curseforge: "CurseForge (.zip)",
                  mcbbs: "MCBBS (.zip)",
                  hmcl: "HMCL (.zip)",
                  multimc: "MultiMC / Prism (.zip)",
                  ready_game: t("import.readyGame"),
                })[visible.pack!.format]}</dd>
              </>
            )}
            <dt>{t("resources.modpacks")}</dt>
            <dd>
              {displayedPlan.pack_name} {displayedPlan.pack_version}
            </dd>
            <dt>Minecraft</dt>
            <dd>{displayedPlan.minecraft}</dd>
            <dt>{t(preview ? "import.clientOutput" : "import.content")}</dt>
            <dd>
              {t("ui.fileCountSize", {
                count: formatNumber(displayedPlan.file_count),
                size: instanceOperationSize(displayedPlan.bytes),
              })}
            </dd>
            {displayedPlan.reused_files > 0 && (
              <>
                <dt>{t("ui.existingFiles")}</dt>
                <dd>
                  {t("import.reuseCount", {
                    count: formatNumber(displayedPlan.reused_files),
                  })}
                </dd>
              </>
            )}
          </dl>
          {preview ? (
            <>
              {preview.summary && <p>{preview.summary}</p>}
              <dl>
                <dt>{t("import.dependencies")}</dt>
                <dd>
                  {preview.dependencies.map((dependency) => (
                    <div key={dependency.id}>
                      {dependency.id} {dependency.version}
                      {!dependency.supported &&
                        ` — ${t("import.unsupportedDependency")}`}
                    </div>
                  ))}
                </dd>
                <dt>{t("import.requiredFiles")}</dt>
                <dd>{formatNumber(preview.required_files)}</dd>
                <dt>{t("import.optionalFiles")}</dt>
                <dd>
                  {t("import.optionalCount", {
                    total: formatNumber(preview.optional_files),
                    selected: formatNumber(visible.optionalPaths.length),
                  })}
                </dd>
                <dt>{t("import.excludedFiles")}</dt>
                <dd>{formatNumber(preview.excluded_files)}</dd>
                <dt>{t("import.downloadBytes")}</dt>
                <dd>{instanceOperationSize(preview.download_bytes)}</dd>
                <dt>{t("import.overrideFiles")}</dt>
                <dd>
                  {t("ui.fileCountSize", {
                    count: formatNumber(preview.override_files),
                    size: instanceOperationSize(preview.override_bytes),
                  })}
                </dd>
                <dt>{t("import.clientOverrides")}</dt>
                <dd>{formatNumber(preview.client_overrides)}</dd>
                <dt>{t("import.shadowedFiles")}</dt>
                <dd>{formatNumber(preview.shadowed_files)}</dd>
              </dl>
              {preview.blockers.length > 0 && (
                <div className="ce-mrpack-blockers">
                  <p>{t("import.blockers")}</p>
                  {preview.blockers.map((blocker, index) => (
                    <p className="ce-instance-plan-warning" key={index}>
                      {blocker}
                    </p>
                  ))}
                </div>
              )}
              {preview.files.length > 0 && (
                <>
                  <p>{t("import.clientFiles")}</p>
                  <div className="ce-mrpack-files">
                    {preview.files.map((file) => (
                      <div className="ce-mrpack-file" key={file.path}>
                        {file.client === "optional" ? (
                          <label className="ce-check">
                            <input
                              type="checkbox"
                              checked={visible.optionalPaths.includes(
                                file.path,
                              )}
                              disabled={
                                !native || disabled || working === "start"
                              }
                              onChange={(event) =>
                                selectOptional(file.path, event.target.checked)
                              }
                            />
                            <span>{file.path}</span>
                          </label>
                        ) : (
                          <span>{file.path}</span>
                        )}
                        <small>
                          {instanceOperationSize(file.size)} ·{" "}
                          {file.client === "optional"
                            ? t("import.optionalFile")
                            : file.client === "unsupported"
                              ? t("import.unsupportedFile")
                              : t("import.requiredFile")}
                          {file.overridden &&
                            ` · ${t("import.overriddenFile")}`}
                        </small>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <p>{t("import.help")}</p>
          )}
          {displayedPlan.warnings.map((warning, index) => (
            <p key={index} className="ce-instance-plan-warning">
              {warning}
            </p>
          ))}
        </div>
      )}
    </InstanceOperationDialog>
  );
}
