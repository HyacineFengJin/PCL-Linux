/** Porter-only retained version reader, derived from registered project rounds.
 * No general path/index, baseline mutation, model tool or new authority exists.
 * Selected copies reuse host receipts/full-tree hashes; frozen runs require a
 * recorded fingerprint or a provable legacy source. Damaged records stay put. */
import { TextDecoder } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { check, cloneJson } from "./runtime/src/errors.mjs";
import {
  captureSourceArtifact,
  sha256,
} from "./runtime/src/artifact-snapshot.mjs";
import { porterSnapshotFingerprint } from "./porter-projects.mjs";
import { porterTextDiff } from "./porter-text-diff.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
function filesChecked(files) {
  check(
    files &&
      typeof files === "object" &&
      !Array.isArray(files) &&
      Object.keys(files).length <= 300 &&
      Object.entries(files).every(
        ([p, text]) =>
          typeof text === "string" &&
          text.isWellFormed() &&
          !text.includes("\0") &&
          p.length > 0 &&
          p.length <= 500 &&
          p.isWellFormed() &&
          !/[\\:\x00-\x1f]/.test(p) &&
          p.split("/").every((v) => v && v !== "." && v !== ".."),
      ),
    "INVALID_SOURCE",
    "Retained version is not a canonical UTF-8 text snapshot; originals retained",
  );
  return cloneJson(files, { maxBytes: 30000, code: "SOURCE_SIZE_LIMIT" });
}
function referenceChecked(ref) {
  check(
    ref &&
      typeof ref === "object" &&
      UUID.test(ref.jobId) &&
      ["input", "artifact"].includes(ref.kind) &&
      Object.keys(ref).every((k) =>
        [
          "kind",
          "jobId",
          ...(ref.kind === "artifact" ? ["operationId"] : []),
        ].includes(k),
      ) &&
      (ref.kind === "input" ||
        (typeof ref.operationId === "string" &&
          /^host-[a-f0-9-]{36}$/.test(ref.operationId))),
    "INVALID_VERSION",
    "Select a frozen input or host copy from this project; paths are not accepted",
  );
  return ref;
}
// Python imported_snapshot fingerprints sorted per-file hashes using its
// default ASCII JSON separators. Preserve that existing format for old runs.
const asciiJson = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const codepointOrder = (a, b) => {
  const left = Array.from(a, (c) => c.codePointAt(0)),
    right = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};
const legacyFingerprint = (files) =>
  sha256(
    "{" +
      Object.keys(files)
        .sort(codepointOrder)
        .map((p) => `${asciiJson(p)}: ${asciiJson(sha256(files[p]))}`)
        .join(", ") +
      "}",
  );

