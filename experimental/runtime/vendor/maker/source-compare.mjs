/** Read-only comparison of two registered checkpoints in one project. Each
 * request reuses full receipt/revision verification, never a cached baseline.
 * Lists use only bounded inventories; text is fetched for one selected changed
 * path. The finite prefix/LCS preview is display data, not an applicable patch.
 * No source, project, protection, review or AI state is changed here.
 */
import { INDEX_LIMITS, readIndexPreview } from "./source-index.mjs";
export const COMPARE_LIMITS = Object.freeze({
  pageFiles: 50,
  previewBytes: INDEX_LIMITS.chunkBytes,
  previewLines: 200,
  diffRows: 400,
});
function need(ok, message) {
  if (!ok) throw new Error(message);
}
async function capturePair(projects, args) {
  need(
    typeof args.baseCheckpointId === "string" &&
      typeof args.targetCheckpointId === "string" &&
      args.baseCheckpointId !== args.targetCheckpointId,
    "Select two different recorded source versions",
  );
  const ref = { id: args.id, expectedRevision: args.expectedRevision };
  const base = await projects.source({
    ...ref,
    checkpointId: args.baseCheckpointId,
  });
  const target = await projects.source({
    ...ref,
    checkpointId: args.targetCheckpointId,
  });
  return {
    base,
    target,
    identity: {
      id: base.project.id,
      revision: base.project.revision,
      baseCheckpointId: base.point.id,
      targetCheckpointId: target.point.id,
      baseFingerprint: base.snapshot.fingerprint,
      targetFingerprint: target.snapshot.fingerprint,
    },
  };
}
function inventoryChanges(base, target) {
  const before = new Map(
    base.snapshot.inventory.map((entry) => [entry.path, entry]),
  );
  const after = new Map(
    target.snapshot.inventory.map((entry) => [entry.path, entry]),
  );
  const changes = [],
    counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 };
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort(
    (a, b) => a.localeCompare(b),
  )) {
    const old = before.get(name),
      next = after.get(name);
    if (old && next && old.sha256 === next.sha256 && old.bytes === next.bytes) {
      counts.unchanged++;
      continue;
    }
    const kind = !old ? "added" : !next ? "deleted" : "modified";
    const view = (value) =>
      value ? { bytes: value.bytes, sha256: value.sha256 } : null;
    counts[kind]++;
    changes.push({ path: name, kind, before: view(old), after: view(next) });
  }
  return { changes, counts };
}
export async function compareProjectSources(projects, args) {
  const { offset = 0, filter = "" } = args;
  need(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= INDEX_LIMITS.files * 2,
    "Invalid comparison cursor",
  );
  need(
    typeof filter === "string" &&
      filter.length <= 120 &&
      !/[\x00-\x1f\x7f]/.test(filter),
    "Invalid comparison filter",
  );
  const { base, target, identity } = await capturePair(projects, args);
  const { changes, counts } = inventoryChanges(base, target);
  const filtered = changes.filter((change) => change.path.includes(filter));
  const page = filtered.slice(offset, offset + COMPARE_LIMITS.pageFiles);
  return {
    ...identity,
    counts,
    totalChanges: changes.length,
    filteredCount: filtered.length,
    changes: page,
    offset,
    pageSize: COMPARE_LIMITS.pageFiles,
    nextOffset:
      offset + page.length < filtered.length ? offset + page.length : null,
  };
}
async function textSide(source, name, present) {
  if (!present) return { metadata: null, lines: [] };
  const value = await readIndexPreview(source, { path: name });
  const metadata = {
    bytes: value.bytes,
    sha256: value.sha256,
    status: value.status,
    truncated: false,
    previewBytes: 0,
    previewLines: 0,
  };
  if (value.status !== "text") return { metadata, lines: [] };
  const all = value.content === "" ? [] : value.content.split("\n");
  const lines = all.slice(0, COMPARE_LIMITS.previewLines);
  metadata.truncated = value.truncated || all.length > lines.length;
  metadata.previewBytes = Buffer.byteLength(lines.join("\n"));
  metadata.previewLines = lines.length;
  return { metadata, lines };
}
function linePreview(before, after) {
  // LCS storage/work is fixed at at most 201*201 cells. A long source line or
  // hundreds of unrelated lines cannot trigger unbounded diff computation.
  const width = after.length + 1,
    table = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const rows = [];
  let i = 0,
    j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({
        kind: "context",
        beforeLine: i + 1,
        afterLine: j + 1,
        text: before[i],
      });
      i++;
      j++;
    } else if (
      i < before.length &&
      (j === after.length ||
        table[(i + 1) * width + j] >= table[i * width + j + 1])
    ) {
      rows.push({
        kind: "deleted",
        beforeLine: i + 1,
        afterLine: null,
        text: before[i++],
      });
    } else
      rows.push({
        kind: "added",
        beforeLine: null,
        afterLine: j + 1,
        text: after[j++],
      });
  }
  return rows;
}
export async function compareProjectFile(projects, args) {
  need(
    typeof args.path === "string" && args.path.length < 1024,
    "Select a changed indexed source file",
  );
  const { base, target, identity } = await capturePair(projects, args);
  const change = inventoryChanges(base, target).changes.find(
    (value) => value.path === args.path,
  );
  need(change, "Select a changed indexed source file");
  const before = await textSide(base, change.path, change.before),
    after = await textSide(target, change.path, change.after);
  const comparable = [before, after].every(
    (side) => !side.metadata || side.metadata.status === "text",
  );
  return {
    ...identity,
    change,
    status: comparable ? "text" : "uncomparable",
    before: before.metadata,
    after: after.metadata,
    rows: comparable ? linePreview(before.lines, after.lines) : [],
    limits: {
      bytes: COMPARE_LIMITS.previewBytes,
      lines: COMPARE_LIMITS.previewLines,
      rows: COMPARE_LIMITS.diffRows,
    },
  };
}
