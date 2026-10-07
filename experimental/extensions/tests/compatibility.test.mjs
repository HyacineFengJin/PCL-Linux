import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectForeignManifest } from '../src/compatibility.mjs';
import { readManifest } from '../src/manifest.mjs';
import { readFile } from 'node:fs/promises';

const n = () => ({ formatVersion: 1, manifestVersion: 1, id: 'example.hello', name: 'Hello', version: '0.1.0-alpha.1',
  publisher: { id: 'example-publisher', namespace: 'example' },
  entryPoint: { assembly: 'lib/net10.0/Hello.dll', type: 'Example.Hello' },
  api: { minimum: '0.1', maximumExclusive: '1.0' },
  services: { required: { 'pcl.commands': '>=0.1 <1.0', 'pcl.ui': '>=0.1 <1.0' }, optional: { 'pcl.future': '>=1.0' } },
  permissions: [{ id: 'ui.inject', reason: 'Display a panel.' }, { id: 'process.start', reason: 'Run an optional helper.', kind: 'optional' }],
  signing: { fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
});
const nex = () => ({ id: 'example.mixin', name: 'Mixin example', version: '1.0.0', author: 'Example',
  entryAssembly: 'lib/Example.dll', pclCoreVersion: '2026.07.1', mixinConfigs: ['mixins/base.json'],
  dependencies: [{ id: 'example.bridge', version: '>=1.0.0 <2.0.0' }],
});
const inspect = manifest => inspectForeignManifest(JSON.stringify(manifest));

test('N metadata never becomes install consent, execution or signature validation', () => {
  const report = inspect(n());
  assert.equal(report.kind, 'compatibility-report');
  assert.equal(report.ecosystem, 'pcl-n');
  assert.equal(report.loadable, false);
  assert.equal(report.codeExecuted, false);
  assert.equal(report.signatureVerified, false);
  assert.equal(Object.hasOwn(report, 'token'), false);
  assert.equal(report.requirements[0].coverage, 'probe-only');
  assert.equal(report.requirements[1].coverage, 'unavailable');
  assert.equal(report.requirements[2].required, false);
  assert.equal(report.permissions[0].required, true);
  assert.equal(report.permissions[1].required, false);
  assert.ok(report.findings.includes('n-ui-unavailable'));
  assert.ok(Object.isFrozen(report.permissions[0]));
});

test('N declared native, dependency and platform requirements remain unverified', () => {
  const m = n();
  m.native = { libraries: [{ name: 'Helper' }] };
  m.dependencies = [{ id: 'example.other', version: '>=1.0', kind: 'optional' }];
  m.platforms = { operatingSystems: ['windows'], architectures: ['x64'], runtimeIdentifiers: ['win-x64'] };
  const report = inspect(m);
  assert.ok(report.findings.includes('n-native-unavailable'));
  assert.equal(report.dependencies[0].required, false);
  assert.deepEqual(report.platformDeclarations, ['operatingSystems: windows', 'architectures: x64', 'runtimeIdentifiers: win-x64']);
});

test('Nex base and opt-in Mixins and bridge dependencies are reported without loading', () => {
  const m = nex();
  m.experimentalFeatures = [{ id: 'optional-feature', mixinConfig: 'mixins/optional.json' }];
  const report = inspect(m);
  assert.deepEqual(report.mixinConfigs, ['mixins/base.json', 'mixins/optional.json']);
  assert.deepEqual(report.experimentalFeatures, ['optional-feature']);
  assert.equal(report.dependencies[0].required, true);
  assert.equal(report.loadable, false);
  assert.ok(report.findings.includes('nex-host-unavailable'));
});

test('existing RH declarations retain their existing parser and review contract', async () => {
  const source = await readFile(new URL('../examples/instance-compass.json', import.meta.url), 'utf8');
  assert.equal(inspectForeignManifest(source), null);
  assert.equal(readManifest(source).manifest.id, 'local.instance-compass');
});

test('mixed formats, unknown schema versions and duplicate declarations fail closed', () => {
  assert.throws(() => inspect({ ...n(), entryAssembly: 'other.dll' }), { code: 'COMPAT_AMBIGUOUS' });
  assert.throws(() => inspect({ ...n(), format: 'pcl-linux.declarative-extension' }), { code: 'COMPAT_AMBIGUOUS' });
  assert.throws(() => inspect({ ...n(), manifestVersion: 2 }), { code: 'COMPAT_VERSION' });
  const m = n(); m.services.optional['pcl.commands'] = '>=1.0';
  assert.throws(() => inspect(m), { code: 'COMPAT_DUPLICATE' });
  assert.throws(() => inspect({ ...nex(), mixinConfig: 'mixins/base.json' }), { code: 'COMPAT_DUPLICATE' });
  assert.throws(() => inspectForeignManifest('{"entryPoint":{},"id":"a","id":"b"}'), { code: 'JSON_DUPLICATE_KEY' });
});

test('all projected paths and text reject traversal, controls and direction overrides', () => {
  for (const entryAssembly of ['../Plugin.dll', '/Plugin.dll', 'C:\\Plugin.dll', 'lib/../Plugin.dll', 'lib/%2e%2e/Plugin.dll', 'lib//Plugin.dll'])
    assert.throws(() => inspect({ ...nex(), entryAssembly }), { code: 'COMPAT_PATH' });
  assert.throws(() => inspect({ ...nex(), mixinConfigs: ['../patch.json'] }), { code: 'COMPAT_PATH' });
  assert.throws(() => inspect({ ...n(), name: 'Publisher\u202eofficial' }), { code: 'COMPAT_TEXT' });
  assert.throws(() => inspect({ ...n(), name: 'x'.repeat(81) }), { code: 'COMPAT_TEXT' });
  assert.throws(() => inspectForeignManifest(' '.repeat(65537)), { code: 'JSON_SIZE' });
});

test('malformed optional declarations are not promoted to required or silently ignored', () => {
  const m = n(); m.permissions[1].kind = 'sometimes';
  assert.throws(() => inspect(m), { code: 'COMPAT_KIND' });
  assert.throws(() => inspect({ ...n(), services: { optional: [] } }), { code: 'COMPAT_OBJECT' });
  assert.throws(() => inspect({ ...nex(), dependencies: [{ id: 'missing.range' }] }), { code: 'COMPAT_TEXT' });
});
