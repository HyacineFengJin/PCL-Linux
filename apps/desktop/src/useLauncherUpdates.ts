import { useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import type { useLauncherPreferences } from "./useLauncherPreferences";
import type { LauncherEffect } from "./launcherTypes";
import { t } from "./i18n";

type View = {
  state: string;
  message: string | null;
  release: { token: string; version: string } | null;
  download: { state: string };
};
const effects: readonly LauncherEffect[] = ["updates"];

/** Automatic policy runs once for each selected channel/policy during this
 * window's lifetime. Changing to manual or importing new preferences invalidates
 * the next step; a late old-channel result cannot trigger a background download.
 * Manual checks and progress rendering belong to the update panel.
 */
export function useLauncherUpdates(
  api: Api,
  native: boolean,
  launcher: ReturnType<typeof useLauncherPreferences>,
  notify: (message: string) => void,
) {
  const selected = `${launcher.prefs.updates.channel}:${launcher.prefs.updates.policy}:${launcher.importEpoch}`;
  const current = useRef({ api, selected, notify });
  current.current = { api, selected, notify };
  const pending = useRef<symbol | null>(null);
  const mounted = useRef(true);
  const [completion, setCompletion] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ready = !!launcher.view.revision && !launcher.view.warning;
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (
      !native ||
      !ready ||
      launcher.prefs.updates.policy === "manual" ||
      attempted.current.has(selected) ||
      pending.current !== null
    )
      return;
    attempted.current.add(selected);
    const operation = Symbol();
    pending.current = operation;
    let live = true;
    void (async () => {
      const view = await api<View>("launcher_update_check");
      if (
        !live ||
        current.current.api !== api ||
        current.current.selected !== selected
      )
        return;
      if (view.state === "error") {
        current.current.notify(
          view.message ||
            t("common.serviceError", { error: "Update check failed" }),
        );
        return;
      }
      if (view.state !== "available" || !view.release) return;
      current.current.notify(
        t("updater.found", { version: view.release.version }),
      );
      if (launcher.prefs.updates.policy === "download") {
        const download = await api<View>("launcher_update_download", {
          token: view.release.token,
        });
        if (
          live &&
          current.current.selected === selected &&
          download.download.state === "staged"
        ) {
          current.current.notify(t("updater.stagedNotice"));
        }
      }
    })()
      .catch((error) => {
        if (
          live &&
          current.current.api === api &&
          current.current.selected === selected
        )
          current.current.notify(String(error));
      })
      .finally(() => {
        // A newer policy waits for the old native operation to finish. Starting
        // both would make the newer request fail Busy and consume its one attempt.
        if (pending.current !== operation) return;
        pending.current = null;
        if (mounted.current) setCompletion((value) => value + 1);
      });
    return () => {
      live = false;
    };
  }, [api, native, ready, launcher.prefs.updates.policy, selected, completion]);
  return { effects };
}
