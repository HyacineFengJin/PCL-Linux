import { ExperimentalVersion } from "./ExperimentalVersion";
import { useEffect, useRef } from "react";
import type { Api } from "./types";
import { t, serviceError, type MessageKey } from "./i18n";
import { InstanceOperationDialog } from "./instanceOperationUi";
import "./extensionCompatibility.css";
import {
  useExtensionRequestScope,
  useExtensionView,
  type ExtensionRequest,
} from "./extensionRequestScope";
import {
  experimentalCall as call,
  type ExtensionEntry,
  type ExtensionReview,
  type ExtensionCompatibilityReport,
  type ExtensionCard,
  type ExperimentalNavigate,
} from "./experimentalTypes";
const capabilityLabel = (id: string) =>
  t(
    (
      {
        "ui.cards": "experimental.capCards",
        "launcher.navigate": "experimental.capNavigate",
        "instances.summary": "experimental.capSummary",
      } as Record<string, MessageKey>
    )[id],
  );

// Retirement does not depend on a successful cleanup RPC. The host's review
// TTL is the fallback if an old API is already unavailable.
function cancelReview(api: Api, token: string) {
  try {
    void call(api, "extensions_cancel", { token }).catch(() => {});
  } catch {}
}

/** Manifest titles and bodies are React text only. No plugin receives our Api,
 * DOM, settings or runtime object; card actions consume a native typed intent. */
