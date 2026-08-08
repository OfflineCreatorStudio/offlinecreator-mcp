import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const manifest = JSON.parse(
  await readFile("release/release-manifest.json", "utf8"),
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const expectedTag = process.env.RELEASE_TAG || `v${pkg.version}`;
const expectedCommit =
  process.env.RELEASE_COMMIT || process.env.GITHUB_SHA || "local-dry-run";

assert.equal(manifest.package, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.tag, expectedTag);
assert.equal(manifest.commit, expectedCommit);
assert.equal(manifest.artifacts.length, 3);

const digest = async (algorithm, file) =>
  createHash(algorithm)
    .update(await readFile(file))
    .digest("hex");

for (const artifact of manifest.artifacts) {
  const file = path.join("release", artifact.name);
  assert.equal(await digest("sha256", file), artifact.sha256);
  assert.equal((await stat(file)).size, artifact.size);
}

const tarball = manifest.artifacts.find((artifact) =>
  artifact.name.endsWith(".tgz"),
);
assert.ok(tarball, "Release manifest does not identify an npm tarball.");
const tarballPath = path.join("release", tarball.name);
assert.equal(await digest("sha1", tarballPath), tarball.npmShasum);
const [integrityAlgorithm, integrityBase64] = tarball.npmIntegrity.split("-");
assert.equal(integrityAlgorithm, "sha512");
assert.equal(
  createHash("sha512")
    .update(await readFile(tarballPath))
    .digest("base64"),
  integrityBase64,
);

const checksumLines = (
  await readFile(`release/offlinecreator-mcp-${pkg.version}.sha256`, "utf8")
)
  .trim()
  .split(/\r?\n/);
assert.deepEqual(
  checksumLines,
  manifest.artifacts
    .filter(
      (artifact) =>
        artifact.name !== `offlinecreator-mcp-${pkg.version}.sha256`,
    )
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`),
);

const archive = spawnSync("tar", ["-tf", tarballPath], { encoding: "utf8" });
assert.equal(
  archive.status,
  0,
  archive.stderr || "Unable to inspect npm tarball.",
);
const files = archive.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((name) => name.replace(/^package\//, ""))
  .filter((name) => !name.endsWith("/"));
for (const name of files) {
  assert.ok(
    ["LICENSE", "README.md", "package.json"].includes(name) ||
      (name.startsWith("dist/") && !name.includes(".test.")),
    `Unexpected npm tarball file: ${name}`,
  );
}
for (const required of [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/oauth-bridge.js",
  "dist/oauth-bridge.d.ts",
]) {
  assert.ok(files.includes(required), `Missing npm tarball file: ${required}`);
}

console.log(
  `Verified release tag/version, tarball SHA-1/SHA-256/SHA-512, SBOM checksum, and ${files.length} packed files.`,
);
