import type { Api } from "./types";
export type ExperimentalPage = "extensions" | "maker" | "porter";
export type ExperimentalNavigate = (
  target: "launch" | "instances" | "downloads" | "tools" | "settings",
) => void;
export type ExtensionEntry = {
  id: string;
  name: string;
  version: string;
  state: string;
  grants: string[];
  publisher: string;
  digest: string;
};
export type ExtensionReview = {
  token: string;
  id: string;
  name: string;
  version: string;
  publisher: string;
  digest: string;
  capabilities: {
    id: string;
    reason: string;
    required: boolean;
    currentlyGranted: boolean;
  }[];
};
export type ExtensionCard = {
  extensionId: string;
  extensionName: string;
  id: string;
  title: string;
  text: string;
  actions: { id: string; label: string; enabled: boolean }[];
};
export type JobSummary = {
  jobId: string;
  revision: number;
  workflow: "maker" | "porter";
  status: string;
  mode: "template" | "live";
  updatedAt: string;
  artifactState: string;
  blockedReason: string | null;
};
export type Artifact = {
  operationId: string;
  directory: string;
  files: string[];
};
export type JobView = {
  summary: JobSummary;
  mode: string;
  result: unknown;
  error?: { message: string };
  artifacts: Artifact[];
  reviews: string[];
};
export type ReviewView = {
  reviewId: string;
  reviewDigest: string;
  status: string;
  kind: string;
  preview: {
    diffs?: { path: string; diff?: string }[];
    changes?: { path: string; unified_diff: string }[];
    warnings?: string[];
    locked_files?: string[];
  };
};
export type EngineStatus = {
  versions: Record<string, string>;
  jobs: JobSummary[];
  liveConfigured: boolean;
  workspace: string;
  storeWarning: string | null;
};
export type MakerSpec = {
  schema_version: number;
  target: string;
  mod_id: string;
  name: string;
  description: string;
  items: {
    id: string;
    names: { en_us: string; zh_cn: string };
    color: string;
    max_count: number;
    recipe: { ingredients: string[]; count: number } | null;
  }[];
};
export type ExperimentalOperation =
  | "status"
  | "catalog"
  | "extensions_list"
  | "extensions_review"
  | "extensions_confirm"
  | "extensions_cancel"
  | "extensions_revoke"
  | "extensions_disable"
  | "extensions_rereview"
  | "extensions_safe_mode"
  | "extensions_cards"
  | "extensions_action"
  | "source_import"
  | "provider_configure"
  | "job_create"
  | "job_read"
  | "job_cancel"
  | "artifact_read"
  | "maker_review"
  | "porter_recipe"
  | "porter_review"
  | "review_read"
  | "review_apply"
  | "review_cancel"
  | "report_read";
export const experimentalCall = <T>(
  api: Api,
  operation: ExperimentalOperation,
  args: Record<string, unknown> = {},
) => api<T>("experimental_call", { operation, args });
