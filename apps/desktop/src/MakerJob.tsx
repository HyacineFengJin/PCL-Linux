import { useEffect, useState } from "react";
import {
  FileCode2,
  GitPullRequest,
  CircleStop,
  FolderOpen,
} from "lucide-react";
import { t, formatDate, serviceError } from "./i18n";
import type { Api } from "./types";
import { experimentalCall as call, type JobView } from "./experimentalTypes";
import { useMakerScope } from "./useMakerScope";
import { MakerReviewDialog } from "./MakerReviewDialog";
import { CeSelect } from "./CeSelect";
export function MakerJob({
  api,
  native,
  jobId,
  onSource,
  onRecord,
  readOnly = false,
}: {
  api: Api;
  native: boolean;
  jobId: string;
  onSource: (operationId: string) => void;
  onRecord?: (operationId: string) => void;
  readOnly?: boolean;
}) {
  const scope = useMakerScope(api, native, jobId);
  const [job, setJob] = useState<JobView | null>(null),
    [reviewId, setReviewId] = useState("");
  const [restoreBase, setRestoreBase] = useState(""),
    [restoreTarget, setRestoreTarget] = useState("");
  useEffect(() => {
    let valid = true,
      polling = false;
    setJob(null);
    setReviewId("");
    setRestoreBase("");
    setRestoreTarget("");
    async function poll() {
      if (!native || !jobId || polling || !valid) return;
      polling = true;
      const current = scope.readTicket();
      try {
        const value = await call<JobView>(api, "job_read", { jobId });
        if (valid && current()) {
          if (value.summary.jobId !== jobId)
            throw new Error(t("maker.responseMismatch"));
          setJob(value);
        }
      } catch (error) {
        if (valid && current()) scope.setError(serviceError(error));
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1800);
    return () => {
      valid = false;
      window.clearInterval(timer);
    };
  }, [scope.scope]);
  const active = job && ["queued", "running"].includes(job.summary.status);
  const resultText =
    job?.result &&
    typeof job.result === "object" &&
    "text" in job.result &&
    typeof job.result.text === "string"
      ? job.result.text
      : "";
  return (
    <div className="maker-document">
      <div className="maker-document-heading">
        <div>
          <small>{t("maker.aiTask")}</small>
          <h2>
            {job
              ? t(
                  `experimental.job.${job.summary.status}` as Parameters<
                    typeof t
                  >[0],
                )
              : t("maker.loading")}
          </h2>
        </div>
        {active && !readOnly && (
          <button
            className="ce-button"
            disabled={scope.busy || !native}
            onClick={() =>
              void scope.perform(async () => {
                await call(api, "job_cancel", { jobId });
              })
            }
          >
            <CircleStop size={15} />
            {t("experimental.cancelJob")}
          </button>
        )}
      </div>
      <p className="experimental-origin">
        {jobId} {job && ` · ${formatDate(job.summary.updatedAt)}`}
      </p>
      <div className="maker-verification">
        <span>
          {t("maker.sourceStatus")} ·{" "}
          {job?.artifacts.length
            ? t("maker.sourceAvailable")
            : t("maker.sourcePending")}
        </span>
        <span>{t("maker.buildNotRun")}</span>
        <span>{t("maker.gameNotRun")}</span>
      </div>
      {job?.error && (
        <p className="experimental-error" role="alert">
          {job.error.message}
        </p>
      )}
      {resultText && (
        <section className="maker-result">
          <h3>{t("maker.aiResponse")}</h3>
          <div className="maker-ai-text">{resultText}</div>
        </section>
      )}
      <section className="maker-task-section">
        <h3>
          <GitPullRequest size={16} />
          {t("maker.proposedChanges")}
        </h3>
        {!job?.reviews.length && (
          <p className="experimental-origin">{t("maker.noProposals")}</p>
        )}
        {!readOnly &&
          job?.reviews.map((id) => (
            <button
              key={id}
              className="maker-feature-row"
              disabled={scope.busy || !native || !!active}
              onClick={() => scope.change(() => setReviewId(id))}
            >
              <GitPullRequest size={16} />
              <span>
                {t("maker.reviewChanges")}
                <small>{id.slice(0, 8)}</small>
              </span>
            </button>
          ))}
      </section>
      <section className="maker-task-section">
        <h3>
          <FileCode2 size={16} />
          {t("maker.sourceOutputs")}
        </h3>
        {job?.artifacts.map((value) => (
          <div className="maker-artifact-row" key={value.operationId}>
            <span>
              <strong>{value.operationId}</strong>
              <small>
                {t("maker.outputFileCount", { count: value.files.length })}
              </small>
            </span>
            <div>
              <button
                className="ce-button"
                disabled={!native || scope.busy}
                onClick={() => {
                  if (scope.callbackCurrent()) onSource(value.operationId);
                }}
              >
                <FileCode2 size={14} />
                {t("maker.openSource")}
              </button>
              {onRecord && (
                <button
                  className="ce-button"
                  disabled={!native || scope.busy || !!active}
                  onClick={() => {
                    if (scope.callbackCurrent()) onRecord(value.operationId);
                  }}
                >
                  {t("experimental.recordVersion")}
                </button>
              )}
              <button
                className="ce-button"
                disabled={!native || scope.busy}
                onClick={() =>
                  void scope.perform(async () => {
                    await api("experimental_open", {
                      jobId,
                      operationId: value.operationId,
                    });
                  })
                }
              >
                <FolderOpen size={14} />
                {t("maker.openFolder")}
              </button>
            </div>
          </div>
        ))}
        {!job?.artifacts.length && (
          <p className="experimental-origin">{t("maker.noSourceOutputs")}</p>
        )}
      </section>
      {!readOnly &&
        job?.summary.workflow === "maker" &&
        job.artifacts.length > 1 && (
          <section className="maker-task-section">
            <h3>{t("maker.restoreSource")}</h3>
            <p className="experimental-origin">{t("maker.restoreHelp")}</p>
            <div className="maker-two-fields">
              <label>
                <span>{t("maker.restoreBase")}</span>
                <CeSelect
                  value={restoreBase}
                  disabled={!native || scope.busy || !!active}
                  onChange={(event) =>
                    scope.change(() => setRestoreBase(event.target.value))
                  }
                >
                  <option value="">{t("maker.selectSource")}</option>
                  {job.artifacts.map((value) => (
                    <option key={value.operationId} value={value.operationId}>
                      {value.operationId}
                    </option>
                  ))}
                </CeSelect>
              </label>
              <label>
                <span>{t("maker.restoreTarget")}</span>
                <CeSelect
                  value={restoreTarget}
                  disabled={!native || scope.busy || !!active}
                  onChange={(event) =>
                    scope.change(() => setRestoreTarget(event.target.value))
                  }
                >
                  <option value="">{t("maker.selectSource")}</option>
                  {job.artifacts.map((value) => (
                    <option key={value.operationId} value={value.operationId}>
                      {value.operationId}
                    </option>
                  ))}
                </CeSelect>
              </label>
            </div>
            <button
              className="ce-button"
              disabled={
                !native ||
                scope.busy ||
                !!active ||
                !restoreBase ||
                !restoreTarget ||
                restoreBase === restoreTarget
              }
              onClick={() =>
                void scope.perform(async () => {
                  const result = await call<{ reviewId: string }>(
                    api,
                    "maker_review",
                    {
                      jobId,
                      operationId: restoreBase,
                      kind: "restore",
                      checkpointOperationId: restoreTarget,
                    },
                  );
                  if (scope.responseCurrent()) setReviewId(result.reviewId);
                })
              }
            >
              {t("maker.previewRestore")}
            </button>
          </section>
        )}
      {scope.error && (
        <p className="experimental-error" role="alert">
          {scope.error}
        </p>
      )}
      {reviewId && (
        <MakerReviewDialog
          key={`${jobId}:${reviewId}`}
          api={api}
          native={native}
          jobId={jobId}
          reviewId={reviewId}
          onClose={() => {
            if (scope.responseCurrent()) setReviewId("");
          }}
          onApplied={async (operationId) => {
            if (!scope.responseCurrent()) return;
            setReviewId("");
            const current = scope.readTicket();
            try {
              const updated = await call<JobView>(api, "job_read", { jobId });
              if (!current()) return;
              if (
                updated.summary.jobId !== jobId ||
                !updated.artifacts.some(
                  (value) => value.operationId === operationId,
                )
              )
                throw new Error(t("maker.responseMismatch"));
              setJob(updated);
            } catch (error) {
              if (current()) scope.setError(serviceError(error));
            }
          }}
        />
      )}
    </div>
  );
}
