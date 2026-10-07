import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  symlink,
  truncate,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectForeignPackage,
  inspectForeignPackageFile,
} from "../src/foreign-package.mjs";
import { openMetadataZip, ARCHIVE_LIMITS } from "../src/zip-metadata.mjs";
import {
  makeArchive,
  nexEntries,
  nEntries,
  nexManifest,
  nManifest,
  directoryEntries,
  sha256,
} from "./fixtures/foreign-archives.mjs";
const inspect = (bytes, format = "pclx") =>
  inspectForeignPackage(bytes, format);
const reject = (bytes, code, format) =>
  assert.rejects(inspect(bytes, format), (error) => error.code === code);
const withPayload = (extra) => [
  ...nexEntries(),
  { name: "content/file.bin", content: "x", ...extra },
];

function editHeaders(bytes, name, change) {
  const result = Buffer.from(bytes);
  const entry = directoryEntries(result).find((entry) => entry.name === name);
  change(result, entry);
  return result;
}
function patchEnvelope(entries, change, tableChange) {
  const result = entries.map((entry) => ({ ...entry }));
  const signed = result.find((entry) => entry.name.endsWith("pnp.signed.json"));
  const envelope = JSON.parse(signed.content);
  if (tableChange) {
    const table = result.find((entry) => entry.name.endsWith("pnp.files.json"));
    const value = JSON.parse(table.content);
    tableChange(value);
    table.content = JSON.stringify(value);
    envelope.fileTableSha256 = sha256(table.content);
  }
  change(envelope);
  signed.content = JSON.stringify(envelope);
  return result;
}

test("independent ZIP writer profiles yield immutable N/Nex reports without execution, consent or signature claims", async () => {
  for (const descriptor of [false, true])
    for (const deflate of [false, true]) {
      for (const [format, entries] of [
        ["pnp", nEntries()],
        ["pclx", nexEntries()],
      ]) {
        const bytes = makeArchive(
          entries.map((entry) => ({ ...entry, deflate })),
          { descriptor },
        );
        const report = await inspect(bytes, format);
        assert.equal(report.kind, "compatibility-report");
        assert.equal(report.archive.format, format);
        assert.equal(report.archive.entryCount, entries.length);
        assert.equal(report.archive.bytes, bytes.length);
        assert.equal(report.loadable, false);
        assert.equal(report.codeExecuted, false);
        assert.equal(report.signatureVerified, false);
        assert.equal(report.archive.payloadVerified, false);
        assert.equal("token" in report, false);
        assert.equal("grants" in report, false);
        assert.ok(Object.isFrozen(report.archive));
      }
    }
  await reject(
    makeArchive(nexEntries(), { comment: "unsupported archive comment" }),
    "COMPAT_ZIP_LAYOUT",
  );
});

test("production-style seek reader skips compressed assembly and Mixin payload streams", async () => {
  const bytes = makeArchive(nexEntries());
  const forbidden = directoryEntries(bytes)
    .filter((entry) => entry.name !== "plugin.json")
    .map((entry) => {
      const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26);
      return [start, start + bytes.readUInt32LE(entry.central + 20)];
    });
  const reads = [];
  const zip = await openMetadataZip({
    length: bytes.length,
    async read(offset, length) {
      reads.push([offset, length]);
      assert.ok(
        forbidden.every(
          ([start, end]) => offset + length <= start || offset >= end,
        ),
      );
      return bytes.subarray(offset, offset + length);
    },
  });
  assert.match(
    (await zip.readJson("plugin.json")).toString(),
    /Package example/,
  );
  assert.ok(reads.length < 20);
  await assert.rejects(zip.readJson("lib/DoNotLoad.dll"), {
    code: "COMPAT_PACKAGE_METADATA",
  });
});

test("all paths, case aliases, duplicates, file-directory conflicts and link types fail closed", async () => {
  for (const name of [
    "../outside",
    "/absolute",
    "C:/drive",
    "dir\\file",
    "./file",
    "dir//file",
    "dir/../file",
    "dir/file.",
    "nul.txt",
    "dir/%2e",
    "dir/\u202efile",
    "dir/e\u0301",
  ])
    await reject(makeArchive(withPayload({ name })), "COMPAT_ZIP_PATH");
  for (const entries of [
    [...nexEntries(), { name: "plugin.json", content: "{}" }],
    [...nexEntries(), { name: "PLUGIN.JSON", content: "{}" }],
    [...nexEntries(), { name: "LIB/other.dll", content: "x" }],
    [...nexEntries(), { name: "lib", content: "x" }],
  ])
    await reject(makeArchive(entries), "COMPAT_ZIP_DUPLICATE");
  for (const attributes of [0o120777 << 16, 0o060644 << 16, 0x400, 0x10])
    await reject(makeArchive(withPayload({ attributes })), "COMPAT_ZIP_LINK");
});

