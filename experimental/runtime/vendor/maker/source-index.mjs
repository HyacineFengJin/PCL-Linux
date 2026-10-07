/** Read-only project access. Indexing streams bounded files to verify receipts;
 * only one requested text chunk or a finite search page is returned. This is
 * deliberately independent of copy/edit snapshots: a larger readable project
 * does not gain permission to bypass handwritten protection or review limits.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { sourceReceipt, recordDigest } from "../../src/artifact-snapshot.mjs";
export const INDEX_LIMITS = Object.freeze({
  files: 1024,
  entries: 2048,
  totalBytes: 8_000_000,
  fileBytes: 1_000_000,
  chunkBytes: 16_384,
  pageFiles: 50,
  searchFiles: 32,
  searchBytes: 2_000_000,
  matches: 40,
});
const textFile = (name) =>
  /\.(java|json|mcmeta|lang|txt|md|properties|gradle|kts|toml|xml)$/i.test(
    name,
  );
function need(ok, message) {
  if (!ok) throw new Error(message);
}
function integer(value, max) {
  need(
    Number.isSafeInteger(value) && value >= 0 && value <= max,
    "Invalid index cursor",
  );
  return value;
}
function term(value, max, empty = true) {
  need(
    typeof value === "string" &&
      value.length <= max &&
      (empty || value.length > 0) &&
      !/[\x00-\x1f\x7f]/.test(value),
    "Invalid search text",
  );
  return value;
}
async function verifiedFile(workspace, name, entry, keep = false) {
  const handle = await fs.open(
    await workspace.resolve(name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    need(
      before.isFile() &&
        before.nlink === 1 &&
        before.size === entry.bytes &&
        before.size <= INDEX_LIMITS.fileBytes,
      "Indexed source file changed",
    );
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65_536),
      parts = [];
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      need(total <= entry.bytes, "Indexed source file grew during read");
      hash.update(buffer.subarray(0, bytesRead));
      if (keep) parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    need(
      total === entry.bytes &&
        hash.digest("hex") === entry.sha256 &&
        after.nlink === 1 &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "Indexed source bytes differ from the host receipt",
    );
    return keep ? Buffer.concat(parts, total) : null;
  } finally {
    await handle.close();
  }
}
export async function captureIndexedSource(store, job, operationId) {
  const { expected, entries } = sourceReceipt(job, operationId, {
    maxFiles: INDEX_LIMITS.files,
  });
  const workspace = await store.workspace(job.id),
    paths = new Set(),
    inventory = [];
  let totalBytes = 0;
  for (const entry of entries) {
    need(
      typeof entry.path === "string" &&
        entry.path.startsWith(expected + "/") &&
        !paths.has(entry.path) &&
        entry.path.length < 1024,
      "Invalid indexed source path",
    );
    need(
      Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= INDEX_LIMITS.fileBytes &&
        typeof entry.sha256 === "string" &&
        /^[a-f0-9]{64}(?![\s\S])/.test(entry.sha256),
      "Invalid indexed source inventory",
    );
    totalBytes += entry.bytes;
    need(totalBytes <= INDEX_LIMITS.totalBytes, "Source index exceeds 8 MB");
    paths.add(entry.path);
    inventory.push({
      path: entry.path.slice(expected.length + 1),
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }
  // Verify the complete tree, including unlisted entries and directory symlinks.
  // Inspect one finite directory iterator at a time, rather than a recursive
  // unbounded readdir result. No index cache hides subsequent external changes.
  let visited = 0,
    files = 0;
  async function walk(directory, prefix, depth = 0) {
    need(
      depth < 32 && !(await fs.lstat(directory)).isSymbolicLink(),
      "Unsafe source directory",
    );
    const stream = await fs.opendir(directory);
    for await (const entry of stream) {
      need(
        ++visited <= INDEX_LIMITS.entries,
        "Source index entry limit exceeded",
      );
      const name = `${prefix}/${entry.name}`,
        full = path.join(directory, entry.name),
        stat = await fs.lstat(full);
      need(!stat.isSymbolicLink(), "Source index contains a symlink");
      if (stat.isDirectory()) await walk(full, name, depth + 1);
      else {
        need(stat.isFile() && paths.has(name), "Source inventory has changed");
        files++;
      }
    }
  }
  // Resolving a listed file also checks the expected root's directory ancestors.
  await workspace.resolve(entries[0].path);
  await walk(path.join(workspace.root, expected), expected);
  need(files === entries.length, "Source inventory has changed");
  for (const entry of entries) await verifiedFile(workspace, entry.path, entry);
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return {
    job,
    workspace,
    snapshot: {
      operationId,
      directory: expected,
      inventory,
      totalBytes,
      treeEntries: visited,
      fingerprint: recordDigest({
        jobId: job.id,
        workflow: job.profile,
        operationId,
        inventory,
      }),
    },
  };
}
export function indexPage(source, { offset = 0, filter = "" } = {}) {
  integer(offset, INDEX_LIMITS.files);
  term(filter, 120);
  const entries = source.snapshot.inventory.filter((entry) =>
    entry.path.includes(filter),
  );
  const page = entries
    .slice(offset, offset + INDEX_LIMITS.pageFiles)
    .map((entry) => ({ ...entry, text: textFile(entry.path) }));
  return {
    fingerprint: source.snapshot.fingerprint,
    fileCount: source.snapshot.inventory.length,
    totalBytes: source.snapshot.totalBytes,
    editableSnapshot:
      source.snapshot.inventory.length <= 300 &&
      source.snapshot.totalBytes <= 256_000 &&
      source.snapshot.treeEntries <= 600,
    filteredCount: entries.length,
    files: page,
    nextOffset:
      offset + page.length < entries.length ? offset + page.length : null,
  };
}
async function readText(source, name) {
  const entry = source.snapshot.inventory.find((value) => value.path === name);
  need(entry && textFile(name), "Select an indexed supported text file");
  const bytes = await verifiedFile(
    source.workspace,
    `${source.snapshot.directory}/${name}`,
    entry,
    true,
  );
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  need(
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content),
    "Indexed text contains binary controls",
  );
  return { entry, bytes, content };
}
export async function readIndexFile(source, { path: name, offset = 0 }) {
  integer(offset, INDEX_LIMITS.fileBytes);
  const { entry, bytes } = await readText(source, name);
  need(
    offset <= bytes.length &&
      (offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80),
    "Text cursor is not a UTF-8 boundary",
  );
  let end = Math.min(offset + INDEX_LIMITS.chunkBytes, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    path: name,
    sha256: entry.sha256,
    bytes: entry.bytes,
    offset,
    content: new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset, end),
    ),
    nextOffset: end < bytes.length ? end : null,
  };
}
export async function searchIndex(source, { query, offset = 0 }) {
  term(query, 120, false);
  integer(offset, INDEX_LIMITS.files);
  const entries = source.snapshot.inventory.filter((entry) =>
    textFile(entry.path),
  );
  const matches = [];
  let index = offset,
    scannedFiles = 0,
    scannedBytes = 0;
  while (
    index < entries.length &&
    scannedFiles < INDEX_LIMITS.searchFiles &&
    matches.length < INDEX_LIMITS.matches
  ) {
    const entry = entries[index];
    if (scannedFiles && scannedBytes + entry.bytes > INDEX_LIMITS.searchBytes)
      break;
    const { content } = await readText(source, entry.path);
    scannedFiles++;
    scannedBytes += entry.bytes;
    index++;
    let start = 0,
      line = 1;
    while (start < content.length) {
      const end = content.indexOf("\n", start),
        stop = end < 0 ? content.length : end;
      const local = content.slice(start, stop).indexOf(query),
        found = local < 0 ? -1 : start + local;
      if (found >= start && found < stop) {
        matches.push({
          path: entry.path,
          sha256: entry.sha256,
          line,
          snippet: content.slice(
            Math.max(start, found - 80),
            Math.min(stop, found + query.length + 80),
          ),
        });
      }
      if (matches.length >= INDEX_LIMITS.matches) break;
      start = stop + 1;
      line++;
    }
  }
  return {
    query,
    fingerprint: source.snapshot.fingerprint,
    scannedFiles,
    scannedBytes,
    matches,
    nextOffset: index < entries.length ? index : null,
    truncatedFile:
      matches.length >= INDEX_LIMITS.matches ? entries[index - 1]?.path : null,
  };
}
