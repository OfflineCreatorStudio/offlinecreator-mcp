import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expected = new Map([
  ["assets/brand/offlinecreator-icon-400.png", [400, 400]],
  ["assets/brand/offlinecreator-icon-512.png", [512, 512]],
  ["assets/brand/offlinecreator-icon-1024.png", [1024, 1024]],
  ["assets/brand/offlinecreator-social-card-1200x630.png", [1200, 630]],
]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

for (const [file, [expectedWidth, expectedHeight]] of expected) {
  const bytes = await readFile(file);
  assert.ok(bytes.subarray(0, 8).equals(pngSignature), `${file} is not PNG`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(bytes.readUInt32BE(16), expectedWidth, `${file} width`);
  assert.equal(bytes.readUInt32BE(20), expectedHeight, `${file} height`);
  assert.equal(bytes[25], 6, `${file} must use RGBA color type`);
}

const alt = (await readFile("assets/brand/social-card-alt.txt", "utf8")).trim();
assert.ok(alt.length >= 20, "Social card alt text must be descriptive.");

console.log("PNG dimensions, RGBA channels, and social-card alt text passed (4 files).");
