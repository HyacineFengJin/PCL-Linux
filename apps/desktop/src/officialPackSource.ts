import type { Api } from "./types";
import { t } from "./i18n";

export type OfficialPackRequest = {
  project_id: string;
  version_id: string;
  file_name: string;
};
type InputStatus = {
  stage: string;
  message: string;
  error?: string;
  result?: {
    source_id: string;
    evidence: {
      request: OfficialPackRequest;
      project_title: string;
      version_name: string;
      file_name: string;
    };
  };
};
export function releasePackSource(api: Api, id: string) {
  if (id) void api("instance_pack_release", { sourceId: id }).catch(() => {});
}

/** A preparation task's result opens review, never the global install-success
 * route. The captured API owns release, including replies after navigation.
 * Once adopted, the dialog owns the input until a native install claim. */
export async function downloadPackSource(
  api: Api,
  request: OfficialPackRequest,
  owner: {
    current: () => boolean;
    adopt: (id: string) => void;
    progress: (message: string) => void;
  },
): Promise<{ id: string; label: string } | null> {
  const job = await api<{ id: string; sourceId: string }>(
    "instance_pack_download",
    { request },
  );
  if (!job.id || !job.sourceId?.startsWith("pack-source-v1:")) {
    if (typeof job.sourceId === "string") releasePackSource(api, job.sourceId);
    throw new Error(t("import.invalidPlan"));
  }
  if (!owner.current()) {
    releasePackSource(api, job.sourceId);
    return null;
  }
  owner.adopt(job.sourceId);
  try {
    for (;;) {
      const status = await api<InputStatus | null>("task_snapshot", {
        id: job.id,
      });
      if (!owner.current()) return null;
      if (!status) throw new Error(t("import.taskMissing"));
      if (status.stage === "error" || status.stage === "cancelled")
        throw new Error(status.error || status.message);
      owner.progress(
        t(
          status.stage === "downloading"
            ? "import.officialDownloading"
            : "import.officialChecking",
        ),
      );
      if (status.stage === "complete") {
        const result = status.result;
        const evidence = result?.evidence;
        if (
          result?.source_id !== job.sourceId ||
          !evidence ||
          evidence.request?.project_id !== request.project_id ||
          evidence.request.version_id !== request.version_id ||
          evidence.request.file_name !== request.file_name ||
          evidence.file_name !== request.file_name ||
          typeof evidence.project_title !== "string" ||
          typeof evidence.version_name !== "string"
        )
          throw new Error(t("import.planChanged"));
        return {
          id: job.sourceId,
          label: `${evidence.project_title} · ${evidence.version_name} · ${evidence.file_name}`,
        };
      }
      if (
        !["queued", "preparing", "processing", "downloading"].includes(
          status.stage,
        )
      )
        throw new Error(t("import.invalidPlan"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!owner.current()) return null;
    }
  } finally {
    if (!owner.current()) releasePackSource(api, job.sourceId);
  }
}
