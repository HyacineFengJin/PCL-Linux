/** Renderer projections only; the host binds every reference to project history. */
export type PorterVersionRef =
  | { kind: "input"; jobId: string }
  | { kind: "artifact"; jobId: string; operationId: string };
export type PorterVersion = {
  ref: PorterVersionRef;
  round: number;
  baselineRevision: number;
  createdAt: string;
};
export type PorterVersionList = {
  versions: PorterVersion[];
  omittedCopies: number;
};
export type PorterComparison = {
  projectId: string;
  left: { ref: PorterVersionRef; fingerprint: string };
  right: { ref: PorterVersionRef; fingerprint: string };
  counts: {
    added: number;
    deleted: number;
    modified: number;
    unchanged: number;
  };
  changes: {
    path: string;
    kind: "added" | "deleted" | "modified";
    beforeBytes: number;
    afterBytes: number;
    beforeHash: string | null;
    afterHash: string | null;
    diff: { text: string; truncated: boolean; coarse: boolean };
  }[];
  scope: "retained-project-text-only";
};
