/** Retained Porter comparison against the real store/review bridge. Authored
 * private fixtures only: no model, source fetch, build, game or native app. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PorterProjects } from "../../porter-projects.mjs";
import { PorterVersions } from "../../porter-versions.mjs";
import { porterTextDiff } from "../../porter-text-diff.mjs";
import { JobStore } from "../src/store.mjs";
import { HostReviewService } from "../src/reviews.mjs";
import { sha256 } from "../src/artifact-snapshot.mjs";

const scratch = fileURLToPath(
  new URL("../../../work/porter-tests/versions/", import.meta.url),
);
const file = "src/示例.java";
const original = {
  [file]: "class Example {\n  int count = 1;\n}\n",
  "src/Other.java": "class Other {}",
  "src/data.json": "{}\n",
};
async function inventory(root) {
  const found = {};
  async function walk(directory, prefix = "") {
    for (const name of (await fs.readdir(directory)).sort()) {
      const full = path.join(directory, name),
        relative = prefix + name,
        stat = await fs.lstat(full);
      if (stat.isSymbolicLink())
        found[relative] = `link:${await fs.readlink(full)}`;
      else if (stat.isDirectory()) {
        found[relative + "/"] = stat.mode;
        await walk(full, relative + "/");
      } else found[relative] = sha256(await fs.readFile(full));
    }
  }
  await walk(root);
  return found;
}
async function fixture(t, grants = [file]) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "retained-"));
  const store = await new JobStore(path.join(root, "jobs")).init();
  const reviews = new HostReviewService({ store });
  const runtime = { getJob: (id) => store.load(id), hasActiveJob: () => false };
  const projects = await new PorterProjects(root, runtime).init();
  let p = await projects.create({
    name: "Example migration",
    goal: "Preserve behavior",
    targetId: "neoforge-26.2",
    rights: "owner",
    source: { files: original, permittedPaths: grants },
  });
  const versions = new PorterVersions({ projects, store, reviews });
  async function round() {
    const r = await projects.beginRound(
      p.id,
      { revision: p.revision, mode: "template" },
      async (input, permittedPaths) => {
        const job = await store.create({
          profile: "porter",
          provider: "fixture",
          input,
        });
        if (permittedPaths.length)
          await reviews.registerPorterSource(job.id, {
            files: input.files,
            permittedPaths,
          });
        job.status = "completed";
        await store.save(job);
        return job;
      },
    );
    p = await projects.read(p.id);
    return { kind: "input", jobId: r.jobId };
  }
  const input = await round();
  async function copy() {
    const proposal = await reviews.requestPorterPatch(input.jobId, {
      sourceId: "primary",
      replacements: { [file]: original[file].replace("1;", "2;") },
      purpose: "Preserve authored change",
    });
    const approval = await reviews.approveReview(input.jobId, {
      reviewId: proposal.reviewId,
      expectedDigest: proposal.reviewDigest,
    });
    const result = await reviews.applyApprovedReview(input.jobId, {
      reviewId: proposal.reviewId,
      approvalToken: approval.approvalToken,
    });
    return {
      kind: "artifact",
      jobId: input.jobId,
      operationId: `host-${result.reviewId}`,
    };
  }
  t.after(async () => {
    await reviews.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    reviews,
    projects,
    versions,
    input,
    copy,
    runtime,
    round,
    get p() {
      return p;
    },
    async baseline(files, permittedPaths = []) {
      p = await projects.setSource(p.id, {
        revision: p.revision,
        source: { files, permittedPaths },
      });
    },
  };
}

test("frozen input and a real approved copy compare without any disk write, including restart", async (t) => {
  const f = await fixture(t),
    copy = await f.copy();
  const before = await inventory(f.root);
  const listed = await f.versions.list(f.p.id);
  assert.deepEqual(
    listed.versions.map((v) => v.ref),
    [f.input, copy],
  );
  const result = await f.versions.compare(f.p.id, f.input, copy);
  assert.deepEqual(result.counts, {
    added: 0,
    deleted: 0,
    modified: 1,
    unchanged: 2,
  });
  assert.match(
    result.changes[0].diff.text,
    /-  int count = 1;\n\+  int count = 2;/,
  );
  assert.equal(result.changes[0].path, file);
  assert.equal(result.scope, "retained-project-text-only");
  assert.deepEqual(await inventory(f.root), before);
  const restart = new PorterVersions({
    projects: await new PorterProjects(f.root, f.runtime).init(),
    store: f.store,
    reviews: f.reviews,
  });
  assert.deepEqual(await restart.compare(f.p.id, f.input, copy), result);
  assert.deepEqual(await inventory(f.root), before);
});

test("two frozen rounds classify additions, deletion, modification and empty files independently of current baseline", async (t) => {
  const f = await fixture(t);
  await f.baseline({
    [file]: "class Different {}",
    "src/Other.java": original["src/Other.java"],
    "src/New.java": "",
  });
  const next = await f.round();
  await f.baseline({ "src/Current.java": "class Current {}" });
  const before = await inventory(f.root),
    result = await f.versions.compare(f.p.id, f.input, next);
  assert.deepEqual(result.counts, {
    added: 1,
    deleted: 1,
    modified: 1,
    unchanged: 1,
  });
  assert.equal(result.changes.find((c) => c.kind === "added").afterBytes, 0);
  assert.equal(
    result.changes.find((c) => c.kind === "deleted").afterHash,
    null,
  );
  assert.deepEqual(await inventory(f.root), before);
  const reverse = await f.versions.compare(f.p.id, next, f.input);
  assert.equal(
    reverse.changes.find((c) => c.path === "src/data.json").kind,
    "added",
  );
  const equal = await f.versions.compare(f.p.id, next, next);
  assert.equal(equal.changes.length, 0);
  assert.equal(equal.counts.unchanged, 3);
});

test("only registered same-project references are accepted; arbitrary paths and unregistered jobs are rejected", async (t) => {
  const f = await fixture(t),
    copy = await f.copy();
  const foreign = await f.projects.create({
    name: "Other",
    goal: "Other goal",
    targetId: "neoforge-26.2",
    rights: "owner",
    source: { files: original, permittedPaths: [] },
  });
  for (const ref of [
    { ...f.input, path: "/arbitrary" },
    { ...f.input, operationId: copy.operationId },
    { kind: "artifact", jobId: f.input.jobId, operationId: "../../path" },
    { ...f.input, jobId: randomUUID() },
    { ...copy, operationId: `host-${randomUUID()}` },
  ])
    await assert.rejects(f.versions.compare(f.p.id, ref, f.input));
  await assert.rejects(
    f.versions.compare(foreign.id, f.input, copy),
    /not registered/,
  );
});

test("canonical file keys never inherit missing content from Object.prototype", async (t) => {
  const f = await fixture(t, []);
  await f.baseline({ constructor: "retained text" });
  const left = await f.round();
  await f.baseline({ toString: "other retained text" });
  const right = await f.round();
  const result = await f.versions.compare(f.p.id, left, right);
  assert.deepEqual(result.counts, {
    added: 1,
    deleted: 1,
    modified: 0,
    unchanged: 0,
  });
});

for (const damage of [
  "changed",
  "added",
  "removed",
  "symlink",
  "hardlink",
  "receipt",
  "changed-receipt",
  "review",
  "input",
  "import",
  "import-null",
  "import-missing",
  "project",
  "workspace",
]) {
  test(`damaged ${damage} is rejected and retained without repair`, async (t) => {
    const f = await fixture(t),
      copy = await f.copy();
    const jobFile = path.join(f.store.directory(copy.jobId), "job.json");
    const record = JSON.parse(await fs.readFile(jobFile, "utf8"));
    const receipt = record.operations.find((r) => r.id === copy.operationId);
    const workspace = path.join(f.store.directory(copy.jobId), "workspace");
    const output = path.join(workspace, receipt.result.outputDirectory),
      target = path.join(output, file);
    if (damage === "changed") await fs.writeFile(target, "external edit");
    if (damage === "added")
      await fs.writeFile(path.join(output, "unexpected.java"), "extra");
    if (damage === "removed") await fs.unlink(target);
    if (damage === "symlink") {
      await fs.unlink(target);
      await fs.symlink(path.join(output, "src/Other.java"), target);
    }
    if (damage === "hardlink")
      await fs.link(target, path.join(f.root, "external-link"));
    if (damage === "receipt") {
      receipt.result.reviewDigest = "0".repeat(64);
      await fs.writeFile(jobFile, JSON.stringify(record));
    }
    if (damage === "changed-receipt") {
      const text = "coordinated external edit";
      await fs.writeFile(target, text);
      const entry = receipt.result.artifacts.find((v) =>
        v.path.endsWith("/" + file),
      );
      entry.bytes = Buffer.byteLength(text);
      entry.sha256 = sha256(text);
      await fs.writeFile(jobFile, JSON.stringify(record));
    }
    if (damage === "review") {
      const reviewFile = path.join(
        f.store.directory(copy.jobId),
        "review-control/reviews",
        `${receipt.result.reviewId}.json`,
      );
      const review = JSON.parse(await fs.readFile(reviewFile, "utf8"));
      review.preview.changed = "tampered";
      await fs.writeFile(reviewFile, JSON.stringify(review));
    }
    if (damage === "input") {
      record.input.files[file] = "tampered input";
      await fs.writeFile(jobFile, JSON.stringify(record));
    }
    if (damage === "import") {
      const primary = path.join(
        f.store.directory(copy.jobId),
        "review-control/sources/primary.json",
      );
      const source = JSON.parse(await fs.readFile(primary, "utf8"));
      source.files[file] = "tampered import";
      await fs.writeFile(primary, JSON.stringify(source));
    }
    if (damage === "import-null")
      await fs.writeFile(
        path.join(
          f.store.directory(copy.jobId),
          "review-control/sources/primary.json",
        ),
        "null",
      );
    if (damage === "import-missing")
      await fs.unlink(
        path.join(
          f.store.directory(copy.jobId),
          "review-control/sources/primary.json",
        ),
      );
    if (damage === "project") {
      const projectFile = path.join(
        f.root,
        "porter-projects",
        f.p.id,
        "project.json",
      );
      await fs.appendFile(projectFile, " ");
    }
    if (damage === "workspace")
      await fs.rename(workspace, path.join(f.root, "retained-workspace"));
    const before = await inventory(f.root);
    await assert.rejects(f.versions.compare(f.p.id, f.input, copy));
    assert.deepEqual(await inventory(f.root), before);
  });
}

test("legacy frozen input uses an existing proof, and unprovable history remains intact", async (t) => {
  const f = await fixture(t, []);
  const projectFile = path.join(
    f.root,
    "porter-projects",
    f.p.id,
    "project.json",
  );
  const old = JSON.parse(await fs.readFile(projectFile, "utf8"));
  delete old.rounds[0].sourceFingerprint;
  await fs.writeFile(projectFile, JSON.stringify(old));
  const projects = await new PorterProjects(f.root, f.runtime).init();
  const versions = new PorterVersions({
    projects,
    store: f.store,
    reviews: f.reviews,
  });
  assert.equal(
    (await versions.compare(old.id, f.input, f.input)).changes.length,
    0,
  );
  await projects.setSource(old.id, {
    revision: old.revision,
    source: { files: { "src/New.java": "class New {}" }, permittedPaths: [] },
  });
  const before = await inventory(f.root);
  await assert.rejects(
    versions.compare(old.id, f.input, f.input),
    /no verifiable fingerprint/,
  );
  assert.deepEqual(await inventory(f.root), before);
});

test("existing Python source fingerprints retain Unicode codepoint order and ASCII encoding", async (t) => {
  const f = await fixture(t);
  const files = {
    "src/😀.java": "// Unicode source\n",
    "src/\ue000.java": "// Private codepoint source\n",
  };
  await f.baseline(files, ["src/😀.java"]);
  const input = await f.round();
  assert.equal(
    (await f.versions.compare(f.p.id, input, input)).counts.unchanged,
    2,
  );
});

test("comparison enforces 30KB independently of valid provenance and caps diff output/work", async (t) => {
  const f = await fixture(t);
  const jobFile = path.join(f.store.directory(f.input.jobId), "job.json"),
    job = JSON.parse(await fs.readFile(jobFile, "utf8"));
  job.input.files[file] = "x".repeat(30000);
  await fs.writeFile(jobFile, JSON.stringify(job));
  await assert.rejects(f.versions.compare(f.p.id, f.input, f.input), /30000/);
  const small = porterTextDiff(
    "Example.java",
    "a\r\nb\nlast",
    "a\r\nc\nlast\n",
  );
  assert.match(small.text, /No newline at end of file/);
  assert.equal(small.truncated, false);
  const many = porterTextDiff(
    "Example.java",
    "a\n".repeat(2000),
    "b\n".repeat(2000),
    1024,
  );
  assert.equal(many.coarse, true);
  assert.equal(many.truncated, true);
  assert.ok(Buffer.byteLength(many.text) <= 1024);
  const long = porterTextDiff("Example.java", "old\n", "界".repeat(1000), 128);
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text) <= 128);
  const separated = porterTextDiff(
    "Example.java",
    "old\n" + "same\n".repeat(12) + "old\n",
    "new\n" + "same\n".repeat(12) + "new\n",
  );
  assert.equal((separated.text.match(/@@ -/g) || []).length, 2);
});

test("bounded display keeps all 600 file classifications and lists retained candidates within 256 versions", async (t) => {
  const f = await fixture(t, []);
  const beforeFiles = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `src/Before${i}.java`,
      "class Before {}\n",
    ]),
  );
  const afterFiles = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `src/After${i}.java`,
      "class After {}\n",
    ]),
  );
  await f.baseline(beforeFiles);
  const left = await f.round();
  await f.baseline(afterFiles);
  const right = await f.round();
  const result = await f.versions.compare(f.p.id, left, right);
  assert.deepEqual(result.counts, {
    added: 300,
    deleted: 300,
    modified: 0,
    unchanged: 0,
  });
  assert.equal(result.changes.length, 600);
  assert.ok(result.changes.some((c) => c.diff.truncated));
  assert.ok(
    result.changes.reduce((n, c) => n + Buffer.byteLength(c.diff.text), 0) <=
      48000,
  );
  const job = await f.store.load(left.jobId);
  // Candidate listing reads bound receipt metadata; actual IO/provenance is
  // checked only for selected references, without scanning hundreds of trees.
  job.operations = Array.from({ length: 300 }, () => {
    const reviewId = randomUUID();
    return {
      id: `host-${reviewId}`,
      name: "porter.apply_patch",
      status: "completed",
      fingerprint: "1".repeat(64),
      result: {
        reviewId,
        reviewDigest: "1".repeat(64),
        status: "reviewed_copy_created",
        outputDirectory: `reviewed/${reviewId}`,
      },
    };
  });
  await f.store.save(job);
  const list = await f.versions.list(f.p.id);
  assert.equal(list.versions.length, 256);
  assert.equal(list.omittedCopies, 47);
  assert.equal(list.versions.filter((v) => v.ref.kind === "input").length, 3);
  const rejected = list.versions.find((v) => v.ref.kind === "artifact").ref;
  const retained = await inventory(f.root);
  await assert.rejects(f.versions.compare(f.p.id, left, rejected));
  assert.deepEqual(await inventory(f.root), retained);
});
