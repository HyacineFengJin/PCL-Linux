import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { extname } from "node:path";
import { createHash } from "node:crypto";
import { inspectForeignManifest } from "./compatibility.mjs";
import { parseJson, fail, freeze } from "./json.mjs";
import {
  ARCHIVE_LIMITS,
  openMetadataZip,
  decodeMetadata,
  packagePath,
} from "./zip-metadata.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadataNames = new Set([
  "META-INF/pnp.files.json",
  "META-INF/pnp.signed.json",
]);
export function foreignPackageFormat(file) {
  const suffix = typeof file === "string" ? extname(file).toLowerCase() : "";
  return suffix === ".pnp" ? "pnp" : suffix === ".pclx" ? "pclx" : null;
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("COMPAT_PACKAGE_METADATA", "Expected a package metadata object.");
  return value;
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail(
      "COMPAT_PACKAGE_METADATA",
      "Expected a lowercase SHA-256 declaration.",
    );
  return value;
}

async function inspectNEnvelope(zip, manifest, report) {
  const tableBytes = await zip.readJson("META-INF/pnp.files.json");
  const signed = object(
    parseJson(decodeMetadata(await zip.readJson("META-INF/pnp.signed.json"))),
  );
  const table = object(parseJson(decodeMetadata(tableBytes)));
  if (
    table.formatVersion !== 1 ||
    table.hashAlgorithm !== "SHA-256" ||
    signed.packageFormat !== 1 ||
    signed.signatureFormat !== 1
  )
    fail(
      "COMPAT_PACKAGE_VERSION",
      "Only PNP package, signature and file-table format version 1 can be inspected.",
    );
  if (
    signed.pluginId !== report.id ||
    signed.pluginVersion !== report.version ||
    digest(signed.manifestSha256) !== hash(manifest) ||
    digest(signed.fileTableSha256) !== hash(tableBytes)
  )
    fail(
      "COMPAT_PACKAGE_METADATA",
      "PNP metadata does not match the selected manifest and file table.",
    );
  digest(signed.payloadRootSha256); // Declaration only: payload streams are not hashed.
  const fingerprints = signed.signingKeyFingerprints;
  if (
    !Array.isArray(fingerprints) ||
    !fingerprints.length ||
    fingerprints.length > 8 ||
    new Set(fingerprints).size !== fingerprints.length ||
    fingerprints.some(
      (value) => typeof value !== "string" || !/^[A-F0-9]{40,128}$/.test(value),
    ) ||
    !fingerprints.includes(signed.signingKeyFingerprint)
  )
    fail(
      "COMPAT_PACKAGE_METADATA",
      "PNP signing declarations are unsupported or inconsistent.",
    );
  const signingEntries = new Set(
    fingerprints.flatMap((value) => [
      `META-INF/signatures/${value}.asc`,
      `META-INF/keys/${value}.asc`,
    ]),
  );
  const payload = new Map(
    zip.entries
      .filter(
        (entry) =>
          !entry.directory &&
          !metadataNames.has(entry.name) &&
          !signingEntries.has(entry.name),
      )
      .map((entry) => [entry.name, entry]),
  );
  if (
    !Array.isArray(table.files) ||
    table.files.length !== payload.size ||
    !payload.size
  )
    fail(
      "COMPAT_PACKAGE_METADATA",
      "PNP file table does not describe the package directory.",
    );
  let previous = null;
  for (const item of table.files) {
    const record = object(item),
      name = packagePath(record.path),
      entry = payload.get(name);
    if (
      !entry ||
      !Number.isSafeInteger(record.size) ||
      record.size !== entry.size ||
      (previous !== null &&
        Buffer.compare(Buffer.from(previous), Buffer.from(name)) >= 0)
    )
      fail(
        "COMPAT_PACKAGE_METADATA",
        "PNP file table paths or sizes are inconsistent.",
      );
    digest(record.sha256);
    if (name === "plugin.json" && record.sha256 !== hash(manifest))
      fail(
        "COMPAT_PACKAGE_METADATA",
        "PNP manifest hash declaration is inconsistent.",
      );
    previous = name;
    payload.delete(name);
  }
  for (const name of signingEntries) {
    const signingEntry = zip.entries.find(
      (entry) => entry.name === name && !entry.directory,
    );
    if (
      !signingEntry ||
      !signingEntry.size ||
      signingEntry.size > ARCHIVE_LIMITS.metadataBytes
    )
      fail(
        "COMPAT_PACKAGE_METADATA",
        "PNP is missing a bounded declared signature or public-key entry.",
      );
  }
  // Signature and public-key entries were only located in the directory. OpenPGP content,
  // identity, trust, payload hashes and the declared payload root stay unverified.
}

