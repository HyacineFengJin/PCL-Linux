import { inflateRawSync } from "node:zlib";
import { fail, MAX_MANIFEST_BYTES } from "./json.mjs";

// This is a read-only ZIP32 profile, not an extractor. Every entry is checked
// before selected metadata is inflated; payload streams are never inflated.
export const ARCHIVE_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  entries: 128,
  directoryBytes: 128 * 1024,
  entryBytes: 16 * 1024 * 1024,
  declaredBytes: 64 * 1024 * 1024,
  ratio: 100,
  metadataBytes: MAX_MANIFEST_BYTES,
});
const bad = () =>
  fail(
    "COMPAT_ZIP_LAYOUT",
    "Package ZIP headers or entry boundaries are inconsistent.",
  );
const unsupported = () =>
  fail(
    "COMPAT_ZIP_FORMAT",
    "Only single-volume ZIP32, stored/deflated entries without encryption, archive comments or extra fields are supported.",
  );
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function decodeMetadata(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    fail("COMPAT_UTF8", "Package metadata must be strict UTF-8.");
  }
}
export function packagePath(name, directory = false) {
  if (
    typeof name !== "string" ||
    !name.length ||
    Buffer.byteLength(name) > 240 ||
    name.normalize("NFC") !== name ||
    /[\p{Cc}\p{Cf}\p{Cs}\\<>:"|?*%]/u.test(name) ||
    name.startsWith("/")
  )
    fail(
      "COMPAT_ZIP_PATH",
      "Package paths must be bounded, normalized relative paths.",
    );
  const value = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    fail(
      "COMPAT_ZIP_PATH",
      "Package paths contain unsafe or ambiguous segments.",
    );
  return value;
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export async function openMetadataZip(input) {
  const lim = ARCHIVE_LIMITS;
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < 22 || length > lim.bytes)
    fail(
      "COMPAT_ZIP_SIZE",
      "Package must be a ZIP archive no larger than 32 MiB.",
    );
  const fits = (offset, size, end = length) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > end
    )
      bad();
  };
  const read = async (offset, size, end = length) => {
    fits(offset, size, end);
    const result = await input.read(offset, size);
    if (!Buffer.isBuffer(result) || result.length !== size) bad();
    return result;
  };
  // The fixed profile has no archive comments: a 22-byte footer is enough,
  // without scanning tail regions that may contain compressed payload streams.
  const eocd = length - 22,
    record = await read(eocd, 22);
  if (record.readUInt32LE(0) !== 0x06054b50) bad();
  if (record.readUInt16LE(20)) unsupported();
  const count = record.readUInt16LE(10);
  const directorySize = record.readUInt32LE(12),
    directoryOffset = record.readUInt32LE(16);
  if (
    record.readUInt16LE(4) ||
    record.readUInt16LE(6) ||
    record.readUInt16LE(8) !== count ||
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    unsupported();
  if (!count || count > lim.entries || directorySize > lim.directoryBytes)
    fail(
      "COMPAT_ZIP_LIMIT",
      "Package entry count or directory size exceeds inspection limits.",
    );
  fits(directoryOffset, directorySize, eocd);
  if (directoryOffset + directorySize !== eocd) bad();
  const central = await read(directoryOffset, directorySize, eocd);
  const entries = [],
    paths = new Map(),
    spellings = new Map();
  let cursor = 0,
    declaredBytes = 0;
  for (let index = 0; index < count; index++) {
    fits(cursor, 46, central.length);
    if (central.readUInt32LE(cursor) !== 0x02014b50) bad();
    const origin = central.readUInt16LE(cursor + 4) >>> 8;
    const version = central.readUInt16LE(cursor + 6),
      flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10),
      crc = central.readUInt32LE(cursor + 16);
    const compressed = central.readUInt32LE(cursor + 20),
      size = central.readUInt32LE(cursor + 24);
    const nameSize = central.readUInt16LE(cursor + 28),
      extraSize = central.readUInt16LE(cursor + 30);
    const commentSize = central.readUInt16LE(cursor + 32),
      attributes = central.readUInt32LE(cursor + 38);
    const offset = central.readUInt32LE(cursor + 42);
    if (
      ![0, 3].includes(origin) ||
      (method === 8 ? version !== 20 : ![10, 20].includes(version)) ||
      ![0, 8].includes(method) ||
      flags & ~(method === 8 ? 0x080e : 0x0808) ||
      extraSize ||
      central.readUInt16LE(cursor + 34) ||
      [compressed, size, offset].includes(0xffffffff)
    )
      unsupported();
    fits(cursor + 46, nameSize + commentSize, central.length);
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!(flags & 0x800) && rawName.some((value) => value >= 128))
      unsupported();
    const name = decodeMetadata(rawName),
      directory = name.endsWith("/");
    const path = packagePath(name, directory),
      key = path.toLowerCase();
    if (paths.has(key))
      fail(
        "COMPAT_ZIP_DUPLICATE",
        "Package has duplicate or case-colliding paths.",
      );
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join("/"),
        folded = spelling.toLowerCase();
      if (spellings.has(folded) && spellings.get(folded) !== spelling)
        fail(
          "COMPAT_ZIP_DUPLICATE",
          "Package directory spellings collide by case.",
        );
      spellings.set(folded, spelling);
    }
    const mode = (attributes >>> 16) & 0xf000;
    if (
      (mode && mode !== (directory ? 0x4000 : 0x8000)) ||
      attributes & 0x400 ||
      (!directory && attributes & 0x10)
    )
      fail(
        "COMPAT_ZIP_LINK",
        "Links, special entries and conflicting directory attributes are unsupported.",
      );
    if ((directory && (size || crc)) || (method === 0 && size !== compressed))
      bad();
    if (
      size > lim.entryBytes ||
      compressed > lim.bytes ||
      size > Math.max(1, compressed) * lim.ratio ||
      (declaredBytes += size) > lim.declaredBytes
    )
      fail(
        "COMPAT_ZIP_LIMIT",
        "Package declared sizes or compression ratios exceed inspection limits.",
      );
    const entry = {
      name,
      path,
      key,
      directory,
      rawName,
      version,
      flags,
      method,
      crc,
      compressed,
      size,
      offset,
    };
    entries.push(entry);
    paths.set(key, entry);
    cursor += 46 + nameSize + commentSize;
  }
  if (cursor !== central.length) bad();
  for (const entry of entries) {
    const parts = entry.key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = paths.get(parts.slice(0, i).join("/"));
      if (parent && !parent.directory)
        fail(
          "COMPAT_ZIP_DUPLICATE",
          "A package file also owns a directory path.",
        );
    }
    const header = await read(entry.offset, 30, directoryOffset);
    if (
      header.readUInt32LE(0) !== 0x04034b50 ||
      header.readUInt16LE(4) !== entry.version ||
      header.readUInt16LE(6) !== entry.flags ||
      header.readUInt16LE(8) !== entry.method
    )
      bad();
    const nameSize = header.readUInt16LE(26),
      extraSize = header.readUInt16LE(28);
    if (extraSize) unsupported();
    if (
      nameSize !== entry.rawName.length ||
      !(await read(entry.offset + 30, nameSize, directoryOffset)).equals(
        entry.rawName,
      )
    )
      bad();
    entry.dataOffset = entry.offset + 30 + nameSize;
    fits(entry.dataOffset, entry.compressed, directoryOffset);
    entry.end = entry.dataOffset + entry.compressed;
    const local = [
      header.readUInt32LE(14),
      header.readUInt32LE(18),
      header.readUInt32LE(22),
    ];
    const expected = [entry.crc, entry.compressed, entry.size];
    if (entry.flags & 8) {
      if (!local.every((value, i) => value === 0 || value === expected[i]))
        bad();
      const first = await read(entry.end, 12, directoryOffset);
      const descriptor =
        first.readUInt32LE(0) === 0x08074b50
          ? Buffer.concat([
              first.subarray(4),
              await read(entry.end + 12, 4, directoryOffset),
            ])
          : first;
      if (expected.some((value, i) => descriptor.readUInt32LE(4 * i) !== value))
        bad();
      entry.end += first.readUInt32LE(0) === 0x08074b50 ? 16 : 12;
    } else if (local.some((value, i) => value !== expected[i])) bad();
  }
  let end = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== end) bad();
    end = entry.end;
  }
  if (end !== directoryOffset) bad();
  return {
    entries,
    declaredBytes,
    // Only selected JSON metadata is read. Entry assemblies and Mixin contents
    // never pass through this method; there is no filesystem extraction API.
    async readJson(name) {
      if (
        ![
          "plugin.json",
          "META-INF/pnp.files.json",
          "META-INF/pnp.signed.json",
        ].includes(name)
      )
        fail(
          "COMPAT_PACKAGE_METADATA",
          "Only the fixed package JSON metadata entries can be read.",
        );
      const entry = entries.find(
        (value) => value.name === name && !value.directory,
      );
      if (!entry)
        fail(
          "COMPAT_PACKAGE_METADATA",
          "Package is missing required metadata.",
        );
      if (
        entry.size < 1 ||
        entry.size > lim.metadataBytes ||
        entry.compressed > 2 * lim.metadataBytes
      )
        fail(
          "COMPAT_PACKAGE_METADATA",
          "Package JSON metadata exceeds the bounded inspection profile.",
        );
      const compressed = await read(
        entry.dataOffset,
        entry.compressed,
        directoryOffset,
      );
      let result;
      try {
        if (entry.method === 0) result = compressed;
        else {
          const inflated = inflateRawSync(compressed, {
            maxOutputLength: lim.metadataBytes,
            info: true,
          });
          if (inflated.engine.bytesWritten !== compressed.length) bad();
          result = inflated.buffer;
        }
      } catch (error) {
        if (error.code?.startsWith("COMPAT_")) throw error;
        fail(
          "COMPAT_PACKAGE_METADATA",
          "Package metadata cannot be inflated within inspection limits.",
        );
      }
      if (result.length !== entry.size || crc32(result) !== entry.crc) bad();
      return result;
    },
  };
}
