/** Private stdio host, owned by Tauri. Third-party extensions only reach the
 * declarative ExtensionHost; neither this dispatcher nor Pi tools are exposed
 * to their cards. Source transformations reuse the supplied domain modules. */
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  createDefaultTools,
  registerDomainAdapters,
  HostReviewService,
  registerReviewPreviewTools,
  LivePiProvider,
} from "./runtime/src/index.mjs";
import { SubprocessSupervisor } from "./runtime/src/subprocesses.mjs";
import {
  captureSourceArtifact,
  sha256,
} from "./runtime/src/artifact-snapshot.mjs";
import { ExtensionHost } from "./extensions/src/host.mjs";
import { readManifest } from "./extensions/src/manifest.mjs";
import { readPackage } from "./extensions/src/package.mjs";

const code = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2]);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
let key = null,
  closing = false;
const adapters = registerDomainAdapters(createDefaultTools());
const bridge = new SubprocessSupervisor({
  trustedCommands: Object.fromEntries(
    [
      ["catalog", path.join(code, "python-host.py"), "catalog"],
      [
        "read_source",
        path.join(code, "python-host.py"),
        "porter.read_directory",
      ],
      [
        "metadata",
        path.join(code, "runtime/src/adapters/python_bridge.py"),
        "porter.propose_metadata",
      ],
      [
        "identifier",
        path.join(code, "runtime/src/adapters/python_bridge.py"),
        "porter.propose_identifier",
      ],
    ].map(([name, script, operation]) => [
      name,
      { executable: "/usr/bin/python3", args: ["-I", "-B", script, operation] },
    ]),
  ),
});
async function domain(name, args) {
  const result = await bridge.run(name, {
    cwd: root,
    input: JSON.stringify(args),
    maxOutputBytes: 256000,
    timeoutMs: 10000,
  });
  const envelope = JSON.parse(result.stdout);
  if (result.status !== "completed" || !envelope.ok)
    throw new Error(
      envelope.error?.message ?? envelope.error ?? "Domain adapter failed",
    );
  return envelope.result;
}
// This driver calls real deterministic domain tools; it is not an AI simulator.
class TemplateProvider {
  id = "pcl-template";
  async run(ctx) {
    if (ctx.job.profile === "maker") {
      await ctx.invoke("plan", "maker.plan", { spec: ctx.job.input.spec });
      return ctx.invoke("generate", "maker.generate", {
        spec: ctx.job.input.spec,
      });
    }
    return ctx.invoke("inspect", "porter.inspect", ctx.job.input);
  }
}
const live = new LivePiProvider({ enabled: true, getApiKey: () => key });
const runtime = await new AgentRuntime({
  root: path.join(root, "jobs"),
  tools: adapters.registry,
  providers: [new TemplateProvider(), live],
}).init();
const reviews = new HostReviewService({ store: runtime.store });
registerReviewPreviewTools(adapters.registry, reviews);
// The new Porter recipes operate on the snapshot and path grants imported by
// the user. A model can propose changes, but cannot approve them or import files.
for (const recipe of ["metadata", "identifier"]) {
  adapters.registry.register({
    name: `porter.propose_${recipe}`,
    replaySafety: "read-only",
    description:
      recipe === "metadata"
        ? "Propose limited Fabric identity fields for an existing NeoForge manifest."
        : "Propose only Fabric/Yarn 1.20.6 → 1.21 Identifier factory edits. No full conversion.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: (args) => {
      if (!args || Object.keys(args).length)
        throw new Error("This tool takes no arguments");
    },
    async execute(_args, ctx) {
      const files = await runtime.store.files(ctx.jobId);
      const source = JSON.parse(
        (await files.read("review-control/sources/primary.json")).content,
      );
      const result = await domain(recipe, {
        files: source.files,
        permittedPaths: source.permittedPaths,
        jobId: ctx.jobId,
      });
      if (result.proposal) {
        const replacements = Object.fromEntries(
          result.proposal.changes.map((c) => [c.path, c.new_text]),
        );
        const review = await reviews.previewPorterFromTool(ctx, {
          sourceId: "primary",
          replacements,
          purpose: result.proposal.purpose,
        });
        return { ...result, review };
      }
      return result;
    },
  });
}
let extensions = new ExtensionHost();
let installed = [],
  storeWarning = null,
  safeMode = false;
