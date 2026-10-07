/** Two recorded checkpoints, one read-only display scope. Changing API, project,
 * revision or either selection retires responses/callbacks; it never changes
 * host source or a saved baseline. Each explicit request verifies both receipts.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CeSelect } from "./CeSelect";
import { t, serviceError } from "./i18n";
import type { Api } from "./types";
import { experimentalCall as call } from "./experimentalTypes";
import type {
  MakerProject,
  ProjectComparisonIdentity,
  ProjectComparisonPage,
  ProjectComparisonPreview,
  ProjectFileChange,
  ProjectComparisonSide,
} from "./experimentalProjectTypes";
export function ExperimentalProjectCompare({
  api,
  native,
  project,
  checkpointId,
}: {
  api: Api;
  native: boolean;
  project: MakerProject;
  checkpointId: string;
}) {
  const initialBase =
    project.checkpoints.find((point) => point.id !== checkpointId)?.id ?? "";
  const [base, setBase] = useState(initialBase),
    [target, setTarget] = useState(checkpointId);
  const [filter, setFilter] = useState(""),
    [page, setPage] = useState<ProjectComparisonPage | null>(null);
  const [preview, setPreview] = useState<ProjectComparisonPreview | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const scope = useMemo(
    () => ({ active: false, working: false }),
    [api, native, project.id, project.revision, checkpointId],
  );
  const owner = useRef<object | null>(null),
    callbacks = useRef<object | null>(null),
    generation = useRef(0);
  const render = {},
    captured = generation.current;
  useLayoutEffect(() => {
    callbacks.current = render;
  });
  useLayoutEffect(() => {
    scope.active = true;
    owner.current = scope;
    setBase(initialBase);
    setTarget(checkpointId);
    setPage(null);
    setPreview(null);
    setPath("");
    setBusy(false);
    setError("");
    return () => {
      scope.active = false;
      if (owner.current === scope) owner.current = null;
    };
  }, [scope]);
  const current = () => scope.active && owner.current === scope;
  const responseCurrent = () => current() && generation.current === captured;
  const callbackCurrent = () =>
    native && responseCurrent() && callbacks.current === render;
  const basePoint = project.checkpoints.find((point) => point.id === base),
    targetPoint = project.checkpoints.find((point) => point.id === target);
  const validPair = !!basePoint && !!targetPoint && base !== target;
  const ref = {
    id: project.id,
    expectedRevision: project.revision,
    baseCheckpointId: base,
    targetCheckpointId: target,
  };
  function validateIdentity(value: ProjectComparisonIdentity) {
    if (
      value.id !== project.id ||
      value.revision !== project.revision ||
      value.baseCheckpointId !== base ||
      value.targetCheckpointId !== target ||
      value.baseFingerprint !== basePoint?.fingerprint ||
      value.targetFingerprint !== targetPoint?.fingerprint
    )
      throw new Error(t("experimental.compareIdentityError"));
  }
  function change(action: () => void) {
    if (!callbackCurrent()) return;
    generation.current++;
    setPage(null);
    setPreview(null);
    setPath("");
    setError("");
    action();
  }
  async function perform(action: () => Promise<void>) {
    if (!validPair || !callbackCurrent() || scope.working) return;
    scope.working = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (responseCurrent()) setError(serviceError(e));
    } finally {
      scope.working = false;
      if (current()) setBusy(false);
    }
  }
  async function list(offset = 0) {
    setPage(null);
    setPreview(null);
    setPath("");
    const value = await call<ProjectComparisonPage>(api, "project_compare", {
      ...ref,
      filter,
      offset,
    });
    if (!responseCurrent()) return;
    validateIdentity(value);
    setPage(value);
  }
  async function read(change: ProjectFileChange) {
    setPreview(null);
    const value = await call<ProjectComparisonPreview>(
      api,
      "project_compare_file",
      { ...ref, path: change.path },
    );
    if (!responseCurrent()) return;
    validateIdentity(value);
    if (
      value.change.path !== change.path ||
      value.change.kind !== change.kind ||
      value.change.before?.sha256 !== change.before?.sha256 ||
      value.change.after?.sha256 !== change.after?.sha256
    )
      throw new Error(t("experimental.compareIdentityError"));
    setPreview(value);
  }
  const unavailable = busy || !native;
  const sideText = (side: ProjectComparisonSide | null) =>
    !side
      ? t("experimental.compareAbsent")
      : side.status === "text"
        ? t("experimental.compareTextSize", {
            bytes: side.previewBytes,
            total: side.bytes,
            lines: side.previewLines,
          })
        : t(
            side.status === "binary"
              ? "experimental.compareBinary"
              : side.status === "unsupported_encoding"
                ? "experimental.compareEncoding"
                : "experimental.compareType",
          );
  return (
    <section className="ce-card experimental-form">
      <h2 className="ce-card-title">{t("experimental.compareVersions")}</h2>
      <p className="experimental-origin">{t("experimental.compareHelp")}</p>
      <label className="ce-row">
        <span>{t("experimental.compareBase")}</span>
        <CeSelect
          className="ce-field"
          value={base}
          disabled={unavailable}
          onChange={(e) => change(() => setBase(e.target.value))}
        >
          {project.checkpoints.map((point) => (
            <option key={point.id} value={point.id}>
              {point.label} · {point.workflow}
            </option>
          ))}
        </CeSelect>
      </label>
      <label className="ce-row">
        <span>{t("experimental.compareTarget")}</span>
        <CeSelect
          className="ce-field"
          value={target}
          disabled={unavailable}
          onChange={(e) => change(() => setTarget(e.target.value))}
        >
          {project.checkpoints.map((point) => (
            <option key={point.id} value={point.id}>
              {point.label} · {point.workflow}
            </option>
          ))}
        </CeSelect>
      </label>
      <label className="ce-row">
        <span>{t("experimental.pathFilter")}</span>
        <input
          className="ce-field"
          value={filter}
          maxLength={120}
          disabled={unavailable}
          onChange={(e) => change(() => setFilter(e.target.value))}
        />
      </label>
      <div className="ce-actions">
        <button
          className="ce-button"
          disabled={unavailable || !validPair}
          onClick={() => void perform(() => list())}
        >
          {t("experimental.compareVersions")}
        </button>
        <button
          className="ce-button"
          disabled={unavailable || !page?.offset}
          onClick={() =>
            void perform(() => list(Math.max(0, page!.offset - page!.pageSize)))
          }
        >
          {t("experimental.previousPage")}
        </button>
        <button
          className="ce-button"
          disabled={unavailable || page?.nextOffset == null}
          onClick={() => void perform(() => list(page!.nextOffset!))}
        >
          {t("experimental.nextPage")}
        </button>
      </div>
      {!validPair && (
        <p className="experimental-origin">
          {t("experimental.comparePairRequired")}
        </p>
      )}
      {page && (
        <>
          <p>{t("experimental.compareCounts", page.counts)}</p>
          <p className="experimental-origin">
            {t("experimental.comparePageSize", {
              count: page.filteredCount,
              start: page.changes.length ? page.offset + 1 : 0,
              end: page.offset + page.changes.length,
            })}
          </p>
          {!page.changes.length && <p>{t("experimental.compareNoChanges")}</p>}
          <label className="ce-row">
            <span>{t("experimental.file")}</span>
            <CeSelect
              className="ce-field"
              value={path}
              disabled={unavailable}
              onChange={(e) => {
                if (!callbackCurrent()) return;
                if (
                  e.target.value &&
                  !page.changes.some((value) => value.path === e.target.value)
                )
                  return;
                generation.current++;
                setPreview(null);
                setPath(e.target.value);
                setError("");
              }}
            >
              <option value="">{t("common.none")}</option>
              {page.changes.map((value) => (
                <option key={value.path} value={value.path}>
                  {t(
                    value.kind === "added"
                      ? "experimental.compareAdded"
                      : value.kind === "deleted"
                        ? "experimental.compareDeleted"
                        : "experimental.compareModified",
                  )}{" "}
                  · {value.path}
                </option>
              ))}
            </CeSelect>
          </label>
          <button
            className="ce-button"
            disabled={
              unavailable || !page.changes.some((value) => value.path === path)
            }
            onClick={() => {
              const selected = page.changes.find(
                (value) => value.path === path,
              );
              if (selected) void perform(() => read(selected));
            }}
          >
            {t("experimental.comparePreview")}
          </button>
        </>
      )}
      {preview && (
        <>
          <p>{preview.change.path}</p>
          <p className="experimental-origin">
            {t("experimental.compareBase")} · {sideText(preview.before)}
          </p>
          <p className="experimental-origin">
            {t("experimental.compareTarget")} · {sideText(preview.after)}
          </p>
          {preview.status === "uncomparable" ? (
            <p>{t("experimental.compareUncomparable")}</p>
          ) : (
            <>
              {(preview.before?.truncated || preview.after?.truncated) && (
                <p className="experimental-origin">
                  {t("experimental.compareTruncated", {
                    bytes: preview.limits.bytes,
                    lines: preview.limits.lines,
                  })}
                </p>
              )}
              <p className="experimental-origin">
                {t("experimental.compareLineLegend")}
              </p>
              {preview.rows.length ? (
                <pre
                  className="experimental-output"
                  aria-label={t("experimental.comparePreview")}
                >
                  {preview.rows
                    .map(
                      (row) =>
                        `${row.kind === "added" ? "+" : row.kind === "deleted" ? "-" : " "} ${row.beforeLine ?? "–"}:${row.afterLine ?? "–"} ${row.text}`,
                    )
                    .join("\n")}
                </pre>
              ) : (
                <p>{t("experimental.compareEmptyText")}</p>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p className="experimental-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