test("unsupported encryption, ZIP64, split volumes, extra fields, methods and encodings are rejected", async () => {
  const original = makeArchive();
  for (const [centralDelta, localDelta, value] of [
    [8, 6, 1],
    [6, 4, 45],
    [6, 4, 11],
    [10, 8, 12],
    [8, 6, 0x1000],
  ]) {
    const bytes = editHeaders(original, "plugin.json", (bytes, entry) => {
      bytes.writeUInt16LE(value, entry.central + centralDelta);
      bytes.writeUInt16LE(value, entry.local + localDelta);
    });
    await reject(bytes, "COMPAT_ZIP_FORMAT");
  }
  const volume = Buffer.from(original);
  volume.writeUInt16LE(1, volume.length - 18);
  await reject(volume, "COMPAT_ZIP_FORMAT");
  const zip64 = Buffer.from(original);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 10);
  await reject(zip64, "COMPAT_ZIP_FORMAT");
  await reject(
    makeArchive(
      withPayload({
        extra: Buffer.from([0x55, 0x54, 0, 0]).toString("base64"),
      }),
    ),
    "COMPAT_ZIP_FORMAT",
  );
  const utf8 = makeArchive(withPayload({ name: "content/é.txt" }));
  await reject(
    editHeaders(utf8, "content/é.txt", (bytes, entry) => {
      bytes.writeUInt16LE(0, entry.central + 8);
      bytes.writeUInt16LE(0, entry.local + 6);
    }),
    "COMPAT_ZIP_FORMAT",
  );
  await reject(
    editHeaders(utf8, "content/é.txt", (bytes, entry) => {
      bytes[entry.central + 46 + 8] = 0xff;
      bytes[entry.local + 30 + 8] = 0xff;
    }),
    "COMPAT_UTF8",
  );
});

test("entry, directory, individual, aggregate and ratio budgets are enforced before inflation", async () => {
  await reject(
    makeArchive([
      ...nexEntries(),
      ...Array.from({ length: 126 }, (_, i) => ({
        name: `content/${i}`,
        content: "x",
      })),
    ]),
    "COMPAT_ZIP_LIMIT",
  );
  const original = makeArchive();
  for (const size of [ARCHIVE_LIMITS.entryBytes + 1, 10001]) {
    await reject(
      editHeaders(original, "lib/DoNotLoad.dll", (bytes, entry) => {
        bytes.writeUInt16LE(8, entry.central + 10);
        bytes.writeUInt32LE(size, entry.central + 24);
      }),
      "COMPAT_ZIP_LIMIT",
    );
  }
  const entries = [
    ...nexEntries(),
    ...Array.from({ length: 5 }, (_, i) => ({
      name: `content/${i}`,
      content: "x",
    })),
  ];
  const aggregate = makeArchive(entries);
  for (const entry of directoryEntries(aggregate).filter((entry) =>
    entry.name.startsWith("content/"),
  )) {
    aggregate.writeUInt16LE(8, entry.central + 10);
    aggregate.writeUInt32LE(1024 * 1024, entry.central + 20);
    aggregate.writeUInt32LE(16 * 1024 * 1024, entry.central + 24);
  }
  await reject(aggregate, "COMPAT_ZIP_LIMIT");
  const directory = Buffer.from(original);
  directory.writeUInt32LE(
    ARCHIVE_LIMITS.directoryBytes + 1,
    directory.length - 10,
  );
  await reject(directory, "COMPAT_ZIP_LIMIT");
  await assert.rejects(
    inspectForeignPackage(Buffer.alloc(ARCHIVE_LIMITS.bytes + 1), "pclx"),
    { code: "COMPAT_ZIP_SIZE" },
  );
});

