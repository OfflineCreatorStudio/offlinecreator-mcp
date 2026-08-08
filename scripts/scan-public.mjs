import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const excludedDirs = new Set(["node_modules", "dist", ".git"]);
const binaryExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["long OfflineCreator key", /oc_(?:live|test)_[A-Za-z0-9_-]{16,}/],
  ["common cloud secret", /(?:sk_live_|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/],
  ["embedded OAuth service secret", /MCP_OAUTH_SERVICE_SECRET\s*[:=]\s*["'][^"'${}\s]{32,}["']/],
  ["UUID / production identifier", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ["excluded infrastructure", /(?:workers\.dev|supabase|stripe|fal-ai)/i],
  ["environment file reference", /(?:^|[\/])\.env(?:\.|$)/m],
];
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      excludedDirs.has(entry.name)
      || entry.name === "package-lock.json"
      || entry.name === ".gitignore"
      || entry.name === "scan-public.mjs"
    ) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (!binaryExt.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}
const findings = [];
for (const file of await walk(".")) {
  const text = (await readFile(file, "utf8")).replaceAll(
    "123e4567-e89b-42d3-a456-426614174000",
    "<TEST_UUID>",
  );
  for (const [label, regex] of patterns) if (regex.test(text)) findings.push(`${file}: ${label}`);
}
if (findings.length) {
  throw new Error(`Public leak scan failed:\n${findings.join("\n")}`);
}
console.log("Broad secret, environment, infrastructure, and production-ID scan passed.");
