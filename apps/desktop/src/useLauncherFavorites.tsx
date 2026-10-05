import { createContext, useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import type {
  LauncherFavoriteChange,
  LauncherFavoriteEntry,
  LauncherFavoriteView,
} from "./launcherFavoriteTypes";
import { t, serviceError } from "./i18n";

/** One app-level revision and admission serves both detail actions and the
 * Favorites page. A page/root unmount cannot let a late reply replace a newer
 * global view. Backend owns folder and provider metadata validation. */
export function useLauncherFavorites(
  api: Api,
  native: boolean,
  notify: (message: string) => void,
) {
  const [view, setView] = useState<LauncherFavoriteView>({
    revision: "",
    folders: [{ id: "default", name: "" }],
    entries: [],
    warning: null,
  });
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const identity = useRef({ api, native });
  if (identity.current.api !== api || identity.current.native !== native)
    identity.current = { api, native };
  const scope = identity.current;
  const live = useRef(true),
    pending = useRef<symbol | null>(null),
    sequence = useRef(0);
  const current = useRef({ view, notify });
  current.current = { view, notify };
  const active = () => live.current && identity.current === scope;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, []);
  async function reload(adoptRepair = false) {
    if (!active() || !native || pending.current) return;
    const captured = ++sequence.current,
      operation = Symbol();
    pending.current = operation;
    setLoading(true);
    setError("");
    try {
      const next = await api<LauncherFavoriteView>("launcher_favorites_read", {
        reload: adoptRepair,
      });
      if (!active() || sequence.current !== captured) return;
      current.current = { ...current.current, view: next };
      setView(next);
    } catch (error) {
      if (active() && sequence.current === captured) setError(String(error));
    } finally {
      if (active() && pending.current === operation) {
        pending.current = null;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    pending.current = null;
    sequence.current++;
    setBusy(false);
    setLoading(false);
    setError("");
    setView({
      revision: "",
      folders: [{ id: "default", name: "" }],
      entries: [],
      warning: null,
    });
    if (native) void reload();
    return () => {
      sequence.current++;
    };
  }, [scope]);
  async function change(
    change: LauncherFavoriteChange,
  ): Promise<LauncherFavoriteView> {
    if (
      !active() ||
      !native ||
      pending.current ||
      !current.current.view.revision ||
      current.current.view.warning ||
      current.current.view !== view
    )
      throw Error(t("favorites.changed"));
    const operation = Symbol(),
      captured = ++sequence.current;
    pending.current = operation;
    setBusy(true);
    setError("");
    try {
      const next = await api<LauncherFavoriteView>("launcher_favorites_patch", {
        expectedRevision: view.revision,
        change,
      });
      if (
        !active() ||
        pending.current !== operation ||
        sequence.current !== captured
      )
        throw Error(t("favorites.changed"));
      current.current = { ...current.current, view: next };
      setView(next);
      return next;
    } catch (error) {
      if (active() && pending.current === operation) {
        setError(String(error));
        current.current.notify(serviceError(error));
      }
      throw error;
    } finally {
      if (active() && pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return { owner: scope, view, busy, loading, error, native, reload, change };
}
export type LauncherFavoritesController = ReturnType<
  typeof useLauncherFavorites
> & { open: (entry: LauncherFavoriteEntry) => void };
export const LauncherFavoritesContext =
  createContext<LauncherFavoritesController | null>(null);
export function favoriteFolderName(folder: { id: string; name: string }) {
  return folder.id === "default" ? t("common.default") : folder.name;
}