test("mismatched local headers, aliases, overlap, descriptors, truncation and appended bytes are rejected", async () => {
  const original = makeArchive();
  for (const change of [
    (bytes, entry) => {
      bytes[entry.local + 30] ^= 1;
    },
    (bytes, entry) => {
      bytes.writeUInt32LE(1, entry.local + 18);
    },
    (bytes, entry) => {
      bytes.writeUInt32LE(0, entry.central + 42);
    },
    (bytes, entry) => {
      bytes.writeUInt32LE(entry.local + 1, entry.central + 42);
    },
  ])
    await reject(
      editHeaders(original, "lib/DoNotLoad.dll", change),
      "COMPAT_ZIP_LAYOUT",
    );
  await reject(original.subarray(0, original.length - 1), "COMPAT_ZIP_LAYOUT");
  await reject(
    Buffer.concat([original, Buffer.from("appended")]),
    "COMPAT_ZIP_LAYOUT",
  );
  const streamed = makeArchive(nexEntries(), { descriptor: true });
  await reject(
    editHeaders(streamed, "plugin.json", (bytes, entry) => {
      const end =
        entry.local +
        30 +
        bytes.readUInt16LE(entry.local + 26) +
        bytes.readUInt32LE(entry.central + 20);
      bytes[end + 4] ^= 1;
    }),
    "COMPAT_ZIP_LAYOUT",
  );
});

test("inflated metadata is bounded and checked for size, CRC, strict UTF-8, JSON keys and complete deflate consumption", async () => {
  const original = makeArchive(
    nexEntries().map((entry) => ({ ...entry, deflate: true })),
  );
  await reject(
    editHeaders(original, "plugin.json", (bytes, entry) => {
      bytes[entry.local + 30 + bytes.readUInt16LE(entry.local + 26)] ^= 255;
    }),
    "COMPAT_PACKAGE_METADATA",
  );
  await reject(
    editHeaders(makeArchive(), "plugin.json", (bytes, entry) => {
      bytes[entry.local + 30 + bytes.readUInt16LE(entry.local + 26)] ^= 1;
    }),
    "COMPAT_ZIP_LAYOUT",
  );
  for (const [content, code] of [
    ['{"id":"a","id":"b","entryAssembly":"lib/X.dll"}', "JSON_DUPLICATE_KEY"],
    [Buffer.from([0xff]), "COMPAT_UTF8"],
    ["x".repeat(65537), "COMPAT_PACKAGE_METADATA"],
  ])
    await reject(makeArchive([{ name: "plugin.json", content }]), code);
  // Garbage inside the declared compressed range must not be silently ignored.
  const one = makeArchive([
    {
      name: "plugin.json",
      content: JSON.stringify(nexManifest),
      deflate: true,
    },
  ]);
  const central = one.readUInt32LE(one.length - 6);
  const trailing = Buffer.concat([
    one.subarray(0, central),
    Buffer.from([1, 2, 3]),
    one.subarray(central),
  ]);
  trailing.writeUInt32LE(one.readUInt32LE(18) + 3, 18);
  trailing.writeUInt32LE(one.readUInt32LE(central + 20) + 3, central + 3 + 20);
  trailing.writeUInt32LE(central + 3, trailing.length - 6);
  await reject(trailing, "COMPAT_ZIP_LAYOUT");
  // Declared size lies below budget, but the real metadata inflates to >64 KiB.
  const bomb = makeArchive([
    { name: "plugin.json", content: " ".repeat(70000), deflate: true },
  ]);
  const entry = directoryEntries(bomb)[0];
  bomb.writeUInt32LE(100, entry.central + 24);
  bomb.writeUInt32LE(100, entry.local + 22);
  await reject(bomb, "COMPAT_PACKAGE_METADATA");
});

test("package identity is strict; nested manifests and RH declarations cannot yield install tokens", async () => {
  await reject(
    makeArchive(
      nexEntries().map((entry) => ({
        ...entry,
        name: `wrapped/${entry.name}`,
      })),
    ),
    "COMPAT_PACKAGE_METADATA",
  );
  await reject(
    makeArchive(
      nexEntries({ ...nexManifest, entryAssembly: "lib/Missing.dll" }),
    ),
    "COMPAT_PACKAGE_ENTRY",
  );
  await reject(makeArchive(nexEntries()), "COMPAT_PACKAGE_FORMAT", "pnp");
  await reject(makeArchive(nEntries()), "COMPAT_PACKAGE_FORMAT", "pclx");
  await reject(
    makeArchive([
      {
        name: "plugin.json",
        content: '{"format":"pcl-linux.declarative-extension"}',
      },
    ]),
    "COMPAT_PACKAGE_FORMAT",
  );
  for (const field of [
    "formatVersion",
    "manifestVersion",
    "entryScript",
    "runtime",
  ])
    await reject(
      makeArchive(nexEntries({ ...nexManifest, [field]: 2 })),
      "COMPAT_PACKAGE_VERSION",
    );
  await reject(
    makeArchive(nEntries({ ...nManifest, formatVersion: 2 })),
    "COMPAT_VERSION",
    "pnp",
  );
});

