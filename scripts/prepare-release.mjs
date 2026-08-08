import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this script through npm.");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const [pkg, lock, plugin, server] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("plugin.json"),
  readJson("server.json"),
]);

const version = pkg.version;
const expectedTag = `v${version}`;
const releaseTag = process.env.RELEASE_TAG || expectedTag;
assert.equal(
  releaseTag,
  expectedTag,
  "Release tag must exactly match package version.",
);
assert.equal(lock.version, version, "package-lock.json version differs.");
assert.equal(
  lock.packages?.[""]?.version,
  version,
  "Lockfile root version differs.",
);
assert.equal(plugin.version, version, "plugin.json version differs.");
assert.equal(server.version, version, "server.json version differs.");
assert.equal(
  server.packages?.[0]?.version,
  version,
  "Registry package version differs.",
);

const releaseDirectory = path.resolve("release");
await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const npm = (...args) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `npm ${args[0]} failed`);
  }
  return result.stdout;
};

const packReport = JSON.parse(
  npm("pack", "--json", "--pack-destination", releaseDirectory),
)[0];
assert.equal(packReport.name, pkg.name);
assert.equal(packReport.version, version);
assert.equal(packReport.filename, `offlinecreator-mcp-${version}.tgz`);

const tarballPath = path.join(releaseDirectory, packReport.filename);
const sbomName = `offlinecreator-mcp-${version}.cyclonedx.json`;
const sbomPath = path.join(releaseDirectory, sbomName);
const sbomText = npm("sbom", "--sbom-format=cyclonedx");
const sbom = JSON.parse(sbomText);
assert.equal(sbom.bomFormat, "CycloneDX");
assert.equal(sbom.metadata?.component?.version, version);
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const artifacts = [];
for (const file of [tarballPath, sbomPath]) {
  artifacts.push({
    name: path.basename(file),
    sha256: await sha256(file),
    size: (await stat(file)).size,
  });
}
artifacts[0].npmIntegrity = packReport.integrity;
artifacts[0].npmShasum = packReport.shasum;

const checksumsName = `offlinecreator-mcp-${version}.sha256`;
const checksumsPath = path.join(releaseDirectory, checksumsName);
await writeFile(
  checksumsPath,
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`,
);

const manifest = {
  schemaVersion: 1,
  package: pkg.name,
  version,
  tag: releaseTag,
  commit:
    process.env.RELEASE_COMMIT || process.env.GITHUB_SHA || "local-dry-run",
  registry: "https://registry.npmjs.org",
  artifacts: [
    ...artifacts,
    {
      name: checksumsName,
      sha256: await sha256(checksumsPath),
      size: (await stat(checksumsPath)).size,
    },
  ],
};
await writeFile(
  path.join(releaseDirectory, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const changelog = await readFile("CHANGELOG.md", "utf8");
const escapedVersion = version.replaceAll(".", "\\.");
const notes = changelog.match(
  new RegExp(`## ${escapedVersion}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`),
)?.[1];
assert.ok(notes?.trim(), `CHANGELOG.md has no release notes for ${version}.`);
await writeFile(
  path.join(releaseDirectory, "release-notes.md"),
  `# ${pkg.name} ${version}\n\n${notes.trim()}\n`,
);

console.log(
  `Prepared ${packReport.filename}, CycloneDX SBOM, checksums, and release manifest for ${releaseTag}.`,
);
