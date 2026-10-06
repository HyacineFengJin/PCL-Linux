import { useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import { t, serviceError, type MessageKey } from "./i18n";
import { InstanceOperationDialog } from "./instanceOperationUi";
import {
  experimentalCall as call,
  type ExtensionEntry,
  type ExtensionReview,
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
  const [cards, setCards] = useState<ExtensionCard[]>([]);
  const [summary, setSummary] = useState<{
    minecraftVersion: string;
    loader: string;
    modCount: number;
    isolated: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    let valid = true;
    if (native)
      void call<ExtensionCard[]>(api, "extensions_cards", { slot })
        .then((v) => {
          if (valid) setCards(v);
        })
        .catch((e) => {
          if (valid) setError(serviceError(e));
        });
    return () => {
      valid = false;
      live.current = false;
    };
  }, [api, native, slot]);
  async function act(card: ExtensionCard, actionId: string) {
    if (busy || !native) return;
    setBusy(true);
    setError("");
    try {
      const intent = await call<{
        kind: string;
        target: Parameters<ExperimentalNavigate>[0];
        summary: NonNullable<typeof summary>;
      }>(api, "extensions_action", {
        extensionId: card.extensionId,
        cardId: card.id,
        actionId,
      });
      if (!live.current) return;
      if (intent.kind === "navigate") onNavigate(intent.target);
      else if (intent.kind === "show-instance-summary")
        setSummary(intent.summary);
    } catch (e) {
      if (live.current) setError(serviceError(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <>
      {cards.map((card) => (
        <section
          key={`${card.extensionId}:${card.id}`}
          className="ce-card experimental-card"
        >
          <h2 className="ce-card-title">
            {card.title}
            <span className="experimental-badge">
              {t("experimental.badge")}
            </span>
          </h2>
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
          <button className="ce-button" onClick={() => setSummary(null)}>
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
  const [entries, setEntries] = useState<ExtensionEntry[]>([]),
    [review, setReview] = useState<ExtensionReview | null>(null),
    [grants, setGrants] = useState<string[]>([]);
  const [safeMode, setSafeMode] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const live = useRef(true);
  async function refresh() {
    const result = await call<{
      entries: ExtensionEntry[];
      safeMode: boolean;
      warning: string | null;
    }>(api, "extensions_list");
    if (live.current) {
      setEntries(result.entries);
      setSafeMode(result.safeMode);
      setError(result.warning || "");
      setRevision((v) => v + 1);
    }
  }
  useEffect(() => {
    live.current = true;
    if (native) void refresh().catch((e) => setError(serviceError(e)));
    return () => {
      live.current = false;
    };
  }, [api, native]);
  async function perform(operation: () => Promise<unknown>) {
    if (busy || !native) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (live.current) await refresh();
    } catch (e) {
      if (live.current) setError(serviceError(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  function acceptReview(value: ExtensionReview) {
    if (live.current) {
      setReview(value);
      setGrants(
        value.capabilities.filter((c) => c.currentlyGranted).map((c) => c.id),
      );
    }
  }
  const dismiss = () => {
    if (!review || busy) return;
    void call(api, "extensions_cancel", { token: review.token }).catch(
      () => {},
    );
    setReview(null);
  };
  return (
    <>
      <section className="ce-card">
        <h2 className="ce-card-title">
          {t("experimental.extensions")}{" "}
          <span className="experimental-badge">
            0.6 · {t("experimental.badge")}
          </span>
        </h2>
        <p>{t("experimental.extensionsHelp")}</p>
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
                }>("experimental_choose", { kind: "extension" });
                if (picked.status === "selected")
                  acceptReview(
                    await call<ExtensionReview>(api, "extensions_review", {
                      path: picked.path,
                    }),
                  );
                else if (picked.status === "unavailable")
                  throw new Error(picked.message);
              })
            }
          >
            {t("experimental.importExtension")}
          </button>
          <button
            className="ce-button"
            disabled={busy || !native}
            onClick={() => void perform(refresh)}
          >
            {t("experimental.refresh")}
          </button>
        </div>
        <label className="ce-check experimental-safe">
          <input
            type="checkbox"
            checked={safeMode}
            disabled={busy || !native}
            onChange={(e) =>
              void perform(() =>
                call(api, "extensions_safe_mode", {
                  enabled: e.target.checked,
                }),
              )
            }
          />
          <span>{t("experimental.safeMode")}</span>
        </label>
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
                void perform(async () =>
                  acceptReview(
                    await call<ExtensionReview>(api, "extensions_rereview", {
                      id: entry.id,
                    }),
                  ),
                )
              }
            >
              {t("experimental.reviewPermissions")}
            </button>
            <button
              className="ce-button"
              disabled={busy || !native || entry.state === "disabled"}
              onClick={() =>
                void perform(() =>
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
                  void perform(() =>
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
      {review && (
        <InstanceOperationDialog
          title={t("experimental.permissions")}
          titleId="experimental-permission-title"
          busy={busy}
          committing={busy}
          confirmLabel={t("experimental.grant")}
          confirmDisabled={
            !native ||
            review.capabilities.some(
              (c) => c.required && !grants.includes(c.id),
            )
          }
          onClose={dismiss}
          onConfirm={() =>
            void perform(async () => {
              await call(api, "extensions_confirm", {
                token: review.token,
                grants,
              });
              if (live.current) setReview(null);
            })
          }
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
                onChange={(e) =>
                  setGrants(
                    e.target.checked
                      ? [...grants, cap.id]
                      : grants.filter((v) => v !== cap.id),
                  )
                }
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
