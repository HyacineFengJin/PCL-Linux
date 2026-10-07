import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const nexManifest = {
  id: "example.mixin",
  name: "Package example",
  version: "1.0.0",
  entryAssembly: "lib/DoNotLoad.dll",
  mixinConfig: "mixins/base.json",
  pclCoreVersion: "2026.07.1",
};
export const nManifest = {
  formatVersion: 1,
  manifestVersion: 1,
  id: "example.n",
  name: "N package example",
  version: "1.0.0",
  publisher: { id: "example.publisher" },
  api: { minimum: "1.0.0", maximumExclusive: "2.0.0" },
  entryPoint: { assembly: "lib/DoNotLoad.dll", type: "Example.Plugin" },
  services: {},
  permissions: [],
};
export const fingerprint = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value);

export function nexEntries(manifest = nexManifest) {
  return [
    { name: "plugin.json", content: json(manifest) },
    {
      name: "lib/DoNotLoad.dll",
      content: "Inert fixture; never load or inflate this payload.",
    },
    {
      name: "mixins/base.json",
      content: "Not Mixin JSON; its content must stay unread.",
    },
  ];
}
export function nEntries(manifest = nManifest) {
  const payload = nexEntries(manifest).slice(0, 2);
  const files = payload
    .map((entry) => ({
      path: entry.name,
      size: Buffer.byteLength(entry.content),
      sha256: sha256(entry.content),
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const table = json({ formatVersion: 1, hashAlgorithm: "SHA-256", files });
  const signed = {
    signatureFormat: 1,
    packageFormat: 1,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    manifestSha256: sha256(payload[0].content),
    fileTableSha256: sha256(table),
    // Deliberately not a verified payload root or valid OpenPGP signature.
    payloadRootSha256: "0".repeat(64),
    signingKeyFingerprint: fingerprint,
    signingKeyFingerprints: [fingerprint],
  };
  return [
    ...payload,
    { name: "META-INF/pnp.files.json", content: table },
    { name: "META-INF/pnp.signed.json", content: json(signed) },
    {
      name: `META-INF/signatures/${fingerprint}.asc`,
      content: "Inert signature placeholder; verification is unavailable.",
    },
    {
      name: `META-INF/keys/${fingerprint}.asc`,
      content: "Inert public-key placeholder; verification is unavailable.",
    },
  ];
}
export function makeArchive(entries = nexEntries(), options = {}) {
  const input = {
    ...options,
    entries: entries.map((entry) => ({
      ...entry,
      attributes: entry.attributes == null ? undefined : entry.attributes >>> 0,
      content: Buffer.from(entry.content).toString("base64"),
    })),
  };
  const result = spawnSync(
    "python3",
    [fileURLToPath(new URL("./make-archive.py", import.meta.url))],
    { input: json(input), maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error("Isolated ZIP fixture construction failed.");
  return result.stdout;
}
export function directoryEntries(bytes) {
  const end = bytes.length - 22;
  // Fixtures without comments are used for mutations; Python independently
  // writes the ZIP, while tests alter individual header claims afterwards.
  const result = [];
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const nameSize = bytes.readUInt16LE(cursor + 28);
    result.push({
      central: cursor,
      local: bytes.readUInt32LE(cursor + 42),
      name: bytes
        .subarray(cursor + 46, cursor + 46 + nameSize)
        .toString("utf8"),
    });
    cursor +=
      46 +
      nameSize +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  }
  return result;
}