test("PNP version, signed envelope, manifest hashes, declared signatures and file-table paths/sizes are bounded", async () => {
  const entries = nEntries();
  for (const field of ["signatureFormat", "packageFormat"])
    await reject(
      makeArchive(
        patchEnvelope(entries, (signed) => {
          signed[field] = 2;
        }),
      ),
      "COMPAT_PACKAGE_VERSION",
      "pnp",
    );
  for (const mutate of [
    (signed) => {
      signed.pluginId = "other.id";
    },
    (signed) => {
      signed.pluginVersion = "2.0.0";
    },
    (signed) => {
      signed.manifestSha256 = "1".repeat(64);
    },
    (signed) => {
      signed.fileTableSha256 = "1".repeat(64);
    },
    (signed) => {
      signed.signingKeyFingerprints = [];
    },
    (signed) => {
      signed.signingKeyFingerprint = "not a fingerprint";
    },
  ])
    await reject(
      makeArchive(patchEnvelope(entries, mutate)),
      "COMPAT_PACKAGE_METADATA",
      "pnp",
    );
  await reject(
    makeArchive(entries.filter((entry) => !entry.name.endsWith(".asc"))),
    "COMPAT_PACKAGE_METADATA",
    "pnp",
  );
  for (const mutate of [
    (table) => {
      table.files[0].size++;
    },
    (table) => {
      table.files.reverse();
    },
    (table) => {
      table.files[0].path = "not-present.dll";
    },
    (table) => {
      table.files.push(table.files[0]);
    },
  ])
    await reject(
      makeArchive(patchEnvelope(entries, () => {}, mutate)),
      "COMPAT_PACKAGE_METADATA",
      "pnp",
    );
  await reject(
    makeArchive(
      patchEnvelope(
        entries,
        () => {},
        (table) => {
          table.formatVersion = 2;
        },
      ),
    ),
    "COMPAT_PACKAGE_VERSION",
    "pnp",
  );
});

test(
  "file entry point rejects symlinks, special inputs, oversize files and unsupported suffixes without extraction",
  { timeout: 5000 },
  async (t) => {
    const scratch = fileURLToPath(
      new URL("../../../work/extension-compatibility-tests/", import.meta.url),
    );
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, "package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "input.pclx");
    await writeFile(file, makeArchive());
    assert.equal((await inspectForeignPackageFile(file)).id, nexManifest.id);
    const cli = fileURLToPath(
      new URL("../compat/inspect.mjs", import.meta.url),
    );
    const inspected = spawnSync(process.execPath, [cli, file]);
    assert.equal(inspected.status, 0);
    assert.equal(JSON.parse(inspected.stdout).archive.format, "pclx");
    const wrong = path.join(root, "wrong.pnp");
    await writeFile(wrong, makeArchive());
    const refused = spawnSync(process.execPath, [cli, wrong]);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout.length, 0);
    assert.match(refused.stderr.toString(), /^COMPAT_PACKAGE_FORMAT:/);
    assert.ok(!refused.stderr.toString().includes(root));

    const link = path.join(root, "link.pclx");
    await symlink(file, link);
    await assert.rejects(inspectForeignPackageFile(link), {
      code: "COMPAT_PACKAGE_FILE",
    });
    await assert.rejects(inspectForeignPackageFile(root + ".zip"), {
      code: "COMPAT_PACKAGE_FORMAT",
    });
    const directory = path.join(root, "directory.pclx");
    await mkdir(directory);
    await assert.rejects(inspectForeignPackageFile(directory), {
      code: "COMPAT_ZIP_SIZE",
    });
    const fifo = path.join(root, "pipe.pclx");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    await assert.rejects(inspectForeignPackageFile(fifo), {
      code: "COMPAT_ZIP_SIZE",
    });
    const oversized = path.join(root, "oversized.pnp");
    await writeFile(oversized, "");
    await truncate(oversized, ARCHIVE_LIMITS.bytes + 1);
    await assert.rejects(inspectForeignPackageFile(oversized), {
      code: "COMPAT_ZIP_SIZE",
    });
  },
);
