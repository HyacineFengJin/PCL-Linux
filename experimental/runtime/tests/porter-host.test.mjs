/** Real host, trusted Python bridge and pinned Pi SDK; authored source and a
 * loopback model only. No game, build script, user settings or paid AI service. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const scratch = fileURLToPath(
  new URL("../../../work/porter-tests/host/", import.meta.url),
);
const hostPath = fileURLToPath(new URL("../../host.mjs", import.meta.url));
const javaPath = "src/main/java/example/Example.java";
const templatePath = "src/main/resources/META-INF/neoforge.mods.toml";
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Isolated Porter host timed out");
}
function stream(res, delta, reason) {
  const chunk = (d, finish) => ({
    id: "offline",
    object: "chat.completion.chunk",
    created: 0,
    model: "offline",
    choices: [{ index: 0, delta: d, finish_reason: finish }],
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    [chunk({ role: "assistant", ...delta }, null), chunk({}, reason)]
      .map((c) => "data: " + JSON.stringify(c) + "\n\n")
      .join("") + "data: [DONE]\n\n",
  );
}
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "host-"));
  const sourceRoot = path.join(root, "authored-source");
  const authored = {
    "gradle.properties": "minecraft_version=1.20.6\n",
    "build.gradle": "// Never executed.\n",
    "src/main/resources/fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "example",
      version: "1.0",
      license: "MIT",
      entrypoints: { main: ["example.Example"] },
      depends: { minecraft: "1.20.6" },
    }),
    [templatePath]:
      'modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="template"\nversion="0"\ndisplayName="Template"\ndescription="Template"\n',
    [javaPath]:
      'package example;\nimport net.minecraft.util.Identifier;\nclass Example { Object id = new Identifier("example:item"); }\n',
  };
  for (const [name, text] of Object.entries(authored)) {
    await fs.mkdir(path.dirname(path.join(sourceRoot, name)), {
      recursive: true,
    });
    await fs.writeFile(path.join(sourceRoot, name), text);
  }
  const children = [],
    readers = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    for (const lines of readers) lines.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  function start() {
    const child = spawn(
      process.execPath,
      [hostPath, path.join(root, "private-host")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(child);
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    readers.push(lines);
    const replies = [];
    lines.on("line", (line) => replies.push(JSON.parse(line)));
    return async (operation, args = {}, expectOk = true) => {
      child.stdin.write(JSON.stringify({ operation, args }) + "\n");
      const reply = await until(() => replies.shift());
      if (expectOk) assert.equal(reply.ok, true, reply.error);
      return expectOk ? reply.result : reply;
    };
  }
  const rpc = start();
  const imported = await rpc("source_import", { directory: sourceRoot });
  async function create(options = {}) {
    return rpc("porter_project_create", {
      name: "Example port",
      goal: "Preserve item behavior and explain unsupported work",
      targetId: "neoforge-26.2",
      rights: "owner",
      sourceId: imported.sourceId,
      permittedPaths: [templatePath, javaPath],
      ...options,
    });
  }
  return { root, sourceRoot, authored, rpc, start, create };
}
test(
  "both recipes dispatch, bind diagnostics to approval, and continue from retained copies",
  { timeout: 30000 },
  async (t) => {
    const { rpc, sourceRoot, authored, create, start } = await fixture(t);
    let p = await create();
    const first = await rpc("porter_project_round", {
      projectId: p.id,
      revision: p.revision,
      mode: "template",
    });
    await until(async () => {
      const j = await rpc("job_read", { jobId: first.jobId });
      return j.summary.status === "completed";
    });
    p = await rpc("porter_project_read", { projectId: p.id });
    const recipe = await rpc("porter_recipe", {
      jobId: first.jobId,
      recipe: "metadata",
    });
    assert.equal(recipe.status, "metadata-only-proposal");
    const preview = await rpc("review_read", {
      jobId: first.jobId,
      reviewId: recipe.review.reviewId,
    });
    assert.ok(
      preview.preview.domain_recipe.diagnostics.some(
        (d) => d.code === "unmapped-entrypoints",
      ),
    );
    assert.equal(
      preview.preview.domain_recipe.full_port_status,
      "blocked-unvalidated",
    );
    const stale = await rpc(
      "review_apply",
      {
        jobId: first.jobId,
        reviewId: preview.reviewId,
        digest: "0".repeat(64),
      },
      false,
    );
    assert.equal(stale.ok, false);
    await rpc("review_apply", {
      jobId: first.jobId,
      reviewId: preview.reviewId,
      digest: preview.reviewDigest,
    });
    const output = await rpc("job_read", { jobId: first.jobId });
    assert.equal(output.artifacts.length, 1);
    p = await rpc("porter_project_source", {
      projectId: p.id,
      revision: p.revision,
      jobId: first.jobId,
      operationId: output.artifacts[0].operationId,
      permittedPaths: [templatePath, javaPath],
    });
    assert.equal(p.snapshot.revision, 2);
    assert.ok(p.snapshot.files[templatePath].includes('modId = "example"'));
    const second = await rpc("porter_project_round", {
      projectId: p.id,
      revision: p.revision,
      mode: "template",
    });
    await until(
      async () =>
        (await rpc("job_read", { jobId: second.jobId })).summary.status ===
        "completed",
    );
    const noChange = await rpc("porter_recipe", {
      jobId: second.jobId,
      recipe: "metadata",
    });
    assert.equal(noChange.status, "no-change");
    const javaProject = await create({
      targetId: "fabric-1.21-yarn-source",
      identifierProfile: "fabric-yarn-1.20.6-to-1.21-identifier-v1",
    });
    const javaRound = await rpc("porter_project_round", {
      projectId: javaProject.id,
      revision: javaProject.revision,
      mode: "template",
    });
    await until(
      async () =>
        (await rpc("job_read", { jobId: javaRound.jobId })).summary.status ===
        "completed",
    );
    const javaRecipe = await rpc("porter_recipe", {
      jobId: javaRound.jobId,
      recipe: "identifier",
    });
    assert.ok(
      javaRecipe.proposal.changes[0].new_text.includes("Identifier.of"),
    );
    const crossing = await rpc(
      "porter_project_source",
      {
        projectId: javaProject.id,
        revision: javaProject.revision,
        jobId: first.jobId,
        operationId: output.artifacts[0].operationId,
        permittedPaths: [javaPath],
      },
      false,
    );
    assert.equal(crossing.ok, false);
    for (const [name, text] of Object.entries(authored))
      assert.equal(
        await fs.readFile(path.join(sourceRoot, name), "utf8"),
        text,
      );
    await rpc("shutdown");
    const restarted = start();
    const retained = await restarted("porter_project_read", {
      projectId: p.id,
    });
    assert.equal(retained.rounds.length, 2);
    assert.equal(retained.snapshot.revision, 2);
    assert.equal(
      (await restarted("job_read", { jobId: first.jobId })).artifacts.length,
      1,
    );
    await restarted("shutdown");
  },
);

test(
  "pinned Pi asks a durable question, stops at one request, and accepts a new round after an answer",
  { timeout: 30000 },
  async (t) => {
    const { rpc, create } = await fixture(t);
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const bytes of req) raw += bytes;
      requests.push(JSON.parse(raw));
      if (requests.length === 1)
        stream(
          res,
          {
            tool_calls: [
              {
                index: 0,
                id: "ask-user",
                type: "function",
                function: {
                  name: "porter__ask_user",
                  arguments: JSON.stringify({
                    question: "Also support a dedicated server?",
                    options: ["Yes", "No"],
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      else
        stream(
          res,
          {
            content:
              "I will retain the server requirement. Compilation and behavior remain unverified.",
          },
          "stop",
        );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    await rpc("provider_preset_save", {
      name: "Offline Porter",
      config: {
        provider: "pcl-custom",
        model: "offline",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        key: "",
      },
    });
    let p = await create();
    const first = await rpc("porter_project_round", {
      projectId: p.id,
      revision: p.revision,
      mode: "live",
    });
    const completed = await until(async () => {
      const j = await rpc("job_read", { jobId: first.jobId });
      return ["completed", "failed"].includes(j.summary.status) && j;
    });
    assert.equal(
      completed.summary.status,
      "completed",
      completed.error?.message,
    );
    assert.equal(completed.result.label, "PORTER_AWAITING_USER");
    assert.equal(requests.length, 1);
    assert.equal(
      (await rpc("status")).jobs.filter((j) =>
        ["queued", "running"].includes(j.status),
      ).length,
      0,
    );
    p = await rpc("porter_project_read", { projectId: p.id });
    assert.ok(p.awaitingQuestion);
    p = await rpc("porter_project_message", {
      projectId: p.id,
      revision: p.revision,
      kind: "answer",
      content: "Yes, preserve dedicated server behavior",
      replyTo: p.awaitingQuestion,
    });
    const second = await rpc("porter_project_round", {
      projectId: p.id,
      revision: p.revision,
      mode: "live",
    });
    await until(
      async () =>
        (await rpc("job_read", { jobId: second.jobId })).summary.status ===
        "completed",
    );
    assert.equal(requests.length, 2);
    assert.ok(
      JSON.stringify(requests[1].messages).includes(
        "Yes, preserve dedicated server behavior",
      ),
    );
    const persisted = await rpc("porter_project_read", { projectId: p.id });
    assert.equal(persisted.rounds.length, 2);
    assert.ok(
      persisted.messages.some(
        (m) =>
          m.role === "assistant" && m.content.includes("remain unverified"),
      ),
    );
    await rpc("shutdown");
  },
);
