export const identifierProfile = "fabric-yarn-1.20.6-to-1.21-identifier-v1";
export type ImportedSource = {
  sourceId: string;
  files: Record<string, string>;
  skipped: string[];
};
export type PorterSource = {
  files: Record<string, string>;
  permittedPaths: string[];
  targetId: string;
  identifierProfile: string | null;
};
type Evidence = { path: string; line: number; excerpt?: string };
export type PorterDiagnostic = {
  code: string;
  severity: string;
  message: string;
  evidence?: Evidence;
};
export type PorterReport = {
  blockers: { code: string; title: string; detail: string }[];
  warnings: {
    code: string;
    title: string;
    detail: string;
    evidence: Evidence[];
  }[];
  dependencies: { id: string; constraint: unknown; target_status: string }[];
  steps: { title: string; action: string }[];
  catalog_checked_at: string;
  status: string;
};
export type PorterDomainResult = {
  recipe_id: string;
  status?: string;
  target_id?: string;
  diagnostics: PorterDiagnostic[];
  remaining_port_blockers: { code: string; message: string }[];
};
export type PorterRecipeResult = PorterDomainResult & {
  proposal: unknown | null;
  review?: { reviewId: string };
};
export type PorterOrigin = {
  provider: "modrinth" | "curseforge" | "mcmod";
  projectId: string;
  versionId: string | null;
  url: string;
  resolution: "reference-only" | "metadata-resolved";
  title?: string;
  sourceUrl?: string | null;
  license?: string | null;
};
export type PorterIntake = { id: string; title: string; url: string };
export type PorterMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: string;
  content: string;
  createdAt: string;
  jobId?: string;
  replyTo?: string;
  options?: string[];
  resolved?: boolean;
  details?: { completed: string[]; remaining: string[]; limitations: string[] };
};
export type PorterProject = {
  id: string;
  revision: number;
  name: string;
  goal: string;
  targetId: string;
  rights: string;
  acknowledgeBeta: boolean;
  identifierProfile: string | null;
  origin: PorterOrigin | null;
  archived: boolean;
  awaitingQuestion: string | null;
  activeRound: string | null;
  createdAt: string;
  updatedAt: string;
  snapshot: {
    files: Record<string, string>;
    permittedPaths: string[];
    revision: number;
    label: string;
    fingerprint: string;
  } | null;
  messages: PorterMessage[];
  rounds: {
    id: string;
    jobId: string;
    status: string;
    mode: string;
    targetId: string;
    baselineRevision: number;
    sourceFingerprint?: string;
    sourceRegistered?: boolean;
    createdAt: string;
    conversationThrough: string | null;
  }[];
};
export type PorterProjectList = {
  projects: {
    id: string;
    name: string;
    targetId: string;
    updatedAt: string;
    archived: boolean;
    hasSource: boolean;
    awaitingQuestion: boolean;
    activeRound: string | null;
    latestJobId: string | null;
    jobIds: string[];
    rounds: number;
  }[];
  unreadableProjectIds: string[];
};

// Mirror the host's path policy only to explain disabled choices. The Python
// contract remains authoritative; renderer checks never grant write authority.
export function porterPathCanBeGranted(path: string) {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) || "";
  return (
    !parts.some((part) =>
      [
        "gradle",
        ".github",
        ".git",
        "buildsrc",
        "build-logic",
        "scripts",
      ].includes(part),
    ) &&
    ![
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradle.properties",
      "gradlew",
      "gradlew.bat",
      "gradle-wrapper.properties",
      "gradle-wrapper.jar",
      "libs.versions.toml",
      "pom.xml",
      "package.json",
      "package-lock.json",
      "requirements.txt",
      "setup.py",
      "pyproject.toml",
      "makefile",
      "dockerfile",
    ].includes(name) &&
    !/\.(sh|bash|bat|cmd|ps1|exe|dll|so|dylib|jar|class|py|js|mjs|cjs)$/.test(
      name,
    )
  );
}
