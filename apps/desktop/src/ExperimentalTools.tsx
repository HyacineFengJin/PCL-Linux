import { ExperimentalVersion } from "./ExperimentalVersion";
import { useEffect, useRef, useState, type RefObject } from "react";
import { CeSelect } from "./CeSelect";
import { t, formatDate, serviceError, type MessageKey } from "./i18n";
import type { Api } from "./types";
import { InstanceOperationDialog } from "./instanceOperationUi";
import { ExperimentalExtensions } from "./ExperimentalExtensions";
import { ExperimentalMaker, initialMakerSpec } from "./ExperimentalMaker";
import {
  experimentalCall as call,
  type ExperimentalNavigate,
  type ExperimentalPage,
  type EngineStatus,
  type JobView,
  type Artifact,
  type ReviewView,
} from "./experimentalTypes";
import "./experimental.css";
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type ImportedSource = {
  sourceId: string;
  files: Record<string, string>;
  skipped: string[];
};
type SourceFile = {
  path: string;
  sha256: string;
  content: string | null;
  binary: boolean;
};
type PorterReport = {
  blockers: { title: string; detail: string }[];
  steps: { title: string; action: string }[];
  catalog_checked_at: string;
  status: string;
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
  allowed: string[];
  mode: string;
  prompt: string;
  jobId: string;
};

/** UI owns only drafts and display selections. Jobs, path grants, file hashes
 * and one-use approvals remain in the native host and the supplied runtime. */
