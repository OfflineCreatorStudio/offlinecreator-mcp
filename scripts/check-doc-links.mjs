import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}
const failures = [];
for (const file of await walk(".")) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1].trim().split("#")[0];
    if (!href || /^(https?:|mailto:)/.test(href)) continue;
    const target = path.resolve(path.dirname(file), decodeURI(href));
    try { await access(target); } catch { failures.push(`${file}: ${match[1]}`); }
  }
}
if (failures.length) {
  throw new Error(
    `Broken local documentation links:\n${failures.join("\n")}`,
  );
}
console.log("Documentation link consistency passed.");
