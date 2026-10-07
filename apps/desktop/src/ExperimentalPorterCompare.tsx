/** Read-only retained versions. Page/API/selection owners guard both admission
 * and replies; an old request never releases a newer owner's busy state. No
 * source tree, apply action, baseline control or model capability is exposed. */
import { useEffect, useRef, useState } from "react";
import { CeSelect } from "./CeSelect";
import { t, serviceError } from "./i18n";
import type { Api } from "./types";
import { experimentalCall as call } from "./experimentalTypes";
import type {
  PorterComparison,
  PorterVersion,
  PorterVersionList,
} from "./experimentalPorterCompareTypes";

type Page = { api: Api; native: boolean; projectId: string };
type Scope = { page: Page; selection: string; epoch: number };
const key = (v: PorterVersion) =>
  `${v.ref.jobId}:${v.ref.kind === "input" ? "input" : v.ref.operationId}`;
function label(v: PorterVersion) {
  return t("experimental.porterCompareVersion", {
    round: v.round,
    baseline: v.baselineRevision,
    kind: t(
      v.ref.kind === "input"
        ? "experimental.porterFrozenInput"
        : "experimental.porterTextCopy",
    ),
    id: (v.ref.kind === "input"
      ? v.ref.jobId
      : v.ref.operationId.replace(/^host-/, "")
    ).slice(0, 8),
  });
}

