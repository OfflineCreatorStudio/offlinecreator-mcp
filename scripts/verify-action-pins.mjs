import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workflowDirectory = ".github/workflows";
const workflowFiles = (await readdir(workflowDirectory))
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => path.join(workflowDirectory, name));

assert.ok(workflowFiles.length > 0, "No GitHub Actions workflows found.");

const violations = [];
let actionCount = 0;
for (const file of workflowFiles) {
  const text = await readFile(file, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(
      /^\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s#]+)(?:\s+#\s*(\S+))?\s*$/,
    );
    if (!match) continue;
    actionCount += 1;
    const [, action, reference, versionComment] = match;
    if (!/^[0-9a-f]{40}$/.test(reference)) {
      violations.push(`${file}:${index + 1}: ${action} is not SHA-pinned`);
    }
    if (!/^v?\d+(?:\.\d+){0,2}$/.test(versionComment ?? "")) {
      violations.push(
        `${file}:${index + 1}: ${action} lacks a trailing version comment`,
      );
    }
  }

  if (/\bNPM_TOKEN\b/.test(text)) {
    violations.push(`${file}: long-lived NPM_TOKEN references are forbidden`);
  }
}

assert.ok(actionCount > 0, "No action uses were found.");
assert.deepEqual(violations, [], violations.join("\n"));
console.log(
  `GitHub Action pin and publish-secret policy passed (${actionCount} uses).`,
);
