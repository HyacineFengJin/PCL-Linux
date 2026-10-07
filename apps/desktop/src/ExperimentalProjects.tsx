/** Persistent project navigation and notes; source approvals and credentials
 * remain owned by the shared host. Local edits survive selection changes and
 * refresh. A stale save retains the draft until the user explicitly retries.
 * Page scopes retire callbacks/results, without canceling submitted host writes.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CeSelect } from "./CeSelect";
import { t, formatDate, serviceError } from "./i18n";
import type { Api } from "./types";
import {
  experimentalCall as call,
  type EngineStatus,
  type JobView,
  type MakerSpec,
} from "./experimentalTypes";
import type {
  MakerProject,
  ProjectCheckpoint,
  ProjectSourceSelection,
} from "./experimentalProjectTypes";
import { ExperimentalProjectFiles } from "./ExperimentalProjectFiles";
import { ExperimentalVersion } from "./ExperimentalVersion";
import "./experimental.css";

type ProjectNotesDraft = { name: string; notes: string; revision: string };
export function createProjectManagerDraft() {
  return {
    id: "",
    name: "",
    notes: "",
    revision: "",
    jobId: "",
    checkpointId: "",
    label: "",
    prompt: "",
    drafts: new Map<string, ProjectNotesDraft>(),
  };
}
export function ExperimentalProjects({
  api,
  native,
  draft,
  onOpen,
  onConfigureAi,
}: {
  draft: RefObject<ReturnType<typeof createProjectManagerDraft>>;
  api: Api;
  native: boolean;
  onOpen: (source: ProjectSourceSelection) => void;
  onConfigureAi?: () => void;
}) {
  const [projects, setProjects] = useState<MakerProject[]>([]),
    [jobs, setJobs] = useState<EngineStatus["jobs"]>([]);
  const [id, setId] = useState(draft.current.id),
    [jobId, setJobId] = useState(draft.current.jobId),
    [job, setJob] = useState<JobView | null>(null);
  const [operationId, setOperationId] = useState(""),
    [checkpointId, setCheckpointId] = useState(draft.current.checkpointId);
  const [name, setName] = useState(draft.current.name),
    [notes, setNotes] = useState(draft.current.notes),
    [label, setLabel] = useState(draft.current.label),
    [prompt, setPrompt] = useState(draft.current.prompt);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const page = useRef<{
    api: Api;
    native: boolean;
    active: boolean;
    working: boolean;
    refresh: number;
  } | null>(null);
  const scope = useMemo(
    () => ({ api, native, active: false, working: false, refresh: 0 }),
    [api, native],
  );
  const callbacks = useRef<object>({}),
    selection = useRef(0);
  const renderCallbacks = {};
  useEffect(() => {
    callbacks.current = renderCallbacks;
  });
  // A selection or draft edit advances the view generation. An admitted
  // write may finish, but must not replace newer local intent on completion.
  const selected = selection.current;
  const isCurrent = () => scope.active && page.current === scope;
  const isCallbackCurrent = () =>
    isCurrent() &&
    callbacks.current === renderCallbacks &&
    selection.current === selected;
  const drafts = useRef(draft.current.drafts);
  const project = projects.find((value) => value.id === id),
    point = project?.checkpoints.find((value) => value.id === checkpointId);
  const [indexEditable, setIndexEditable] = useState(true);
  useEffect(
    () => setIndexEditable(true),
    [project?.id, project?.revision, point?.id],
  );
  const [loadedRevision, setLoadedRevision] = useState(draft.current.revision);
  // The owning app retains drafts while users visit AI settings or source review.
  useEffect(() => {
    draft.current = {
      id,
      name,
      notes,
      revision: loadedRevision,
      jobId,
      checkpointId,
      label,
      prompt,
      drafts: drafts.current,
    };
  }, [
    draft,
    id,
    name,
    notes,
    loadedRevision,
    jobId,
    checkpointId,
    label,
    prompt,
  ]);
  function choose(next: MakerProject | undefined) {
    if (!isCallbackCurrent()) return;
    selection.current++;
    drafts.current.set(id, { name, notes, revision: loadedRevision });
    const draft = drafts.current.get(next?.id ?? "");
    setId(next?.id ?? "");
    setName(draft?.name ?? next?.name ?? "");
    setNotes(draft?.notes ?? next?.notes ?? "");
    setLoadedRevision(draft?.revision ?? next?.revision ?? "");
    setCheckpointId(next?.checkpoints.at(-1)?.id ?? "");
    setError("");
  }
  async function refresh() {
    const request = ++scope.refresh;
    try {
      const [saved, status] = await Promise.all([
        call<{ projects: MakerProject[] }>(api, "projects_list"),
        call<EngineStatus>(api, "status"),
      ]);
      if (isCurrent() && request === scope.refresh) {
        setProjects(saved.projects);
        setJobs(status.jobs);
      }
    } catch (error) {
      if (isCurrent() && request === scope.refresh) throw error;
    }
  }
  useEffect(() => {
    page.current = scope;
    scope.active = true;
    setBusy(false);
    if (native)
      void refresh().catch((e) => {
        if (isCurrent()) setError(serviceError(e));
      });
    return () => {
      scope.active = false;
      if (page.current === scope) page.current = null;
    };
  }, [api, native]);
  useEffect(() => {
    let valid = true;
    setJob(null);
    setOperationId("");
    if (native && jobId)
      void call<JobView>(api, "job_read", { jobId })
        .then((value) => {
          if (valid && isCurrent()) {
            setJob(value);
            setOperationId(value.artifacts.at(-1)?.operationId ?? "");
          }
        })
        .catch((e) => {
          if (valid && isCurrent()) setError(serviceError(e));
        });
    return () => {
      valid = false;
    };
  }, [api, native, jobId]);
  async function perform(action: () => Promise<void>) {
    // Only the currently rendered page can admit a request. Once admitted,
    // its host transaction finishes independently; scope/selection checks only
    // decide whether its response may update this view.
    if (!native || !isCallbackCurrent() || scope.working) return;
    scope.working = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (isCurrent() && selection.current === selected)
        setError(serviceError(e));
    } finally {
      scope.working = false;
      if (isCurrent()) setBusy(false);
    }
  }
  async function saved(value: MakerProject) {
    if (!isCurrent()) return;
    if (selection.current !== selected) {
      await refresh();
      return;
    }
    if (value.id !== id) selection.current++;
    drafts.current.delete(value.id);
    if (!id) drafts.current.delete("");
    setLoadedRevision(value.revision);
    setId(value.id);
    setName(value.name);
    setNotes(value.notes);
    setCheckpointId(value.checkpoints.at(-1)?.id ?? "");
    await refresh();
  }
  async function save(attach = false, archived = project?.archived ?? false) {
    if (!project) return;
    await saved(
      await call<MakerProject>(api, "project_update", {
        id,
        expectedRevision: loadedRevision,
        name,
        notes,
        archived,
        ...(attach ? { source: { jobId, operationId, label } } : {}),
      }),
    );
  }
  async function open(source: ProjectCheckpoint) {
    const value = await call<ProjectSourceSelection>(api, "project_open", {
      id,
      expectedRevision: project?.revision,
      checkpointId: source.id,
    });
    if (isCurrent() && selection.current === selected) onOpen(value);
  }
  const unavailable = !native || busy;
  return (
    <div className="experimental-panel">
      <section className="ce-card experimental-form">
        <h2 className="ce-card-title">{t("experimental.projects")}</h2>
        <p>{t("experimental.projectsHelp")}</p>
        <div className="ce-actions">
          <button
            className="ce-button"
            disabled={unavailable}
            onClick={() => void perform(refresh)}
          >
            {t("experimental.refresh")}
          </button>
          <button
            className="ce-button"
            disabled={unavailable}
            onClick={() => choose(undefined)}
          >
            {t("experimental.new")}
          </button>
        </div>
        <div className="experimental-job-list">
          {projects.map((value) => (
            <button
              className={`ce-button experimental-job ${id === value.id ? "primary" : ""}`}
              key={value.id}
              disabled={busy}
              onClick={() => choose(value)}
            >
              <span>
                {value.name}
                {value.archived ? ` · ${t("experimental.archived")}` : ""}
              </span>
              <span>{formatDate(value.updatedAt)}</span>
            </button>
          ))}
        </div>
        {!projects.length && (
          <p className="experimental-origin">{t("experimental.noProjects")}</p>
        )}
        <label className="ce-row">
          <span>{t("experimental.name")}</span>
          <input
            className="ce-field"
            maxLength={120}
            value={name}
            disabled={unavailable}
            onChange={(e) => {
              if (isCallbackCurrent()) {
                selection.current++;
                setName(e.target.value);
              }
            }}
          />
        </label>
        <label className="ce-row">
          <span>{t("experimental.projectNotes")}</span>
          <textarea
            className="ce-field experimental-editor"
            maxLength={8192}
            value={notes}
            disabled={unavailable}
            onChange={(e) => {
              if (isCallbackCurrent()) {
                selection.current++;
                setNotes(e.target.value);
              }
            }}
          />
        </label>
        <p className="experimental-origin">
          {t("experimental.projectNotesHelp")}
        </p>
        {project && (
          <div className="ce-actions">
            <button
              className="ce-button primary"
              disabled={unavailable || !name.trim()}
              onClick={() => void perform(() => save())}
            >
              {t("experimental.saveProject")}
            </button>
            <button
              className="ce-button"
              disabled={unavailable}
              onClick={() => void perform(() => save(false, !project.archived))}
            >
              {t(
                project.archived
                  ? "experimental.unarchiveProject"
                  : "experimental.archiveProject",
              )}
            </button>
            {loadedRevision !== project.revision && (
              <button
                className="ce-button"
                disabled={unavailable}
                onClick={() => {
                  if (!isCallbackCurrent()) return;
                  selection.current++;
                  setLoadedRevision(project.revision);
                  drafts.current.delete(id);
                  setError("");
                }}
              >
                {t("experimental.retryProjectSave")}
              </button>
            )}
          </div>
        )}
      </section>
      <section className="ce-card experimental-form">
        <h2 className="ce-card-title">{t("experimental.recordVersion")}</h2>
        <p>{t("experimental.recordVersionHelp")}</p>
        <label className="ce-row">
          <span>{t("experimental.jobs")}</span>
          <CeSelect
            className="ce-field"
            value={jobId}
            disabled={unavailable}
            onChange={(e) => {
              if (!isCallbackCurrent()) return;
              selection.current++;
              setJob(null);
              setOperationId("");
              setJobId(e.target.value);
            }}
          >
            <option value="">{t("common.none")}</option>
            {jobs
              .filter((value) => !["queued", "running"].includes(value.status))
              .map((value) => (
                <option key={value.jobId} value={value.jobId}>
                  {value.workflow} · {formatDate(value.updatedAt)} ·{" "}
                  {value.jobId.slice(0, 8)}
                </option>
              ))}
          </CeSelect>
        </label>
        <label className="ce-row">
          <span>{t("experimental.artifact")}</span>
          <CeSelect
            className="ce-field"
            value={operationId}
            disabled={unavailable}
            onChange={(e) => {
              if (isCallbackCurrent()) {
                selection.current++;
                setOperationId(e.target.value);
              }
            }}
          >
            <option value="">{t("common.none")}</option>
            {job?.artifacts.map((value) => (
              <option key={value.operationId} value={value.operationId}>
                {value.directory}
              </option>
            ))}
          </CeSelect>
        </label>
        <label className="ce-row">
          <span>{t("experimental.versionLabel")}</span>
          <input
            className="ce-field"
            value={label}
            maxLength={120}
            disabled={unavailable}
            onChange={(e) => {
              if (isCallbackCurrent()) {
                selection.current++;
                setLabel(e.target.value);
              }
            }}
          />
        </label>
        <button
          className="ce-button primary"
          disabled={
            unavailable || !name.trim() || !label.trim() || !operationId
          }
          onClick={() =>
            void perform(async () => {
              if (project) await save(true);
              else
                await saved(
                  await call<MakerProject>(api, "project_create", {
                    name,
                    notes,
                    jobId,
                    operationId,
                    label,
                  }),
                );
            })
          }
        >
          {t(
            project
              ? "experimental.recordVersion"
              : "experimental.createProject",
          )}
        </button>
      </section>
      {project && (
        <section className="ce-card experimental-form">
          <h2 className="ce-card-title">{t("experimental.projectHistory")}</h2>
          <label className="ce-row">
            <span>{t("experimental.checkpoint")}</span>
            <CeSelect
              className="ce-field"
              value={checkpointId}
              disabled={unavailable}
              onChange={(e) => {
                if (isCallbackCurrent()) {
                  selection.current++;
                  setCheckpointId(e.target.value);
                }
              }}
            >
              {project.checkpoints.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.label} · {value.workflow} ·{" "}
                  {formatDate(value.createdAt)}
                </option>
              ))}
            </CeSelect>
          </label>
          <p>{t("experimental.projectVerification")}</p>
          <button
            className="ce-button"
            disabled={unavailable || !point || !indexEditable}
            onClick={() => void perform(() => open(point!))}
          >
            {t("experimental.continueEditing")}
          </button>
          <label className="ce-row">
            <span>{t("experimental.prompt")}</span>
            <textarea
              className="ce-field"
              rows={4}
              value={prompt}
              maxLength={12000}
              disabled={unavailable}
              onChange={(e) => {
                if (isCallbackCurrent()) {
                  selection.current++;
                  setPrompt(e.target.value);
                }
              }}
            />
          </label>
          <p className="experimental-origin">
            {t("experimental.continueProjectHelp")}
          </p>
          <div className="ce-actions">
            <button
              className="ce-button"
              disabled={busy || !onConfigureAi}
              onClick={() => {
                if (isCallbackCurrent()) onConfigureAi?.();
              }}
            >
              {t("experimental.ai")}
            </button>
            <button
              className="ce-button primary"
              disabled={
                unavailable ||
                project.archived ||
                !indexEditable ||
                point?.workflow !== "maker" ||
                !prompt.trim() ||
                name !== project.name ||
                notes !== project.notes
              }
              onClick={() =>
                void perform(async () => {
                  const value = await call<{
                    jobId: string;
                    operationId: string;
                    spec: MakerSpec;
                  }>(api, "project_continue", {
                    id,
                    expectedRevision: project.revision,
                    checkpointId,
                    prompt,
                  });
                  if (isCurrent() && selection.current === selected)
                    onOpen({
                      workflow: "maker",
                      jobId: value.jobId,
                      operationId: value.operationId,
                      spec: value.spec,
                    });
                })
              }
            >
              {t("experimental.continueAI")}
            </button>
          </div>
        </section>
      )}
      {project && point && (
        <ExperimentalProjectFiles
          key={`${project.id}:${project.revision}:${point.id}`}
          api={api}
          native={native}
          source={{
            id,
            expectedRevision: project.revision,
            checkpointId: point.id,
          }}
          onIndexed={setIndexEditable}
        />
      )}
      {error && (
        <p className="experimental-error" role="alert">
          {error}
        </p>
      )}
      <ExperimentalVersion version="0.6" />
    </div>
  );
}
