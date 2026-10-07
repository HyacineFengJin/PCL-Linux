/** Private receipt fixtures only; comparisons never execute generated code,
 * build tools, games, AI providers or application settings. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { JobStore } from "../../../src/store.mjs";
import { sha256 } from "../../../src/artifact-snapshot.mjs";
import { captureIndexedSource } from "../source-index.mjs";
import { MakerProjects } from "../projects.mjs";
import {
  compareProjectSources,
  compareProjectFile,
  COMPARE_LIMITS,
} from "../source-compare.mjs";
const scratch = fileURLToPath(
  new URL("../../../../../work/maker-compare/qa/", import.meta.url),
);
async function fixture(t, count = 60) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "compare-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new JobStore(path.join(root, "jobs")).init();
  const job = await store.create({
    profile: "maker",
    provider: "pcl-template",
    input: {},
  });
  const workspace = await store.workspace(job.id);
  const before = {
    "same.java": "unchanged\n",
    "changed.java": "first\nold\nlast\n",
    "deleted.java": "removed\n",
    "image.png": Buffer.from([137, 80, 78, 71]),
    "bom.txt": "\ufeffsame\n",
    "large.java": "// 旧🌸\n".repeat(8000),
    "long.java": "旧".repeat(12000),
    "creator-state.json": '{"protected":["changed.java"]}',
  };
  const after = {
    ...before,
    "changed.java": "first\nnew\nlast\n",
    "added.java": "added\n",
    "empty.txt": "",
    "image.png": Buffer.from([137, 80, 78, 72]),
    "bom.txt": "same\n",
    "encoding.java": Buffer.from([0xff]),
    "controls.txt": Buffer.from([0, 1]),
    "late-invalid.java": Buffer.concat([
      Buffer.from("// prefix\n".repeat(5000)),
      Buffer.from([0xff]),
    ]),
    "large.java": "// 新🌸\n".repeat(8000),
    "long.java": "新".repeat(12000),
  };
  delete after["deleted.java"];
  for (let i = 0; i < count; i++) {
    before[`old/File${String(i).padStart(3, "0")}.java`] = "old\n";
    after[`new/File${String(i).padStart(3, "0")}.java`] = "new\n";
  }
  for (const [operationId, files] of [
    ["before", before],
    ["after", after],
  ]) {
    const directory = `generated/${operationId}`,
      artifacts = [];
    for (const [name, value] of Object.entries(files)) {
      const bytes = Buffer.from(value);
      const written = await workspace.writeBytes(`${directory}/${name}`, bytes);
      artifacts.push({ ...written, sha256: sha256(bytes) });
    }
    job.operations.push({
      id: operationId,
      name: "maker.generate",
      status: "completed",
      result: {
        status: "source_generated_only",
        outputDirectory: directory,
        artifacts,
      },
    });
  }
  job.status = "completed";
  await store.save(job);
  const projects = await new MakerProjects(root, async (id, operation) =>
    captureIndexedSource(store, await store.load(id), operation),
  ).init();
  let project = await projects.create({
    name: "Comparison fixture",
    notes: "Retain handwriting",
    jobId: job.id,
    operationId: "before",
    label: "Baseline",
  });
  project = await projects.update({
    id: project.id,
    expectedRevision: project.revision,
    name: project.name,
    notes: project.notes,
    archived: false,
    source: { jobId: job.id, operationId: "after", label: "Target" },
  });
  const ref = {
    id: project.id,
    expectedRevision: project.revision,
    baseCheckpointId: project.checkpoints[0].id,
    targetCheckpointId: project.checkpoints[1].id,
  };
  return { root, store, job, workspace, projects, project, ref, before, after };
}
async function durableBytes(root) {
  const result = {};
  async function walk(directory, relative = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name),
        full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else result[name] = sha256(await fs.readFile(full));
    }
  }
  await walk(root);
  return result;
}
test("registered comparison paginates added/deleted/modified paths and reverses direction without mutating durable records", async (t) => {
  const f = await fixture(t),
    original = await durableBytes(f.root);
  const changes = [];
  let offset = 0,
    first;
  do {
    const page = await compareProjectSources(f.projects, { ...f.ref, offset });
    first ??= page;
    assert.equal(page.changes.length <= COMPARE_LIMITS.pageFiles, true);
    assert.equal(page.baseFingerprint, f.project.checkpoints[0].fingerprint);
    assert.equal(page.targetFingerprint, f.project.checkpoints[1].fingerprint);
    changes.push(...page.changes);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(
    new Set(changes.map((value) => value.path)).size,
    changes.length,
  );
  assert.deepEqual(first.counts, {
    added: 65,
    deleted: 61,
    modified: 5,
    unchanged: 2,
  });
  assert.equal(first.totalChanges, 131);
  assert.equal(
    changes.find((value) => value.path === "changed.java").kind,
    "modified",
  );
  const reverse = await compareProjectSources(f.projects, {
    ...f.ref,
    baseCheckpointId: f.ref.targetCheckpointId,
    targetCheckpointId: f.ref.baseCheckpointId,
  });
  assert.deepEqual(reverse.counts, {
    added: 61,
    deleted: 65,
    modified: 5,
    unchanged: 2,
  });
  assert.equal(
    (await compareProjectSources(f.projects, { ...f.ref, filter: "changed" }))
      .filteredCount,
    1,
  );
  assert.deepEqual(await durableBytes(f.root), original);
});
test("text previews show bounded line additions/deletions with byte/line truncation and preserve UTF-8/BOM distinctions", async (t) => {
  const f = await fixture(t, 0),
    original = await durableBytes(f.root);
  const read = (name) =>
    compareProjectFile(f.projects, { ...f.ref, path: name });
  const changed = await read("changed.java");
  assert.equal(changed.status, "text");
  assert.deepEqual(
    changed.rows.slice(0, 3).map((row) => [row.kind, row.text]),
    [
      ["context", "first"],
      ["deleted", "old"],
      ["added", "new"],
    ],
  );
  assert.equal(changed.rows[1].beforeLine, 2);
  assert.equal(changed.rows[2].afterLine, 2);
  const added = await read("added.java"),
    removed = await read("deleted.java");
  assert.equal(added.before, null);
  assert.equal(
    added.rows.every((row) => row.kind === "added"),
    true,
  );
  assert.equal(removed.after, null);
  assert.equal(
    removed.rows.every((row) => row.kind === "deleted"),
    true,
  );
  assert.deepEqual((await read("empty.txt")).rows, []);
  assert.equal(
    (await read("bom.txt")).rows.some(
      (row) => row.kind === "deleted" && row.text.startsWith("\ufeff"),
    ),
    true,
  );
  for (const name of ["large.java", "long.java"]) {
    const value = await read(name);
    assert.equal(value.rows.length <= 400, true);
    for (const side of [value.before, value.after]) {
      assert.equal(side.truncated, true);
      assert.equal(side.previewBytes <= 16384, true);
      assert.equal(side.previewLines <= 200, true);
    }
    assert.equal(
      value.rows.some((row) => row.text.includes("\ufffd")),
      false,
    );
  }
  assert.deepEqual(await durableBytes(f.root), original);
});
test("binary, unsupported types and invalid UTF-8 including bytes beyond the preview produce explicit uncomparable results", async (t) => {
  const f = await fixture(t, 0);
  for (const [name, status] of [
    ["image.png", "unsupported_type"],
    ["encoding.java", "unsupported_encoding"],
    ["late-invalid.java", "unsupported_encoding"],
    ["controls.txt", "binary"],
  ]) {
    const value = await compareProjectFile(f.projects, {
      ...f.ref,
      path: name,
    });
    assert.equal(value.status, "uncomparable");
    assert.equal(value.after.status, status);
    assert.deepEqual(value.rows, []);
  }
});
test("stale revisions, unknown versions, unsafe paths, unchanged files and invalid cursors are rejected", async (t) => {
  const f = await fixture(t, 0);
  for (const offset of [-1, 1.5, 2049])
    await assert.rejects(
      compareProjectSources(f.projects, { ...f.ref, offset }),
      /cursor/,
    );
  await assert.rejects(
    compareProjectSources(f.projects, { ...f.ref, filter: "\n" }),
    /filter/,
  );
  await assert.rejects(
    compareProjectSources(f.projects, { ...f.ref, expectedRevision: "stale" }),
    /changed/,
  );
  await assert.rejects(
    compareProjectSources(f.projects, {
      ...f.ref,
      targetCheckpointId: f.ref.baseCheckpointId,
    }),
    /different/,
  );
  await assert.rejects(
    compareProjectSources(f.projects, {
      ...f.ref,
      targetCheckpointId: "missing",
    }),
    /recorded/,
  );
  for (const name of ["../outside.java", "same.java", "missing.java"])
    await assert.rejects(
      compareProjectFile(f.projects, { ...f.ref, path: name }),
      /changed indexed/,
    );
});
test("receipt drift and post-index tampering remain errors rather than encoding limitations", async (t) => {
  const f = await fixture(t, 0);
  const tampered = path.join(f.workspace.root, "generated/after/changed.java");
  const source = f.projects.source.bind(f.projects);
  const raced = {
    async source(ref) {
      const value = await source(ref);
      if (ref.checkpointId === f.ref.targetCheckpointId)
        await fs.appendFile(tampered, "tamper");
      return value;
    },
  };
  await assert.rejects(
    compareProjectFile(raced, { ...f.ref, path: "changed.java" }),
    /changed|differ/,
  );
  await assert.rejects(
    compareProjectSources(f.projects, f.ref),
    /changed|differ/,
  );
});
test("larger registered versions remain read-only and union paging is bounded independently of edit limits", async (t) => {
  const f = await fixture(t, 340);
  const page = await compareProjectSources(f.projects, f.ref);
  assert.equal(page.changes.length, 50);
  assert.equal(page.totalChanges, 691);
  const end = await compareProjectSources(f.projects, {
    ...f.ref,
    offset: 650,
  });
  assert.equal(end.changes.length, 41);
  assert.equal(end.nextOffset, null);
});

test("a registered Porter receipt can be compared to a Maker version without source grants or changes", async (t) => {
  const f = await fixture(t, 0);
  const job = await f.store.create({
    profile: "porter",
    provider: "pcl-template",
    input: {},
  });
  const workspace = await f.store.workspace(job.id),
    reviewId = randomUUID();
  const bytes = Buffer.from("ported source\n");
  const artifact = await workspace.writeBytes(
    `reviewed/${reviewId}/changed.java`,
    bytes,
  );
  job.status = "completed";
  job.operations.push({
    id: `host-${reviewId}`,
    name: "porter.apply_patch",
    status: "completed",
    result: {
      status: "reviewed_copy_created",
      reviewId,
      outputDirectory: `reviewed/${reviewId}`,
      artifacts: [{ ...artifact, sha256: sha256(bytes) }],
    },
  });
  await f.store.save(job);
  const project = await f.projects.update({
    id: f.project.id,
    expectedRevision: f.project.revision,
    name: f.project.name,
    notes: f.project.notes,
    archived: false,
    source: {
      jobId: job.id,
      operationId: `host-${reviewId}`,
      label: "Ported version",
    },
  });
  const original = await durableBytes(f.root);
  const ref = {
    ...f.ref,
    expectedRevision: project.revision,
    targetCheckpointId: project.checkpoints.at(-1).id,
  };
  const value = await compareProjectFile(f.projects, {
    ...ref,
    path: "changed.java",
  });
  assert.equal(value.status, "text");
  assert.equal(
    value.rows.some(
      (row) => row.kind === "added" && row.text === "ported source",
    ),
    true,
  );
  assert.deepEqual(await durableBytes(f.root), original);
});
test(
  "native-facing comparison IPC verifies both registered versions without AI configuration or source writes",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, 0),
      original = await durableBytes(f.root),
      replies = [];
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../../../host.mjs", import.meta.url)), f.root],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => replies.push(JSON.parse(line)));
    t.after(() => {
      child.kill("SIGKILL");
      lines.close();
    });
    async function rpc(operation, args = {}, ok = true) {
      child.stdin.write(JSON.stringify({ operation, args }) + "\n");
      const deadline = Date.now() + 8000;
      while (!replies.length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const reply = replies.shift();
      assert.ok(reply, "Host response timed out");
      assert.equal(reply.ok, ok, reply.error);
      return ok ? reply.result : reply.error;
    }
    assert.equal((await rpc("project_compare", f.ref)).counts.modified, 5);
    assert.equal(
      (await rpc("project_compare_file", { ...f.ref, path: "changed.java" }))
        .status,
      "text",
    );
    assert.equal(
      (await rpc("project_compare_file", { ...f.ref, path: "image.png" }))
        .status,
      "uncomparable",
    );
    assert.match(
      await rpc(
        "project_compare",
        { ...f.ref, expectedRevision: "stale" },
        false,
      ),
      /changed/,
    );
    assert.equal((await rpc("status")).liveAvailable, false);
    assert.equal(
      (await rpc("projects_list")).projects[0].revision,
      f.project.revision,
    );
    await rpc("shutdown");
    // A host lease file is session control, not project/source/AI metadata.
    const current = await durableBytes(f.root);
    for (const [name, digest] of Object.entries(original))
      assert.equal(current[name], digest, name);
    assert.deepEqual(
      Object.keys(current).filter((name) => !(name in original)),
      [],
    );
  },
);
