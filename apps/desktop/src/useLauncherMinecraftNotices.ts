import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Api } from "./types";
import type { LauncherEffect } from "./launcherTypes";
import type { useLauncherPreferences } from "./useLauncherPreferences";
import { createTranslator, type Translator } from "./i18n";
import {
  validMinecraftNoticeView,
  type MinecraftNoticeItem,
  type MinecraftNoticeView,
} from "./launcherMinecraftNoticeTypes";
export type LauncherClosingSource = (
  listener: (closing: boolean) => void,
) => Promise<() => void>;
export type LauncherClosingPayload = { closing: boolean; generation: number };
export function validLauncherClosingPayload(
  value: unknown,
): value is LauncherClosingPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as LauncherClosingPayload;
  return (
    typeof payload.closing === "boolean" &&
    Number.isSafeInteger(payload.generation) &&
    payload.generation > 0
  );
}
/** Observe native admission without onCloseRequested, which would destroy the
 * window and bypass writer drain. One adapter remembers monotonic native state
 * across subscriptions; a late old false cannot reopen a newer closing owner. */
export function createLauncherClosingSource(
  subscribe: (listener: (payload: unknown) => void) => Promise<() => void> = (
    listener,
  ) =>
    getCurrentWindow().listen<unknown>("launcher_closing", (event) =>
      listener(event.payload),
    ),
): LauncherClosingSource {
  let latest: LauncherClosingPayload | null = null;
  return async (listener) => {
    let delivered = 0;
    const forward = (payload: LauncherClosingPayload) => {
      if (payload.generation <= delivered) return;
      delivered = payload.generation;
      listener(payload.closing);
    };
    const remove = await subscribe((value) => {
      if (
        !validLauncherClosingPayload(value) ||
        (latest &&
          (value.generation < latest.generation ||
            (value.generation === latest.generation &&
              value.closing !== latest.closing)))
      )
        return;
      latest = value;
      forward(value);
    });
    // Subscription can finish after an earlier listener retired. Replay only
    // the latest known native owner to the new listener, once per subscription.
    if (latest) forward(latest);
    return remove;
  };
}
const HOUR = 60 * 60 * 1000;
const effects: readonly LauncherEffect[] = ["minecraft_updates"];
const clock = () =>
  typeof performance === "undefined" ? Date.now() : performance.now();
const identity = (item: MinecraftNoticeItem) =>
  JSON.stringify([item.channel, item.versionId]);
export function minecraftNoticeMessage(
  items: readonly MinecraftNoticeItem[],
  tr: Translator,
) {
  const release = items.find((item) => item.channel === "release"),
    snapshot = items.find((item) => item.channel === "snapshot");
  return release && snapshot
    ? tr.t("minecraftNotice.bothFound", {
        release: release.versionId,
        snapshot: snapshot.versionId,
      })
    : release
      ? tr.t("minecraftNotice.releaseFound", { version: release.versionId })
      : snapshot
        ? tr.t("minecraftNotice.snapshotFound", { version: snapshot.versionId })
        : "";
}
/** One window owns serial check→display→ack. Obsolete physical work keeps the
 * admission slot until completion, then wakes latest intent. Receipt pending is
 * native authority; session display IDs survive context changes so retrying ack
 * never repeats an already adopted toast. No game/root state is read or changed. */
