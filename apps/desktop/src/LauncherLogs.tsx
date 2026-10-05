import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import { createTranslator } from "./i18n";
import {
  type LauncherLocale,
  type LauncherLogRow,
  type LauncherLogSelection,
  type LauncherLogExportPlan,
  type LauncherLogExportOutcome,
  type LauncherLogClearPlan,
  type LauncherLogClearOutcome,
  type LauncherLogRecoveryRow,
  type LauncherLogRestoreOutcome,
} from "./launcherTypes";
import { LauncherCard as Card } from "./LauncherSettingsControls";

type Props = {
  api: Api;
  scopeKey: string;
  native: boolean;
  operationsEnabled: boolean;
  busy: boolean;
  region: LauncherLocale;
  language?: LauncherLocale;
  onOpen: (kind: string) => void;
  onNotify: (message: string) => void;
};

/** The panel's API is already root-bound. Confirmation tokens and operation IDs
 * belong to that scope; remounting on root change discards them. A stale reply
 * must never replace the new root's list or open an old cleanup confirmation.
 */
export function LauncherLogs({
  api,
  scopeKey,
  native,
  operationsEnabled,
  busy,
  region,
  language = "zh-CN",
  onOpen,
  onNotify,
}: Props) {
  const tr = createTranslator({ language, region });
  // Async messages use the current language while service data stays untouched.
  const translator = useRef(tr);
  translator.current = tr;
  const [logs, setLogs] = useState<LauncherLogRow[]>([]);
  const [recovery, setRecovery] = useState<LauncherLogRecoveryRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [clearPlan, setClearPlan] = useState<LauncherLogClearPlan | null>(null);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const live = useRef(true),
    admission = useRef(false),
    request = useRef(0);
  const reading = useRef(0);
  const gate = useRef({ native, operationsEnabled, busy });
  gate.current = { native, operationsEnabled, busy };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      ++request.current;
      ++reading.current;
    };
  }, []);
  const active = (scope: string, token?: number) =>
    live.current &&
    currentScope.current === scope &&
    (token === undefined || request.current === token);
  const refresh = useCallback(async () => {
    const scope = scopeKey,
      token = ++request.current;
    try {
      const rows = await api<LauncherLogRow[]>("launcher_logs");
      if (!active(scope, token)) return;
      setLogs(rows);
      setSelected((old) =>
        old && rows.some((row) => row.name === old)
          ? old
          : rows.find((row) => row.current)?.name || null,
      );
      setError("");
      if (operationsEnabled) {
        const retained = await api<LauncherLogRecoveryRow[]>(
          "launcher_log_recovery",
        );
        if (active(scope, token)) setRecovery(retained);
      } else setRecovery([]);
    } catch (e) {
      if (active(scope, token)) setError(String(e));
    }
  }, [api, scopeKey, operationsEnabled]);
  useEffect(() => {
    setSelected(null);
    setContent(null);
    setClearPlan(null);
    setRecovery([]);
    void refresh();
  }, [refresh, scopeKey]);
  const blocked = !native || !operationsEnabled || busy || working;
  const blockedReason = !native
    ? tr.t("logs.preview")
    : !operationsEnabled
      ? tr.t("logs.unavailable")
      : busy || working
        ? tr.t("common.working")
        : undefined;
  async function run(work: (scope: string) => Promise<void>) {
    if (
      !active(scopeKey) ||
      !gate.current.native ||
      !gate.current.operationsEnabled ||
      gate.current.busy ||
      admission.current
    )
      return;
    admission.current = true;
    setWorking(true);
    const scope = scopeKey;
    try {
      await work(scope);
    } catch (e) {
      if (active(scope)) onNotify(translator.current.serviceError(e));
    } finally {
      admission.current = false;
      if (active(scope)) setWorking(false);
    }
  }
  function read(row: LauncherLogRow) {
    const scope = scopeKey,
      token = ++reading.current;
    if (!active(scope)) return;
    setSelected(row.name);
    setContent(null);
    api<string>("launcher_read_log", { name: row.name })
      .then((text) => {
        if (active(scope) && reading.current === token) setContent(text);
      })
      .catch((e) => {
        if (active(scope) && reading.current === token)
          onNotify(translator.current.serviceError(e));
      });
  }
  function exportLogs(selection: LauncherLogSelection) {
    void run(async (scope) => {
      const plan = await api<LauncherLogExportPlan>(
        "launcher_prepare_log_export",
        { selection },
      );
      if (!active(scope)) return;
      const outcome = await api<LauncherLogExportOutcome | null>(
        "launcher_export_logs",
        { selection, revision: plan.revision },
      );
      if (outcome && active(scope))
        onNotify(
          translator.current.t("logs.exported", {
            count: translator.current.formatNumber(outcome.fileCount),
            path: outcome.path,
          }),
        );
    });
  }
  function prepareClear() {
    void run(async (scope) => {
      const plan = await api<LauncherLogClearPlan>(
        "launcher_prepare_log_clear",
      );
      if (!active(scope)) return;
      if (!plan.fileCount)
        onNotify(translator.current.t("logs.nothingToClear"));
      else setClearPlan(plan);
    });
  }
  function confirmClear() {
    if (!clearPlan) return;
    const plan = clearPlan;
    void run(async (scope) => {
      let outcome: LauncherLogClearOutcome;
      try {
        outcome = await api<LauncherLogClearOutcome>("launcher_clear_logs", {
          revision: plan.revision,
        });
      } catch (error) {
        if (active(scope)) {
          setClearPlan(null);
          await refresh();
        }
        throw error;
      }
      if (!active(scope)) return;
      setClearPlan(null);
      setContent(null);
      onNotify(
        translator.current.t("logs.cleared", {
          count: translator.current.formatNumber(outcome.fileCount),
        }),
      );
      await refresh();
    });
  }
  const date = (seconds: number) => tr.formatDate(seconds * 1000);
  return (
    <div className="extra-settings">
      <Card title={tr.t("logs.actions")}>
        <div className="ce-actions extra-log-actions">
          <button
            className="ce-button primary"
            disabled={
              blocked || (!selected && !logs.some((row) => row.current))
            }
            title={
              blockedReason ||
              (!selected && !logs.some((row) => row.current)
                ? tr.t("logs.selectFirst")
                : undefined)
            }
            onClick={() =>
              exportLogs(
                selected
                  ? { kind: "named", name: selected }
                  : { kind: "current" },
              )
            }
          >
            {tr.t("logs.export")}
          </button>
          <button
            className="ce-button"
            disabled={blocked || !logs.length}
            title={blockedReason}
            onClick={() => exportLogs({ kind: "all" })}
          >
            {tr.t("logs.exportAll")}
          </button>
          <button className="ce-button" onClick={() => onOpen("logs")}>
            {tr.t("logs.openFolder")}
          </button>
          <button
            className="ce-button danger"
            disabled={blocked}
            title={blockedReason}
            onClick={prepareClear}
          >
            {tr.t("logs.clear")}
          </button>
        </div>
      </Card>
      <Card title={tr.t("logs.all")}>
        {error ? (
          <p className="extra-muted" role="alert">
            {tr.serviceError(error)}
          </p>
        ) : !logs.length ? (
          <p className="extra-muted">{tr.t("logs.empty")}</p>
        ) : (
          logs.map((row) => (
            <button
              className="extra-log-row"
              key={row.name}
              aria-pressed={selected === row.name}
              disabled={working}
              style={
                selected === row.name
                  ? {
                      background:
                        "var(--launcher-selected-background, rgba(32,120,218,.08))",
                    }
                  : undefined
              }
              onClick={() => read(row)}
            >
              {date(row.modified)}
              {row.current ? tr.t("logs.currentSuffix") : ""}
              <small>{row.path}</small>
            </button>
          ))
        )}
        <div className="ce-actions extra-actions">
          <button
            className="ce-button"
            disabled={working}
            onClick={() => void refresh()}
          >
            {tr.t("logs.refresh")}
          </button>
        </div>
      </Card>
      {content !== null && (
        <Card title={tr.t("logs.content")} collapse>
          <pre className="log-view">{content}</pre>
        </Card>
      )}
      {!!recovery.length && (
        <Card title={tr.t("logs.recovery")} collapse>
          {recovery.map((row) => (
            <div
              key={row.operationId}
              style={{ margin: "10px", overflowWrap: "anywhere" }}
            >
              <p>
                {date(row.createdAt)} ·{" "}
                {tr.t("logs.count", { count: tr.formatNumber(row.fileCount) })}
              </p>
              {!!row.names.length && (
                <small>
                  {row.names.join(tr.language === "zh-CN" ? "、" : ", ")}
                </small>
              )}
              {row.warnings.map((warning) => (
                <p
                  className="extra-muted"
                  role="alert"
                  key={tr.serviceError(warning)}
                >
                  {tr.serviceError(warning)}
                </p>
              ))}
              <div className="ce-actions extra-actions">
                <button
                  className="ce-button"
                  disabled={blocked || !row.revision || row.warnings.length > 0}
                  title={
                    blockedReason ||
                    (!row.revision || row.warnings.length
                      ? tr.t("logs.retainedNeedsReview")
                      : undefined)
                  }
                  onClick={() =>
                    void run(async (scope) => {
                      const outcome = await api<LauncherLogRestoreOutcome>(
                        "launcher_restore_logs",
                        {
                          operationId: row.operationId,
                          revision: row.revision,
                        },
                      );
                      if (!active(scope)) return;
                      onNotify(
                        row.needsCompletion
                          ? translator.current.t("logs.completed")
                          : translator.current.t("logs.restored", {
                              count: translator.current.formatNumber(
                                outcome.fileCount,
                              ),
                            }),
                      );
                      await refresh();
                    })
                  }
                >
                  {row.needsCompletion
                    ? tr.t("logs.finish")
                    : tr.t("logs.restore")}
                </button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {clearPlan && (
        <div
          className="modal-shade rd-name-shade"
          onClick={() => {
            if (!working) setClearPlan(null);
          }}
        >
          <section
            className="modal rd-name-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="launcher-log-clear-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !working) {
                e.stopPropagation();
                setClearPlan(null);
              }
            }}
          >
            <header>
              <h2 id="launcher-log-clear-title">{tr.t("logs.clear")}</h2>
            </header>
            <p>
              {tr.t("logs.clearDescription", {
                count: tr.formatNumber(clearPlan.fileCount),
              })}
            </p>
            {clearPlan.retainedCurrent && (
              <p>
                {tr.t("logs.retainedCurrent", {
                  name: clearPlan.retainedCurrent,
                })}
              </p>
            )}
            <ul
              style={{
                maxHeight: "35vh",
                overflow: "auto",
                overflowWrap: "anywhere",
              }}
            >
              {clearPlan.names.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p>{tr.t("logs.clearHelp")}</p>
            <div className="ce-actions">
              <button
                className="ce-button"
                autoFocus
                disabled={working}
                onClick={() => setClearPlan(null)}
              >
                {tr.t("common.cancel")}
              </button>
              <button
                className="ce-button danger"
                disabled={blocked}
                onClick={confirmClear}
              >
                {tr.t("logs.confirmClear")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
