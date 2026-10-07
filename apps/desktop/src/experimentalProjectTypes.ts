import type { MakerSpec } from "./experimentalTypes";
export type ProjectCheckpoint = {
  id: string;
  label: string;
  createdAt: string;
  jobId: string;
  operationId: string;
  workflow: "maker" | "porter";
  fingerprint: string;
};
export type MakerProject = {
  id: string;
  revision: string;
  name: string;
  notes: string;
  archived: boolean;
  updatedAt: string;
  checkpoints: ProjectCheckpoint[];
};
export type ProjectSourceSelection = {
  workflow: "maker" | "porter";
  jobId: string;
  operationId: string;
  spec?: MakerSpec;
};

export type ProjectSourceRef = {
  id: string;
  expectedRevision: string;
  checkpointId: string;
};
export type ProjectIndexPage = {
  fingerprint: string;
  fileCount: number;
  totalBytes: number;
  editableSnapshot: boolean;
  filteredCount: number;
  nextOffset: number | null;
  files: { path: string; bytes: number; sha256: string; text: boolean }[];
};
export type ProjectFileChunk = {
  path: string;
  bytes: number;
  sha256: string;
  offset: number;
  content: string;
  nextOffset: number | null;
};
export type ProjectSearchPage = {
  query: string;
  fingerprint: string;
  scannedFiles: number;
  scannedBytes: number;
  matches: { path: string; sha256: string; line: number; snippet: string }[];
  nextOffset: number | null;
  truncatedFile: string | null;
};
export type ProjectComparisonRef = {
  id: string;
  expectedRevision: string;
  baseCheckpointId: string;
  targetCheckpointId: string;
};
export type ProjectComparisonIdentity = {
  id: string;
  revision: string;
  baseCheckpointId: string;
  targetCheckpointId: string;
  baseFingerprint: string;
  targetFingerprint: string;
};
export type ProjectFileChange = {
  path: string;
  kind: "added" | "deleted" | "modified";
  before: { bytes: number; sha256: string } | null;
  after: { bytes: number; sha256: string } | null;
};
export type ProjectComparisonPage = ProjectComparisonIdentity & {
  counts: {
    added: number;
    deleted: number;
    modified: number;
    unchanged: number;
  };
  totalChanges: number;
  filteredCount: number;
  changes: ProjectFileChange[];
  offset: number;
  pageSize: number;
  nextOffset: number | null;
};
export type ProjectComparisonSide = {
  bytes: number;
  sha256: string;
  status: "text" | "binary" | "unsupported_type" | "unsupported_encoding";
  truncated: boolean;
  previewBytes: number;
  previewLines: number;
};
export type ProjectComparisonPreview = ProjectComparisonIdentity & {
  change: ProjectFileChange;
  status: "text" | "uncomparable";
  before: ProjectComparisonSide | null;
  after: ProjectComparisonSide | null;
  rows: {
    kind: "context" | "added" | "deleted";
    beforeLine: number | null;
    afterLine: number | null;
    text: string;
  }[];
  limits: { bytes: number; lines: number; rows: number };
};
