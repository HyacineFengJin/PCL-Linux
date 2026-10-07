/** Stream/index fixtures are private host artifacts, never user projects.
 * No generated code, compiler, game or model endpoint is executed. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobStore } from "../../../src/store.mjs";
import {
  captureSourceArtifact,
  sha256,
} from "../../../src/artifact-snapshot.mjs";
import {
  captureIndexedSource,
  indexPage,
  readIndexFile,
  searchIndex,
  INDEX_LIMITS,
} from "../source-index.mjs";
import { MakerProjects } from "../projects.mjs";
const scratch = fileURLToPath(
  new URL("../../../../../work/maker-index/qa/", import.meta.url),
);
async function fixture(t, large = true) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new JobStore(path.join(root, "jobs")).init();
  const job = await store.create({
    profile: "maker",
    provider: "pcl-template",
    input: {},
  });
  const workspace = await store.workspace(job.id),
    operationId = "index-source",
    directory = `generated/${operationId}`,
    artifacts = [];
  const files = {
    "src/main/java/Unicode.java": "// 开发🌸\n".repeat(6000),
    "image.png": Buffer.from([137, 80, 78, 71]),
  };
  for (let index = 0; index < (large ? 350 : 1); index++)
    files[`src/main/java/File${String(index).padStart(3, "0")}.java`] =
      `// File ${index}\n` +
      "// retained code\n".repeat(60) +
      (index === 349 ? "// a+b needle\n" : "");
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value),
      written = await workspace.writeBytes(`${directory}/${name}`, bytes);
    artifacts.push({ ...written, sha256: sha256(bytes) });
  }
  job.status = "completed";
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
  await store.save(job);
  const capture = async (id, operation) =>
    captureIndexedSource(store, await store.load(id), operation);
  return {
    root,
    store,
    job,
    workspace,
    operationId,
    directory,
    files,
    capture,
  };
}
test("large source index bypasses only read limits; paging and chunks remain bounded and lossless", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    captureSourceArtifact(value.store, value.job, value.operationId),
    /inventory/,
  );
  const source = await value.capture(value.job.id, value.operationId);
  assert.equal(source.snapshot.inventory.length, 352);
  assert.equal(source.snapshot.totalBytes > 256000, true);
  assert.equal("files" in source.snapshot, false); // no whole-tree byte bundle
  const seen = [];
  let next = 0;
  do {
    const page = indexPage(source, { offset: next });
    assert.equal(page.files.length <= 50, true);
    assert.equal(page.editableSnapshot, false);
    seen.push(...page.files.map((file) => file.path));
    next = page.nextOffset;
  } while (next !== null);
  assert.equal(new Set(seen).size, 352);
  assert.equal(indexPage(source, { filter: "Unicode" }).filteredCount, 1);
  const chunks = [];
  next = 0;
  do {
    const chunk = await readIndexFile(source, {
      path: "src/main/java/Unicode.java",
      offset: next,
    });
    assert.equal(
      Buffer.byteLength(chunk.content) <= INDEX_LIMITS.chunkBytes,
      true,
    );
    chunks.push(chunk.content);
    next = chunk.nextOffset;
  } while (next !== null);
  assert.equal(chunks.join(""), value.files["src/main/java/Unicode.java"]);
  await assert.rejects(
    readIndexFile(source, { path: "src/main/java/Unicode.java", offset: 4 }),
    /UTF-8/,
  );
  await assert.rejects(
    readIndexFile(source, { path: "image.png" }),
    /supported text/,
  );
  await assert.rejects(
    readIndexFile(source, { path: "../../private" }),
    /supported text/,
  );
  assert.throws(() => indexPage(source, { offset: -1 }), /cursor/);
  assert.throws(() => indexPage(source, { offset: 0.5 }), /cursor/);
});
test("literal search traverses finite pages and reports match truncation instead of completeness", async (t) => {
  const value = await fixture(t),
    source = await value.capture(value.job.id, value.operationId);
  const matches = [];
  let next = 0;
  do {
    const result = await searchIndex(source, { query: "a+b", offset: next });
    assert.equal(result.scannedFiles <= 32, true);
    assert.equal(result.scannedBytes <= 2000000, true);
    matches.push(...result.matches);
    next = result.nextOffset;
  } while (next !== null);
  assert.equal(matches.length, 1);
  assert.match(matches[0].path, /349/);
  assert.equal(matches[0].line, 62);
  const limited = await searchIndex(source, { query: "retained code" });
  assert.equal(limited.matches.length, 40);
  assert.match(limited.truncatedFile, /File000/);
  assert.equal(
    (await searchIndex(source, { query: "RETAINED CODE" })).matches.length,
    0,
  );
  await assert.rejects(searchIndex(source, { query: "" }), /search text/);
});
test("indexed fingerprints match legacy snapshots and any drift or unsafe entry blocks access", async (t) => {
  const value = await fixture(t, false);
  const indexed = await value.capture(value.job.id, value.operationId),
    legacy = await captureSourceArtifact(
      value.store,
      value.job,
      value.operationId,
    );
  assert.equal(indexed.snapshot.fingerprint, legacy.fingerprint);
  const file = path.join(
      value.workspace.root,
      value.directory,
      "src/main/java/File000.java",
    ),
    original = await fs.readFile(file);
  await fs.writeFile(file, "// changed source\n");
  await assert.rejects(
    value.capture(value.job.id, value.operationId),
    /changed|differ/,
  );
  await fs.writeFile(file, original);
  await fs.writeFile(
    path.join(value.workspace.root, value.directory, "unexpected.txt"),
    "unexpected",
  );
  await assert.rejects(
    value.capture(value.job.id, value.operationId),
    /inventory/,
  );
  await fs.unlink(
    path.join(value.workspace.root, value.directory, "unexpected.txt"),
  );
  const outside = path.join(value.root, "backup.java");
  await fs.rename(file, outside);
  await fs.symlink(outside, file);
  await assert.rejects(
    value.capture(value.job.id, value.operationId),
    /symlink|Symlinks/,
  );
  assert.deepEqual(await fs.readFile(outside), original);
});
test("index admission rejects oversized receipts before reading and keeps large directory inventories out of editing", async (t) => {
  const value = await fixture(t, false),
    job = structuredClone(value.job);
  const result = job.operations[0].result,
    entry = result.artifacts[0];
  result.artifacts = Array.from({ length: 1025 }, () => entry);
  await assert.rejects(
    captureIndexedSource(value.store, job, value.operationId),
    /inventory/,
  );
  result.artifacts = [{ ...entry, bytes: 1000001 }];
  await assert.rejects(
    captureIndexedSource(value.store, job, value.operationId),
    /inventory/,
  );
  result.artifacts = Array.from({ length: 9 }, (_, index) => ({
    ...entry,
    path: `${value.directory}/Large${index}.java`,
    bytes: 1000000,
  }));
  await assert.rejects(
    captureIndexedSource(value.store, job, value.operationId),
    /8 MB/,
  );
  for (let index = 0; index < 610; index++)
    await fs.mkdir(
      path.join(value.workspace.root, value.directory, `empty-${index}`),
    );
  const indexed = await value.capture(value.job.id, value.operationId);
  assert.equal(indexed.snapshot.totalBytes < 256000, true);
  assert.equal(indexPage(indexed).editableSnapshot, false);
  await assert.rejects(
    captureSourceArtifact(value.store, value.job, value.operationId),
    /entry limit/,
  );
});
test(
  "native-facing host registers a large version and exposes bounded read-only IPC without an AI preset",
  { timeout: 15000 },
  async (t) => {
    const value = await fixture(t),
      replies = [];
    const hostPath = fileURLToPath(
      new URL("../../../../host.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [hostPath, value.root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    const project = await rpc("project_create", {
      name: "Large source",
      notes: "Read-only inspection",
      jobId: value.job.id,
      operationId: value.operationId,
      label: "Index fixture",
    });
    const ref = {
      id: project.id,
      expectedRevision: project.revision,
      checkpointId: project.checkpoints[0].id,
    };
    const page = await rpc("project_files", ref);
    assert.equal(page.files.length, 50);
    assert.equal(page.editableSnapshot, false);
    assert.equal(
      (
        await rpc("project_file_read", {
          ...ref,
          path: "src/main/java/Unicode.java",
        })
      ).nextOffset !== null,
      true,
    );
    assert.equal(
      (await rpc("project_search", { ...ref, query: "a+b", offset: 320 }))
        .matches.length,
      1,
    );
    assert.match(await rpc("project_open", ref, false), /inventory/);
    assert.match(
      await rpc("project_files", { ...ref, expectedRevision: "stale" }, false),
      /changed/,
    );
    const file = path.join(
      value.workspace.root,
      value.directory,
      "src/main/java/File000.java",
    );
    await fs.appendFile(file, "changed");
    assert.match(
      await rpc(
        "project_file_read",
        { ...ref, path: "src/main/java/Unicode.java" },
        false,
      ),
      /changed|differ/,
    );
    assert.equal((await rpc("status")).liveAvailable, false);
    assert.equal(
      (await rpc("projects_list")).projects[0].revision,
      project.revision,
    );
    await rpc("shutdown");
  },
);
