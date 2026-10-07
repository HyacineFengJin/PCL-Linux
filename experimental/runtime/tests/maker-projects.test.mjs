/** Isolated project persistence and real Pi 1.0.4 continuation over loopback.
 * Generated Java, build scripts and games are never executed. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MakerProjects } from "../vendor/maker/projects.mjs";
const scratch = fileURLToPath(
  new URL("../../../work/maker-increment/qa/", import.meta.url),
);
const hostPath = fileURLToPath(new URL("../../host.mjs", import.meta.url));
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "projects-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause();
  }
  throw new Error("Offline project check timed out");
}
test("project notes, archive and history persist; stale saves and changed sources retain prior data", async (t) => {
  const root = await fixture(t),
    jobId = randomUUID();
  let fingerprint = "a".repeat(64),
    status = "completed";
  const capture = async () => ({
    job: { profile: "maker", status },
    snapshot: { fingerprint },
  });
  const store = await new MakerProjects(root, capture).init();
  const first = await store.create({
    name: "Long-lived mod",
    notes: "Preserve events.\n长期维护",
    label: "Initial",
    jobId,
    operationId: "generate-1",
  });
  const next = await store.update({
    id: first.id,
    expectedRevision: first.revision,
    name: first.name,
    notes: "Updated notes",
    archived: true,
  });
  await assert.rejects(
    store.update({
      id: first.id,
      expectedRevision: first.revision,
      name: "Lost draft",
      notes: "Stale",
      archived: false,
    }),
    /changed/,
  );
  const reopened = await new MakerProjects(root, capture).init();
  assert.deepEqual(await reopened.list(), [next]);
  fingerprint = "b".repeat(64);
  await assert.rejects(
    reopened.source({
      id: next.id,
      expectedRevision: next.revision,
      checkpointId: next.checkpoints[0].id,
    }),
    /changed/,
  );
  status = "running";
  await assert.rejects(
    reopened.update({
      id: next.id,
      expectedRevision: next.revision,
      name: next.name,
      notes: next.notes,
      archived: false,
      source: { jobId, operationId: "generate-2", label: "Next" },
    }),
    /finish/,
  );
  assert.deepEqual(await reopened.get(first.id), next);
  status = "completed";
  const last = await reopened.update({
    id: next.id,
    expectedRevision: next.revision,
    name: next.name,
    notes: next.notes,
    archived: false,
    source: { jobId, operationId: "generate-2", label: "Next" },
  });
  assert.equal(last.checkpoints.length, 2);
  assert.equal(last.archived, false);
  assert.deepEqual(last.verification, {
    source: "recorded",
    compilation: "not_run",
    game: "not_run",
  });
  await assert.rejects(
    reopened.update({
      id: last.id,
      expectedRevision: last.revision,
      name: last.name,
      notes: last.notes,
      archived: false,
      source: { jobId, operationId: "generate-2", label: "Duplicate" },
    }),
    /already recorded/,
  );
  assert.deepEqual(await reopened.get(first.id), last);
});
test("invalid metadata and symlinked records fail closed without rewriting originals", async (t) => {
  const root = await fixture(t);
  const store = await new MakerProjects(root, async () => ({
    job: { profile: "maker", status: "completed" },
    snapshot: { fingerprint: "a".repeat(64) },
  })).init();
  const input = {
    name: "Mod",
    notes: "",
    label: "Initial",
    jobId: randomUUID(),
    operationId: "generate",
  };
  await assert.rejects(store.create({ ...input, name: "Bad\nname" }), /name/);
  await assert.rejects(
    store.create({ ...input, notes: "x".repeat(8193) }),
    /notes/,
  );
  const record = await store.create(input),
    file = path.join(root, "projects", record.id + ".json");
  const original = await fs.readFile(file);
  const backup = path.join(root, "original.json");
  await fs.rename(file, backup);
  await fs.symlink(backup, file);
  await assert.rejects(store.get(record.id), /Symlinks/);
  assert.deepEqual(await fs.readFile(backup), original);
  await fs.unlink(file);
  await fs.writeFile(file, "{broken");
  await assert.rejects(store.list());
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});
function userInput(body) {
  const content = body.messages.findLast(
    (value) => value.role === "user",
  ).content;
  return JSON.parse(
    typeof content === "string"
      ? content
      : content.map((value) => value.text ?? "").join(""),
  );
}
function stream(res, delta, finishReason) {
  const chunk = (value) => ({
    id: "offline",
    object: "chat.completion.chunk",
    created: 0,
    model: "offline",
    choices: [{ index: 0, ...value }],
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    [
      chunk({ delta: { role: "assistant", ...delta }, finish_reason: null }),
      chunk({ delta: {}, finish_reason: finishReason }),
    ]
      .map((value) => "data: " + JSON.stringify(value) + "\n\n")
      .join("") + "data: [DONE]\n\n",
  );
}
test(
  "host continuation uses a verified source and saved preset; Pi proposes a new Java class and only host review creates the next version",
  { timeout: 20000 },
  async (t) => {
    const root = await fixture(t),
      requests = [];
    const javaPath =
      "src/main/java/lab/generated/project_mod/ExtraBehavior.java";
    const text =
      "package lab.generated.project_mod;\npublic final class ExtraBehavior { public static int capacity(int base) { return base * 2; } }\n";
    const server = http.createServer(async (req, res) => {
      let bytes = "";
      for await (const part of req) bytes += part;
      const body = JSON.parse(bytes);
      requests.push(body);
      if (requests.length === 1) {
        const input = userInput(body);
        stream(
          res,
          {
            tool_calls: [
              {
                index: 0,
                id: "offline-add-java",
                type: "function",
                function: {
                  name: "maker__preview_source_edit",
                  arguments: JSON.stringify({
                    sourceOperationId: input.sourceOperationId,
                    request: {
                      schema_version: 1,
                      lock_paths: [],
                      edits: [{ path: javaPath, expected_sha256: null, text }],
                    },
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else
        stream(
          res,
          {
            content:
              "Source change proposed; compilation and game verification not run.",
          },
          "stop",
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let child, lines, replies;
    function launch() {
      child = spawn(process.execPath, [hostPath, root], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.resume();
      replies = [];
      lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => replies.push(JSON.parse(line)));
    }
    launch();
    t.after(async () => {
      child.kill("SIGKILL");
      lines.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    async function envelope(operation, args = {}) {
      child.stdin.write(JSON.stringify({ operation, args }) + "\n");
      return until(() => replies.shift());
    }
    async function rpc(operation, args = {}) {
      const reply = await envelope(operation, args);
      assert.equal(reply.ok, true, reply.error);
      return reply.result;
    }
    const spec = {
      schema_version: 1,
      target: "fabric-1.21.1",
      mod_id: "project_mod",
      name: "Project Mod",
      description: "Long-lived mod",
      items: [
        {
          id: "crystal",
          names: { en_us: "Crystal", zh_cn: "结晶" },
          color: "#71b8ff",
          max_count: 64,
          recipe: { ingredients: ["minecraft:amethyst_shard"], count: 1 },
        },
      ],
    };
    const generated = await rpc("job_create", {
      mode: "template",
      profile: "maker",
      spec,
    });
    const first = await until(async () => {
      const value = await rpc("job_read", generated);
      return value.summary.status === "completed" && value;
    });
    const operationId = first.artifacts[0].operationId;
    let project = await rpc("project_create", {
      name: "Project Mod",
      notes: "Keep handwritten behavior; add a class for future expansion.",
      jobId: generated.jobId,
      operationId,
      label: "Initial source",
    });
    const unitRef = { id: project.id, expectedRevision: project.revision };
    const workspace = await rpc("project_units", unitRef);
    const feature = await rpc("project_unit_save", {
      ...unitRef,
      expectedWorkspaceRevision: workspace.workspaceRevision,
      unit: {
        id: "",
        name: "Capacity system",
        kind: "systems",
        state: "planned",
        notes: "Persistent complex behavior",
        files: [javaPath],
      },
    });
    assert.equal(
      (await rpc("project_unit_read", { ...unitRef, unitId: feature.unit.id }))
        .unit.notes,
      "Persistent complex behavior",
    );
    assert.equal(
      (
        await envelope("project_unit_save", {
          ...unitRef,
          expectedWorkspaceRevision: workspace.workspaceRevision,
          unit: { ...feature.unit, updatedAt: undefined },
        })
      ).ok,
      false,
    );
    const sourceArgs = () => ({
      id: project.id,
      expectedRevision: project.revision,
      checkpointId: project.checkpoints[0].id,
    });
    assert.equal(
      (
        await envelope("project_continue", {
          ...sourceArgs(),
          prompt: "Add capacity behavior",
        })
      ).ok,
      false,
    );
    assert.equal(requests.length, 0);
    await rpc("shutdown");
    child.stdin.end();
    lines.close();
    if (child.exitCode === null)
      await new Promise((resolve) => child.once("exit", resolve));
    launch();
    assert.deepEqual((await rpc("projects_list")).projects, [project]);
    assert.equal(
      (await rpc("project_units", unitRef)).units[0].id,
      feature.unit.id,
    );
    const opened = await rpc("project_open", sourceArgs());
    assert.deepEqual(opened.spec, spec);
    assert.equal(opened.operationId, operationId);
    await rpc("provider_preset_save", {
      name: "Offline",
      config: {
        provider: "pcl-custom",
        model: "offline",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        key: "",
      },
    });
    project = await rpc("project_update", {
      id: project.id,
      expectedRevision: project.revision,
      name: project.name,
      notes: project.notes,
      archived: true,
    });
    const archived = await envelope("project_continue", {
      ...sourceArgs(),
      prompt: "Change archived source",
    });
    assert.equal(archived.ok, false);
    assert.match(archived.error, /Unarchive/);
    assert.equal(requests.length, 0);
    project = await rpc("project_update", {
      id: project.id,
      expectedRevision: project.revision,
      name: project.name,
      notes: project.notes,
      archived: false,
    });
    const continuation = await rpc("project_continue", {
      ...sourceArgs(),
      prompt: "Add capacity behavior in a new Java class",
    });
    assert.deepEqual(continuation.spec, spec);
    const finished = await until(async () => {
      const value = await rpc("job_read", { jobId: continuation.jobId });
      assert.notEqual(value.summary.status, "failed", JSON.stringify(value));
      return value.summary.status === "completed" && value;
    });
    const input = userInput(requests[0]);
    assert.equal(input.project.notes, project.notes);
    assert.equal(input.sourceOperationId, continuation.operationId);
    assert.equal(
      input.sourceInventory.some(
        (entry) =>
          entry.path.endsWith(".java") &&
          entry.expected_sha256 === entry.sha256,
      ),
      true,
    );
    const toolNames = requests[0].tools.map((value) => value.function.name);
    assert.equal(toolNames.includes("maker__preview_source_edit"), true);
    assert.equal(
      toolNames.some((value) => /approve|apply|build/.test(value)),
      false,
    );
    assert.equal(finished.artifacts.length, 1); // seeded source only, before human approval
    assert.equal(finished.reviews.length, 1);
    const review = await rpc("review_read", {
      jobId: continuation.jobId,
      reviewId: finished.reviews[0],
    });
    const applied = await rpc("review_apply", {
      jobId: continuation.jobId,
      reviewId: review.reviewId,
      digest: review.reviewDigest,
    });
    assert.equal(applied.buildValidated, false);
    assert.equal(applied.originalSourceModified, false);
    const result = await rpc("job_read", { jobId: continuation.jobId });
    const nextOperation = result.artifacts.find(
      (value) => value.operationId !== continuation.operationId,
    ).operationId;
    assert.equal(
      (
        await rpc("artifact_read", {
          jobId: continuation.jobId,
          operationId: nextOperation,
          path: javaPath,
        })
      ).content,
      text,
    );
    project = await rpc("project_update", {
      id: project.id,
      expectedRevision: project.revision,
      name: project.name,
      notes: project.notes,
      archived: false,
      source: {
        jobId: continuation.jobId,
        operationId: nextOperation,
        label: "Capacity helper",
      },
    });
    assert.equal(project.checkpoints.length, 2);
    for (const name of first.artifacts[0].files) {
      const original = await rpc("artifact_read", {
        jobId: generated.jobId,
        operationId,
        path: name,
      });
      const copied = await rpc("artifact_read", {
        jobId: continuation.jobId,
        operationId: continuation.operationId,
        path: name,
      });
      assert.equal(original.sha256, copied.sha256);
    }
    const natural = await rpc("job_create", {
      mode: "live",
      profile: "maker",
      prompt: "Initialize a Fabric mod from natural-language requirements",
    });
    await until(async () => {
      const value = await rpc("job_read", natural);
      assert.notEqual(value.summary.status, "failed", JSON.stringify(value));
      return value.summary.status === "completed";
    });
    const nlInput = userInput(requests.at(-1));
    assert.equal("spec" in nlInput, false);
    assert.match(nlInput.prompt, /natural-language/);
    const revision = await rpc("maker_review", {
      kind: "revision",
      jobId: continuation.jobId,
      operationId: nextOperation,
      spec: { ...spec, name: "Expanded Project" },
    });
    await rpc("review_apply", {
      jobId: continuation.jobId,
      reviewId: revision.reviewId,
      digest: revision.reviewDigest,
    });
    const revised = (
      await rpc("job_read", { jobId: continuation.jobId })
    ).artifacts.at(-1);
    assert.equal(
      (
        await rpc("artifact_read", {
          jobId: continuation.jobId,
          operationId: revised.operationId,
          path: javaPath,
        })
      ).content,
      text,
    );
    const importedDirectory = path.join(root, "porter-input");
    await fs.mkdir(path.join(importedDirectory, "src"), { recursive: true });
    await fs.writeFile(
      path.join(importedDirectory, "src/Example.java"),
      "public class Example {}\n",
    );
    const imported = await rpc("source_import", {
      directory: importedDirectory,
    });
    const port = await rpc("job_create", {
      mode: "template",
      profile: "porter",
      sourceId: imported.sourceId,
      permittedPaths: ["src/Example.java"],
      targetId: "neoforge-26.3",
      rights: "owner",
      acknowledgeBeta: true,
    });
    await until(async () => {
      const value = await rpc("job_read", port);
      assert.notEqual(value.summary.status, "failed", JSON.stringify(value));
      return value.summary.status === "completed";
    });
    const portReview = await rpc("porter_review", {
      jobId: port.jobId,
      path: "src/Example.java",
      text: "public class Example { int capacity = 2; }\n",
      purpose: "Offline source review",
    });
    const portResult = await rpc("review_apply", {
      jobId: port.jobId,
      reviewId: portReview.reviewId,
      digest: portReview.reviewDigest,
    });
    const portProject = await rpc("project_create", {
      name: "Migrated source",
      notes: "Porter result",
      label: "Text patch",
      jobId: port.jobId,
      operationId: `host-${portResult.reviewId}`,
    });
    const portArgs = {
      id: portProject.id,
      expectedRevision: portProject.revision,
      checkpointId: portProject.checkpoints[0].id,
    };
    assert.equal((await rpc("project_open", portArgs)).workflow, "porter");
    assert.equal(
      (
        await envelope("project_continue", {
          ...portArgs,
          prompt: "Continue port",
        })
      ).ok,
      false,
    );
    assert.equal(requests.length, 3); // continuation turns plus NL-only initialization
    const file = path.join(
      root,
      "jobs",
      generated.jobId,
      "workspace",
      first.artifacts[0].directory,
      "creator-spec.json",
    );
    await fs.appendFile(file, " ");
    const rejected = await envelope("project_continue", {
      ...sourceArgs(),
      prompt: "Keep source",
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Source bytes differ/);
    assert.equal(requests.length, 3); // continuation turns plus NL-only initialization // tampering cannot start another model request
    await rpc("shutdown");
  },
);