export function ExperimentalCards({
  api,
  native,
  slot,
  onNavigate,
}: {
  api: Api;
  native: boolean;
  slot: "tools.cards" | "home.secondary";
  onNavigate: ExperimentalNavigate;
}) {
  type Summary = {
    minecraftVersion: string;
    loader: string;
    modCount: number;
    isolated: boolean;
  };
  const scope = useExtensionRequestScope(api, native, slot);
  const view = useExtensionView<{
    cards: ExtensionCard[];
    summary: Summary | null;
    error: string;
    busy: boolean;
  }>(scope.owner, { cards: [], summary: null, error: "", busy: false });
  const { cards, summary, error, busy } = view.value;
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    const request = scope.beginRead();
    if (request) {
      view.update({ cards: [], summary: null, error: "", busy: false });
      void call<ExtensionCard[]>(api, "extensions_cards", { slot })
        .then((v) => {
          if (request.current()) view.update({ cards: v });
        })
        .catch((e) => {
          if (request.current()) view.update({ error: serviceError(e) });
        })
        .finally(request.finish);
    }
    return () => request?.finish();
  }, [scope.owner]);
  async function act(card: ExtensionCard, actionId: string) {
    if (
      !scope.current() ||
      !view.current()?.cards.includes(card) ||
      !card.actions.some((a) => a.id === actionId && a.enabled)
    )
      return;
    const request = scope.beginOperation();
    if (!request) return;
    view.update({ busy: true, error: "" });
    try {
      const intent = await call<{
        kind: string;
        target: Parameters<ExperimentalNavigate>[0];
        summary: Summary;
      }>(api, "extensions_action", {
        extensionId: card.extensionId,
        cardId: card.id,
        actionId,
      });
      if (!request.current() || !view.current()?.cards.includes(card)) return;
      if (intent.kind === "navigate") navigate.current(intent.target);
      else if (intent.kind === "show-instance-summary")
        view.update({ summary: intent.summary });
    } catch (e) {
      if (request.current()) view.update({ error: serviceError(e) });
    } finally {
      if (request.current()) view.update({ busy: false });
      request.finish();
    }
  }
  return (
    <>
      {cards.map((card) => (
        <section
          key={`${card.extensionId}:${card.id}`}
          className="ce-card experimental-card"
        >
          <h2 className="ce-card-title">{card.title}</h2>
          <p className="experimental-origin">{card.extensionName}</p>
          <p className="experimental-body">{card.text}</p>
          <div className="ce-actions">
            {card.actions.map((a) => (
              <button
                key={a.id}
                className="ce-button"
                disabled={!a.enabled || busy || !native}
                onClick={() => void act(card, a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </section>
      ))}
      {error && cards.length > 0 && (
        <p className="experimental-error" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <section className="ce-card">
          <h2 className="ce-card-title">{t("experimental.summary")}</h2>
          <dl className="experimental-summary">
            <dt>{t("experimental.version")}</dt>
            <dd>{summary.minecraftVersion}</dd>
            <dt>{t("experimental.loader")}</dt>
            <dd>{summary.loader}</dd>
            <dt>{t("experimental.mods")}</dt>
            <dd>{summary.modCount}</dd>
            <dt>{t("experimental.isolated")}</dt>
            <dd>
              {t(summary.isolated ? "experimental.yes" : "experimental.no")}
            </dd>
          </dl>
          <button
            className="ce-button"
            onClick={() => {
              if (scope.current() && view.current()?.summary === summary)
                view.update({ summary: null });
            }}
          >
            {t("common.cancel")}
          </button>
        </section>
      )}
    </>
  );
}

export function ExperimentalExtensions({
  api,
  native,
  onNavigate,
}: {
  api: Api;
  native: boolean;
  onNavigate: ExperimentalNavigate;
}) {
  type Dialog = {
    owner: object;
    lifetime: object;
    api: Api;
    value: ExtensionReview | ExtensionCompatibilityReport;
    grants: string[];
    valid: boolean;
    released: boolean;
    committing: boolean;
  };
  const scope = useExtensionRequestScope(api, native, "extensions-manager");
  const view = useExtensionView<{
    entries: ExtensionEntry[];
    dialog: Dialog | null;
    safeMode: boolean;
    busy: boolean;
    error: string;
    revision: number;
  }>(scope.owner, {
    entries: [],
    dialog: null,
    safeMode: false,
    busy: false,
    error: "",
    revision: 0,
  });
  const { entries, dialog, safeMode, busy, error, revision } = view.value;
  const review = dialog && !("kind" in dialog.value) ? dialog.value : null;
  const compatibility = dialog && "kind" in dialog.value ? dialog.value : null;
  const grants = dialog?.grants ?? [];
  const activeDialog = useRef<Dialog | null>(null);

  const ownsDialog = (value: Dialog) =>
    value.valid &&
    activeDialog.current === value &&
    value.owner === scope.owner &&
    scope.ownsLifetime(value.lifetime);
  function retireDialog(value: Dialog, release = true) {
    value.valid = false;
    if (activeDialog.current === value) activeDialog.current = null;
    // Only pending consent is cancelled. Once confirm was submitted, the host
    // owns its transaction; renderer retirement is not an uninstall or rollback.
    if (
      release &&
      !value.released &&
      !value.committing &&
      !("kind" in value.value)
    ) {
      value.released = true;
      cancelReview(value.api, value.value.token);
    }
  }
  async function refresh(parent?: ExtensionRequest) {
    if (parent && !parent.current()) return;
    const request = scope.beginRead();
    if (!request) return;
    try {
      const result = await call<{
        entries: ExtensionEntry[];
        safeMode: boolean;
        warning: string | null;
      }>(api, "extensions_list");
      if (request.current() && (!parent || parent.current()))
        view.update({
          entries: result.entries,
          safeMode: result.safeMode,
          error: result.warning || "",
          revision: (view.current()?.revision ?? 0) + 1,
        });
    } catch (e) {
      if (request.current() && (!parent || parent.current()))
        view.update({ error: serviceError(e) });
    } finally {
      request.finish();
    }
  }
  useEffect(() => {
    if (scope.current()) {
      view.update({ dialog: null, busy: false });
      void refresh();
    }
    return () => {
      const pending = activeDialog.current;
      if (pending?.owner === scope.owner) retireDialog(pending);
    };
  }, [scope.owner]);
  async function perform(
    operation: (request: ExtensionRequest) => Promise<unknown>,
    refreshAfter = true,
  ) {
    // Ref admission closes the same-render double-click window before awaiting
    // or relying on React's rendered busy flag.
    const request = scope.beginOperation();
    if (!request) return;
    view.update({ busy: true, error: "" });
    try {
      await operation(request);
      if (request.current() && refreshAfter) await refresh(request);
    } catch (e) {
      if (request.current()) view.update({ error: serviceError(e) });
    } finally {
      if (request.current()) view.update({ busy: false });
      request.finish();
    }
  }
  function acceptReview(
    value: ExtensionReview | ExtensionCompatibilityReport,
    request: ExtensionRequest,
  ) {
    if (!request.current()) {
      // The submitted read may already have created a token. Release it through
      // its captured API, even though no follow-up workflow may use that API.
      if (!("kind" in value)) cancelReview(api, value.token);
      return;
    }
    if (activeDialog.current) retireDialog(activeDialog.current);
    const next: Dialog = {
      owner: scope.owner,
      lifetime: request.lifetime,
      api,
      value,
      grants:
        "kind" in value
          ? []
          : value.capabilities
              .filter((c) => c.currentlyGranted)
              .map((c) => c.id),
      valid: true,
      released: false,
      committing: false,
    };
    activeDialog.current = next;
    view.update({ dialog: next });
  }
  function dismiss(value: Dialog) {
    if (!ownsDialog(value) || value.committing) return;
    scope.retireOperation();
    retireDialog(value);
    view.update({ dialog: null, busy: false });
  }
  async function importReview(request: ExtensionRequest) {
    const picked = await api<{
      status: string;
      path?: string;
      message?: string;
    }>("experimental_choose", { kind: "extension" });
    if (!request.current()) return;
    if (picked.status === "selected")
      acceptReview(
        await call<ExtensionReview | ExtensionCompatibilityReport>(
          api,
          "extensions_review",
          { path: picked.path },
        ),
        request,
      );
    else if (picked.status === "unavailable") throw new Error(picked.message);
  }
  function performForEntry(
    entry: ExtensionEntry,
    operation: (request: ExtensionRequest) => Promise<unknown>,
    refreshAfter = true,
  ) {
    if (scope.current() && view.current()?.entries.includes(entry))
      void perform(operation, refreshAfter);
  }
  function confirm(value: Dialog) {
    if (
      !ownsDialog(value) ||
      value.committing ||
      "kind" in value.value ||
      value.value.capabilities.some(
        (c) => c.required && !value.grants.includes(c.id),
      )
    )
      return;
    const token = value.value.token;
    void perform(async (request) => {
      if (!request.current() || !ownsDialog(value)) return;
      value.committing = true;
      view.update({ dialog: value });
      try {
        await call(api, "extensions_confirm", {
          token,
          grants: [...value.grants],
        });
      } finally {
        // A consumed confirmation cannot be revived by saved callbacks, even
        // on failure. A fresh review is required for another consent attempt.
        retireDialog(value, false);
        if (request.current()) view.update({ dialog: null });
      }
    });
  }
  return (
    <>
      <section className="ce-card">
        <h2 className="ce-card-title">{t("experimental.extensions")}</h2>
        <p>{t("experimental.extensionsHelp")}</p>
        <div className="ce-actions">
          <button
            className="ce-button"
            disabled={busy || !native}
            onClick={() => void perform(importReview, false)}
          >
            {t("experimental.importExtension")}
          </button>
          <button
            className="ce-button"
            disabled={busy || !native}
            onClick={() => void perform(refresh, false)}
          >
            {t("experimental.refresh")}
          </button>
        </div>
        <label className="ce-check experimental-safe">
          <input
            type="checkbox"
            checked={safeMode}
            disabled={busy || !native}
            onChange={(e) => {
              const enabled = e.target.checked;
              void perform(() =>
                call(api, "extensions_safe_mode", { enabled }),
              );
            }}
          />
          <span>{t("experimental.safeMode")}</span>
        </label>
        <ExperimentalVersion version="0.6.1" />
      </section>
      {error && (
        <p className="experimental-error" role="alert">
          {error}
        </p>
      )}
      {entries.length === 0 && (
        <section className="ce-card">
          <p>{t("experimental.noExtensions")}</p>
        </section>
      )}
      {entries.map((entry) => (
        <section className="ce-card" key={entry.id}>
          <h2 className="ce-card-title">
            {entry.name}{" "}
            <span className="experimental-origin">
              {entry.version} ·{" "}
              {t(`experimental.state.${entry.state}` as MessageKey)}
            </span>
          </h2>
          <p className="experimental-origin">
            {t("experimental.publisher")}: {entry.publisher}
          </p>
          <div className="ce-actions">
            <button
              className="ce-button"
              disabled={busy || !native}
              onClick={() =>
                performForEntry(
                  entry,
                  async (request) =>
                    acceptReview(
                      await call<ExtensionReview>(api, "extensions_rereview", {
                        id: entry.id,
                      }),
                      request,
                    ),
                  false,
                )
              }
            >
              {t("experimental.reviewPermissions")}
            </button>
            <button
              className="ce-button"
              disabled={busy || !native || entry.state === "disabled"}
              onClick={() =>
                performForEntry(entry, () =>
                  call(api, "extensions_disable", { id: entry.id }),
                )
              }
            >
              {t("experimental.disable")}
            </button>
          </div>
          <h3 className="experimental-subtitle">
            {t("experimental.permissions")}
          </h3>
          {entry.grants.map((cap) => (
            <div className="experimental-permission" key={cap}>
              <span>{capabilityLabel(cap)}</span>
              <button
                className="ce-button"
                disabled={busy || !native}
                onClick={() =>
                  performForEntry(entry, () =>
                    call(api, "extensions_revoke", {
                      id: entry.id,
                      capability: cap,
                    }),
                  )
                }
              >
                {t("experimental.revoke")}
              </button>
            </div>
          ))}
        </section>
      ))}
      <ExperimentalCards
        key={revision}
        api={api}
        native={native}
        slot="tools.cards"
        onNavigate={onNavigate}
      />
      {compatibility && dialog && (
        <ExtensionCompatibilityDialog
          report={compatibility}
          onClose={() => dismiss(dialog)}
        />
      )}
      {review && dialog && (
        <InstanceOperationDialog
          title={t("experimental.permissions")}
          titleId="experimental-permission-title"
          busy={busy}
          committing={dialog.committing}
          confirmLabel={t("experimental.grant")}
          confirmDisabled={
            !native ||
            review.capabilities.some(
              (c) => c.required && !grants.includes(c.id),
            )
          }
          onClose={() => dismiss(dialog)}
          onConfirm={() => confirm(dialog)}
        >
          <h3>
            {review.name} · {review.version}
          </h3>
          <p>
            {t("experimental.publisher")}: {review.publisher}
          </p>
          {review.capabilities.map((cap) => (
            <label className="ce-check experimental-capability" key={cap.id}>
              <input
                type="checkbox"
                checked={grants.includes(cap.id)}
                disabled={busy}
                onChange={(e) => {
                  if (!ownsDialog(dialog) || dialog.committing || scope.busy())
                    return;
                  dialog.grants = e.target.checked
                    ? [...new Set([...dialog.grants, cap.id])]
                    : dialog.grants.filter((v) => v !== cap.id);
                  view.update({ dialog });
                }}
              />
              <span>
                <strong>
                  {capabilityLabel(cap.id)} ·{" "}
                  {t(
                    cap.required
                      ? "experimental.required"
                      : "experimental.optional",
                  )}
                </strong>
                <small>{cap.reason}</small>
              </span>
            </label>
          ))}
          <p className="experimental-origin experimental-digest">
            SHA-256: {review.digest}
          </p>
        </InstanceOperationDialog>
      )}
    </>
  );
}

/** Descriptors are text only; the report has no grants or install token. The
 * shared confirmation dialog keeps CE keyboard, focus and animation behavior. */
export function ExtensionCompatibilityDialog({
  report,
  onClose,
}: {
  report: ExtensionCompatibilityReport;
  onClose: () => void;
}) {
  const requirementKind = (required: boolean) =>
    t(required ? "experimental.required" : "experimental.optional");
  return (
    <InstanceOperationDialog
      title={t("experimental.compatTitle")}
      titleId="experimental-compatibility-title"
      busy={false}
      committing={false}
      confirmLabel={t("experimental.compatCannotInstall")}
      cancelLabel={t("experimental.compatClose")}
      confirmDisabled={true}
      onConfirm={() => {}}
      onClose={onClose}
    >
      <div className="extension-compatibility">
        <h3>
          {report.name} · {report.version}
        </h3>
        <p>{t("experimental.compatReadOnly")}</p>
        <dl className="experimental-summary">
          <dt>{t("experimental.compatEcosystem")}</dt>
          <dd>{report.ecosystem === "pcl-n" ? "PCL N" : "PCL Nex"}</dd>
          <dt>ID</dt>
          <dd>{report.id}</dd>
          <dt>{t("experimental.publisher")}</dt>
          <dd>{report.publisher ?? t("experimental.compatUndeclared")}</dd>
          <dt>{t("experimental.compatEntry")}</dt>
          <dd>{report.entryAssembly}</dd>
          {report.apiRange && (
            <>
              <dt>
                {t(
                  report.ecosystem === "pcl-n"
                    ? "experimental.compatApi"
                    : "experimental.compatCore",
                )}
              </dt>
              <dd>{report.apiRange}</dd>
            </>
          )}
        </dl>
        <ul>
          {report.findings.map((code) => (
            <li key={code}>{t(`experimental.compat.${code}`)}</li>
          ))}
        </ul>
        {report.requirements.length > 0 && (
          <>
            <h3>{t("experimental.compatServices")}</h3>
            <ul>
              {report.requirements.map((service) => (
                <li key={service.id}>
                  {service.id} · {service.range} ·{" "}
                  {requirementKind(service.required)} ·{" "}
                  {t(
                    service.coverage === "probe-only"
                      ? "experimental.compatProbeOnly"
                      : "experimental.compatUnavailable",
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {report.permissions.length > 0 && (
          <>
            <h3>{t("experimental.permissions")}</h3>
            <ul>
              {report.permissions.map((permission) => (
                <li key={permission.id}>
                  {permission.id} · {requirementKind(permission.required)}
                  <p>{permission.reason}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        {report.dependencies.length > 0 && (
          <>
            <h3>{t("experimental.compatDependencies")}</h3>
            <ul>
              {report.dependencies.map((dependency) => (
                <li key={dependency.id}>
                  {dependency.id} · {dependency.range} ·{" "}
                  {requirementKind(dependency.required)}
                </li>
              ))}
            </ul>
          </>
        )}
        {report.mixinConfigs.length > 0 && (
          <>
            <h3>{t("experimental.compatMixin")}</h3>
            <ul>
              {report.mixinConfigs.map((config) => (
                <li key={config}>{config}</li>
              ))}
            </ul>
          </>
        )}
        {report.platformDeclarations.length > 0 && (
          <>
            <h3>{t("experimental.compatPlatforms")}</h3>
            <ul>
              {report.platformDeclarations.map((platform) => (
                <li key={platform}>{platform}</li>
              ))}
            </ul>
          </>
        )}
        <p className="experimental-origin experimental-digest">
          SHA-256: {report.digest}
        </p>
      </div>
    </InstanceOperationDialog>
  );
}
