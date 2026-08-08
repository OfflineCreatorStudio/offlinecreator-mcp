import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this check through npm.");
const result = spawnSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json"],
  {
  encoding: "utf8",
  },
);
if (result.status !== 0) throw new Error(result.stderr || "npm pack --dry-run failed");
const report = JSON.parse(result.stdout);
const names = report[0].files.map((file) => file.path).sort();
const allowed = ["LICENSE", "README.md", "package.json"];
for (const name of names) {
  assert.ok(allowed.includes(name) || (name.startsWith("dist/") && !name.includes(".test.")), `Unexpected packed file: ${name}`);
}
for (const required of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/oauth-bridge.js",
  "dist/oauth-bridge.d.ts",
  ...allowed,
]) {
  assert.ok(names.includes(required), `Missing packed file: ${required}`);
}
console.log(`npm pack dry-run allowlist passed (${names.length} files).`);
