import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const hostPath = fileURLToPath(new URL('../../host.mjs', import.meta.url));
const scratch = fileURLToPath(new URL('../../../work/extension-compatibility-tests/', import.meta.url));
const foreign = { id: 'example.mixin', name: 'Example', version: '1.0.0',
  entryAssembly: 'lib/DoNotLoad.dll', mixinConfig: 'patch.json', pclCoreVersion: '2026.07.1' };

async function start(t, damaged = false) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'host-'));
  if (damaged) await writeFile(path.join(root, 'extensions.json'), 'not-json');
  const child = spawn(process.execPath, [hostPath, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', line => pending.shift()?.(JSON.parse(line)));
  t.after(async () => {
    child.kill('SIGKILL');
    lines.close();
    await rm(root, { recursive: true, force: true });
  });
  function rpc(operation, args = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated host reply timed out.')), 5000);
      pending.push(reply => { clearTimeout(timer); resolve(reply); });
      child.stdin.write(JSON.stringify({ operation, args }) + '\n');
    });
  }
  return { root, rpc };
}

test('foreign file inspection never loads code, changes install state or issues consent', { timeout: 12000 }, async t => {
  const { root, rpc } = await start(t);
  const file = path.join(root, 'plugin.json');
  await writeFile(file, JSON.stringify(foreign));
  // These deliberately invalid assembly/config files must never be read/loaded.
  await mkdir(path.join(root, 'lib'));
  await writeFile(path.join(root, foreign.entryAssembly), 'This is not an assembly.');
  await writeFile(path.join(root, foreign.mixinConfig), 'This is not JSON.');
  const before = await rpc('extensions_list');
  const nativeSource = await readFile(new URL('../examples/instance-compass.json', import.meta.url), 'utf8');
  const nativeReview = await rpc('extensions_review', { source: nativeSource });
  assert.equal(nativeReview.ok, true);
  const filesBefore = await readdir(root);
  const reply = await rpc('extensions_review', { path: file });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.kind, 'compatibility-report');
  assert.equal(reply.result.loadable, false);
  assert.equal(reply.result.codeExecuted, false);
  assert.equal(reply.result.signatureVerified, false);
  assert.equal(Object.hasOwn(reply.result, 'token'), false);
  assert.deepEqual(await rpc('extensions_list'), before);
  assert.deepEqual(await readdir(root), filesBefore);
  const confirm = await rpc('extensions_confirm', { token: foreign.id, grants: ['ui.inject'] });
  assert.equal(confirm.ok, false);
  assert.match(confirm.error, /expired/);
  assert.deepEqual(await rpc('extensions_list'), before);
  // Native reviews remain usable after foreign inspection; their token is not
  // replaced, reused or promoted from the foreign report.
  const installed = await rpc('extensions_confirm', { token: nativeReview.result.token,
    grants: nativeReview.result.capabilities.filter(c => c.required).map(c => c.id) });
  assert.equal(installed.ok, true);
  assert.equal((await rpc('extensions_list')).result.entries.length, 1);
  assert.equal((await rpc('extensions_review', { source: '{"entryPoint":{},"id":"a","id":"b"}' })).ok, false);
});

test('damaged native store does not prevent read-only diagnosis or get overwritten', { timeout: 12000 }, async t => {
  const { root, rpc } = await start(t, true);
  assert.ok((await rpc('extensions_list')).result.warning);
  assert.equal((await rpc('extensions_review', { source: JSON.stringify(foreign) })).ok, true);
  assert.equal(await readFile(path.join(root, 'extensions.json'), 'utf8'), 'not-json');
});
