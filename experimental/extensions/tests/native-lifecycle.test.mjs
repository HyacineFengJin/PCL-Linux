import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ExtensionHost } from '../src/host.mjs';

const source = await readFile(new URL('../examples/instance-compass.json', import.meta.url), 'utf8');
const manifest = JSON.parse(source), id = manifest.id;
const all = manifest.capabilities.map(c => c.id);
const hostPath = fileURLToPath(new URL('../../host.mjs', import.meta.url));
const scratch = fileURLToPath(new URL('../../../work/extension-compatibility-tests/', import.meta.url));

async function connect(root) {
  const child = spawn(process.execPath, [hostPath, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', line => pending.shift()?.(JSON.parse(line)));
  let closed = false;
  const exit = new Promise(resolve => child.once('exit', resolve));
  function rpc(operation, args = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated native extension host timed out.')), 5000);
      pending.push(reply => { clearTimeout(timer); resolve(reply); });
      child.stdin.write(JSON.stringify({ operation, args }) + '\n');
    });
  }
  async function call(operation, args = {}) {
    const reply = await rpc(operation, args);
    assert.equal(reply.ok, true, reply.error);
    return reply.result;
  }
  async function close() {
    if (closed) return;
    closed = true;
    try { await call('shutdown'); }
    finally { child.kill('SIGKILL'); await exit; lines.close(); }
  }
  return { rpc, call, close };
}

test('ordinary declarations persist optional/required revocation, reconsent and disable across restarts', { timeout: 15000 }, async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'native-recovery-'));
  let host;
  try {
    host = await connect(root);
    let review = await host.call('extensions_review', { source });
    await host.call('extensions_confirm', { token: review.token, grants: all });
    await host.call('extensions_revoke', { id, capability: 'launcher.navigate' });
    await host.close();

    host = await connect(root);
    let entry = (await host.call('extensions_list')).entries[0];
    assert.equal(entry.state, 'active');
    assert.equal(entry.grants.includes('launcher.navigate'), false);
    let cards = await host.call('extensions_cards', { slot: 'tools.cards' });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].actions.find(a => a.kind === 'navigate' || a.id === 'instances').enabled, false);
    const revoked = await host.call('extensions_revoke', { id, capability: 'ui.cards' });
    assert.equal(revoked.state, 'suspended');
    await host.close();

    host = await connect(root);
    entry = (await host.call('extensions_list')).entries[0];
    assert.equal(entry.state, 'suspended');
    assert.equal(entry.grants.includes('ui.cards'), false);
    assert.deepEqual(await host.call('extensions_cards', { slot: 'tools.cards' }), []);
    const before = await readFile(path.join(root, 'extensions.json'), 'utf8');
    review = await host.call('extensions_rereview', { id });
    const denied = await host.rpc('extensions_confirm', { token: review.token, grants: [] });
    assert.equal(denied.ok, false);
    assert.equal(await readFile(path.join(root, 'extensions.json'), 'utf8'), before);
    review = await host.call('extensions_rereview', { id });
    await host.call('extensions_confirm', { token: review.token, grants: all });
    await host.call('extensions_disable', { id });
    await host.close();

    host = await connect(root);
    entry = (await host.call('extensions_list')).entries[0];
    assert.equal(entry.state, 'disabled');
    assert.deepEqual(entry.grants.sort(), all.slice().sort());
    assert.deepEqual(await host.call('extensions_cards', { slot: 'tools.cards' }), []);
    review = await host.call('extensions_rereview', { id });
    await host.call('extensions_confirm', { token: review.token, grants: ['ui.cards'] });
    await host.close();

    host = await connect(root);
    entry = (await host.call('extensions_list')).entries[0];
    assert.equal(entry.state, 'active');
    assert.deepEqual(entry.grants, ['ui.cards']);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native action and consent handles do not survive revoke, disable or safe-mode cycling', () => {
  for (const invalidate of [host => host.revoke(id, 'launcher.navigate'), host => host.disable(id), host => { host.setSafeMode(true); host.setSafeMode(false); }]) {
    const host = new ExtensionHost();
    host.confirmReview(host.prepareReview(source).token, all);
    const action = host.prepareAction(id, 'compass', 'instances');
    const review = host.prepareReview(source);
    invalidate(host);
    assert.throws(() => host.commitAction(action.token));
    assert.throws(() => host.confirmReview(review.token, all));
  }
});
