/** Record shipped vendor sources without running a tool or importing the host.
 * Tests and transient bytecode are not distribution inputs. Component versions
 * remain explicit release metadata; this command updates only file fingerprints.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const experimental = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = path.join(experimental, "SOURCES.json");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check"))
  throw new Error("Usage: node experimental/scripts/sync-sources.mjs [--check]");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const prefix = "experimental/runtime/";
const names = execFileSync(
  "git",
  ["ls-files", "-z", "--", `${prefix}vendor`],
  { cwd: repository, encoding: "utf8" },
)
  .split("\0")
  .filter((name) => name && !name.includes("/tests/"))
  .sort();
if (!names.length) throw new Error("No tracked vendor sources found");
const fingerprints = {};
for (const name of names) {
  const file = path.join(repository, name);
  if (!(await fs.lstat(file)).isFile())
    throw new Error(`Expected an ordinary vendor source: ${name}`);
  fingerprints[name.slice(prefix.length)] = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}
if (args[0] === "--check") {
  const recorded = Object.entries(manifest.vendor_sha256).sort();
  if (JSON.stringify(recorded) !== JSON.stringify(Object.entries(fingerprints)))
    throw new Error("Vendor fingerprints are stale; regenerate SOURCES.json");
  console.log(`Verified ${names.length} vendor source fingerprints`);
} else {
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, vendor_sha256: fingerprints }, null, 2) + "\n",
  );
  console.log(`Recorded ${names.length} vendor source fingerprints`);
}
