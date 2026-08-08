import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const allowedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
assert.equal(lock.lockfileVersion, 3, "License check expects package-lock v3.");

const violations = [];
let checked = 0;

for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
  if (!location || !location.startsWith("node_modules/")) continue;
  checked += 1;
  const packageName = location.slice(
    location.lastIndexOf("node_modules/") + 13,
  );
  const license = metadata.license;
  if (typeof license !== "string" || !allowedLicenses.has(license)) {
    violations.push(`${packageName}: ${license ?? "missing license"}`);
  }
}

assert.ok(
  checked > 0,
  "No installed dependency metadata found in package-lock.json.",
);
assert.deepEqual(
  violations,
  [],
  `Dependency license policy failed:\n${violations.join("\n")}`,
);

console.log(
  `Dependency license policy passed for ${checked} locked packages (${[...allowedLicenses].join(", ")}).`,
);