/** No consent token can emerge from a package, including one containing an RH
 * declarative manifest. Filename, ZIP profile and ecosystem must all agree. */
async function inspectPackageInput(input, format) {
  if (!["pnp", "pclx"].includes(format))
    fail(
      "COMPAT_PACKAGE_FORMAT",
      "Only PNP and PCLX packages can be inspected.",
    );
  const zip = await openMetadataZip(input);
  const manifest = await zip.readJson("plugin.json");
  const source = decodeMetadata(manifest),
    report = inspectForeignManifest(source);
  if (!report || report.ecosystem !== (format === "pnp" ? "pcl-n" : "pcl-nex"))
    fail(
      "COMPAT_PACKAGE_FORMAT",
      "Package suffix and foreign manifest ecosystem do not match.",
    );
  if (format === "pnp") await inspectNEnvelope(zip, manifest, report);
  else {
    const m = parseJson(source);
    // The pinned Nex format has no package version field. Do not silently
    // interpret a future version or a removed script/lifecycle format as it.
    if (
      Object.keys(m).some((key) =>
        /^(formatVersion|manifestVersion|signatureFormat|packageFormat|entryType|loadMethod|unloadMethod|entryScript|runtime)$/i.test(
          key,
        ),
      )
    )
      fail(
        "COMPAT_PACKAGE_VERSION",
        "Versioned or legacy Nex package manifests are unsupported.",
      );
  }
  for (const name of [report.entryAssembly, ...report.mixinConfigs]) {
    if (!zip.entries.some((entry) => entry.name === name && !entry.directory))
      fail(
        "COMPAT_PACKAGE_ENTRY",
        "A declared entry or Mixin path is missing from the package directory.",
      );
  }
  return freeze({
    ...report,
    archive: {
      format,
      bytes: input.length,
      entryCount: zip.entries.length,
      declaredUncompressedBytes: zip.declaredBytes,
      payloadVerified: false,
    },
  });
}

// In-memory entry point is useful for bounded fixtures. The production reader
// below seeks only ZIP metadata and selected JSON, never hashing whole payloads.
export async function inspectForeignPackage(bytes, format) {
  if (!Buffer.isBuffer(bytes) || bytes.length > ARCHIVE_LIMITS.bytes)
    fail("COMPAT_ZIP_SIZE", "Package must be a bounded ZIP buffer.");
  const snapshot = Buffer.from(bytes);
  return inspectPackageInput(
    {
      length: snapshot.length,
      read: async (offset, length) =>
        snapshot.subarray(offset, offset + length),
    },
    format,
  );
}

export async function inspectForeignPackageFile(file) {
  const format = foreignPackageFormat(file);
  if (!format)
    fail(
      "COMPAT_PACKAGE_FORMAT",
      "Only PNP and PCLX package paths are supported.",
    );
  let handle;
  try {
    // O_NONBLOCK rejects special files without blocking before stat. All reads
    // have fixed bounds; same-size concurrent edits are detected by file times.
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(ARCHIVE_LIMITS.bytes) ||
      before.size < 22n
    )
      fail(
        "COMPAT_ZIP_SIZE",
        "Expected a regular package file no larger than 32 MiB.",
      );
    const report = await inspectPackageInput(
      {
        length: Number(before.size),
        async read(offset, length) {
          const buffer = Buffer.alloc(length);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await handle.read(
              buffer,
              read,
              length - read,
              offset + read,
            );
            if (!bytesRead)
              fail(
                "COMPAT_ZIP_LAYOUT",
                "Package changed or ended during inspection.",
              );
            read += bytesRead;
          }
          return buffer;
        },
      },
      format,
    );
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      fail("COMPAT_ZIP_SIZE", "Package changed during inspection.");
    return report;
  } catch (error) {
    if (error.code?.startsWith("COMPAT_") || error.code?.startsWith("JSON_"))
      throw error;
    fail(
      "COMPAT_PACKAGE_FILE",
      "Package cannot be read as a regular, non-link file.",
    );
  } finally {
    if (handle) await handle.close();
  }
}
