import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  decodeSafeImageBase64,
  isPathInsideRoot,
  readSafeLocalImage,
} from "./safe-fs.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("safe-fs", () => {
  it("keeps paths inside the upload root", () => {
    const root = path.resolve("/tmp/oc-upload-root");
    assert.equal(isPathInsideRoot(path.join(root, "a.png"), root), true);
    assert.equal(
      isPathInsideRoot(path.join(root, "..", "secret.png"), root),
      false,
    );
  });

  it("reads an in-root PNG and rejects escape attempts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oc-mcp-"));
    const imagePath = path.join(root, "shot.png");
    await writeFile(imagePath, PNG_1X1);

    const ok = await readSafeLocalImage({
      filePath: "shot.png",
      rootDir: root,
    });
    assert.equal(ok.contentType, "image/png");
    assert.equal(ok.bytes.equals(PNG_1X1), true);

    await assert.rejects(
      () =>
        readSafeLocalImage({
          filePath: path.join("..", "outside.png"),
          rootDir: root,
        }),
      /upload root/i,
    );
  });

  it("rejects non-image base64 payloads", () => {
    assert.throws(
      () =>
        decodeSafeImageBase64({
          imageBase64: Buffer.from("not-an-image").toString("base64"),
        }),
      /recognized image/i,
    );
  });

  it("accepts valid PNG base64", () => {
    const decoded = decodeSafeImageBase64({
      imageBase64: PNG_1X1.toString("base64"),
    });
    assert.equal(decoded.contentType, "image/png");
  });
});