const extensionFile = path.join(root, "extensions.json");
async function boundedRead(file, max = 128000) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error("Expected a bounded regular file");
    const bytes = await handle.readFile();
    if (bytes.length > max) throw new Error("File exceeds limit");
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
function parseExtension(source) {
  return JSON.parse(source).packageFormat === "pcl-linux.declarative-package"
    ? readPackage(source)
    : readManifest(source);
}
function prepareExtension(source) {
  return JSON.parse(source).packageFormat === "pcl-linux.declarative-package"
    ? extensions.preparePackageReview(source)
    : extensions.prepareReview(source);
}
try {
  const saved = JSON.parse(await boundedRead(extensionFile, 1000000));
  if (
    saved.schemaVersion !== 1 ||
    !Array.isArray(saved.entries) ||
    saved.entries.length > 32
  )
    throw new Error("Invalid extension store");
  for (const record of saved.entries) {
    const loaded = parseExtension(record.source);
    if (
      loaded.manifest.id !== record.id ||
      loaded.digest !== record.digest ||
      !Array.isArray(record.grants) ||
      typeof record.enabled !== "boolean"
    )
      throw new Error("Extension store content changed");
    const declared = loaded.manifest.capabilities.map((c) => c.id);
    if (record.grants.some((c) => !declared.includes(c)))
      throw new Error("Invalid stored grant");
    const review = prepareExtension(record.source);
    extensions.confirmReview(review.token, declared);
    for (const id of declared)
      if (!record.grants.includes(id)) extensions.revoke(record.id, id);
    if (!record.enabled) extensions.disable(record.id);
  }
  installed = saved.entries;
} catch (error) {
  if (error.code !== "ENOENT") {
    storeWarning =
      "Extension store unreadable; retained for recovery. No grants loaded.";
    extensions = new ExtensionHost();
    safeMode = true;
    extensions.setSafeMode(true);
  }
}
async function persistExtensions() {
  if (storeWarning) throw new Error(storeWarning);
  const entries = installed.map((record) => {
    const state = extensions.inspect(record.id);
    return { ...record, grants: state.grants, enabled: record.enabled };
  });
  const text = JSON.stringify({ schemaVersion: 1, entries });
  if (Buffer.byteLength(text) > 1000000)
    throw new Error("Extension store exceeds 1 MB");
  const temporary = extensionFile + ".new";
  await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, extensionFile);
  installed = entries;
}
const pendingExtensions = new Map();
const sourceImports = new Map();
async function listJobs() {
  const entries = await fs.readdir(runtime.store.root);
  const jobs = [];
  for (const id of entries
    .filter((v) => /^[a-f0-9-]{36}$/.test(v))
    .slice(-100)) {
    try {
      const job = await runtime.getJob(id);
      jobs.push({
        ...(await runtime.getPublicJobSummary(id)),
        mode: job.provider === "pcl-template" ? "template" : "live",
      });
    } catch {
      /* Retain corrupt jobs without inventing a completed status. */
    }
  }
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function artifact(jobId, operationId) {
  const job = await runtime.getJob(jobId);
  const snapshot = await captureSourceArtifact(runtime.store, job, operationId);
  const workspace = await runtime.store.workspace(jobId);
  return {
    job,
    snapshot,
    directory: path.join(workspace.root, snapshot.directory),
  };
}
async function dispatch(operation, a) {
  if (closing && operation !== "shutdown")
    throw new Error("Experimental host is closing");
  switch (operation) {
    case "status":
      return {
        versions: {
          extensions: "0.6",
          maker: "0.4",
          porter: "0.5.1",
          runtime: "v7",
          pi: "1.0.4",
        },
        jobs: await listJobs(),
        liveConfigured: !!key,
        liveTested: false,
        workspace: root,
        storeWarning,
        extensions: extensions.list(),
      };
    case "catalog":
      return domain("catalog", {});
    case "extensions_list":
      return { entries: extensions.list(), safeMode, warning: storeWarning };
    case "extensions_review": {
      if (storeWarning) throw new Error(storeWarning);
      const source = a.path ? await boundedRead(a.path) : a.source;
      const review = prepareExtension(source);
      if (pendingExtensions.size >= 64) pendingExtensions.clear();
      pendingExtensions.set(review.token, source);
      return review;
    }
    case "extensions_confirm": {
      if (storeWarning) throw new Error(storeWarning);
      const source = pendingExtensions.get(a.token);
      pendingExtensions.delete(a.token);
      if (!source) throw new Error("Extension review expired");
      const result = extensions.confirmReview(a.token, a.grants);
      installed = installed.filter((v) => v.id !== result.id);
      installed.push({
        id: result.id,
        digest: result.digest,
        source,
        grants: result.grants,
        enabled: true,
      });
      try {
        await persistExtensions();
      } catch (error) {
        extensions.disable(result.id);
        throw error;
      }
      return result;
    }
    case "extensions_cancel":
      pendingExtensions.delete(a.token);
      return extensions.cancelReview(a.token);
    case "extensions_revoke": {
      const result = extensions.revoke(a.id, a.capability);
      await persistExtensions();
      return result;
    }
    case "extensions_disable": {
      const result = extensions.disable(a.id);
      installed.find((v) => v.id === a.id).enabled = false;
      await persistExtensions();
      return result;
    }
    case "extensions_rereview": {
      const record = installed.find((v) => v.id === a.id);
      if (!record) throw new Error("Unknown extension");
      return dispatch("extensions_review", { source: record.source });
    }
    case "extensions_safe_mode":
      if (storeWarning) throw new Error(storeWarning);
      safeMode = a.enabled;
      return extensions.setSafeMode(a.enabled);
    case "extensions_cards":
      extensions.setContext(a.context ?? null);
      return extensions.cards(a.slot);
    case "extensions_action":
      extensions.setContext(a.context ?? null);
      return extensions.commitAction(
        extensions.prepareAction(a.extensionId, a.cardId, a.actionId).token,
      );
    case "source_import": {
      const result = await domain("read_source", { directory: a.directory });
      if (sourceImports.size >= 16) sourceImports.clear();
      const id = randomUUID();
      sourceImports.set(id, result.files);
      return { sourceId: id, files: result.files, skipped: result.skipped };
    }
    case "provider_configure":
      if (
        a.key !== null &&
        (typeof a.key !== "string" ||
          a.key.length < 16 ||
          a.key.length > 512 ||
          /\s/.test(a.key))
      )
        throw new Error("Invalid API key");
      key = a.key;
      return { liveConfigured: !!key, liveTested: false };
    case "job_create": {
      if (
        !["maker", "porter"].includes(a.profile) ||
        !["template", "live"].includes(a.mode)
      )
        throw new Error("Choose a supported workflow");
      if (a.mode === "live" && !key)
        throw new Error("Configure a session key first");
      if (
        (await listJobs()).filter((j) =>
          ["queued", "running"].includes(j.status),
        ).length >= 2
      )
        throw new Error("The shared runtime already has two active jobs");
      let files;
      if (a.profile === "porter") {
        files = sourceImports.get(a.sourceId);
        if (!files) throw new Error("Re-import the source directory");
      }
      const input =
        a.profile === "maker"
          ? { spec: a.spec, ...(a.mode === "live" ? { prompt: a.prompt } : {}) }
          : {
              files,
              targetId: a.targetId,
              rights: a.rights,
              acknowledgeBeta: a.acknowledgeBeta,
              ...(a.mode === "live" ? { prompt: a.prompt } : {}),
            };
      // Template scanner rejects AI prompt as an unknown tool argument.
      const job = await runtime.createJob({
        profile: a.profile,
        input,
        provider: a.mode === "live" ? live.id : "pcl-template",
      });
      if (files && a.permittedPaths?.length)
        await reviews.registerPorterSource(job.id, {
          files,
          permittedPaths: a.permittedPaths,
        });
      void runtime.start(job.id).catch(() => {});
      return { jobId: job.id };
    }
    case "job_read": {
      const job = await runtime.getJob(a.jobId);
      return {
        summary: await runtime.getPublicJobSummary(a.jobId),
        mode: job.provider === "pcl-template" ? "template" : "live",
        result: job.result,
        error: job.error,
        artifacts: job.operations
          .filter(
            (op) => op.status === "completed" && op.result?.outputDirectory,
          )
          .map((op) => ({
            operationId: op.id,
            directory: op.result.outputDirectory,
            files: op.result.artifacts.map((f) =>
              f.path.slice(op.result.outputDirectory.length + 1),
            ),
          })),
        reviews: (
          await fs
            .readdir(
              path.join(
                runtime.store.directory(job.id),
                "review-control/reviews",
              ),
            )
            .catch(() => [])
        )
          .filter((v) => v.endsWith(".json"))
          .map((v) => v.slice(0, -5)),
      };
    }
    case "job_cancel":
      return runtime.cancel(a.jobId);
    case "artifact_read": {
      const { snapshot } = await artifact(a.jobId, a.operationId);
      const bytes = snapshot.files[a.path];
      if (!bytes) throw new Error("Unknown artifact file");
      return {
        path: a.path,
        sha256: sha256(bytes),
        content: a.path.endsWith(".png") ? null : bytes.toString("utf8"),
        binary: a.path.endsWith(".png"),
      };
    }
    case "artifact_directory":
      return { directory: (await artifact(a.jobId, a.operationId)).directory };
    case "maker_review": {
      if (a.kind === "revision")
        return reviews.requestMakerSourceEdit(a.jobId, {
          sourceOperationId: a.operationId,
          request: { operation: "regenerate", spec: a.spec },
        });
      if (a.kind === "restore") {
        const checkpoint = await artifact(a.jobId, a.checkpointOperationId);
        return reviews.requestMakerSourceEdit(a.jobId, {
          sourceOperationId: a.operationId,
          request: {
            operation: "restore",
            checkpointRoot: checkpoint.directory,
          },
        });
      }
      const source = await artifact(a.jobId, a.operationId);
      const request = {
        schema_version: 1,
        edits:
          a.kind === "lock"
            ? []
            : [{ path: a.path, expected_sha256: a.sha256, text: a.text }],
        lock_paths: a.kind === "lock" ? [a.path] : [],
      };
      return reviews.requestMakerSourceEdit(source.job.id, {
        sourceOperationId: a.operationId,
        request,
      });
    }
    case "porter_recipe": {
      if (!["metadata", "identifier"].includes(a.recipe))
        throw new Error("Unknown migration recipe");
      const record = JSON.parse(
        (
          await (
            await runtime.store.files(a.jobId)
          ).read("review-control/sources/primary.json")
        ).content,
      );
      const result = await domain(a.recipe, {
        files: record.files,
        permittedPaths: record.permittedPaths,
        jobId: a.jobId,
      });
      if (result.proposal) {
        const replacements = Object.fromEntries(
          result.proposal.changes.map((c) => [c.path, c.new_text]),
        );
        result.review = await reviews.requestPorterPatch(a.jobId, {
          sourceId: "primary",
          replacements,
          purpose: result.proposal.purpose,
        });
      }
      return result;
    }
    case "porter_review":
      return reviews.requestPorterPatch(a.jobId, {
        sourceId: "primary",
        replacements: { [a.path]: a.text },
        purpose: a.purpose,
      });
    case "review_read":
      return reviews.getReview(a.jobId, a.reviewId);
    case "review_apply": {
      const approval = await reviews.approveReview(a.jobId, {
        reviewId: a.reviewId,
        expectedDigest: a.digest,
      });
      return reviews.applyApprovedReview(a.jobId, {
        reviewId: a.reviewId,
        approvalToken: approval.approvalToken,
      });
    }
    case "review_cancel":
      return reviews.revokeReview(a.jobId, { reviewId: a.reviewId });
    case "report_read": {
      const job = await runtime.getJob(a.jobId);
      const report = job.operations.find(
        (op) => op.status === "completed" && op.result?.reportPath,
      )?.result.reportPath;
      if (!report) return null;
      return JSON.parse(
        (await (await runtime.store.workspace(job.id)).read(report)).content,
      );
    }
    case "shutdown":
      closing = true;
      key = null;
      await runtime.shutdown();
      await Promise.all([
        reviews.shutdown(),
        adapters.shutdown(),
        bridge.shutdown(),
      ]);
      return true;
    default:
      throw new Error("Unknown experimental host operation");
  }
}
// Native calls are serialized, but runtime jobs continue independently. Every
// line receives one bounded envelope; no model or child stdout reaches IPC.
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
for await (const line of input) {
  let reply;
  try {
    if (Buffer.byteLength(line) > 128000)
      throw new Error("Request exceeds 128 KB");
    const request = JSON.parse(line);
    reply = {
      ok: true,
      result: await dispatch(request.operation, request.args ?? {}),
    };
  } catch (error) {
    reply = { ok: false, error: String(error.message).slice(0, 1000) };
  }
  const output = JSON.stringify(reply);
  process.stdout.write(
    (Buffer.byteLength(output) <= 1000000
      ? output
      : JSON.stringify({ ok: false, error: "Host response exceeds limit" })) +
      "\n",
  );
  if (closing) break;
}
if (!closing) await dispatch("shutdown", {});
