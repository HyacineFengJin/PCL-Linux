import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { inspectForeignManifest } from '../src/compatibility.mjs';
import { MAX_MANIFEST_BYTES } from '../src/json.mjs';

// This CLI only reads the manifest itself. Assembly, Mixin and dependency paths
// stay inert text even when they name files beside the selected manifest.
try {
  if (process.argv.length !== 3) throw new Error('Usage: node inspect.mjs <plugin.json>');
  const handle = await open(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Expected a manifest no larger than 64 KiB.');
    // Reserve only the allowed size plus one overflow byte, even if the file
    // grows after stat. Do not read an unbounded concurrently replaced input.
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds limit.');
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
  const report = inspectForeignManifest(source);
  if (!report) throw new Error('Manifest is not recognized as PCL N or PCL Nex.');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  process.stderr.write((error.code?.startsWith('COMPAT_') || error.code?.startsWith('JSON_') ?
    `${error.code}: ${error.message}` : 'Manifest inspection failed; check the file and CLI arguments.') + '\n');
  process.exitCode = 1;
}
