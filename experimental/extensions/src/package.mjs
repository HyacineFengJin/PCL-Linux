import { createHash } from 'node:crypto';
import { parseJson, canonicalJson, fail, freeze, MAX_MANIFEST_BYTES } from './json.mjs';
import { readManifest } from './manifest.mjs';

export const PACKAGE_FORMAT = 'pcl-linux.declarative-package';

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key)))
    fail('PACKAGE_FIELDS', 'Package must contain exactly the supported declarative fields.');
}

/** A JSON envelope, not a ZIP/archive or executable package. */
export function createPackage(manifestSource) {
  const { manifest, digest } = readManifest(manifestSource);
  const source = JSON.stringify({
    packageFormat: PACKAGE_FORMAT, packageVersion: 1,
    manifest, integrity: { algorithm: 'sha256', manifestDigest: digest },
  }, null, 2) + '\n';
  if (Buffer.byteLength(source,'utf8') > MAX_MANIFEST_BYTES)
    fail('PACKAGE_SIZE', 'The complete package, including its envelope, must fit in 64 KiB.');
  return source;
}

export function readPackage(source) {
  const p = parseJson(source);
  exactObject(p, ['packageFormat','packageVersion','manifest','integrity']);
  if (p.packageFormat !== PACKAGE_FORMAT || p.packageVersion !== 1)
    fail('PACKAGE_FORMAT', 'Unsupported package format or version; executable plugin packages are not accepted.');
  exactObject(p.integrity,['algorithm','manifestDigest']);
  if (p.integrity.algorithm !== 'sha256' || typeof p.integrity.manifestDigest !== 'string' ||
      !/^[a-f0-9]{64}(?![\s\S])/.test(p.integrity.manifestDigest))
    fail('PACKAGE_INTEGRITY', 'Package integrity must declare a lowercase SHA-256 manifest digest.');
  const loaded = readManifest(canonicalJson(p.manifest));
  if (loaded.digest !== p.integrity.manifestDigest)
    fail('PACKAGE_DIGEST_MISMATCH', 'Manifest changed after packaging; review a newly prepared package.');
  return freeze({
    ...loaded,
    package: {
      format: PACKAGE_FORMAT, version: 1,
      digest: createHash('sha256').update(source).digest('hex'),
      bytes: Buffer.byteLength(source,'utf8'),
      publisherVerified: false,
      note: 'Integrity detects mismatched content. It is not a publisher signature or authenticity proof.',
    },
  });
}
