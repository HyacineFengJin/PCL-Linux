import { useEffect, useRef, useState, type RefObject } from "react";
import { CeSelect } from "./CeSelect";
import { t, formatDate, serviceError, type MessageKey } from "./i18n";
import type { Api } from "./types";
import { InstanceOperationDialog } from "./instanceOperationUi";
import { ExperimentalExtensions } from "./ExperimentalExtensions";
import { ExperimentalMaker, initialMakerSpec } from "./ExperimentalMaker";
import { ExperimentalPorterWorkspace } from "./ExperimentalPorterWorkspace";
import type { ImportedSource } from "./experimentalPorterTypes";
import {
  experimentalCall as call,
  type ExperimentalNavigate,
  type ExperimentalPage,
  type EngineStatus,
  type JobView,
  type Artifact,
  type ReviewView,
} from "./experimentalTypes";
import type { ProjectSourceSelection } from "./experimentalProjectTypes";
import "./experimental.css";
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type SourceFile = {
  path: string;
  sha256: string;
  content: string | null;
  binary: boolean;
};

// Drafts stay in the owning app session while users visit AI configuration.
// Credentials are never part of this record; submitted jobs remain host-owned.
export type ExperimentalDraft = {
  spec: typeof initialMakerSpec;
  source: ImportedSource | null;
  directory: string;
  targetId: string;
  rights: string;
  beta: boolean;
  identifierDeclared?: boolean;
  allowed: string[];
  mode: string;
  prompt: string;
  jobId: string;
  porterProjectId?: string;
  porterName?: string;
  porterGoal?: string;
  porterOriginUrl?: string;
  porterNew?: boolean;
};

type ExperimentalToolsProps = {
  api: Api;
  native: boolean;
  page: ExperimentalPage;
  drafts: RefObject<Partial<Record<ExperimentalPage, ExperimentalDraft>>>;
  initialSource?: ProjectSourceSelection;
  onConfigureAi?: () => void;
  onNavigate: ExperimentalNavigate;
  onPorterBrowseMods?: (
    origin?: import("./experimentalPorterTypes").PorterOrigin | null,
  ) => void;
  porterIntake?: import("./experimentalPorterTypes").PorterIntake | null;
  onPorterIntakeConsumed?: () => void;
};
export function ExperimentalTools(props: ExperimentalToolsProps) {
  // Recorded Porter copies keep their read-only viewer; managed migration
  // projects own fresh rounds and reviews in the dedicated workspace.
  if (props.page === "porter" && !props.initialSource)
    return (
      <ExperimentalPorterWorkspace
        api={props.api}
        native={props.native}
        drafts={props.drafts}
        onConfigureAi={props.onConfigureAi}
        onBrowseMods={props.onPorterBrowseMods}
        intake={props.porterIntake}
        onIntakeConsumed={props.onPorterIntakeConsumed}
      />
    );
  return <ExperimentalCommonTools {...props} />;
}

/** UI owns only drafts and display selections. Jobs, path grants, file hashes
 * and one-use approvals remain in the native host and the supplied runtime. */
