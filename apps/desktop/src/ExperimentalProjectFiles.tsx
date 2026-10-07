/** A version-scoped read-only browser. Every page is receipt-verified by the
 * host; offsets belong to a selected version, never an arbitrary local path.
 * Unmount cancels display updates, keeping responses from another version out.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CeSelect } from "./CeSelect";
import { t, serviceError } from "./i18n";
import type { Api } from "./types";
import { experimentalCall as call } from "./experimentalTypes";
import type {
  ProjectSourceRef,
  ProjectIndexPage,
  ProjectFileChunk,
  ProjectSearchPage,
} from "./experimentalProjectTypes";
export function ExperimentalProjectFiles({
  api,
  native,
  source,
  onIndexed,
}: {
  api: Api;
  native: boolean;
  source: ProjectSourceRef;
  onIndexed: (editable: boolean) => void;
}) {
  const [index, setIndex] = useState<ProjectIndexPage | null>(null),
    [offset, setOffset] = useState(0),
    [filter, setFilter] = useState("");
  const [name, setName] = useState(""),
    [chunk, setChunk] = useState<ProjectFileChunk | null>(null),
    [previous, setPrevious] = useState<number[]>([]);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState<ProjectSearchPage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pageScope = useRef<object | null>(null);
  const scope = useMemo(
    () => ({ active: false, working: false }),
    [api, native, source.id, source.expectedRevision, source.checkpointId],
  );
  const callbacks = useRef<object>({}),
    view = useRef(0);
  const renderCallbacks = {},
    generation = view.current;
  useEffect(() => {
    callbacks.current = renderCallbacks;
  });
  const isCurrent = () => scope.active && pageScope.current === scope;
  const isResponseCurrent = () => isCurrent() && view.current === generation;
  const isCallbackCurrent = () =>
    isResponseCurrent() && callbacks.current === renderCallbacks;
  async function perform(action: () => Promise<void>) {
    if (!native || !isCallbackCurrent() || scope.working) return;
    scope.working = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (isResponseCurrent()) setError(serviceError(e));
    } finally {
      scope.working = false;
      if (isCurrent()) setBusy(false);
    }
  }
  async function page(next: number) {
    const value = await call<ProjectIndexPage>(api, "project_files", {
      ...source,
      offset: next,
      filter,
    });
    if (isResponseCurrent()) {
      setIndex(value);
      setOffset(next);
      onIndexed(value.editableSnapshot);
    }
  }
  async function read(path: string, next = 0, history: number[] = []) {
    const value = await call<ProjectFileChunk>(api, "project_file_read", {
      ...source,
      path,
      offset: next,
    });
    if (isResponseCurrent()) {
      setName(path);
      setChunk(value);
      setPrevious(history);
    }
  }
  async function find(next = 0) {
    const value = await call<ProjectSearchPage>(api, "project_search", {
      ...source,
      query,
      offset: next,
    });
    if (isResponseCurrent()) setSearch(value);
  }
  useEffect(() => {
    pageScope.current = scope;
    scope.active = true;
    setBusy(false);
    setIndex(null);
    setChunk(null);
    setPrevious([]);
    setSearch(null);
    setName("");
    void perform(() => page(0));
    return () => {
      scope.active = false;
      if (pageScope.current === scope) pageScope.current = null;
    };
  }, [scope]);
  const unavailable = busy || !native;
  return (
    <section className="ce-card experimental-form">
      <h2 className="ce-card-title">{t("experimental.sourceIndex")}</h2>
      <p className="experimental-origin">{t("experimental.sourceIndexHelp")}</p>
      {index && (
        <p>
          {t("experimental.sourceIndexSize", {
            count: index.fileCount,
            bytes: index.totalBytes,
          })}
        </p>
      )}
      {index && !index.editableSnapshot && (
        <p className="experimental-origin">
          {t("experimental.sourceIndexReadOnly")}
        </p>
      )}
      <label className="ce-row">
        <span>{t("experimental.pathFilter")}</span>
        <input
          className="ce-field"
          value={filter}
          maxLength={120}
          disabled={unavailable}
          onChange={(e) => {
            if (!isCallbackCurrent()) return;
            view.current++;
            setFilter(e.target.value);
            setIndex(null);
            setOffset(0);
          }}
        />
      </label>
      <div className="ce-actions">
        <button
          className="ce-button"
          disabled={unavailable}
          onClick={() => void perform(() => page(0))}
        >
          {t("experimental.refresh")}
        </button>
        <button
          className="ce-button"
          disabled={unavailable || !offset}
          onClick={() => void perform(() => page(Math.max(0, offset - 50)))}
        >
          {t("experimental.previousPage")}
        </button>
        <button
          className="ce-button"
          disabled={unavailable || index?.nextOffset == null}
          onClick={() => void perform(() => page(index!.nextOffset!))}
        >
          {t("experimental.nextPage")}
        </button>
      </div>
      <label className="ce-row">
        <span>{t("experimental.file")}</span>
        <CeSelect
          className="ce-field"
          value={index?.files.some((file) => file.path === name) ? name : ""}
          disabled={unavailable}
          onChange={(e) => {
            if (e.target.value) void perform(() => read(e.target.value));
          }}
        >
          <option value="">{t("common.none")}</option>
          {index?.files.map((file) => (
            <option key={file.path} value={file.path} disabled={!file.text}>
              {file.path} · {file.bytes} B
            </option>
          ))}
        </CeSelect>
      </label>
      {chunk && (
        <>
          <p className="experimental-origin">
            {chunk.path} · {chunk.offset}–
            {chunk.offset + new TextEncoder().encode(chunk.content).length} /{" "}
            {chunk.bytes} B
          </p>
          <textarea
            className="ce-field experimental-editor"
            aria-label={t("experimental.sourceIndex")}
            value={chunk.content}
            readOnly
            spellCheck={false}
          />
          <div className="ce-actions">
            <button
              className="ce-button"
              disabled={unavailable || !previous.length}
              onClick={() =>
                void perform(() =>
                  read(name, previous.at(-1)!, previous.slice(0, -1)),
                )
              }
            >
              {t("experimental.previousChunk")}
            </button>
            <button
              className="ce-button"
              disabled={unavailable || chunk.nextOffset == null}
              onClick={() =>
                void perform(() =>
                  read(name, chunk.nextOffset!, [...previous, chunk.offset]),
                )
              }
            >
              {t("experimental.nextChunk")}
            </button>
          </div>
        </>
      )}
      <label className="ce-row">
        <span>{t("experimental.sourceSearch")}</span>
        <input
          className="ce-field"
          value={query}
          maxLength={120}
          disabled={unavailable}
          onChange={(e) => {
            if (!isCallbackCurrent()) return;
            view.current++;
            setQuery(e.target.value);
            setSearch(null);
          }}
        />
      </label>
      <div className="ce-actions">
        <button
          className="ce-button"
          disabled={unavailable || !query}
          onClick={() => void perform(() => find())}
        >
          {t("experimental.sourceSearch")}
        </button>
        <button
          className="ce-button"
          disabled={unavailable || search?.nextOffset == null}
          onClick={() => void perform(() => find(search!.nextOffset!))}
        >
          {t("experimental.nextPage")}
        </button>
      </div>
      {search && (
        <>
          <p>
            {t("experimental.searchPageSize", {
              count: search.scannedFiles,
              bytes: search.scannedBytes,
            })}
          </p>
          {!search.matches.length && <p>{t("experimental.noSearchMatches")}</p>}
          {search.truncatedFile && (
            <p className="experimental-origin">
              {t("experimental.searchTruncated", {
                path: search.truncatedFile,
              })}
            </p>
          )}
          {search.matches.map((match, i) => (
            <button
              key={`${match.path}:${match.line}:${i}`}
              className="ce-button experimental-job"
              disabled={unavailable}
              onClick={() => void perform(() => read(match.path))}
            >
              <span>
                {match.path}:{match.line}
              </span>
              <span>{match.snippet}</span>
            </button>
          ))}
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