export class PorterVersions {
  constructor({ projects, store, reviews }) {
    this.projects = projects;
    this.store = store;
    this.reviews = reviews;
  }
  async bound(project, ref) {
    referenceChecked(ref);
    const round = project.rounds.find((r) => r.jobId === ref.jobId);
    check(
      round,
      "WRONG_PROJECT",
      "Version is not registered in this Porter project",
    );
    const job = await this.store.load(ref.jobId),
      binding = job.input?.porterProject;
    check(
      job.profile === "porter" &&
        binding?.id === project.id &&
        binding.roundId === round.id &&
        binding.baselineRevision === round.baselineRevision &&
        job.input.targetId === round.targetId &&
        (round.sourceFingerprint === undefined ||
          binding.sourceFingerprint === round.sourceFingerprint) &&
        (round.sourceRegistered === undefined ||
          binding.sourceRegistered === round.sourceRegistered),
      "WRONG_PROJECT",
      "Frozen run no longer matches its project round; originals retained",
    );
    return { job, round };
  }
  async list(projectId) {
    const project = await this.projects.readRetained(projectId),
      inputs = [],
      copies = [];
    for (const [i, r] of project.rounds.entries()) {
      const ref = { kind: "input", jobId: r.jobId };
      const { job } = await this.bound(project, ref);
      const metadata = {
        round: i + 1,
        baselineRevision: r.baselineRevision,
        createdAt: r.createdAt,
      };
      inputs.push({ ref, ...metadata });
      for (const receipt of job.operations || []) {
        if (
          receipt.name !== "porter.apply_patch" ||
          receipt.status !== "completed"
        )
          continue;
        this.receipt(job, receipt.id);
        copies.push({
          ref: { kind: "artifact", jobId: job.id, operationId: receipt.id },
          ...metadata,
        });
      }
    }
    // Keep every frozen input and copies from newer registered rounds within a
    // bounded selector. Receipts retain their order inside each round; this is
    // not a global wall-clock index of edits made later to older rounds.
    const retained = copies.slice(-(256 - inputs.length));
    await this.projects.readRetained(projectId);
    return cloneJson(
      {
        versions: [...inputs, ...retained],
        omittedCopies: copies.length - retained.length,
      },
      { maxBytes: 128000 },
    );
  }
  async frozen(project, job, round) {
    const files = filesChecked(job.input.files),
      fingerprint = porterSnapshotFingerprint(files);
    let source,
      sourcePresent = false;
    try {
      source = JSON.parse(
        (
          await (
            await this.store.files(job.id)
          ).read("review-control/sources/primary.json")
        ).content,
      );
      sourcePresent = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    check(
      !round.sourceRegistered || sourcePresent,
      "SOURCE_CHANGED",
      "Registered frozen source is missing; originals retained",
    );
    if (sourcePresent) {
      check(
        source &&
          source.jobId === job.id &&
          source.id === "primary" &&
          HEX.test(source.fingerprint) &&
          source.fingerprint ===
            legacyFingerprint(filesChecked(source.files)) &&
          porterSnapshotFingerprint(source.files) === fingerprint,
        "SOURCE_CHANGED",
        "Frozen source differs from its imported fingerprint; originals retained",
      );
    }
    const anchored =
      round.sourceFingerprint && round.sourceFingerprint === fingerprint;
    const matchingBaseline =
      project.snapshot?.revision === round.baselineRevision &&
      project.snapshot.fingerprint === fingerprint;
    check(
      anchored || source || matchingBaseline,
      "UNVERIFIED_VERSION",
      "This older frozen input has no verifiable fingerprint; originals retained",
    );
    check(
      round.sourceFingerprint === undefined || anchored,
      "SOURCE_CHANGED",
      "Frozen input fingerprint changed; originals retained",
    );
    return { files, fingerprint };
  }
  async read(project, ref) {
    const { job, round } = await this.bound(project, ref);
    // Verify the frozen source for copies too: their provenance must remain
    // readable even when the project has since adopted a different baseline.
    const frozen = await this.frozen(project, job, round);
    if (ref.kind === "input") return frozen;
    const receipt = this.receipt(job, ref.operationId);
    // Existing review digest validation and whole-tree capture remain the
    // authority. Merely passing an operation ID never authorizes arbitrary IO.
    await (
      await this.store.files(job.id)
    ).resolve(`review-control/reviews/${receipt.result.reviewId}.json`);
    const review = await this.reviews.getReview(
      job.id,
      receipt.result.reviewId,
    );
    check(
      review.kind === "porter_patch" &&
        review.reviewDigest === receipt.fingerprint,
      "SOURCE_CHANGED",
      "Copy no longer matches its original review; originals retained",
    );
    const directory = await fs.lstat(
      path.join(this.store.directory(job.id), "workspace"),
    );
    check(
      directory.isDirectory() && !directory.isSymbolicLink(),
      "SOURCE_CHANGED",
      "Original copy workspace is missing or unsafe; retained",
    );
    const captured = await captureSourceArtifact(
      this.store,
      job,
      ref.operationId,
    );
    // Bind even the captured receipt inventory back to the approved contract.
    // Editing both a copy and its job receipt must not disguise an outside edit.
    const contract = review.preview;
    check(
      contract.contract_version === 1 &&
        contract.source_snapshot?.fingerprint ===
          legacyFingerprint(frozen.files) &&
        Array.isArray(contract.changes) &&
        contract.changes.length > 0,
      "SOURCE_CHANGED",
      "Copy review no longer matches its frozen input; originals retained",
    );
    const expected = Object.fromEntries(
      Object.entries(frozen.files).map(([p, text]) => [p, sha256(text)]),
    );
    const changed = new Set();
    for (const change of contract.changes) {
      check(
        Object.hasOwn(expected, change.path) &&
          !changed.has(change.path) &&
          change.base_sha256 === expected[change.path] &&
          typeof change.new_text === "string" &&
          sha256(change.new_text) === change.new_sha256,
        "SOURCE_CHANGED",
        "Approved copy file hashes are inconsistent; originals retained",
      );
      changed.add(change.path);
      expected[change.path] = change.new_sha256;
    }
    check(
      captured.inventory.length === Object.keys(expected).length &&
        captured.inventory.every((f) => expected[f.path] === f.sha256),
      "SOURCE_CHANGED",
      "Copy inventory differs from its approved original contract; originals retained",
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const files = filesChecked(
      Object.fromEntries(
        Object.entries(captured.files).map(([p, bytes]) => [
          p,
          decoder.decode(bytes),
        ]),
      ),
    );
    return { files, fingerprint: captured.fingerprint };
  }
  receipt(job, operationId) {
    const matches = job.operations?.filter(
      (r) => r.id === operationId && r.status === "completed",
    );
    const receipt = matches?.length === 1 ? matches[0] : null;
    check(
      receipt?.name === "porter.apply_patch" &&
        HEX.test(receipt.fingerprint) &&
        receipt.fingerprint === receipt.result?.reviewDigest &&
        UUID.test(receipt.result?.reviewId) &&
        operationId === `host-${receipt.result.reviewId}` &&
        receipt.result.outputDirectory ===
          `reviewed/${receipt.result.reviewId}` &&
        receipt.result.status === "reviewed_copy_created",
      "INVALID_SOURCE",
      "Copy receipt fingerprint or identity is invalid; originals retained",
    );
    return receipt;
  }
  async compare(projectId, leftRef, rightRef) {
    const project = await this.projects.readRetained(projectId);
    const [left, right] = await Promise.all([
      this.read(project, leftRef),
      this.read(project, rightRef),
    ]);
    const changes = [],
      counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 };
    let remaining = 48000;
    for (const name of [
      ...new Set([...Object.keys(left.files), ...Object.keys(right.files)]),
    ].sort()) {
      const before = Object.hasOwn(left.files, name)
          ? left.files[name]
          : undefined,
        after = Object.hasOwn(right.files, name)
          ? right.files[name]
          : undefined;
      if (before === after) {
        counts.unchanged++;
        continue;
      }
      const kind =
        before === undefined
          ? "added"
          : after === undefined
            ? "deleted"
            : "modified";
      counts[kind]++;
      const diff = porterTextDiff(
        name,
        before ?? "",
        after ?? "",
        Math.min(6000, remaining),
      );
      remaining -= diff.bytes;
      changes.push({
        path: name,
        kind,
        beforeBytes: Buffer.byteLength(before ?? ""),
        afterBytes: Buffer.byteLength(after ?? ""),
        beforeHash: before === undefined ? null : sha256(before),
        afterHash: after === undefined ? null : sha256(after),
        diff: {
          text: diff.text,
          truncated: diff.truncated,
          coarse: diff.coarse,
        },
      });
    }
    await this.projects.readRetained(projectId);
    return cloneJson(
      {
        projectId,
        left: { ref: leftRef, fingerprint: left.fingerprint },
        right: { ref: rightRef, fingerprint: right.fingerprint },
        counts,
        changes,
        scope: "retained-project-text-only",
      },
      { maxBytes: 400000 },
    );
  }
}