export function ExperimentalTools({
  api,
  native,
  page,
  drafts,
  onNavigate,
  onConfigureAi,
}: {
  api: Api;
  native: boolean;
  page: ExperimentalPage;
  drafts: RefObject<Partial<Record<ExperimentalPage, ExperimentalDraft>>>;
  onConfigureAi?: () => void;
  onNavigate: ExperimentalNavigate;
}) {
  const draft = drafts.current[page];
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState(draft?.mode ?? "template"),
    [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [spec, setSpec] = useState(draft?.spec ?? initialMakerSpec),
    [source, setSource] = useState<ImportedSource | null>(
      draft?.source ?? null,
    ),
    [directory, setDirectory] = useState(draft?.directory ?? "");
  const [targets, setTargets] = useState<
      { id: string; minecraft: string; loader: string; channel: string }[]
    >([]),
    [targetId, setTargetId] = useState(draft?.targetId ?? "neoforge-26.3"),
    [rights, setRights] = useState(draft?.rights ?? "unknown"),
    [beta, setBeta] = useState(draft?.beta ?? false),
    [allowed, setAllowed] = useState<string[]>(draft?.allowed ?? []);
  const [jobId, setJobId] = useState(draft?.jobId ?? ""),
    [job, setJob] = useState<JobView | null>(null),
    [report, setReport] = useState<PorterReport | null>(null);
  const [operationId, setOperationId] = useState(""),
    [path, setPath] = useState(""),
    [file, setFile] = useState<SourceFile | null>(null),
    [text, setText] = useState(""),
    [checkpoint, setCheckpoint] = useState("");
  const [review, setReview] = useState<
      (ReviewView & { ownerJob: string }) | null
    >(null),
    [result, setResult] = useState<unknown>(null),
    [patchPath, setPatchPath] = useState(""),
    [patchText, setPatchText] = useState(""),
    [purpose, setPurpose] = useState("");
  const live = useRef(true),
    working = useRef(false);
  useEffect(() => {
    drafts.current[page] = {
      spec,
      source,
      directory,
      targetId,
      rights,
      beta,
      allowed,
      mode,
      prompt,
      jobId,
    };
  }, [
    drafts,
    page,
    spec,
    source,
    directory,
    targetId,
    rights,
    beta,
    allowed,
    mode,
    prompt,
    jobId,
  ]);
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
    if (native)
      void call<{ targets: typeof targets }>(api, "catalog")
        .then((v) => {
          if (valid) setTargets(v.targets);
        })
        .catch((e) => {
          if (valid) setError(serviceError(e));
        });
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
    setReport(null);
    setOperationId("");
    setPath("");
    setFile(null);
    setText("");
    setCheckpoint("");
    setResult(null);
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
        if (
          value.summary.workflow === "porter" &&
          !["running", "queued"].includes(value.summary.status)
        ) {
          const analysis = await call<PorterReport | null>(api, "report_read", {
            jobId,
          });
          if (valid) setReport(analysis);
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
    if (page !== "maker" && page !== "porter") return;
    const value = await call<{ jobId: string }>(api, "job_create", {
      profile: page,
      mode,
      prompt,
      spec,
      sourceId: source?.sourceId,
      permittedPaths: allowed,
      targetId,
      rights,
      acknowledgeBeta: beta,
    });
    if (live.current) setJobId(value.jobId);
  }
  const active = !!job && ["queued", "running"].includes(job.summary.status),
    noCapacity =
      (status?.jobs.filter((j) => ["queued", "running"].includes(j.status))
        .length || 0) >= 2;
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
            (page === "porter" && !source) ||
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
      {page === "porter" && (
        <>
          <section className="ce-card">
            <h2 className="ce-card-title">{t("experimental.porter")}</h2>
            <p>{t("experimental.porterHelp")}</p>
            <label className="ce-row">
              <span>{t("experimental.source")}</span>
              <input
                className="ce-field"
                readOnly
                value={directory}
                placeholder={t("experimental.noSource")}
              />
            </label>
            <div className="ce-actions">
              <button
                className="ce-button"
                disabled={busy || !native}
                onClick={() =>
                  void perform(async () => {
                    const picked = await api<{
                      status: string;
                      path?: string;
                      message?: string;
                    }>("experimental_choose", { kind: "source" });
                    if (picked.status === "unavailable")
                      throw new Error(picked.message);
                    if (picked.status !== "selected") return;
                    const imported = await call<ImportedSource>(
                      api,
                      "source_import",
                      { directory: picked.path },
                    );
                    if (live.current) {
                      setSource(imported);
                      setDirectory(picked.path || "");
                      setAllowed([]);
                      setPatchPath("");
                      setPatchText("");
                    }
                  })
                }
              >
                {t("experimental.sourceChoose")}
              </button>
            </div>
            {source && (
              <p className="experimental-origin">
                {t("experimental.importScope", {
                  count: Object.keys(source.files).length,
                  skipped: source.skipped.length,
                })}
              </p>
            )}
            <label className="ce-row">
              <span>{t("experimental.target")}</span>
              <CeSelect
                className="ce-field"
                value={targetId}
                disabled={busy || !native}
                onChange={(e) => setTargetId(e.target.value)}
              >
                {targets.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.loader} · {v.minecraft} ({v.channel})
                  </option>
                ))}
              </CeSelect>
            </label>
            <label className="ce-row">
              <span>{t("experimental.rights")}</span>
              <CeSelect
                className="ce-field"
                value={rights}
                disabled={busy || !native}
                onChange={(e) => setRights(e.target.value)}
              >
                <option value="unknown">
                  {t("experimental.rightsUnknown")}
                </option>
                <option value="owner">{t("experimental.rightsOwner")}</option>
                <option value="permission">
                  {t("experimental.rightsPermission")}
                </option>
                <option value="license-reviewed">
                  {t("experimental.rightsLicense")}
                </option>
              </CeSelect>
            </label>
            <label className="ce-check experimental-safe">
              <input
                type="checkbox"
                checked={beta}
                disabled={busy}
                onChange={(e) => setBeta(e.target.checked)}
              />
              <span>{t("experimental.beta")}</span>
            </label>
            {source && (
              <details className="experimental-safe">
                <summary>{t("experimental.allowedPaths")}</summary>
                <div className="experimental-paths">
                  {Object.keys(source.files).map((p) => (
                    <label className="ce-check" key={p}>
                      <input
                        type="checkbox"
                        checked={allowed.includes(p)}
                        disabled={
                          busy ||
                          /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|pom\.xml|package\.json|gradlew(?:\.bat)?)$/.test(
                            p,
                          )
                        }
                        onChange={(e) =>
                          setAllowed(
                            e.target.checked
                              ? [...allowed, p]
                              : allowed.filter((v) => v !== p),
                          )
                        }
                      />
                      <span>{p}</span>
                    </label>
                  ))}
                </div>
              </details>
            )}
            <ExperimentalVersion version="0.5.1" />
          </section>
          {modeUi}
        </>
      )}
      {error && (
        <p className="experimental-error" role="alert">
          {error}
        </p>
      )}
      {(page === "maker" || page === "porter") && (
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
              {job.reviews.map((id) => (
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
          {report && (
            <section className="ce-card">
              <h2 className="ce-card-title">{t("experimental.report")}</h2>
              <p className="experimental-origin">
                {report.catalog_checked_at} · {report.status}
              </p>
              {report.blockers.map((b, i) => (
                <div key={i}>
                  <h3 className="experimental-subtitle">{b.title}</h3>
                  <p>{b.detail}</p>
                </div>
              ))}
              {report.steps.map((step, i) => (
                <div key={i}>
                  <h3 className="experimental-subtitle">
                    {i + 1}. {step.title}
                  </h3>
                  <p>{step.action}</p>
                </div>
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
          {page === "porter" && job && !active && (
            <section className="ce-card">
              <h2 className="ce-card-title">{t("experimental.review")}</h2>
              <div className="ce-actions">
                {(["metadata", "identifier"] as const).map((recipe) => (
                  <button
                    className="ce-button"
                    key={recipe}
                    disabled={busy || !native}
                    onClick={() =>
                      void perform(async () => {
                        const value = await call<{
                          review?: { reviewId: string };
                        }>(api, "porter_recipe", { jobId, recipe });
                        if (live.current) setResult(value);
                        if (value.review) await showReview(jobId, value.review);
                      })
                    }
                  >
                    {t(
                      recipe === "metadata"
                        ? "experimental.metadataRecipe"
                        : "experimental.javaRecipe",
                    )}
                  </button>
                ))}
              </div>
              <h3 className="experimental-subtitle">
                {t("experimental.manualPatch")}
              </h3>
              <label className="ce-row">
                <span>{t("experimental.file")}</span>
                <input
                  className="ce-field"
                  value={patchPath}
                  disabled={busy}
                  onChange={(e) => {
                    setPatchPath(e.target.value);
                    setPatchText(source?.files[e.target.value] || "");
                  }}
                />
              </label>
              <label className="ce-row">
                <span>{t("experimental.patchPurpose")}</span>
                <input
                  className="ce-field"
                  value={purpose}
                  maxLength={500}
                  disabled={busy}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </label>
              <textarea
                className="ce-field experimental-editor"
                aria-label={t("experimental.manualPatch")}
                spellCheck={false}
                value={patchText}
                disabled={busy}
                onChange={(e) => setPatchText(e.target.value)}
              />
              <button
                className="ce-button"
                disabled={busy || !native || !patchPath || !purpose}
                onClick={() =>
                  void perform(async () =>
                    showReview(
                      jobId,
                      await call(api, "porter_review", {
                        jobId,
                        path: patchPath,
                        text: patchText,
                        purpose,
                      }),
                    ),
                  )
                }
              >
                {t("experimental.patchPreview")}
              </button>
              {result != null && (
                <pre className="experimental-output">{pretty(result)}</pre>
              )}
            </section>
          )}
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