export function useLauncherMinecraftNotices({
  api,
  native,
  launcher,
  onNotify,
  disabled = false,
  subscribeClosing,
}: {
  api: Api;
  native: boolean;
  launcher: ReturnType<typeof useLauncherPreferences>;
  onNotify: (message: string) => void;
  disabled?: boolean;
  subscribeClosing?: LauncherClosingSource;
}) {
  const defaultSource = useRef<LauncherClosingSource | null>(null);
  if (!defaultSource.current)
    defaultSource.current = createLauncherClosingSource();
  const closingSource = subscribeClosing || defaultSource.current;
  const p = launcher.prefs,
    release = p.management.minecraft_release_notifications,
    snapshot = p.management.minecraft_snapshot_notifications;
  const policy = JSON.stringify([
    release,
    snapshot,
    p.network,
    launcher.importEpoch,
  ]);
  const validated = !!launcher.view.revision && !launcher.view.warning;
  const canListen = native && validated && (release || snapshot);
  const binding = useRef({ api, canListen, subscribeClosing: closingSource });
  if (
    binding.current.api !== api ||
    binding.current.canListen !== canListen ||
    binding.current.subscribeClosing !== closingSource
  )
    binding.current = { api, canListen, subscribeClosing: closingSource };
  const listenerOwner = binding.current;
  const [listening, setListening] = useState<object | null>(null),
    [completion, setCompletion] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const closing = useRef(false),
    closeGeneration = useRef(0),
    life = useRef<symbol | null>(null),
    pending = useRef<symbol | null>(null);
  const available =
    canListen &&
    listening === listenerOwner &&
    !disabled &&
    !launcher.busy &&
    !closing.current;
  const owner = useRef({
    api,
    policy,
    available,
    closeGeneration: closeGeneration.current,
  });
  if (
    owner.current.api !== api ||
    owner.current.policy !== policy ||
    owner.current.available !== available ||
    owner.current.closeGeneration !== closeGeneration.current
  )
    owner.current = {
      api,
      policy,
      available,
      closeGeneration: closeGeneration.current,
    };
  const scope = owner.current;
  const cadence = useRef({
    api,
    policy,
    closeGeneration: closeGeneration.current,
    nextDue: 0,
  });
  if (
    cadence.current.api !== api ||
    cadence.current.policy !== policy ||
    cadence.current.closeGeneration !== closeGeneration.current
  )
    cadence.current = {
      api,
      policy,
      closeGeneration: closeGeneration.current,
      nextDue: 0,
    };
  const displayed = useRef(new Set<string>()),
    lastError = useRef("");
  const latest = useRef({
    api,
    release,
    snapshot,
    onNotify,
    tr: createTranslator(p.localization),
    available,
    scope,
  });
  latest.current = {
    api,
    release,
    snapshot,
    onNotify,
    tr: createTranslator(p.localization),
    available,
    scope,
  };
  useEffect(() => {
    const lifetime = Symbol();
    life.current = lifetime;
    return () => {
      if (life.current === lifetime) life.current = null;
    };
  }, []);
  useEffect(() => {
    if (!canListen) return;
    let active = true,
      unlisten: (() => void) | undefined;
    void closingSource((value) => {
      if (!active || !life.current || binding.current !== listenerOwner) return;
      closing.current = value;
      closeGeneration.current++;
      // Retire synchronously: a promise callback can run before React renders.
      owner.current = {
        ...owner.current,
        available: false,
        closeGeneration: closeGeneration.current,
      };
      latest.current = { ...latest.current, available: false };
      setCompletion((value) => value + 1);
    })
      .then((remove) => {
        if (active && life.current && binding.current === listenerOwner) {
          unlisten = remove;
          setListening(listenerOwner);
        } else remove();
      })
      .catch((error) => {
        if (active && life.current && binding.current === listenerOwner) {
          const message = String(error);
          setError(message);
          if (message !== lastError.current) {
            lastError.current = message;
            try {
              latest.current.onNotify(latest.current.tr.serviceError(error));
            } catch {
              // A refused toast never authorizes a check or acknowledgement.
            }
          }
        }
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [listenerOwner]);
  async function read() {
    const state = latest.current,
      lifetime = life.current;
    if (
      !lifetime ||
      !state.available ||
      state.scope !== owner.current ||
      closing.current ||
      pending.current ||
      clock() < cadence.current.nextDue
    )
      return;
    const operation = Symbol(),
      captured = state.scope;
    pending.current = operation;
    setBusy(true);
    setError("");
    const current = () =>
      life.current === lifetime &&
      pending.current === operation &&
      owner.current === captured &&
      latest.current.available &&
      !closing.current;
    function due(view?: MinecraftNoticeView) {
      if (!current()) return;
      cadence.current.nextDue =
        clock() +
        Math.max(HOUR, view?.retryAt ? view.retryAt * 1000 - Date.now() : 0);
    }
    try {
      const value = await state.api<unknown>(
        "launcher_minecraft_updates_check",
        { refresh: cadence.current.nextDue !== 0 },
      );
      if (!current()) return;
      if (!validMinecraftNoticeView(value, state.release, state.snapshot))
        throw new Error(latest.current.tr.t("minecraftNotice.invalidResponse"));
      due(value);
      if (value.state === "unavailable" || value.state === "storageBlocked") {
        const warning =
          value.warning ||
          latest.current.tr.t(
            value.state === "storageBlocked"
              ? "minecraftNotice.storageBlocked"
              : "minecraftNotice.unavailable",
          );
        if (warning !== lastError.current) {
          lastError.current = warning;
          latest.current.onNotify(
            value.warning
              ? latest.current.tr.serviceError(value.warning)
              : warning,
          );
        }
        return;
      }
      lastError.current = "";
      if (value.state !== "ready" || !value.batch) return;
      const batch = value.batch,
        unseen = batch.items.filter(
          (item) => !displayed.current.has(identity(item)),
        );
      if (unseen.length) {
        try {
          latest.current.onNotify(
            minecraftNoticeMessage(unseen, latest.current.tr),
          );
        } catch (error) {
          if (current()) setError(String(error));
          return;
        }
        // Mark only after the existing toast callback accepted the merged message.
        for (const item of unseen) displayed.current.add(identity(item));
      }
      if (!current()) return;
      // Failure leaves native pending and session display IDs intact. Do not
      // immediately overwrite the accepted notice with an acknowledgement error.
      try {
        const ack = await state.api<unknown>("launcher_minecraft_updates_ack", {
          token: batch.token,
        });
        if (!current()) return;
        if (!validMinecraftNoticeView(ack, state.release, state.snapshot))
          throw new Error(
            latest.current.tr.t("minecraftNotice.invalidResponse"),
          );
        if (ack.warning) setError(ack.warning);
      } catch (error) {
        if (current()) setError(String(error));
      }
    } catch (error) {
      if (current()) {
        due();
        const message = String(error);
        setError(message);
        if (message !== lastError.current) {
          lastError.current = message;
          latest.current.onNotify(latest.current.tr.serviceError(error));
        }
      }
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        if (life.current) {
          setBusy(false);
          setCompletion((value) => value + 1);
        }
      }
    }
  }
  useEffect(() => {
    if (!available) return;
    void read();
    const focus = () => void read(),
      timer = window.setInterval(focus, HOUR);
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [scope, completion]);
  return { effects: native ? effects : [], busy, error };
}
