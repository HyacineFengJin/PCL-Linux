/** Renderer ownership only. Retiring a page/request stops UI updates, never a
 * submitted host transaction. An uncertain approval remains blocked until a
 * fresh authoritative pending review permits retry; the host keeps final say.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Api } from "./types";
export type MakerSelection = {
  jobId: string;
  operationId: string;
  path: string;
  checkpoint: string;
  reviewJob: string;
  reviewId: string;
  reviewDigest: string;
};
export function useMakerRequests({
  api,
  native,
  page,
  sourceKey,
  selection,
  draft,
}: {
  api: Api;
  native: boolean;
  page: string;
  sourceKey: string;
  selection: MakerSelection;
  draft: {
    spec: unknown;
    mode: string;
    prompt: string;
    text: string;
    sha256?: string;
  };
}) {
  const scope = useMemo(
    () => ({ active: false, working: false, submitted: new Set<string>() }),
    [api, native, page, sourceKey],
  );
  const owner = useRef<object | null>(null),
    latest = useRef<{ render: object; draft: typeof draft } | null>(null);
  const target = useRef(selection),
    generation = useRef(0);
  const render = {},
    captured = generation.current;
  // Commit ownership before paint, including cleanup on unmount/API replacement.
  // A callback retained outside React must not outlive the committed controls.
  useLayoutEffect(() => {
    latest.current = { render, draft };
    target.current = selection;
  });
  useLayoutEffect(() => {
    owner.current = scope;
    scope.active = true;
    return () => {
      scope.active = false;
      if (owner.current === scope) owner.current = null;
    };
  }, [scope]);
  const isPageCurrent = () => scope.active && owner.current === scope;
  const isResponseCurrent = () =>
    isPageCurrent() &&
    generation.current === captured &&
    Object.keys(selection).every(
      (key) =>
        target.current[key as keyof MakerSelection] ===
        selection[key as keyof MakerSelection],
    ) &&
    Object.keys(draft).every(
      (key) =>
        latest.current?.draft[key as keyof typeof draft] ===
        draft[key as keyof typeof draft],
    );
  const isCallbackCurrent = () =>
    native &&
    page === "maker" &&
    isResponseCurrent() &&
    latest.current?.render === render;
  const key = (job: string, id: string, digest: string) =>
    JSON.stringify([job, id, digest]);
  return {
    scope,
    isPageCurrent,
    isResponseCurrent,
    isCallbackCurrent,
    invalidate(next: Partial<MakerSelection> = {}) {
      target.current = { ...target.current, ...next };
      generation.current++;
    },
    // Poll/read tickets capture the current generation at request admission,
    // not the generation of an effect installed before a later text edit.
    readTicket(expected: Partial<MakerSelection> = {}) {
      const version = generation.current;
      return () =>
        native &&
        isPageCurrent() &&
        generation.current === version &&
        Object.keys(expected).every(
          (field) =>
            target.current[field as keyof MakerSelection] ===
            expected[field as keyof MakerSelection],
        );
    },
    admit() {
      if (!isCallbackCurrent() || scope.working) return false;
      scope.working = true;
      return true;
    },
    finish() {
      scope.working = false;
    },
    isSubmitted(job: string, id: string, digest: string) {
      return scope.submitted.has(key(job, id, digest));
    },
    reserve(job: string, id: string, digest: string) {
      if (
        !isCallbackCurrent() ||
        scope.working ||
        target.current.reviewJob !== job ||
        target.current.reviewId !== id ||
        target.current.reviewDigest !== digest ||
        scope.submitted.has(key(job, id, digest))
      )
        return false;
      scope.submitted.add(key(job, id, digest));
      return true;
    },
    authoritativePending(job: string, id: string, digest: string) {
      scope.submitted.delete(key(job, id, digest));
    },
  };
}
