import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../../../apps/desktop/', import.meta.url));
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const { build } = requireDesktop('esbuild');
const mock = fileURLToPath(new URL('./fixtures/react-events.mjs', import.meta.url));
let compiled, work, modulePath;
test.before(async () => {
  const scratch = fileURLToPath(new URL('../../../work/extension-compatibility-tests/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  work = await mkdtemp(path.join(scratch, 'events-'));
  const result = await build({ stdin: { contents: `
    export { ExperimentalExtensions, ExperimentalCards } from './src/ExperimentalExtensions';
    export { t } from './src/i18n';
    export { mount, nodes, text } from ${JSON.stringify(mock)};
  `, resolveDir: desktop, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs',
    jsx: 'automatic', alias: { 'react': mock, 'react/jsx-runtime': mock },
    loader: { '.css': 'empty' }, write: false });
  modulePath = path.join(work, 'events.cjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  compiled = requireDesktop(modulePath);
});
test.after(async () => { if (modulePath) delete requireDesktop.cache[modulePath]; if (work) await rm(work, { recursive: true, force: true }); });

function api() {
  const calls = [];
  const invoke = (command, args) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ operation: command === 'experimental_call' ? args.operation : command,
      args: command === 'experimental_call' ? args.args : args, resolve, reject, taken: false });
    if (invoke.throwCancel && command === 'experimental_call' && args.operation === 'extensions_cancel')
      throw new Error('Fixture retired API unavailable');
    return promise;
  };
  invoke.calls = calls;
  invoke.next = operation => {
    const call = calls.find(value => value.operation === operation && !value.taken);
    assert.ok(call, `Missing API call ${operation}`); call.taken = true; return call;
  };
  invoke.count = operation => calls.filter(value => value.operation === operation).length;
  return invoke;
}
const entry = name => ({ id: 'example.extension', name, version: '1.0.0', state: 'active', publisher: 'Example', digest: 'a'.repeat(64), grants: ['ui.cards'] });
const list = entries => ({ entries, safeMode: false, warning: null });
const review = token => ({ token, id: 'example.extension', name: token, version: '1.0.0', publisher: 'Example', digest: 'a'.repeat(64),
  capabilities: [{ id: 'ui.cards', required: true, reason: 'Display a card.', currentlyGranted: false }] });
const card = title => ({ extensionId: 'example.extension', extensionName: 'Example', id: 'card', title, text: 'Body',
  actions: [{ id: 'go', label: 'Go', enabled: true }, { id: 'summary', label: 'Summary', enabled: true }] });
const summary = version => ({ minecraftVersion: version, loader: 'Fabric', modCount: 1, isolated: true });
const props = invoke => ({ api: invoke, native: true, onNavigate() {} });
const buttons = harness => compiled.nodes(harness.tree).filter(node => node.type === 'button');
const button = (harness, label) => {
  const node = buttons(harness).find(node => compiled.text(node.props.children) === label);
  assert.ok(node, `Missing button ${label}`); return node.props;
};
const messageButton = (harness, key) => button(harness, compiled.t(key));
const dialogs = harness => compiled.nodes(harness.tree).filter(node => typeof node.type === 'function' && node.type.name === 'InstanceOperationDialog');
const dialog = harness => { const value = dialogs(harness)[0]; assert.ok(value, 'Missing permission dialog'); return value; };
const checkbox = node => compiled.nodes(node).find(value => value.type === 'input').props;

async function manager(invoke, entries = []) {
  const harness = compiled.mount(compiled.ExperimentalExtensions, props(invoke));
  invoke.next('extensions_list').resolve(list(entries)); await harness.flush(); return harness;
}
async function openReview(harness, invoke, value) {
  messageButton(harness, 'experimental.importExtension').onClick();
  invoke.next('experimental_choose').resolve({ status: 'selected', path: 'fixture.json' }); await harness.flush();
  invoke.next('extensions_review').resolve(value); await harness.flush(); return dialog(harness);
}
async function cards(invoke, onNavigate = () => {}, slot = 'tools.cards') {
  const harness = compiled.mount(compiled.ExperimentalCards, { ...props(invoke), onNavigate, slot });
  invoke.next('extensions_cards').resolve([card('Current card')]); await harness.flush(); return harness;
}

test('saved manager callbacks after unmount submit no reads, chooser or permission mutations', async () => {
  const invoke = api(), harness = await manager(invoke, [entry('Current')]);
  const callbacks = buttons(harness).map(node => node.props.onClick);
  const safeMode = compiled.nodes(harness.tree).find(node => node.type === 'input').props.onChange;
  harness.unmount(); const before = invoke.calls.length;
  for (const callback of callbacks) callback();
  safeMode({ target: { checked: true } }); await harness.flush();
  assert.equal(invoke.calls.length, before);
  assert.equal(harness.retiredWrites, 0);
});

test('API/native replacement retires manager callbacks even after values change back', async () => {
  for (const change of ['api', 'native']) {
    const first = api(), next = api(), harness = await manager(first, [entry('First')]);
    const callbacks = buttons(harness).map(node => node.props.onClick);
    harness.setProps(change === 'api' ? props(next) : { ...props(first), native: false });
    if (change === 'api') { next.next('extensions_list').resolve(list([entry('Next')])); await harness.flush(); }
    harness.setProps(props(first)); first.next('extensions_list').resolve(list([entry('Returned')])); await harness.flush();
    const before = first.calls.length;
    for (const callback of callbacks) callback(); await harness.flush();
    assert.equal(first.calls.length, before); harness.unmount();
  }
});

test('chooser admission is synchronous and retirement prevents the unsubmitted review step', async () => {
  const invoke = api(), harness = await manager(invoke);
  const saved = messageButton(harness, 'experimental.importExtension').onClick;
  saved(); saved(); assert.equal(invoke.count('experimental_choose'), 1);
  const chosen = invoke.next('experimental_choose'); harness.unmount();
  chosen.resolve({ status: 'selected', path: 'fixture.json' }); await harness.flush();
  assert.equal(invoke.count('extensions_review'), 0);
  assert.equal(harness.retiredWrites, 0);
});

test('closing consent retires a pending new review; late cleanup cannot unlock a newer import', async () => {
  const invoke = api(), harness = await manager(invoke);
  const first = await openReview(harness, invoke, review('first'));
  const savedImport = messageButton(harness, 'experimental.importExtension').onClick;
  savedImport(); invoke.next('experimental_choose').resolve({ status: 'selected', path: 'second.json' }); await harness.flush();
  const pending = invoke.next('extensions_review');
  first.props.onClose(); await harness.flush();
  assert.equal(dialogs(harness).length, 0);
  assert.equal(invoke.next('extensions_cancel').args.token, 'first');
  savedImport(); const thirdChooser = invoke.next('experimental_choose');
  pending.resolve(review('late-second')); await harness.flush();
  assert.equal(dialogs(harness).length, 0);
  assert.equal(invoke.next('extensions_cancel').args.token, 'late-second');
  savedImport(); assert.equal(invoke.count('experimental_choose'), 3);
  assert.equal(messageButton(harness, 'experimental.importExtension').disabled, true);
  first.props.onConfirm(); checkbox(first).onChange({ target: { checked: true } });
  assert.equal(invoke.count('extensions_confirm'), 0);
  thirdChooser.resolve({ status: 'cancelled' }); await harness.flush();
  assert.equal(messageButton(harness, 'experimental.importExtension').disabled, false); harness.unmount();
});

test('late review from an old API is cancelled there and never replaces fresh consent', async () => {
  const first = api(), second = api(), harness = await manager(first);
  messageButton(harness, 'experimental.importExtension').onClick();
  first.next('experimental_choose').resolve({ status: 'selected', path: 'old.json' }); await harness.flush();
  const late = first.next('extensions_review');
  harness.setProps(props(second)); second.next('extensions_list').resolve(list([])); await harness.flush();
  await openReview(harness, second, review('fresh'));
  late.resolve(review('old')); await harness.flush();
  assert.equal(first.next('extensions_cancel').args.token, 'old');
  assert.equal(dialog(harness).props.children[0].props.children[0], 'fresh');
  assert.equal(second.count('extensions_cancel'), 0); harness.unmount();
});

test('saved consent/checkbox/close handles cannot affect a replacement dialog', async () => {
  const invoke = api(), harness = await manager(invoke);
  const first = await openReview(harness, invoke, review('first'));
  const second = await openReview(harness, invoke, review('second'));
  checkbox(first).onChange({ target: { checked: true } }); first.props.onConfirm(); first.props.onClose(); await harness.flush();
  assert.equal(dialog(harness).props.confirmDisabled, true);
  assert.equal(invoke.count('extensions_confirm'), 0);
  // Grant and confirm before a React render: admission and selected grants
  // must use the current dialog, not a captured checked/busy snapshot.
  checkbox(second).onChange({ target: { checked: true } });
  second.props.onConfirm(); second.props.onConfirm(); second.props.onClose();
  const committed = invoke.next('extensions_confirm');
  assert.deepEqual(committed.args, { token: 'second', grants: ['ui.cards'] });
  assert.equal(invoke.count('extensions_confirm'), 1);
  harness.unmount(); committed.resolve({ id: 'example.extension' }); await harness.flush();
  assert.equal(invoke.calls.filter(v => v.operation === 'extensions_cancel' && v.args.token === 'second').length, 0);
  assert.equal(invoke.count('extensions_list'), 1);
  assert.equal(harness.retiredWrites, 0);
});

test('failed confirmation consumes the dialog and cannot be retried with a saved token', async () => {
  const invoke = api(), harness = await manager(invoke);
  const current = await openReview(harness, invoke, review('once'));
  checkbox(current).onChange({ target: { checked: true } }); current.props.onConfirm();
  invoke.next('extensions_confirm').reject(new Error('Fixture permission transaction failed')); await harness.flush();
  assert.equal(dialogs(harness).length, 0);
  current.props.onConfirm(); assert.equal(invoke.count('extensions_confirm'), 1);
  assert.ok(compiled.text(harness.tree).includes('Fixture permission transaction failed')); harness.unmount();
});

test('best-effort cancellation failure cannot keep a retired consent dialog usable', async () => {
  const invoke = api(), harness = await manager(invoke);
  const current = await openReview(harness, invoke, review('cancel-failure'));
  checkbox(current).onChange({ target: { checked: true } });
  invoke.throwCancel = true;
  assert.doesNotThrow(() => current.props.onClose()); await harness.flush();
  assert.equal(dialogs(harness).length, 0);
  current.props.onConfirm(); assert.equal(invoke.count('extensions_confirm'), 0); harness.unmount();
});

test('newest refresh owns list data; earlier responses and errors do not overwrite it', async () => {
  const invoke = api(), harness = compiled.mount(compiled.ExperimentalExtensions, props(invoke));
  const initial = invoke.next('extensions_list');
  messageButton(harness, 'experimental.refresh').onClick();
  invoke.next('extensions_list').resolve({ entries: [entry('Newest entry')], safeMode: true, warning: null }); await harness.flush();
  initial.resolve(list([entry('Stale entry')])); await harness.flush();
  assert.ok(compiled.text(harness.tree).includes('Newest entry'));
  assert.ok(!compiled.text(harness.tree).includes('Stale entry'));
  assert.equal(compiled.nodes(harness.tree).find(n => n.type === 'input').props.checked, true); harness.unmount();
});

test('saved card actions retire after API/native/slot changes and unmount', async () => {
  for (const change of ['api', 'native', 'slot', 'unmount']) {
    const first = api(), second = api(), harness = await cards(first);
    const saved = button(harness, 'Go').onClick;
    if (change === 'unmount') harness.unmount();
    else {
      harness.setProps(change === 'api' ? { ...props(second), slot: 'tools.cards' } :
        { ...props(first), native: change !== 'native', slot: change === 'slot' ? 'home.secondary' : 'tools.cards' });
      if (change === 'api') { second.next('extensions_cards').resolve([card('Other API')]); await harness.flush(); }
      else if (change === 'slot') { first.next('extensions_cards').resolve([card('Other slot')]); await harness.flush(); }
      harness.setProps({ ...props(first), slot: 'tools.cards' });
      first.next('extensions_cards').resolve([card('Returned cards')]); await harness.flush();
    }
    saved(); await harness.flush(); assert.equal(first.count('extensions_action'), 0); harness.unmount();
  }
});

test('old navigation/summary replies cannot pollute a new slot or unlock its active action', async () => {
  for (const oldKind of ['navigate', 'show-instance-summary']) {
    const invoke = api(), navigations = [], harness = await cards(invoke, target => navigations.push(target));
    button(harness, 'Go').onClick(); const oldAction = invoke.next('extensions_action');
    harness.setProps({ ...props(invoke), slot: 'home.secondary', onNavigate: target => navigations.push(target) });
    assert.ok(!compiled.text(harness.tree).includes('Current card'));
    invoke.next('extensions_cards').resolve([card('New slot')]); await harness.flush();
    const saved = button(harness, 'Summary').onClick; saved(); saved();
    const freshAction = invoke.next('extensions_action');
    oldAction.resolve({ kind: oldKind, target: 'settings', summary: summary('OLD') }); await harness.flush();
    saved(); assert.equal(invoke.count('extensions_action'), 2);
    assert.deepEqual(navigations, []); assert.ok(!compiled.text(harness.tree).includes('OLD'));
    freshAction.resolve({ kind: 'show-instance-summary', summary: summary('NEW') }); await harness.flush();
    assert.ok(compiled.text(harness.tree).includes('NEW')); harness.unmount();
  }
});

test('old summary close handles do not erase a newer summary and navigation uses current callback', async () => {
  const invoke = api(), oldNavigation = [], newNavigation = [], harness = await cards(invoke, target => oldNavigation.push(target));
  button(harness, 'Summary').onClick(); invoke.next('extensions_action').resolve({ kind: 'show-instance-summary', summary: summary('FIRST') }); await harness.flush();
  const close = messageButton(harness, 'common.cancel').onClick;
  button(harness, 'Summary').onClick(); invoke.next('extensions_action').resolve({ kind: 'show-instance-summary', summary: summary('SECOND') }); await harness.flush();
  close(); await harness.flush(); assert.ok(compiled.text(harness.tree).includes('SECOND'));
  button(harness, 'Go').onClick(); const pending = invoke.next('extensions_action');
  harness.setProps({ ...props(invoke), slot: 'tools.cards', onNavigate: target => newNavigation.push(target) });
  pending.resolve({ kind: 'navigate', target: 'instances' }); await harness.flush();
  assert.deepEqual(oldNavigation, []); assert.deepEqual(newNavigation, ['instances']); harness.unmount();
});

test('effect restarts reject replies and consent from the previous mounted lifetime', async () => {
  const invoke = api(), harness = compiled.mount(compiled.ExperimentalExtensions, props(invoke));
  const oldRead = invoke.next('extensions_list'); harness.restartEffects();
  invoke.next('extensions_list').resolve(list([entry('Restarted')])); await harness.flush();
  oldRead.reject(new Error('Retired effect error')); await harness.flush();
  assert.ok(!compiled.text(harness.tree).includes('Retired effect error'));
  const old = await openReview(harness, invoke, review('before-restart'));
  harness.restartEffects(); invoke.next('extensions_list').resolve(list([])); await harness.flush();
  checkbox(old).onChange({ target: { checked: true } }); old.props.onConfirm();
  assert.equal(invoke.count('extensions_confirm'), 0);
  assert.equal(dialogs(harness).length, 0); harness.unmount();
});
