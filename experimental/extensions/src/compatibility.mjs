import { parseJson, fail, freeze, canonicalJson } from './json.mjs';
import { createHash } from 'node:crypto';

export const N_SDK_PROBE = freeze({
  version: '0.2.5',
  commit: 'abc4c0a4bec9c1ece28eba17bff2c5eba5b7fe52',
});

const unsafe = /[\p{Cc}\p{Cf}\p{Cs}]/u;
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('COMPAT_OBJECT', 'Expected a plugin manifest object.');
  return value;
}
function text(value, limit = 160) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value ||
      [...value].length > limit || unsafe.test(value))
    fail('COMPAT_TEXT', 'Plugin metadata must be bounded text without control characters.');
  return value;
}
function list(value, project, limit = 32) {
  if (!Array.isArray(value) || value.length > limit)
    fail('COMPAT_LIST', 'Plugin metadata collection exceeds the supported inspection limits.');
  return value.map(project);
}
function unique(values, key = value => value) {
  if (new Set(values.map(key)).size !== values.length)
    fail('COMPAT_DUPLICATE', 'Plugin metadata contains duplicate declarations.');
  return values;
}
function relativePath(value) {
  text(value, 240);
  if (value.startsWith('/') || /[\\<>:"|?*%]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..'))
    fail('COMPAT_PATH', 'Plugin entry and configuration paths must stay package-relative.');
  return value;
}
function assembly(value) {
  relativePath(value);
  if (!value.toLowerCase().endsWith('.dll')) fail('COMPAT_ASSEMBLY', 'Expected a managed assembly path.');
  return value;
}
function required(kind = 'required') {
  if (kind !== 'required' && kind !== 'optional') fail('COMPAT_KIND', 'Unknown dependency or permission kind.');
  return kind === 'required';
}

/** Inspection is deliberately separate from consent/install. No entry path is
 * opened, no package is extracted, and the result cannot become a review token.
 * Unknown fields are not interpreted; this is not upstream schema validation,
 * signature verification, or a claim that a plugin is safe or loadable. */
export function inspectForeignManifest(source) {
  const m = object(parseJson(source));
  const n = Object.hasOwn(m, 'entryPoint');
  const nex = ['entryAssembly', 'mixinConfig', 'mixinConfigs', 'experimentalFeatures'].some(key => Object.hasOwn(m, key));
  if (!n && !nex) return null;
  if ((n && nex) || Object.hasOwn(m, 'format') || Object.hasOwn(m, 'packageFormat'))
    fail('COMPAT_AMBIGUOUS', 'Plugin manifest mixes incompatible formats.');
  const common = {
    kind: 'compatibility-report', ecosystem: n ? 'pcl-n' : 'pcl-nex',
    id: text(m.id, 128), name: text(m.name, 80), version: text(m.version, 80),
    loadable: false, codeExecuted: false, signatureVerified: false,
    digest: createHash('sha256').update(canonicalJson(m)).digest('hex'),
  };
  return freeze(n ? inspectN(m, common) : inspectNex(m, common));
}

function inspectN(m, common) {
  if (m.formatVersion !== 1 || m.manifestVersion !== 1)
    fail('COMPAT_VERSION', 'Only PCL N manifest/format version 1 can be inspected.');
  const entry = object(m.entryPoint), publisher = object(m.publisher), api = object(m.api);
  const services = object(m.services ?? {});
  const requirements = [];
  for (const kind of ['required', 'optional']) {
    for (const [id, range] of Object.entries(object(services[kind] ?? {}))) {
      requirements.push({ id: text(id, 128), range: text(range), required: kind === 'required',
        coverage: id === 'pcl.commands' ? 'probe-only' : 'unavailable' });
    }
  }
  if (requirements.length > 32) fail('COMPAT_LIST', 'Too many service declarations.');
  unique(requirements, v => v.id);
  const permissions = unique(list(m.permissions ?? [], value => {
    const p = object(value);
    return { id: text(p.id, 128), reason: text(p.reason, 240), required: required(p.kind) };
  }), v => v.id);
  const dependencies = unique(list(m.dependencies ?? [], value => {
    const d = object(value);
    return { id: text(d.id, 128), range: text(d.version), required: required(d.kind) };
  }), v => v.id);
  const platforms = object(m.platforms ?? {});
  const platformDeclarations = ['operatingSystems', 'architectures', 'runtimeIdentifiers']
    .flatMap(key => unique(list(platforms[key] ?? [], value => text(value, 80))).map(value => `${key}: ${value}`));
  const findings = ['n-probe-only', 'ranges-unverified'];
  if (m.ui != null || requirements.some(v => v.id === 'pcl.ui')) findings.push('n-ui-unavailable');
  if (m.native != null && list(object(m.native).libraries ?? [], object).length) findings.push('n-native-unavailable');
  return {
    ...common, publisher: text(publisher.id, 128), entryAssembly: assembly(entry.assembly),
    entryType: text(entry.type, 240), apiRange: `${text(api.minimum)} ≤ API < ${text(api.maximumExclusive)}`,
    sdkProbeVersion: N_SDK_PROBE.version, requirements, permissions, dependencies,
    platformDeclarations, mixinConfigs: [], findings,
  };
}

function inspectNex(m, common) {
  // Nex's loader accepts base and opt-in feature configurations. All are only
  // reported here; neither a Mixin nor a bridge dependency is applied to RH.
  const configs = [];
  function addConfigs(owner) {
    if (owner.mixinConfig != null) configs.push(relativePath(owner.mixinConfig));
    if (owner.mixinConfigs != null) configs.push(...list(owner.mixinConfigs, relativePath));
  }
  addConfigs(m);
  const features = unique(list(m.experimentalFeatures ?? [], value => {
    const feature = object(value);
    const id = text(feature.id, 128);
    addConfigs(feature);
    return id;
  }));
  if (configs.length > 32) fail('COMPAT_LIST', 'Too many Mixin configurations.');
  unique(configs);
  const dependencies = unique(list(m.dependencies ?? [], value => {
    const d = object(value);
    return { id: text(d.id, 128), range: text(d.version), required: true };
  }), v => v.id);
  return {
    ...common, publisher: m.author == null ? null : text(m.author, 128),
    entryAssembly: assembly(m.entryAssembly), entryType: null,
    apiRange: m.pclCoreVersion == null ? null : text(m.pclCoreVersion), sdkProbeVersion: null,
    requirements: [], permissions: [], dependencies, platformDeclarations: [], mixinConfigs: configs,
    experimentalFeatures: features, findings: ['nex-host-unavailable', 'ranges-unverified'],
  };
}
