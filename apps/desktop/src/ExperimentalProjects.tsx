/** The library owns project selection; a workspace owns documents and drafts.
 * Navigation retires display callbacks, never admitted host transactions.
 * New projects begin with natural language through the shared saved AI preset;
 * they become durable projects only after a source receipt is recorded. */
import { useEffect, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Files,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { CeSelect } from "./CeSelect";
import { InstanceOperationDialog } from "./instanceOperationUi";
import { t, formatDate, serviceError } from "./i18n";
import type { Api } from "./types";
import {
  experimentalCall as call,
  type EngineStatus,
  type JobView,
} from "./experimentalTypes";
import type {
  MakerProject,
  ProjectSourceSelection,
} from "./experimentalProjectTypes";
import { ExperimentalProjectCompare } from "./ExperimentalProjectCompare";
import { ExperimentalVersion } from "./ExperimentalVersion";
import { MakerFeatures, makerKindLabel } from "./MakerFeatures";
import { MakerSource } from "./MakerSource";
import { MakerJob } from "./MakerJob";
import { MakerAiPanel } from "./MakerAiPanel";
import {
  createProjectManagerDraft,
  makerKinds,
  makerRouteKey,
  makerAiPrompt,
  type MakerDraft,
  type MakerRoute,
  type MakerUnit,
} from "./makerWorkspaceState";
import { useMakerScope } from "./useMakerScope";
import "./experimental.css";
import "./maker-workspace.css";
export { createProjectManagerDraft } from "./makerWorkspaceState";
export function ExperimentalProjects({
  api,
  native,
  draft: retained,
  onConfigureAi,
}: {
  api: Api;
  native: boolean;
  draft: RefObject<MakerDraft>;
  onConfigureAi?: () => void;
  onOpen?: (source: ProjectSourceSelection) => void;
}) {
  const draft = retained.current;
  const [screen, setScreen] = useState(draft.screen),
    [route, setRoute] = useState(draft.route),
    [tabs, setTabs] = useState(draft.tabs);
  const [projects, setProjects] = useState<MakerProject[]>([]),
    [status, setStatus] = useState<EngineStatus | null>(null);
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [showArchived, setShowArchived] = useState(false);
  const [aiOpen, setAiOpen] = useState(
      draft.aiOpen &&
        (typeof window === "undefined" || window.innerWidth >= 950),
    ),
    [treeOpen, setTreeOpen] = useState(draft.treeOpen),
    [featuresOpen, setFeaturesOpen] = useState(true);
  const [newName, setNewName] = useState(draft.newName),
    [newGoal, setNewGoal] = useState(draft.newGoal);
  const [prompt, setPrompt] = useState(
      draft.prompts.get(route.projectId) ?? "",
    ),
    [unitContext, setUnitContext] = useState<MakerUnit>(),
    [fileContext, setFileContext] = useState<string>();
  const [notes, setNotes] = useState({ name: "", notes: "", revision: "" });
  const [selectedVersion, setSelectedVersion] = useState(
    draft.selectedVersions.get(route.projectId) ?? "",
  );
  const [registerJobId, setRegisterJobId] = useState(""),
    [registerJob, setRegisterJob] = useState<JobView | null>(null),
    [registerOp, setRegisterOp] = useState("");
  const [record, setRecord] = useState<{
      projectId: string;
      jobId: string;
      operationId: string;
    } | null>(null),
    [label, setLabel] = useState("");
  const scope = useMakerScope(api, native, "maker-workspace");
  const project = projects.find((value) => value.id === route.projectId),
    pending = draft.pending.find((value) => value.id === route.projectId);
  const point =
    project?.checkpoints.find((value) => value.id === selectedVersion) ??
    project?.checkpoints.at(-1);
  const name = project?.name ?? pending?.name ?? t("maker.newProject");
  const selectedPreset = status?.aiPresets.presets.find(
    (value) => value.id === status.aiPresets.selectedId,
  );
  const active =
    status?.jobs.filter((value) => ["queued", "running"].includes(value.status))
      .length ?? 0;
  useEffect(() => {
    Object.assign(draft, {
      screen,
      route,
      tabs,
      aiOpen,
      treeOpen,
      newName,
      newGoal,
    });
  }, [screen, route, tabs, aiOpen, treeOpen, newName, newGoal]);
  async function refresh(current = scope.readTicket("library")) {
    const [list, engine] = await Promise.all([
      call<{ projects: MakerProject[] }>(api, "projects_list"),
      call<EngineStatus>(api, "status"),
    ]);
    if (!current()) return;
    setProjects(list.projects);
    setStatus(engine);
  }
  useEffect(() => {
    const current = scope.readTicket("library");
    if (native)
      void refresh(current).catch((error) => {
        if (current()) scope.setError(serviceError(error));
      });
  }, [scope.scope]);
  useEffect(() => {
    setPrompt(draft.prompts.get(route.projectId) ?? "");
    setUnitContext(undefined);
    setFileContext(undefined);
    setSelectedVersion(draft.selectedVersions.get(route.projectId) ?? "");
  }, [route.projectId]);
  useEffect(() => {
    if (project)
      setNotes(
        draft.notes.get(project.id) ?? {
          name: project.name,
          notes: project.notes,
          revision: project.revision,
        },
      );
  }, [project?.id, project?.revision]);
  function navigate(next: MakerRoute) {
    scope.change(() => {
      setScreen("workspace");
      setRoute(next);
      setUnitContext(undefined);
      setFileContext(undefined);
      const open = [
        ...draft.tabs.filter(
          (value) => makerRouteKey(value) !== makerRouteKey(next),
        ),
        next,
      ].slice(-12);
      draft.tabs = open;
      draft.route = next;
      draft.screen = "workspace";
      setTabs(open);
    });
  }
  function goLibrary() {
    scope.change(() => {
      setScreen("library");
      draft.screen = "library";
      setRecord(null);
    });
  }
  function startPage(next: "create" | "register") {
    scope.change(() => {
      setScreen(next);
      draft.screen = next;
      setRegisterJob(null);
      setRegisterJobId("");
      setRegisterOp("");
    });
  }
  function setCreation(field: "name" | "goal", value: string) {
    scope.change(() => {
      if (field === "name") {
        setNewName(value);
        draft.newName = value;
      } else {
        setNewGoal(value);
        draft.newGoal = value;
      }
    });
  }
  const jobIds = [
    ...new Set([
      ...(project?.checkpoints.map((value) => value.jobId) ?? []),
      ...(draft.activeJobs.get(route.projectId) ?? []),
      ...(pending ? [pending.jobId] : []),
    ]),
  ];
  const jobId = route.jobId ?? jobIds.at(-1) ?? "";
  function tabLabel(value: MakerRoute) {
    if (value.section === "units")
      return value.kind ? makerKindLabel(value.kind) : t("maker.features");
    if (value.section === "unit")
      return (
        draft.titles.get(makerRouteKey(value)) ||
        (value.unitId === "new"
          ? t("maker.newFeature")
          : draft.units.get(
              `${value.projectId}:${value.unitId}:${value.kind ?? "other"}`,
            )?.unit.name || t("maker.featureDocument"))
      );
    return t(`maker.section.${value.section}`);
  }
  async function create() {
    const request = `Create a Minecraft mod project named ${newName.trim()}. Current supported target: Fabric 1.21.1.\n\nRequirements:\n${newGoal}\n\nUse the shared Maker tools. Explain unsupported APIs and split complex work into incremental changes. Preserve handwritten source. Source generation, compilation and game verification must be reported separately.`;
    const result = await call<{ jobId: string }>(api, "job_create", {
      profile: "maker",
      mode: "live",
      prompt: request,
    });
    if (!scope.responseCurrent()) return;
    if (!result.jobId) throw new Error(t("maker.responseMismatch"));
    const value = {
      id: `pending:${result.jobId}`,
      name: newName.trim(),
      notes: newGoal,
      jobId: result.jobId,
    };
    draft.pending.push(value);
    draft.newName = "";
    draft.newGoal = "";
    setNewName("");
    setNewGoal("");
    navigate({ projectId: value.id, section: "tasks", jobId: value.jobId });
  }
  async function send() {
    if (
      !project ||
      !point ||
      project.archived ||
      point.workflow !== "maker" ||
      route.operationId
    )
      return;
    const result = await call<{ jobId: string }>(api, "project_continue", {
      id: project.id,
      expectedRevision: project.revision,
      checkpointId: point.id,
      prompt: makerAiPrompt(project, prompt, unitContext, fileContext),
    });
    if (!scope.responseCurrent()) return;
    if (!result.jobId) throw new Error(t("maker.responseMismatch"));
    draft.activeJobs.set(
      project.id,
      [...(draft.activeJobs.get(project.id) ?? []), result.jobId].slice(-64),
    );
    setPrompt("");
    draft.prompts.set(project.id, "");
    navigate({ projectId: project.id, section: "tasks", jobId: result.jobId });
  }
  function openRecord(
    operationId: string,
    sourceJob = jobId,
    projectId = route.projectId,
  ) {
    scope.change(() => {
      setRecord({ projectId, jobId: sourceJob, operationId });
      setLabel("");
    });
  }
  async function recordSource() {
    if (!record) return;
    const owner = projects.find((value) => value.id === record.projectId),
      pendingOwner = draft.pending.find(
        (value) => value.id === record.projectId,
      );
    const saved = await call<MakerProject>(
      api,
      owner ? "project_update" : "project_create",
      owner
        ? {
            id: owner.id,
            expectedRevision: owner.revision,
            name: owner.name,
            notes: owner.notes,
            archived: owner.archived,
            source: {
              jobId: record.jobId,
              operationId: record.operationId,
              label,
            },
          }
        : {
            name: pendingOwner?.name ?? newName.trim(),
            notes: pendingOwner?.notes ?? newGoal,
            jobId: record.jobId,
            operationId: record.operationId,
            label,
          },
    );
    if (!scope.responseCurrent()) return;
    if (!saved.id || (owner && saved.id !== owner.id))
      throw new Error(t("maker.responseMismatch"));
    setProjects((old) => [
      ...old.filter((value) => value.id !== saved.id),
      saved,
    ]);
    if (pendingOwner) {
      draft.pending = draft.pending.filter(
        (value) => value.id !== pendingOwner.id,
      );
      draft.tabs = draft.tabs.filter(
        (value) => value.projectId !== pendingOwner.id,
      );
    }
    draft.selectedVersions.set(saved.id, saved.checkpoints.at(-1)!.id);
    setSelectedVersion(saved.checkpoints.at(-1)!.id);
    setRecord(null);
    navigate({ projectId: saved.id, section: "overview" });
  }
  async function saveProject(archived = project?.archived) {
    if (!project) return;
    const saved = await call<MakerProject>(api, "project_update", {
      id: project.id,
      expectedRevision: notes.revision,
      name: notes.name,
      notes: notes.notes,
      archived,
    });
    if (!scope.responseCurrent()) return;
    if (saved.id !== project.id) throw new Error(t("maker.responseMismatch"));
    draft.notes.delete(saved.id);
    setProjects((old) =>
      old.map((value) => (value.id === saved.id ? saved : value)),
    );
    setNotes({
      name: saved.name,
      notes: saved.notes,
      revision: saved.revision,
    });
  }
  function editNotes(field: "name" | "notes", value: string) {
    scope.change(() => {
      const next = { ...notes, [field]: value };
      setNotes(next);
      draft.notes.set(route.projectId, next);
    });
  }
  function chooseVersion(id: string) {
    scope.change(() => {
      setSelectedVersion(id);
      draft.selectedVersions.set(route.projectId, id);
    });
  }
  const disabled = !native || scope.busy;
  const filtered = projects.filter(
    (value) =>
      (showArchived || !value.archived) &&
      value.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const visibleTabs = tabs.filter(
    (value) => value.projectId === route.projectId,
  );
  const sections = [
    "overview",
    "source",
    "history",
    "tasks",
    "settings",
  ] as const;
  return (
    <section
      className={`maker-studio ${screen === "workspace" ? "in-workspace" : ""}`}
    >
      {screen === "library" ? (
        <div className="maker-library">
          <header className="maker-library-heading">
            <div>
              <small>{t("maker.libraryEyebrow")}</small>
              <h1>{t("experimental.maker")}</h1>
              <p>{t("maker.libraryIntro")}</p>
            </div>
            <button
              className="ce-button primary"
              disabled={disabled}
              onClick={() => startPage("create")}
            >
              <Plus size={16} />
              {t("maker.newProject")}
            </button>
          </header>
          <div className="maker-library-toolbar">
            <div>
              <Search size={16} />
              <input
                className="ce-field"
                aria-label={t("maker.searchProjects")}
                placeholder={t("maker.searchProjects")}
                value={query}
                maxLength={120}
                onChange={(event) =>
                  scope.change(() => {
                    setQuery(event.target.value);
                    setPage(0);
                  })
                }
              />
            </div>
            <label>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) =>
                  scope.change(() => {
                    setShowArchived(event.target.checked);
                    setPage(0);
                  })
                }
              />
              {t("experimental.showArchived")}
            </label>
            <button
              className="ce-button"
              disabled={disabled}
              onClick={() => void scope.perform(() => refresh())}
            >
              {t("maker.refresh")}
            </button>
          </div>
          {!!draft.pending.length && (
            <div className="maker-pending-projects">
              {draft.pending.map((value) => (
                <button
                  key={value.id}
                  className="maker-project-tile pending"
                  onClick={() =>
                    navigate({
                      projectId: value.id,
                      section: "tasks",
                      jobId: value.jobId,
                    })
                  }
                >
                  <Sparkles size={20} />
                  <strong>{value.name}</strong>
                  <small>{t("maker.projectGenerating")}</small>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          )}
          <div className="maker-project-grid">
            {filtered.slice(page * 24, page * 24 + 24).map((value) => (
              <button
                key={value.id}
                className="maker-project-tile ce-card"
                onClick={() =>
                  navigate({ projectId: value.id, section: "overview" })
                }
              >
                <span className="maker-project-mark">
                  <Files size={24} />
                </span>
                <strong>{value.name}</strong>
                <small>
                  {t("maker.versionCount", { count: value.checkpoints.length })}{" "}
                  · {formatDate(value.updatedAt)}
                </small>
                <span className="maker-project-tile-footer">
                  {value.archived
                    ? t("experimental.archived")
                    : t("maker.openWorkspace")}
                  <ChevronRight size={16} />
                </span>
              </button>
            ))}
          </div>
          {!filtered.length && !draft.pending.length && (
            <div className="maker-library-empty">
              <Files size={36} />
              <h2>{t("maker.libraryEmpty")}</h2>
              <p>{t("maker.libraryEmptyHelp")}</p>
            </div>
          )}
          <footer className="maker-library-bottom">
            <button
              className="ce-button"
              disabled={disabled}
              onClick={() => startPage("register")}
            >
              <FolderOpen size={15} />
              {t("maker.registerExisting")}
            </button>
            <div className="maker-pagination">
              <button
                className="ce-button"
                disabled={page === 0}
                onClick={() => scope.change(() => setPage(page - 1))}
              >
                {t("experimental.previousPage")}
              </button>
              <span>{page + 1}</span>
              <button
                className="ce-button"
                disabled={(page + 1) * 24 >= filtered.length}
                onClick={() => scope.change(() => setPage(page + 1))}
              >
                {t("experimental.nextPage")}
              </button>
            </div>
          </footer>
        </div>
      ) : screen === "create" || screen === "register" ? (
        <div className="maker-creation-page">
          <button className="ce-button" onClick={goLibrary}>
            <ArrowLeft size={15} />
            {t("maker.allProjects")}
          </button>
          <div className="maker-creation-heading">
            <Sparkles size={28} />
            <h1>
              {t(
                screen === "create"
                  ? "maker.newProject"
                  : "maker.registerExisting",
              )}
            </h1>
            <p>
              {t(
                screen === "create"
                  ? "maker.creationIntro"
                  : "maker.registrationIntro",
              )}
            </p>
          </div>
          <label>
            <span>{t("experimental.projectName")}</span>
            <input
              className="ce-field"
              maxLength={120}
              value={newName}
              onChange={(event) => setCreation("name", event.target.value)}
            />
          </label>
          <label>
            <span>{t("maker.projectGoal")}</span>
            <textarea
              className="ce-field"
              rows={9}
              maxLength={6000}
              value={newGoal}
              placeholder={t("maker.projectGoalPlaceholder")}
              onChange={(event) => setCreation("goal", event.target.value)}
            />
          </label>
          {screen === "create" ? (
            <>
              <p className="experimental-origin">{t("maker.currentTarget")}</p>
              <div className="maker-creation-actions">
                {onConfigureAi && (
                  <button
                    className="ce-button"
                    onClick={() => {
                      if (scope.callbackCurrent()) onConfigureAi();
                    }}
                  >
                    {t("experimental.configureAi")}
                  </button>
                )}
                <button
                  className="ce-button primary"
                  disabled={
                    disabled ||
                    !selectedPreset ||
                    !newName.trim() ||
                    !newGoal.trim() ||
                    active >= 2
                  }
                  onClick={() => void scope.perform(create)}
                >
                  <Sparkles size={16} />
                  {t("maker.createWithAi")}
                </button>
              </div>
              {!selectedPreset && (
                <p className="experimental-origin">{t("maker.choosePreset")}</p>
              )}
            </>
          ) : (
            <>
              <label>
                <span>{t("maker.sourceTask")}</span>
                <CeSelect
                  value={registerJobId}
                  disabled={disabled}
                  onChange={(event) => {
                    const id = event.target.value;
                    scope.change(() => {
                      setRegisterJobId(id);
                      setRegisterJob(null);
                      setRegisterOp("");
                    });
                    if (id) {
                      const current = scope.readTicket("register");
                      void call<JobView>(api, "job_read", { jobId: id })
                        .then((value) => {
                          if (current()) {
                            if (value.summary.jobId !== id)
                              throw new Error(t("maker.responseMismatch"));
                            setRegisterJob(value);
                          }
                        })
                        .catch((error) => {
                          if (current()) scope.setError(serviceError(error));
                        });
                    }
                  }}
                >
                  <option value="">{t("maker.selectTask")}</option>
                  {status?.jobs
                    .filter((value) => value.status === "completed")
                    .map((value) => (
                      <option key={value.jobId} value={value.jobId}>
                        {value.workflow} · {value.jobId}
                      </option>
                    ))}
                </CeSelect>
              </label>
              <label>
                <span>{t("maker.sourceOutput")}</span>
                <CeSelect
                  value={registerOp}
                  disabled={disabled}
                  onChange={(event) =>
                    scope.change(() => setRegisterOp(event.target.value))
                  }
                >
                  <option value="">{t("maker.selectSource")}</option>
                  {registerJob?.artifacts.map((value) => (
                    <option key={value.operationId} value={value.operationId}>
                      {value.operationId}
                    </option>
                  ))}
                </CeSelect>
              </label>
              <button
                className="ce-button primary"
                disabled={disabled || !newName.trim() || !registerOp}
                onClick={() => openRecord(registerOp, registerJobId, "")}
              >
                {t("maker.registerProject")}
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <header className="maker-workspace-header">
            <div className="maker-breadcrumb">
              <button
                className="maker-icon-button"
                aria-label={t("maker.toggleTree")}
                onClick={() => scope.change(() => setTreeOpen(!treeOpen))}
              >
                <PanelLeft size={17} />
              </button>
              <button onClick={goLibrary}>{t("maker.allProjects")}</button>
              <ChevronRight size={14} />
              <strong>{name}</strong>
              <ChevronRight size={14} />
              <span>{unitContext?.name || tabLabel(route)}</span>
            </div>
            <button
              className="ce-button"
              onClick={() => scope.change(() => setAiOpen(!aiOpen))}
            >
              <Sparkles size={15} />
              AI
            </button>
          </header>
          <div
            className={`maker-workbench ${treeOpen ? "with-tree" : ""} ${aiOpen ? "with-ai" : ""}`}
          >
            {treeOpen && (
              <nav
                className="maker-project-tree"
                aria-label={t("maker.projectNavigation")}
              >
                <div className="maker-tree-project">
                  <FolderOpen size={16} />
                  <strong>{name}</strong>
                </div>
                <button
                  className={route.section === "overview" ? "selected" : ""}
                  onClick={() =>
                    navigate({
                      projectId: route.projectId,
                      section: "overview",
                    })
                  }
                >
                  <LayoutDashboard size={15} />
                  {t("maker.section.overview")}
                </button>
                <button
                  className="maker-tree-group"
                  disabled={!project}
                  onClick={() =>
                    scope.change(() => setFeaturesOpen(!featuresOpen))
                  }
                >
                  {featuresOpen ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                  <Files size={15} />
                  {t("maker.features")}
                </button>
                {featuresOpen && project && (
                  <div className="maker-tree-children">
                    {makerKinds.map((kind) => (
                      <button
                        key={kind}
                        className={
                          route.kind === kind &&
                          ["units", "unit"].includes(route.section)
                            ? "selected"
                            : ""
                        }
                        onClick={() =>
                          navigate({
                            projectId: project.id,
                            section: "units",
                            kind,
                          })
                        }
                      >
                        {makerKindLabel(kind)}
                      </button>
                    ))}
                  </div>
                )}
                {sections
                  .filter((section) => section !== "overview")
                  .map((section) => (
                    <button
                      key={section}
                      disabled={!project && section !== "tasks"}
                      className={route.section === section ? "selected" : ""}
                      onClick={() =>
                        navigate({ projectId: route.projectId, section })
                      }
                    >
                      {section === "history" ? (
                        <GitBranch size={15} />
                      ) : section === "tasks" ? (
                        <Sparkles size={15} />
                      ) : section === "settings" ? (
                        <Settings2 size={15} />
                      ) : (
                        <Files size={15} />
                      )}
                      {t(`maker.section.${section}`)}
                    </button>
                  ))}
                <div className="maker-tree-bottom">
                  {point?.label ?? t("maker.sourcePending")}
                </div>
              </nav>
            )}
            <main className="maker-editor-area">
              <div
                className="maker-document-tabs"
                role="tablist"
                aria-label={t("maker.openDocuments")}
              >
                {visibleTabs.map((value) => (
                  <div
                    key={makerRouteKey(value)}
                    className={
                      makerRouteKey(value) === makerRouteKey(route)
                        ? "selected"
                        : ""
                    }
                  >
                    <button
                      role="tab"
                      aria-selected={
                        makerRouteKey(value) === makerRouteKey(route)
                      }
                      onClick={() => navigate(value)}
                    >
                      {tabLabel(value)}
                    </button>
                    <button
                      className="maker-tab-close"
                      aria-label={t("maker.closeDocument")}
                      onClick={() =>
                        scope.change(() => {
                          const remaining = draft.tabs.filter(
                            (tab) =>
                              makerRouteKey(tab) !== makerRouteKey(value),
                          );
                          draft.tabs = remaining;
                          setTabs(remaining);
                          if (makerRouteKey(value) === makerRouteKey(route)) {
                            const next = remaining
                              .filter(
                                (tab) => tab.projectId === route.projectId,
                              )
                              .at(-1) ?? {
                              projectId: route.projectId,
                              section: "overview" as const,
                            };
                            setRoute(next);
                            draft.route = next;
                            setUnitContext(undefined);
                            setFileContext(undefined);
                          }
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {project || pending ? (
                <div className="maker-document-view">
                  {route.section === "overview" && (
                    <div className="maker-document maker-project-overview">
                      <small>{t("maker.workspaceEyebrow")}</small>
                      <h1>{name}</h1>
                      <p>
                        {project?.notes ||
                          pending?.notes ||
                          t("maker.projectGoalPlaceholder")}
                      </p>
                      <div className="maker-verification">
                        <span>
                          {project
                            ? t("maker.sourceRecorded")
                            : t("maker.sourcePending")}
                        </span>
                        <span>{t("maker.buildNotRun")}</span>
                        <span>{t("maker.gameNotRun")}</span>
                      </div>
                      <div className="maker-overview-links">
                        {(["units", "source", "history", "tasks"] as const).map(
                          (section) => (
                            <button
                              key={section}
                              className="ce-card"
                              disabled={!project && section !== "tasks"}
                              onClick={() =>
                                navigate({
                                  projectId: route.projectId,
                                  section,
                                })
                              }
                            >
                              <span>
                                {section === "units"
                                  ? t("maker.features")
                                  : t(`maker.section.${section}`)}
                              </span>
                              <small>{t(`maker.overview.${section}`)}</small>
                              <ChevronRight size={16} />
                            </button>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                  {project && ["units", "unit"].includes(route.section) && (
                    <MakerFeatures
                      key={`${project.id}:${route.kind ?? "all"}:${route.unitId ?? "list"}`}
                      api={api}
                      native={native}
                      project={project}
                      route={route}
                      draft={draft}
                      onRoute={navigate}
                      onContext={(value) => {
                        if (scope.responseCurrent()) {
                          if (value?.name)
                            draft.titles.set(makerRouteKey(route), value.name);
                          setUnitContext(value);
                        }
                      }}
                    />
                  )}
                  {route.section === "source" &&
                    ((route.operationId && route.jobId) || point) && (
                      <MakerSource
                        key={`${project?.revision}:${point?.id}:${route.jobId ?? ""}:${route.operationId ?? ""}`}
                        api={api}
                        native={native}
                        project={route.operationId ? undefined : project}
                        point={route.operationId ? undefined : point}
                        source={
                          route.operationId && route.jobId
                            ? {
                                jobId: route.jobId,
                                operationId: route.operationId,
                              }
                            : point!
                        }
                        draft={draft}
                        readOnly={
                          !!project?.archived ||
                          (!route.operationId && point?.workflow === "porter")
                        }
                        onContext={(value) => {
                          if (scope.responseCurrent()) setFileContext(value);
                        }}
                      />
                    )}
                  {project && route.section === "history" && (
                    <div className="maker-document">
                      <div className="maker-document-heading">
                        <h2>{t("maker.section.history")}</h2>
                      </div>
                      <p>{t("maker.historyHelp")}</p>
                      <CeSelect
                        value={point?.id ?? ""}
                        disabled={disabled}
                        onChange={(event) => chooseVersion(event.target.value)}
                      >
                        {project.checkpoints.map((value) => (
                          <option key={value.id} value={value.id}>
                            {value.label}
                          </option>
                        ))}
                      </CeSelect>
                      <div className="maker-version-list">
                        {project.checkpoints.map((value) => (
                          <button
                            className={`maker-feature-row ${value.id === point?.id ? "selected" : ""}`}
                            key={value.id}
                            onClick={() => {
                              if (!scope.callbackCurrent()) return;
                              draft.selectedVersions.set(project.id, value.id);
                              setSelectedVersion(value.id);
                              navigate({
                                projectId: project.id,
                                section: "source",
                              });
                            }}
                          >
                            <GitBranch size={16} />
                            <span>
                              <strong>{value.label}</strong>
                              <small>
                                {formatDate(value.createdAt)} · {value.workflow}
                              </small>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                      </div>
                      {point && project.checkpoints.length > 1 && (
                        <ExperimentalProjectCompare
                          key={`${project.id}:${project.revision}:${point.id}`}
                          api={api}
                          native={native}
                          project={project}
                          checkpointId={point.id}
                        />
                      )}
                    </div>
                  )}
                  {route.section === "tasks" && (
                    <>
                      <div className="maker-task-selector">
                        <CeSelect
                          value={jobId}
                          onChange={(event) =>
                            navigate({
                              projectId: route.projectId,
                              section: "tasks",
                              jobId: event.target.value,
                            })
                          }
                          disabled={!native}
                        >
                          <option value="">{t("maker.selectTask")}</option>
                          {jobIds.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </CeSelect>
                      </div>
                      {jobId ? (
                        <MakerJob
                          key={jobId}
                          api={api}
                          native={native}
                          jobId={jobId}
                          readOnly={
                            !!project?.archived ||
                            project?.checkpoints.some(
                              (value) =>
                                value.jobId === jobId &&
                                value.workflow === "porter",
                            )
                          }
                          onSource={(op) =>
                            navigate({
                              projectId: route.projectId,
                              section: "source",
                              jobId,
                              operationId: op,
                            })
                          }
                          onRecord={
                            project?.archived
                              ? undefined
                              : (op) => openRecord(op)
                          }
                        />
                      ) : (
                        <div className="maker-empty">{t("maker.noTasks")}</div>
                      )}
                    </>
                  )}
                  {project && route.section === "settings" && (
                    <div className="maker-document maker-project-settings">
                      <div className="maker-document-heading">
                        <h2>{t("maker.section.settings")}</h2>
                        <button
                          className="ce-button primary"
                          disabled={disabled || !notes.name.trim()}
                          onClick={() =>
                            void scope.perform(() => saveProject())
                          }
                        >
                          {t("maker.saveProject")}
                        </button>
                      </div>
                      {notes.revision !== project.revision && (
                        <button
                          className="ce-button"
                          disabled={disabled}
                          onClick={() =>
                            scope.change(() => {
                              const next = {
                                ...notes,
                                revision: project.revision,
                              };
                              setNotes(next);
                              draft.notes.set(project.id, next);
                            })
                          }
                        >
                          {t("maker.acceptProjectRevision")}
                        </button>
                      )}
                      <label>
                        <span>{t("experimental.projectName")}</span>
                        <input
                          className="ce-field"
                          value={notes.name}
                          maxLength={120}
                          onChange={(event) =>
                            editNotes("name", event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>{t("maker.projectGoal")}</span>
                        <textarea
                          className="ce-field maker-notes"
                          rows={12}
                          value={notes.notes}
                          maxLength={6000}
                          onChange={(event) =>
                            editNotes("notes", event.target.value)
                          }
                        />
                      </label>
                      <button
                        className="ce-button"
                        disabled={disabled}
                        onClick={() =>
                          void scope.perform(() =>
                            saveProject(!project.archived),
                          )
                        }
                      >
                        {t(
                          project.archived
                            ? "experimental.unarchiveProject"
                            : "experimental.archiveProject",
                        )}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="maker-empty">{t("maker.projectMissing")}</div>
              )}
            </main>
            {aiOpen && (
              <MakerAiPanel
                name={name}
                version={point?.label}
                blockedReason={
                  route.operationId ? t("maker.recordBeforeAi") : undefined
                }
                unit={unitContext}
                file={fileContext}
                prompt={prompt}
                status={status}
                latestJob={draft.activeJobs.get(route.projectId)?.at(-1)}
                disabled={
                  disabled ||
                  !project ||
                  !!project.archived ||
                  !selectedPreset ||
                  point?.workflow !== "maker" ||
                  !!route.operationId ||
                  active >= 2
                }
                onPrompt={(value) =>
                  scope.change(() => {
                    setPrompt(value);
                    draft.prompts.set(route.projectId, value);
                  })
                }
                onSend={() => void scope.perform(send)}
                onClose={() => scope.change(() => setAiOpen(false))}
                onConfigure={
                  onConfigureAi
                    ? () => {
                        if (scope.callbackCurrent()) onConfigureAi();
                      }
                    : undefined
                }
              />
            )}
          </div>
        </>
      )}
      {scope.error && (
        <p className="experimental-error maker-global-error" role="alert">
          {scope.error}
        </p>
      )}
      <ExperimentalVersion version="1.0-preview" />
      {record && (
        <InstanceOperationDialog
          title={t("maker.recordSource")}
          titleId="maker-record-source"
          busy={scope.busy}
          committing={scope.busy}
          confirmLabel={t("experimental.recordVersion")}
          confirmDisabled={disabled || !label.trim()}
          onClose={() => scope.change(() => setRecord(null))}
          onConfirm={() => void scope.perform(recordSource)}
        >
          <p>{t("maker.recordSourceHelp")}</p>
          <p className="experimental-origin">{record.operationId}</p>
          <label>
            <span>{t("experimental.versionLabel")}</span>
            <input
              className="ce-field"
              maxLength={120}
              value={label}
              disabled={disabled}
              onChange={(event) =>
                scope.change(() => setLabel(event.target.value))
              }
            />
          </label>
        </InstanceOperationDialog>
      )}
    </section>
  );
}
