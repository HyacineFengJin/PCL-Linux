/** Committed UI ownership, independent of host transaction ownership. Navigation
 * retires callbacks and display updates, never an admitted write. */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./types";
import { serviceError } from "./i18n";
export function useMakerScope(api: Api, native: boolean, key: string) {
  const scope = useMemo(
    () => ({
      active: false,
      working: false,
      sequence: new Map<string, number>(),
    }),
    [api, native, key],
  );
  const owner = useRef<object | null>(null),
    committed = useRef<object | null>(null);
  const view = useRef(0),
    render = {},
    version = view.current;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useLayoutEffect(() => {
    committed.current = render;
  });
  useLayoutEffect(() => {
    owner.current = scope;
    scope.active = true;
    setBusy(false);
    setError("");
    return () => {
      scope.active = false;
      if (owner.current === scope) owner.current = null;
    };
  }, [scope]);
  const current = () => scope.active && owner.current === scope;
  const responseCurrent = () => current() && view.current === version;
  const callbackCurrent = () =>
    native && responseCurrent() && committed.current === render;
  return {
    scope,
    busy,
    error,
    current,
    responseCurrent,
    callbackCurrent,
    setError,
    change(action: () => void) {
      if (!callbackCurrent()) return;
      view.current++;
      setError("");
      action();
    },
    readTicket(channel = "main") {
      const generation = view.current,
        request = (scope.sequence.get(channel) ?? 0) + 1;
      scope.sequence.set(channel, request);
      return () =>
        current() &&
        view.current === generation &&
        scope.sequence.get(channel) === request;
    },
    async perform(action: () => Promise<void>) {
      if (!callbackCurrent() || scope.working) return;
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
    },
  };
}
