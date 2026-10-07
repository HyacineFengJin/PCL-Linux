/** Isolated organization persistence. Feature references never edit or grant
 * source access; rejected CAS/corrupt metadata retains existing files. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MakerProjects } from "../vendor/maker/projects.mjs";
import { MakerWorkspace } from "../vendor/maker/workspace.mjs";
const scratch = fileURLToPath(
  new URL("../../../work/maker-ide/qa/", import.meta.url),
);
const unit = (name = "Complex rules") => ({
  id: "",
  name,
  kind: "rules",
  state: "planned",
  notes: "Multi-stage behavior\n长期维护",
  files: ["src/main/java/example/Rules.java"],
});
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = await new MakerProjects(root, async () => ({
    job: { profile: "maker", status: "completed" },
    snapshot: { fingerprint: "a".repeat(64) },
  })).init();
  const project = await projects.create({
    name: "Long mod",
    jobId: randomUUID(),
    operationId: "generate-1",
    label: "First",
  });
  const workspace = await new MakerWorkspace(root, projects).init();
  const ref = { id: project.id, expectedRevision: project.revision };
  return {
    root,
    projects,
    project,
    workspace,
    ref,
    file: path.join(root, "maker-workspaces", `${project.id}.json`),
  };
}
test("feature documents persist independently and summary pages exclude full requirements", async (t) => {
  const f = await fixture(t),
    initial = await f.workspace.list(f.ref);
  const saved = await f.workspace.save({
    ...f.ref,
    expectedWorkspaceRevision: initial.workspaceRevision,
    unit: unit(),
  });
  const reopened = await new MakerWorkspace(f.root, f.projects).init(),
    page = await reopened.list(f.ref);
  assert.equal(page.total, 1);
  assert.equal(page.counts.rules, 1);
  assert.equal("notes" in page.units[0], false);
  assert.equal("files" in page.units[0], false);
  assert.deepEqual(
    (await reopened.read({ ...f.ref, unitId: saved.unit.id })).unit,
    saved.unit,
  );
  assert.deepEqual(await f.projects.get(f.project.id), f.project);
});
test("hundreds of features use bounded category/search pages", async (t) => {
  const f = await fixture(t),
    now = new Date().toISOString();
  await fs.writeFile(
    f.file,
    JSON.stringify({
      schemaVersion: 1,
      projectId: f.project.id,
      units: Array.from({ length: 300 }, (_, i) => ({
        ...unit(`Feature ${String(i).padStart(3, "0")}`),
        id: randomUUID(),
        kind: i < 150 ? "rules" : "systems",
        updatedAt: now,
      })),
    }),
  );
  const first = await f.workspace.list({ ...f.ref, kind: "rules" });
  assert.equal(first.total, 300);
  assert.equal(first.filteredCount, 150);
  assert.equal(first.units.length, 50);
  assert.equal(first.nextOffset, 50);
  const last = await f.workspace.list({ ...f.ref, kind: "rules", offset: 100 });
  assert.equal(last.units.length, 50);
  assert.equal(last.nextOffset, null);
  const search = await f.workspace.list({ ...f.ref, query: "Feature 299" });
  assert.equal(search.units.length, 1);
  assert.equal(search.units[0].kind, "systems");
});
test("stale workspace or project revisions retain the committed document", async (t) => {
  const f = await fixture(t),
    initial = await f.workspace.list(f.ref);
  const saved = await f.workspace.save({
    ...f.ref,
    expectedWorkspaceRevision: initial.workspaceRevision,
    unit: unit(),
  });
  const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(
    f.workspace.save({
      ...f.ref,
      expectedWorkspaceRevision: initial.workspaceRevision,
      unit: { ...unit("Stale"), id: saved.unit.id },
    }),
    /Workspace changed/,
  );
  await f.projects.update({
    ...f.ref,
    name: f.project.name,
    notes: "Changed project",
    archived: false,
  });
  await assert.rejects(
    f.workspace.save({
      ...f.ref,
      expectedWorkspaceRevision: saved.workspaceRevision,
      unit: unit("Stale project"),
    }),
    /Project changed/,
  );
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});
test("archive and invalid related paths reject writes without changing source records", async (t) => {
  const f = await fixture(t),
    initial = await f.workspace.list(f.ref);
  for (const files of [
    ["../outside"],
    ["/outside"],
    ["src\\A.java"],
    ["src//A.java"],
    ["src/./A.java"],
    ["same", "same"],
  ])
    await assert.rejects(
      f.workspace.save({
        ...f.ref,
        expectedWorkspaceRevision: initial.workspaceRevision,
        unit: { ...unit(), files },
      }),
    );
  const archived = await f.projects.update({
    ...f.ref,
    name: f.project.name,
    notes: "",
    archived: true,
  });
  await assert.rejects(
    f.workspace.save({
      id: archived.id,
      expectedRevision: archived.revision,
      expectedWorkspaceRevision: initial.workspaceRevision,
      unit: unit(),
    }),
    /Unarchive/,
  );
  assert.equal(
    (await f.projects.get(archived.id)).checkpoints[0].fingerprint,
    "a".repeat(64),
  );
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});
test("corruption, future schemas and linked metadata are retained and rejected", async (t) => {
  const f = await fixture(t);
  for (const bytes of [
    "{broken",
    JSON.stringify({ schemaVersion: 9, projectId: f.project.id, units: [] }),
  ]) {
    await fs.writeFile(f.file, bytes);
    await assert.rejects(f.workspace.list(f.ref));
    assert.equal(await fs.readFile(f.file, "utf8"), bytes);
  }
  const outside = path.join(f.root, "unrelated.json");
  await fs.writeFile(outside, "{} ");
  await fs.rm(f.file);
  await fs.symlink(outside, f.file);
  await assert.rejects(f.workspace.list(f.ref), /Symlinks/);
  assert.equal(await fs.readFile(outside, "utf8"), "{} ");
});
test("document update and capacity rejection preserve the previous workspace", async (t) => {
  const f = await fixture(t),
    initial = await f.workspace.list(f.ref);
  const saved = await f.workspace.save({
    ...f.ref,
    expectedWorkspaceRevision: initial.workspaceRevision,
    unit: unit(),
  });
  const { updatedAt, ...input } = saved.unit;
  const updated = await f.workspace.save({
    ...f.ref,
    expectedWorkspaceRevision: saved.workspaceRevision,
    unit: {
      ...input,
      state: "in_progress",
      notes: "More complex implementation",
    },
  });
  assert.equal(updated.unit.state, "in_progress");
  assert.notEqual(updated.workspaceRevision, saved.workspaceRevision);
  const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(
    f.workspace.save({
      ...f.ref,
      expectedWorkspaceRevision: updated.workspaceRevision,
      unit: { ...input, notes: "x".repeat(6001) },
    }),
  );
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("4096 document capacity and trailing identity characters reject additions without replacing metadata", async (t) => {
  const f = await fixture(t),
    now = new Date().toISOString();
  const units = Array.from({ length: 4096 }, () => ({
    ...unit("Rule"),
    id: randomUUID(),
    notes: "",
    files: [],
    updatedAt: now,
  }));
  await fs.writeFile(
    f.file,
    JSON.stringify({ schemaVersion: 1, projectId: f.project.id, units }),
  );
  const first = await f.workspace.list(f.ref),
    before = await fs.readFile(f.file, "utf8");
  assert.equal(first.total, 4096);
  assert.equal(first.units.length, 50);
  await assert.rejects(
    f.workspace.save({
      ...f.ref,
      expectedWorkspaceRevision: first.workspaceRevision,
      unit: unit(),
    }),
    /limit is 4096/,
  );
  await assert.rejects(
    f.workspace.save({
      ...f.ref,
      expectedWorkspaceRevision: first.workspaceRevision,
      unit: { ...unit(), id: units[0].id + "\n" },
    }),
    /Invalid feature identity/,
  );
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});