function ExperimentalCommonTools({
  api,
  native,
  page,
  drafts,
  initialSource,
  onNavigate,
  onConfigureAi,
}: {
  api: Api;
  native: boolean;
  page: ExperimentalPage;
  drafts: RefObject<Partial<Record<ExperimentalPage, ExperimentalDraft>>>;
  initialSource?: ProjectSourceSelection;
  onConfigureAi?: () => void;
  onNavigate: ExperimentalNavigate;
}) {
  const draft = drafts.current[page];
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState(draft?.mode ?? "template"),
    [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [spec, setSpec] = useState(
    initialSource?.spec ?? draft?.spec ?? initialMakerSpec,
  );
  const [jobId, setJobId] = useState(
      initialSource?.jobId ?? draft?.jobId ?? "",
    ),
    [job, setJob] = useState<JobView | null>(null);
  const [operationId, setOperationId] = useState(""),
    [path, setPath] = useState(""),
    [file, setFile] = useState<SourceFile | null>(null),
    [text, setText] = useState(""),
    [checkpoint, setCheckpoint] = useState("");
  const [review, setReview] = useState<
    (ReviewView & { ownerJob: string }) | null
  >(null);
  const live = useRef(true),
    working = useRef(false);
  useEffect(() => {
    drafts.current[page] = {
      spec,
      source: null,
      directory: "",
      targetId: "",
      rights: "unknown",
      beta: false,
      allowed: [],
      mode,
      prompt,
      jobId,
    };
  }, [drafts, page, spec, mode, prompt, jobId]);
  async function refresh() {
    const value = await call<EngineStatus>(api, "status");
    if (live.current) setStatus(value);
  }
  useEffect(() => {
    live.current = true;
    let valid = true,
      polling = false;
    async function poll() {
      if (!native || polling || !valid) return;
      polling = true;
      try {
        const value = await call<EngineStatus>(api, "status");
        if (valid) setStatus(value);
      } catch (e) {
        if (valid) setError(serviceError(e));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      valid = false;
      live.current = false;
      window.clearInterval(timer);
    };
  }, [api, native]);
  useEffect(() => {
    let valid = true,
      polling = false;
    setJob(null);
    setOperationId(
      initialSource?.jobId === jobId ? initialSource.operationId : "",
    );
    setPath("");
    setFile(null);
    setText("");
    setCheckpoint("");
    async function poll() {
      if (!jobId || !native || !valid || polling) return;
      polling = true;
      try {
        const value = await call<JobView>(api, "job_read", { jobId });
        if (valid) {
          setJob(value);
          setOperationId(
            (old) => old || value.artifacts.at(-1)?.operationId || "",
          );
        }
      } catch (e) {
        if (valid) setError(serviceError(e));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1600);
    return () => {
      valid = false;
      window.clearInterval(timer);
    };
  }, [api, native, jobId]);
  const artifact: Artifact | undefined = job?.artifacts.find(
    (a) => a.operationId === operationId,
  );
  useEffect(() => {
    setPath("");
    setFile(null);
    setText("");
    if (artifact)
      setPath(
        artifact.files.find((p) => p.endsWith(".java")) ||
          artifact.files[0] ||
          "",
      );
  }, [operationId, artifact?.operationId]);
  useEffect(() => {
    let valid = true;
    setFile(null);
    setText("");
    if (native && jobId && operationId && path)
      void call<SourceFile>(api, "artifact_read", { jobId, operationId, path })
        .then((v) => {
          if (valid) {
            setFile(v);
            setText(v.content || "");
          }
        })
        .catch((e) => {
          if (valid) setError(serviceError(e));
        });
    return () => {
      valid = false;
    };
  }, [api, native, jobId, operationId, path]);
  async function perform(action: () => Promise<unknown>) {
    if (!native || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (live.current) await refresh();
    } catch (e) {
      if (live.current) setError(serviceError(e));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function showReview(ownerJob: string, value: { reviewId: string }) {
    const data = await call<ReviewView>(api, "review_read", {
      jobId: ownerJob,
      reviewId: value.reviewId,
    });
    if (live.current) setReview({ ...data, ownerJob });
  }
  async function start() {
    if (page !== "maker") return;
    const value = await call<{ jobId: string }>(api, "job_create", {
      profile: page,
      mode,
      prompt,
      spec,
    });
    if (live.current) setJobId(value.jobId);
  }
  const active = !!job && ["queued", "running"].includes(job.summary.status),
    noCapacity =
      (status?.jobs.filter((j) => ["queued", "running"].includes(j.status))
        .length || 0) >= 2;
  // Porter review proposals target the original imported snapshot. A recorded
  // output opens for inspection only; do not imply a patch continues that copy.
  const viewingPorterVersion =
    page === "porter" && initialSource?.jobId === jobId;
  const canEdit = !busy && native && !active && !!file && !file.binary;
  const fileEditable =
    canEdit &&
    ((path.startsWith("src/main/java/") && path.endsWith(".java")) ||
      (path.startsWith("src/main/resources/") &&
        /\.(json|mcmeta|txt|lang)$/.test(path) &&
        path !== "src/main/resources/fabric.mod.json"));
  const modeUi = (
    <section className="ce-card">
      <label className="ce-row experimental-mode">
        <span>{t("experimental.mode")}</span>
        <CeSelect
          className="ce-field"
          value={mode}
          disabled={busy || !native}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="template">{t("experimental.template")}</option>
          <option value="live" disabled={!status?.liveAvailable}>
            {t("experimental.live")}
          </option>
        </CeSelect>
      </label>
      {mode === "live" && (
        <label className="ce-row">
          <span>{t("experimental.prompt")}</span>
          <textarea
            className="ce-field"
            rows={3}
            value={prompt}
            maxLength={12000}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
      )}
      <div className="ce-actions">
        <button
          className="ce-button"
          disabled={busy || !onConfigureAi}
          onClick={onConfigureAi}
        >
          {t("experimental.ai")}
        </button>
        <button
          className="ce-button primary"
          disabled={
            busy ||
            !native ||
            noCapacity ||
            (mode === "live" && (!status?.liveAvailable || !prompt.trim()))
          }
          onClick={() => void perform(start)}
        >
          {t(
            mode === "live"
              ? "experimental.startAI"
              : page === "maker"
                ? "experimental.generate"
                : "experimental.analyze",
          )}
        </button>
      </div>
    </section>
  );
  return (
    <div className="experimental-panel">
      {page === "extensions" && (
        <ExperimentalExtensions
          api={api}
          native={native}
          onNavigate={onNavigate}
        />
      )}
      {page === "maker" && (
        <>
          <ExperimentalMaker
            spec={spec}
            onChange={setSpec}
            disabled={busy || !native}
          />
          {modeUi}
        </>
      )}
      {error && (
        <p className="experimental-error" role="alert">
          {error}
        </p>
      )}
      {page === "maker" && (
        <>
          <section className="ce-card">
            <h2 className="ce-card-title">{t("experimental.jobs")}</h2>
            <div className="experimental-job-list">
              {status?.jobs
                .filter((j) => j.workflow === page)
                .map((j) => (
                  <button
                    className={`ce-button experimental-job ${j.jobId === jobId ? "primary" : ""}`}
                    disabled={busy}
                    key={j.jobId}
                    onClick={() => setJobId(j.jobId)}
                  >
                    <span>
                      {formatDate(j.updatedAt)} · {j.jobId.slice(0, 8)}
                    </span>
                    <span>
                      {t(`experimental.job.${j.status}` as MessageKey)}
                    </span>
                  </button>
                ))}
            </div>
            {!status?.jobs.some((j) => j.workflow === page) && (
              <p className="experimental-origin">{t("experimental.noJobs")}</p>
            )}
          </section>
          {job && (
            <section className="ce-card">
              <h2 className="ce-card-title">
                {t(`experimental.job.${job.summary.status}` as MessageKey)}
              </h2>
              {job.error && (
                <p className="experimental-error">{job.error.message}</p>
              )}
              {active && (
                <button
                  className="ce-button"
                  disabled={busy || !native}
                  onClick={() =>
                    void perform(() => call(api, "job_cancel", { jobId }))
                  }
                >
                  {t("experimental.cancelJob")}
                </button>
              )}
              {job.result != null && (
                <details>
                  <summary>{t("experimental.result")}</summary>
                  <pre className="experimental-output">
                    {pretty(job.result)}
                  </pre>
                </details>
              )}
              {!viewingPorterVersion &&
                job.reviews.map((id) => (
                  <button
                    className="ce-button"
                    key={id}
                    disabled={busy || active}
                    onClick={() =>
                      void perform(() => showReview(jobId, { reviewId: id }))
                    }
                  >
                    {t("experimental.review")} · {id.slice(0, 8)}
                  </button>
                ))}
            </section>
          )}
          {job?.artifacts.length ? (
            <section className="ce-card">
              <h2 className="ce-card-title">{t("experimental.sourceEdit")}</h2>
              <label className="ce-row">
                <span>{t("experimental.artifact")}</span>
                <CeSelect
                  className="ce-field"
                  value={operationId}
                  disabled={busy}
                  onChange={(e) => setOperationId(e.target.value)}
                >
                  {job.artifacts.map((a) => (
                    <option key={a.operationId} value={a.operationId}>
                      {a.directory}
                    </option>
                  ))}
                </CeSelect>
              </label>
              <label className="ce-row">
                <span>{t("experimental.file")}</span>
                <CeSelect
                  className="ce-field"
                  value={path}
                  disabled={busy}
                  onChange={(e) => setPath(e.target.value)}
                >
                  {artifact?.files.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </CeSelect>
              </label>
              {viewingPorterVersion && (
                <p className="experimental-origin">
                  {t("experimental.porterVersionReadOnly")}
                </p>
              )}
              {file?.binary ? (
                <p>{t("experimental.binary")}</p>
              ) : (
                <textarea
                  aria-label={t("experimental.sourceEdit")}
                  className="ce-field experimental-editor"
                  spellCheck={false}
                  value={text}
                  readOnly={page !== "maker" || !fileEditable}
                  onChange={(e) => setText(e.target.value)}
                />
              )}
              <div className="ce-actions">
                <button
                  className="ce-button"
                  disabled={busy || !native}
                  onClick={() =>
                    void perform(() =>
                      api("experimental_open", { jobId, operationId }),
                    )
                  }
                >
                  {t("experimental.openProject")}
                </button>
                {page === "maker" && (
                  <>
                    <button
                      className="ce-button"
                      disabled={!fileEditable || text === file?.content}
                      onClick={() =>
                        void perform(async () =>
                          showReview(
                            jobId,
                            await call(api, "maker_review", {
                              jobId,
                              operationId,
                              kind: "edit",
                              path,
                              text,
                              sha256: file?.sha256,
                            }),
                          ),
                        )
                      }
                    >
                      {t("experimental.previewEdit")}
                    </button>
                    <button
                      className="ce-button"
                      disabled={!fileEditable}
                      onClick={() =>
                        void perform(async () =>
                          showReview(
                            jobId,
                            await call(api, "maker_review", {
                              jobId,
                              operationId,
                              kind: "lock",
                              path,
                            }),
                          ),
                        )
                      }
                    >
                      {t("experimental.lock")}
                    </button>
                    <button
                      className="ce-button"
                      disabled={busy || active || !native}
                      onClick={() =>
                        void perform(async () =>
                          showReview(
                            jobId,
                            await call(api, "maker_review", {
                              jobId,
                              operationId,
                              kind: "revision",
                              spec,
                            }),
                          ),
                        )
                      }
                    >
                      {t("experimental.regenerate")}
                    </button>
                  </>
                )}
              </div>
              {page === "maker" && job.artifacts.length > 1 && (
                <>
                  <label className="ce-row">
                    <span>{t("experimental.checkpoint")}</span>
                    <CeSelect
                      className="ce-field"
                      value={checkpoint}
                      disabled={busy || active}
                      onChange={(e) => setCheckpoint(e.target.value)}
                    >
                      <option value="">{t("common.none")}</option>
                      {job.artifacts
                        .filter((a) => a.operationId !== operationId)
                        .map((a) => (
                          <option key={a.operationId} value={a.operationId}>
                            {a.directory}
                          </option>
                        ))}
                    </CeSelect>
                  </label>
                  <button
                    className="ce-button"
                    disabled={busy || active || !checkpoint || !native}
                    onClick={() =>
                      void perform(async () =>
                        showReview(
                          jobId,
                          await call(api, "maker_review", {
                            jobId,
                            operationId,
                            kind: "restore",
                            checkpointOperationId: checkpoint,
                          }),
                        ),
                      )
                    }
                  >
                    {t("experimental.restore")}
                  </button>
                </>
              )}
            </section>
          ) : null}
        </>
      )}
      {review && (
        <InstanceOperationDialog
          title={t("experimental.review")}
          titleId="experimental-review-title"
          busy={busy}
          committing={busy}
          confirmLabel={t("experimental.apply")}
          confirmDisabled={!native || review.status !== "pending"}
          onClose={() => {
            if (busy) return;
            void call(api, "review_cancel", {
              jobId: review.ownerJob,
              reviewId: review.reviewId,
            }).catch(() => {});
            setReview(null);
          }}
          onConfirm={() =>
            void perform(async () => {
              const applied = await call<{ reviewId: string }>(
                api,
                "review_apply",
                {
                  jobId: review.ownerJob,
                  reviewId: review.reviewId,
                  digest: review.reviewDigest,
                },
              );
              if (live.current) {
                setReview(null);
                setOperationId(`host-${applied.reviewId}`);
                setJob(
                  await call<JobView>(api, "job_read", {
                    jobId: review.ownerJob,
                  }),
                );
              }
            })
          }
        >
          <p>{t("experimental.newCopyHelp")}</p>
          <p className="experimental-origin experimental-digest">
            SHA-256: {review.reviewDigest}
          </p>
          {review.preview.warnings?.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
          {(review.preview.diffs || review.preview.changes || []).map(
            (change, i) => (
              <div className="experimental-review-file" key={i}>
                <strong>{change.path}</strong>
                <pre className="experimental-output">
                  {"diff" in change
                    ? change.diff
                    : "unified_diff" in change
                      ? change.unified_diff
                      : ""}
                </pre>
              </div>
            ),
          )}
          {!(review.preview.diffs || review.preview.changes)?.length && (
            <pre className="experimental-output">{pretty(review.preview)}</pre>
          )}
          {error && <p className="experimental-error">{error}</p>}
        </InstanceOperationDialog>
      )}
    </div>
  );
}
