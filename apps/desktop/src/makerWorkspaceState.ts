/** IDE navigation owns drafts and open tabs; the host owns project/feature
 * metadata and immutable sources. A feature is a user-defined unit of work,
 * rather than a template item or proof of compilation. */
import type { MakerProject } from "./experimentalProjectTypes";
import { t } from "./i18n";
export const makerKinds = [
  "items",
  "blocks",
  "rules",
  "systems",
  "assets",
  "other",
] as const;
export type MakerKind = (typeof makerKinds)[number];
export type MakerUnit = {
  id: string;
  name: string;
  kind: MakerKind;
  state: "planned" | "in_progress" | "ready";
  notes: string;
  files: string[];
  updatedAt?: string;
};
export type MakerUnitPage = {
  id: string;
  revision: string;
  workspaceRevision: string;
  counts: Record<MakerKind, number>;
  total: number;
  filteredCount: number;
  offset: number;
  nextOffset: number | null;
  units: (Omit<MakerUnit, "notes" | "files"> & { fileCount: number })[];
};
export type MakerUnitResult = {
  id: string;
  revision: string;
  workspaceRevision: string;
  unit: MakerUnit;
};
export type MakerRoute = {
  projectId: string;
  section:
    "overview" | "units" | "unit" | "source" | "history" | "tasks" | "settings";
  kind?: MakerKind;
  unitId?: string;
  jobId?: string;
  operationId?: string;
};
export type MakerPending = {
  id: string;
  name: string;
  notes: string;
  jobId: string;
};
export function createProjectManagerDraft() {
  return {
    screen: "library" as "library" | "create" | "register" | "workspace",
    route: { projectId: "", section: "overview" } as MakerRoute,
    tabs: [] as MakerRoute[],
    titles: new Map<string, string>(),
    notes: new Map<string, { name: string; notes: string; revision: string }>(),
    units: new Map<string, { unit: MakerUnit; revision: string }>(),
    prompts: new Map<string, string>(),
    pending: [] as MakerPending[],
    activeJobs: new Map<string, string[]>(),
    selectedVersions: new Map<string, string>(),
    buffers: new Map<
      string,
      { text: string; original: string; sha256: string }
    >(),
    aiOpen: true,
    treeOpen: true,
    newName: "",
    newGoal: "",
  };
}
export type MakerDraft = ReturnType<typeof createProjectManagerDraft>;
export function makerRouteKey(route: MakerRoute) {
  return JSON.stringify([
    route.projectId,
    route.section,
    route.kind ?? "",
    route.unitId ?? "",
    route.jobId ?? "",
    route.operationId ?? "",
  ]);
}
export function makerAiPrompt(
  project: Pick<MakerProject, "name">,
  request: string,
  selected?: MakerUnit,
  file?: string,
) {
  const prompt = [
    `Project: ${project.name}`,
    ...(selected
      ? [
          `Feature: ${selected.name} (${selected.kind})`,
          `Feature requirements:\n${selected.notes}`,
          `Related paths:\n${selected.files.join("\n")}`,
        ]
      : []),
    ...(file ? [`Selected source path: ${file}`] : []),
    `Request:\n${request}`,
    "Continue the selected source version. Preserve handwritten code. Propose changes for human review; explain missing APIs or unsupported requests.",
  ].join("\n\n");
  if (prompt.length > 12000) throw new Error(t("maker.promptTooLong"));
  return prompt;
}
