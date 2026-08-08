import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const history = spawnSync(
  "git",
  ["log", "-p", "--all", "--full-history", "--no-ext-diff", "--binary"],
  {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  },
);
assert.equal(
  history.status,
  0,
  history.stderr || "Unable to read Git history.",
);

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OfflineCreator API key", /\boc_(?:live|test)_[A-Za-z0-9_-]{16,}\b/],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Stripe live secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["npm access token", /\bnpm_[A-Za-z0-9]{20,}\b/],
];

const findings = patterns
  .filter(([, pattern]) => pattern.test(history.stdout))
  .map(([label]) => label);
assert.deepEqual(
  findings,
  [],
  `Secret patterns found in Git history: ${findings.join(", ")}`,
);
console.log("Git history secret scan passed.");
