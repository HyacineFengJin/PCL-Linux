/** One review belongs to one mounted source/task. An uncertain application is
 * blocked until an authoritative pending read, and an acknowledged commit is
 * never replayed because a subsequent display refresh failed. */
import { useEffect, useRef, useState } from "react";
import { InstanceOperationDialog } from "./instanceOperationUi";
import { experimentalCall as call, type ReviewView } from "./experimentalTypes";
import { t, serviceError } from "./i18n";
import type { Api } from "./types";
import { useMakerScope } from "./useMakerScope";
export function MakerReviewDialog({
  api,
  native,
  jobId,
  reviewId,
  digest,
  onClose,
  onApplied,
}: {
  api: Api;
  native: boolean;
  jobId: string;
  reviewId: string;
  digest?: string;
  onClose: () => void;
  onApplied: (operationId: string) => Promise<void>;
}) {
  const scope = useMakerScope(
    api,
    native,
    `${jobId}:${reviewId}:${digest ?? ""}`,
  );
  const [review, setReview] = useState<ReviewView | null>(null);
  const submitted = useRef(false);
  async function read(current = scope.readTicket()) {
    const value = await call<ReviewView & { jobId: string }>(
      api,
      "review_read",
      { jobId, reviewId },
    );
    if (!current()) return;
    if (
      value.jobId !== jobId ||
      value.reviewId !== reviewId ||
      (digest && value.reviewDigest !== digest)
    )
      throw new Error(t("maker.responseMismatch"));
    submitted.current = value.status !== "pending";
    setReview(value);
  }
  useEffect(() => {
    submitted.current = false;
    setReview(null);
    const current = scope.readTicket();
    if (native)
      void read(current).catch((error) => {
        if (current()) scope.setError(serviceError(error));
      });
  }, [scope.scope]);
  return (
    <InstanceOperationDialog
      title={t("maker.reviewChanges")}
      titleId="maker-review-title"
      busy={scope.busy}
      committing={scope.busy}
      confirmLabel={t("maker.applyChanges")}
      confirmDisabled={
        !native || !review || review.status !== "pending" || submitted.current
      }
      onClose={() => {
        if (!scope.callbackCurrent() || scope.busy) return;
        void scope.perform(async () => {
          await call(api, "review_cancel", { jobId, reviewId });
          if (scope.responseCurrent()) onClose();
        });
      }}
      onConfirm={() => {
        if (
          !scope.callbackCurrent() ||
          scope.scope.working ||
          submitted.current ||
          review?.status !== "pending"
        )
          return;
        submitted.current = true;
        void scope.perform(async () => {
          const result = await call<{ reviewId: string }>(api, "review_apply", {
            jobId,
            reviewId,
            digest: review.reviewDigest,
          });
          if (!scope.responseCurrent()) return;
          if (result.reviewId !== reviewId)
            throw new Error(t("maker.responseMismatch"));
          setReview({ ...review, status: "applied" });
          await onApplied(`host-${reviewId}`);
        });
      }}
    >
      <p>{t("maker.reviewHelp")}</p>
      {review && (
        <>
          <p className="experimental-origin experimental-digest">
            SHA-256: {review.reviewDigest}
          </p>
          {review.preview.warnings?.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
          <div className="maker-review-diffs">
            {(review.preview.diffs || review.preview.changes || []).map(
              (change, index) => (
                <section key={index}>
                  <strong>{change.path}</strong>
                  <pre className="experimental-output">
                    {"diff" in change
                      ? change.diff
                      : "unified_diff" in change
                        ? change.unified_diff
                        : ""}
                  </pre>
                </section>
              ),
            )}
          </div>
        </>
      )}
      {scope.error && (
        <p className="experimental-error" role="alert">
          {scope.error}
        </p>
      )}
      <button
        className="ce-button"
        disabled={!native || scope.busy}
        onClick={() => void scope.perform(() => read())}
      >
        {t("maker.refreshReview")}
      </button>
    </InstanceOperationDialog>
  );
}
