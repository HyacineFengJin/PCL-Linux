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
