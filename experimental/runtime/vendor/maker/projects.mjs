/** Launcher-owned project metadata. Source stays in immutable job artifacts.
 * The native host holds the exclusive experimental lease and serializes calls.
 * CAS revisions prevent stale editors from overwriting project notes; a single
 * atomic metadata replacement commits a checkpoint. Failed capture/write leaves
 * the previous record and every source artifact available for recovery.
 */
import fs from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { Workspace } from "../../src/workspace.mjs";
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const HEX = /^[a-f0-9]{64}(?![\s\S])/;
function need(ok, message) {
  if (!ok) throw new Error(message);
}
function text(value, max, label, multiline = false) {
  need(
    typeof value === "string" &&
      value.length <= max &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(
        value,
      ),
    `Invalid ${label}`,
  );
  need(
    multiline || (value.trim().length > 0 && !/[\t\r\n]/.test(value)),
    `Invalid ${label}`,
  );
  return multiline ? value : value.trim();
}
function exact(value, fields) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === [...fields].sort().join(),
    "Invalid project fields",
  );
}
export class MakerProjects {
  constructor(root, capture) {
    this.workspace = new Workspace(path.join(root, "projects"));
    this.capture = capture;
  }
  async init() {
    await this.workspace.init();
    return this;
  }
  file(id) {
    need(UUID.test(id), "Invalid project ID");
    return `${id}.json`;
  }
  validate(record) {
    exact(record, [
      "schemaVersion",
      "id",
      "name",
      "notes",
      "archived",
      "createdAt",
      "updatedAt",
      "checkpoints",
    ]);
    need(
      record.schemaVersion === 1 &&
        UUID.test(record.id) &&
        typeof record.archived === "boolean",
      "Unsupported project record",
    );
    text(record.name, 120, "name");
    text(record.notes, 8192, "notes", true);
    const date = (value) =>
      need(
        typeof value === "string" && new Date(value).toISOString() === value,
        "Invalid project timestamp",
      );
    date(record.createdAt);
    date(record.updatedAt);
    need(
      Array.isArray(record.checkpoints) &&
        record.checkpoints.length >= 1 &&
        record.checkpoints.length <= 128,
      "Project version limit is 128",
    );
    const ids = new Set();
    for (const point of record.checkpoints) {
      exact(point, [
        "id",
        "label",
        "createdAt",
        "jobId",
        "operationId",
        "workflow",
        "fingerprint",
      ]);
      need(
        UUID.test(point.id) && UUID.test(point.jobId) && !ids.has(point.id),
        "Invalid checkpoint ID",
      );
      ids.add(point.id);
      need(
        typeof point.operationId === "string" &&
          /^[a-zA-Z0-9_-]{1,120}(?![\s\S])/.test(point.operationId) &&
          ["maker", "porter"].includes(point.workflow) &&
          HEX.test(point.fingerprint),
        "Invalid checkpoint source",
      );
      text(point.label, 120, "version label");
      date(point.createdAt);
    }
    return record;
  }
  view(record) {
    return {
      ...record,
      revision: createHash("sha256")
        .update(JSON.stringify(record))
        .digest("hex"),
      verification: {
        source: "recorded",
        compilation: "not_run",
        game: "not_run",
      },
    };
  }
  async get(id) {
    const data = await this.workspace.read(this.file(id));
    const record = this.validate(JSON.parse(data.content));
    need(record.id === id, "Project identity mismatch");
    return this.view(record);
  }
  async list() {
    const names = (await fs.readdir(this.workspace.root)).filter((name) =>
      name.endsWith(".json"),
    );
    need(names.length <= 128, "Project limit is 128");
    return (
      await Promise.all(names.map((name) => this.get(name.slice(0, -5))))
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async checkpoint({ jobId, operationId, label }) {
    const { job, snapshot } = await this.capture(jobId, operationId);
    need(
      !["queued", "running"].includes(job.status),
      "Wait for the source job to finish",
    );
    return {
      id: randomUUID(),
      label: text(label, 120, "version label"),
      createdAt: new Date().toISOString(),
      jobId,
      operationId,
      workflow: job.profile,
      fingerprint: snapshot.fingerprint,
    };
  }
  async create({ name, notes = "", jobId, operationId, label }) {
    need((await this.list()).length < 128, "Project limit is 128");
    const now = new Date().toISOString();
    const record = {
      schemaVersion: 1,
      id: randomUUID(),
      name: text(name, 120, "name"),
      notes: text(notes, 8192, "notes", true),
      archived: false,
      createdAt: now,
      updatedAt: now,
      checkpoints: [await this.checkpoint({ jobId, operationId, label })],
    };
    await this.workspace.write(
      this.file(record.id),
      JSON.stringify(this.validate(record)),
    );
    return this.view(record);
  }
  async update({ id, expectedRevision, name, notes, archived, source }) {
    const current = await this.get(id);
    need(
      current.revision === expectedRevision,
      "Project changed; refresh before saving",
    );
    need(typeof archived === "boolean", "Invalid archive state");
    const { revision, verification, ...record } = current;
    record.name = text(name, 120, "name");
    record.notes = text(notes, 8192, "notes", true);
    record.archived = archived;
    if (source) {
      const point = await this.checkpoint(source);
      need(
        !record.checkpoints.some(
          (old) => old.fingerprint === point.fingerprint,
        ),
        "This source version is already recorded",
      );
      record.checkpoints.push(point);
    }
    record.updatedAt = new Date().toISOString();
    await this.workspace.write(
      this.file(id),
      JSON.stringify(this.validate(record)),
    );
    return this.view(record);
  }
  async source({ id, expectedRevision, checkpointId }, capture = this.capture) {
    const project = await this.get(id);
    need(
      project.revision === expectedRevision,
      "Project changed; refresh before continuing",
    );
    const point = project.checkpoints.find(
      (value) => value.id === checkpointId,
    );
    need(point, "Select a recorded source version");
    const captured = await capture(point.jobId, point.operationId);
    need(
      captured.snapshot.fingerprint === point.fingerprint,
      "Recorded source version changed",
    );
    need(
      !["queued", "running"].includes(captured.job.status),
      "Wait for the source job to finish",
    );
    return { project, point, ...captured };
  }
}
