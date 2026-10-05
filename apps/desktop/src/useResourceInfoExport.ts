import { useEffect, useRef, useState } from "react";
import type { Api } from "./types";
import type { ResourceFile } from "./resourceUpdateTypes";
import { t, formatNumber, serviceError } from "./i18n";
type ExportOutcome = {
  status: "complete" | "cancelled" | "unavailable";
  path?: string;
  count?: number;
  warning?: string;
};
/** Native rereads selected file identities and serializes metadata; no client
 * description or arbitrary path determines source authority. The chooser can
 * outlive this list, so all UI responses belong to the captured list context. */
export function useResourceInfoExport({
  api,
  contextKey,
  native,
  id,
  kind,
  onNotify,
}: {
  api: Api;
  contextKey: string;
  native: boolean;
  id: string;
  kind: string;
  onNotify: (message: string) => void;
}) {
  const owner = useRef({ api, contextKey });
  if (owner.current.api !== api || owner.current.contextKey !== contextKey)
    owner.current = { api, contextKey };
  const scope = owner.current;
  const live = useRef(true),
    pending = useRef<object | null>(null);
  const callbacks = useRef({ onNotify, native });
  callbacks.current = { onNotify, native };
  const [working, setWorking] = useState<object | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () => live.current && owner.current === scope;
  async function exportInfo(files: readonly ResourceFile[]) {
    if (
      !current() ||
      !callbacks.current.native ||
      pending.current ||
      !files.length
    )
      return;
    const operation = { scope };
    pending.current = operation;
    setWorking(operation);
    try {
      const result = await api<ExportOutcome>("local_resource_info_export", {
        id,
        kind,
        files: files.map((file) => ({
          file_name: file.file_name,
          fingerprint: file.fingerprint,
        })),
      });
      if (!current() || pending.current !== operation) return;
      if (result.status === "complete")
        callbacks.current.onNotify(
          t("local.infoExported", {
            count: formatNumber(result.count || files.length),
            path: result.path || "",
          }),
        );
      if (result.status === "unavailable")
        callbacks.current.onNotify(
          result.warning
            ? serviceError(result.warning)
            : t("local.infoUnavailable"),
        );
      if (result.status === "complete" && result.warning)
        callbacks.current.onNotify(
          t("local.infoExportWarning", {
            path: result.path || "",
            warning: result.warning,
          }),
        );
    } catch (error) {
      if (current() && pending.current === operation)
        callbacks.current.onNotify(serviceError(error));
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        if (live.current) setWorking(null);
      }
    }
  }
  return { exportInfo, busy: !!working };
}
