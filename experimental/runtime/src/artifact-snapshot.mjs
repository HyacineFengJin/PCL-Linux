import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check } from './errors.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function recordDigest(value) { return sha256(JSON.stringify(value)); }

/** One receipt policy for bounded snapshots and indexed read-only access.
 * The caller chooses a finite file limit; output roots and receipt ownership
 * never come from the model or the renderer. */
export function sourceReceipt(job, operationId, { maxFiles = 300 } = {}) {
  check(typeof operationId === 'string' && /^[a-zA-Z0-9_-]{1,120}(?![\s\S])/.test(operationId), 'INVALID_SOURCE', 'Expected a source operation ID');
  const receipt = job.operations.find(op => op.id === operationId && op.status === 'completed');
  const kindAllowed = job.profile === 'maker' ? ['maker.generate', 'maker.revise', 'maker.edit_source'] : ['porter.apply_patch'];
  check(receipt && kindAllowed.includes(receipt.name), 'INVALID_SOURCE', 'Select a completed source receipt from this workflow');
  const generated = receipt.name === 'maker.generate';
  const expected = generated ? `generated/${operationId}` : `reviewed/${receipt.result.reviewId}`;
  check(generated ? receipt.result.status === 'source_generated_only'
    : receipt.result.status === 'reviewed_copy_created' && /^[a-f0-9-]{36}(?![\s\S])/.test(receipt.result.reviewId)
      && operationId === `host-${receipt.result.reviewId}`, 'INVALID_SOURCE', 'Source receipt is not a host-owned source artifact');
  check(receipt.result.outputDirectory === expected && Array.isArray(receipt.result.artifacts)
    && receipt.result.artifacts.length > 0 && receipt.result.artifacts.length <= maxFiles, 'INVALID_SOURCE', 'Invalid source inventory');
  return { expected, entries: receipt.result.artifacts };
}

/** Verify a host receipt and capture bounded immutable bytes; never execute source. */
export async function captureSourceArtifact(store, job, operationId) {
  const { expected, entries } = sourceReceipt(job, operationId);
  const workspace = await store.workspace(job.id); const files = {}; const inventory = []; let total = 0;
  const expectedPaths = new Set();
  for (const entry of entries) {
    check(typeof entry.path === 'string' && entry.path.startsWith(expected + '/') && !expectedPaths.has(entry.path), 'INVALID_SOURCE', 'Invalid source inventory path');
    expectedPaths.add(entry.path);
    const handle = await fs.open(await workspace.resolve(entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = await handle.stat();
      check(stat.isFile() && stat.nlink === 1 && stat.size <= 1_000_000, 'SOURCE_CHANGED', 'Source file is no longer a bounded private regular file');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    total += bytes.length; check(total <= 256_000, 'SOURCE_TOO_LARGE', 'Build snapshot exceeds 256 KB');
    check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'SOURCE_CHANGED', 'Source bytes differ from the host receipt');
    const relative = entry.path.slice(expected.length + 1); files[relative] = bytes;
    inventory.push({ path: relative, bytes: bytes.length, sha256: entry.sha256 });
  }
  // Verify the whole selected tree, not merely the files listed in a receipt.
  const actual = []; let visited = 0;
  async function walk(directory, prefix, depth = 0) {
    check(depth < 32, 'SOURCE_TOO_LARGE', 'Source directory nesting exceeds the limit');
    for (const name of await fs.readdir(directory)) {
      check(++visited <= 600, 'SOURCE_TOO_LARGE', 'Source tree exceeds its entry limit');
      const relative = `${prefix}/${name}`; const full = path.join(directory, name); const stat = await fs.lstat(full);
      check(!stat.isSymbolicLink(), 'SOURCE_CHANGED', 'Source tree contains a symlink');
      if (stat.isDirectory()) await walk(full, relative, depth + 1);
      else { check(stat.isFile(), 'SOURCE_CHANGED', 'Source tree contains a special file'); actual.push(relative); }
      check(actual.length <= 300, 'SOURCE_TOO_LARGE', 'Source tree exceeds its file limit');
    }
  }
  await walk(path.join(workspace.root, expected), expected);
  check(actual.length === expectedPaths.size && actual.every(name => expectedPaths.has(name)), 'SOURCE_CHANGED', 'Source inventory has changed');
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return { operationId, directory: expected, inventory, files,
    fingerprint: recordDigest({ jobId: job.id, workflow: job.profile, operationId, inventory }) };
}
