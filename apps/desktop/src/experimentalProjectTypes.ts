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