export function ExperimentalPorterCompare({
  api,
  native,
  projectId,
  disabled,
}: {
  api: Api;
  native: boolean;
  projectId: string;
  disabled: boolean;
}) {
  const [left, setLeft] = useState(""),
    [right, setRight] = useState("");
  const live = useRef(true),
    epoch = useRef(0);
  const pageOwner = useRef<Page>({ api, native, projectId });
  if (
    pageOwner.current.api !== api ||
    pageOwner.current.native !== native ||
    pageOwner.current.projectId !== projectId
  )
    pageOwner.current = { api, native, projectId };
  const page = pageOwner.current,
    selection = JSON.stringify([left, right]);
  const owner = useRef<Scope>({ page, selection, epoch: epoch.current });
  if (
    owner.current.page !== page ||
    owner.current.selection !== selection ||
    owner.current.epoch !== epoch.current
  )
    owner.current = { page, selection, epoch: epoch.current };
  const scope = owner.current;
  const admission = useRef(disabled);
  admission.current = disabled;
  const reading = useRef<{ page: Page } | null>(null),
    working = useRef<{ scope: Scope } | null>(null);
  const [loadingPage, setLoadingPage] = useState<Page | null>(null),
    [busyScope, setBusyScope] = useState<Scope | null>(null);
  const [list, setList] = useState<{
    page: Page;
    value: PorterVersionList;
  } | null>(null);
  const [result, setResult] = useState<{
    scope: Scope;
    value: PorterComparison;
  } | null>(null);
  const [error, setError] = useState<{ page: Page; text: string } | null>(null);
  const currentPage = () => live.current && pageOwner.current === page;
  const current = () =>
    currentPage() && owner.current === scope && epoch.current === scope.epoch;
  const allowed = () =>
    current() &&
    native &&
    !admission.current &&
    reading.current?.page !== page &&
    working.current?.scope !== scope;
  const versions = list?.page === page ? list.value.versions : [];
  const comparison = result?.scope === scope ? result.value : null;
  const waiting =
    disabled || !native || loadingPage === page || busyScope === scope;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function load() {
    if (
      !currentPage() ||
      !native ||
      reading.current?.page === page ||
      working.current?.scope === scope
    )
      return;
    const run = { page };
    reading.current = run;
    setLoadingPage(page);
    setError(null);
    try {
      const value = await call<PorterVersionList>(
        api,
        "porter_project_versions",
        { projectId },
      );
      if (currentPage()) {
        epoch.current++;
        setList({ page, value });
        const latestCopy = [...value.versions]
          .reverse()
          .find((v) => v.ref.kind === "artifact");
        const baseline = latestCopy
          ? value.versions.find(
              (v) =>
                v.ref.kind === "input" && v.ref.jobId === latestCopy.ref.jobId,
            )
          : value.versions.at(-1);
        setLeft(baseline ? key(baseline) : "");
        setRight(latestCopy ? key(latestCopy) : baseline ? key(baseline) : "");
      }
    } catch (e) {
      if (currentPage()) {
        setList(null);
        setError({ page, text: serviceError(e) });
      }
    } finally {
      if (reading.current === run) reading.current = null;
      if (currentPage()) setLoadingPage(null);
    }
  }
  useEffect(() => {
    void load();
  }, [api, native, projectId]);
  function choose(value: string, side: "left" | "right") {
    if (
      !allowed() ||
      value === (side === "left" ? left : right) ||
      !versions.some((v) => key(v) === value)
    )
      return;
    epoch.current++;
    setError(null);
    (side === "left" ? setLeft : setRight)(value);
  }
  async function compare() {
    const a = versions.find((v) => key(v) === left),
      b = versions.find((v) => key(v) === right);
    if (!allowed() || !a || !b) return;
    const run = { scope };
    working.current = run;
    setBusyScope(scope);
    setError(null);
    try {
      const value = await call<PorterComparison>(
        api,
        "porter_project_compare",
        { projectId, left: a.ref, right: b.ref },
      );
      if (current()) setResult({ scope, value });
    } catch (e) {
      if (current()) setError({ page, text: serviceError(e) });
    } finally {
      if (working.current === run) working.current = null;
      if (current()) setBusyScope(null);
    }
  }
  return (
    <section className="ce-card experimental-porter-comparison">
      <h2 className="ce-card-title">{t("experimental.porterCompare")}</h2>
      <p className="experimental-origin">
        {t("experimental.porterCompareHelp")}
      </p>
      {(["left", "right"] as const).map((side) => (
        <label className="ce-row" key={side}>
          <span>
            {t(
              side === "left"
                ? "experimental.porterCompareFrom"
                : "experimental.porterCompareTo",
            )}
          </span>
          <CeSelect
            className="ce-field"
            value={side === "left" ? left : right}
            disabled={waiting || !versions.length}
            aria-label={t(
              side === "left"
                ? "experimental.porterCompareFrom"
                : "experimental.porterCompareTo",
            )}
            onChange={(e) => choose(e.target.value, side)}
          >
            {!versions.length && <option value="">{t("common.none")}</option>}
            {versions.map((v) => (
              <option key={key(v)} value={key(v)}>
                {label(v)}
              </option>
            ))}
          </CeSelect>
        </label>
      ))}
      <div className="ce-actions">
        <button
          className="ce-button primary"
          disabled={waiting || !versions.length}
          onClick={() => void compare()}
        >
          {t("experimental.porterCompareRun")}
        </button>
        <button
          className="ce-button"
          disabled={waiting}
          onClick={() => {
            if (allowed()) void load();
          }}
        >
          {t("experimental.refresh")}
        </button>
      </div>
      {loadingPage === page && <p>{t("common.working")}</p>}
      {list?.page === page && list.value.omittedCopies > 0 && (
        <p className="experimental-origin">
          {t("experimental.porterCompareOmitted", {
            count: list.value.omittedCopies,
          })}
        </p>
      )}
      {list?.page === page && !versions.length && (
        <p>{t("experimental.porterCompareEmpty")}</p>
      )}
      {error?.page === page && (
        <p className="experimental-error">{error.text}</p>
      )}
      {comparison && (
        <>
          <p>{t("experimental.porterCompareCounts", comparison.counts)}</p>
          <p className="experimental-origin experimental-digest">
            {t("experimental.porterCompareFrom")}: {comparison.left.fingerprint}
            <br />
            {t("experimental.porterCompareTo")}: {comparison.right.fingerprint}
          </p>
          {!comparison.changes.length && (
            <p>{t("experimental.porterCompareEqual")}</p>
          )}
          {comparison.changes.map((c) => (
            <details className="experimental-safe" key={c.path}>
              <summary>
                {t(
                  c.kind === "added"
                    ? "experimental.porterCompareAdded"
                    : c.kind === "deleted"
                      ? "experimental.porterCompareDeleted"
                      : "experimental.porterCompareModified",
                )}{" "}
                · {c.path}
              </summary>
              <p className="experimental-origin">
                {c.beforeBytes} B → {c.afterBytes} B
              </p>
              <p className="experimental-origin experimental-digest">
                SHA-256: {c.beforeHash || t("common.none")} →{" "}
                {c.afterHash || t("common.none")}
              </p>
              {c.diff.coarse && (
                <p className="experimental-origin">
                  {t("experimental.porterCompareCoarse")}
                </p>
              )}
              {c.diff.text && (
                <pre className="experimental-output">{c.diff.text}</pre>
              )}
              {c.diff.truncated && (
                <p className="experimental-origin">
                  {t("experimental.porterCompareTruncated")}
                </p>
              )}
            </details>
          ))}
        </>
      )}
    </section>
  );
}
