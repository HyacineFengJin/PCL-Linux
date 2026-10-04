import { useEffect, useRef, useState } from "react";
import type { Api, JavaCatalog, Settings } from "./types";

type JavaScope = {
  api: Api;
  root: string;
  revision?: string;
  context: string;
};

function useJavaScope(api: Api, settings: Settings, context = "") {
  const root = settings.root_id || settings.root;
  const current = useRef<JavaScope>({
    api,
    root,
    revision: settings.revision,
    context,
  });
  if (
    current.current.api !== api ||
    current.current.root !== root ||
    current.current.revision !== settings.revision ||
    current.current.context !== context
  )
    current.current = { api, root, revision: settings.revision, context };
  return current;
}

export function useJavaCatalog(api: Api, settings: Settings) {
  const scope = useJavaScope(api, settings);
  const captured = scope.current;
  const [result, setResult] = useState<{
    scope: JavaScope;
    catalog: JavaCatalog;
    loading: boolean;
    error: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const isCurrent = () => live && scope.current === captured;
    setResult({
      scope: captured,
      catalog: { runtimes: [], unavailable: [] },
      loading: true,
      error: "",
    });
    // The parent API already binds the root. Old scans must not replace another
    // root's catalog or the catalog read for a newer settings revision.
    void api<JavaCatalog>("java_catalog")
      .then((catalog) => {
        if (isCurrent())
          setResult({ scope: captured, catalog, loading: false, error: "" });
      })
      .catch((error) => {
        if (isCurrent())
          setResult({
            scope: captured,
            catalog: { runtimes: [], unavailable: [] },
            loading: false,
            error: String(error),
          });
      });
    return () => {
      live = false;
    };
  }, [api, captured, scope]);
  return result?.scope === captured
    ? result
    : { catalog: { runtimes: [], unavailable: [] }, loading: true, error: "" };
}

export function useJavaAction({
  api,
  settings,
  context = "",
  native,
  disabled,
  onNotify,
}: {
  api: Api;
  settings: Settings;
  context?: string;
  native: boolean;
  disabled: boolean;
  onNotify: (message: string) => void;
}) {
  const scope = useJavaScope(api, settings, context);
  const captured = scope.current;
  const live = useRef(true);
  const blocked = !native || disabled || !settings.revision;
  const availability = useRef(blocked);
  availability.current = blocked;
  const operation = useRef<{ scope: JavaScope; token: symbol } | null>(null);
  const [activity, setActivity] = useState<typeof operation.current>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const pending = activity?.scope === captured;
  async function run(perform: (isCurrent: () => boolean) => Promise<void>) {
    if (
      !live.current ||
      scope.current !== captured ||
      availability.current ||
      operation.current?.scope === captured
    )
      return;
    const owned = { scope: captured, token: Symbol("java-selection") };
    operation.current = owned;
    setActivity(owned);
    // A portal or save can outlive navigation. Only its original revision and
    // view may publish notices or request a fresh settings snapshot.
    const isCurrent = () =>
      live.current && scope.current === captured && operation.current === owned;
    try {
      await perform(isCurrent);
    } catch (error) {
      if (isCurrent()) onNotify(String(error));
    } finally {
      if (operation.current === owned) operation.current = null;
      if (live.current)
        setActivity((current) => (current === owned ? null : current));
    }
  }
  return { disabled: blocked || pending, run };
}
