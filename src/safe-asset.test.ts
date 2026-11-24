import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { assetContentMismatch } from "./asset-sniff.js";
import { readSafeLocalAsset } from "./safe-asset.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const SECRET_TEXT = Buffer.from("TOP SECRET BYTES\n");

/** Opaque, non-text bytes standing in for an encrypted draft-cache bundle. */
const OPAQUE_BIN = Buffer.from([
  0x00, 0xff, 0x13, 0x37, 0xc0, 0xde, 0x80, 0x01,
]);

function mp4Bytes() {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "latin1"),
    Buffer.alloc(16),
  ]);
}

function binaryStl(triangles: number) {
  const bytes = Buffer.alloc(84 + triangles * 50);
  bytes.write("binary stl header", 0, "latin1");
  bytes.writeUInt32LE(triangles, 80);
  return bytes;
}

/**
 * Returns a skip reason when this OS/user cannot create the link (Windows
 * file symlinks need Developer Mode or elevation; junctions do not), or null.
 */
async function tryLink(
  target: string,
  linkPath: string,
  type: "file" | "dir" | "junction",
) {
  try {
    await symlink(target, linkPath, type);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EPERM" ||
      code === "EACCES" ||
      code === "ENOSYS" ||
      code === "UNKNOWN"
    ) {
      return process.platform === "win32"
        ? `Windows without symlink privilege cannot create a ${type} link (${code}); enable Developer Mode or run elevated to exercise this case`
        : `this filesystem cannot create a ${type} link (${code})`;
    }
    throw error;
  }
}

describe("safe-asset", () => {
  let base: string;
  let root: string;
  let outside: string;

  before(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "oc-mcp-asset-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.bin"), OPAQUE_BIN);
    await writeFile(path.join(outside, "secret.png"), PNG_1X1);
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reads an in-root asset and reports its content type", async () => {
    await writeFile(path.join(root, "shot.png"), PNG_1X1);
    const read = await readSafeLocalAsset({
      filePath: "shot.png",
      rootDir: root,
    });
    assert.equal(read.contentType, "image/png");
    assert.equal(read.bytes.equals(PNG_1X1), true);
  });

  it("still accepts GIF, which Studio takes as an asset (but not as upload_input)", async () => {
    await writeFile(path.join(root, "anim.gif"), GIF_1X1);
    const read = await readSafeLocalAsset({
      filePath: "anim.gif",
      rootDir: root,
    });
    assert.equal(read.contentType, "image/gif");
  });

  it("accepts a file name that starts with two dots", async () => {
    await writeFile(path.join(root, "..clip.mp4"), mp4Bytes());
    const read = await readSafeLocalAsset({
      filePath: "..clip.mp4",
      rootDir: root,
    });
    assert.equal(read.contentType, "video/mp4");
  });

  it("rejects paths that leave the root and names the root", async () => {
    await assert.rejects(
      () =>
        readSafeLocalAsset({
          filePath: path.join("..", "outside", "secret.png"),
          rootDir: root,
        }),
      (error: Error) => {
        assert.match(error.message, /must stay inside the upload root/);
        assert.ok(error.message.includes(root), error.message);
        return true;
      },
    );
  });

  it("rejects unsupported extensions and missing files", async () => {
    await writeFile(path.join(root, "notes.txt"), "hello");
    await assert.rejects(
      () => readSafeLocalAsset({ filePath: "notes.txt", rootDir: root }),
      /Unsupported asset extension/,
    );
    await assert.rejects(
      () => readSafeLocalAsset({ filePath: "absent.mp4", rootDir: root }),
      /not found/i,
    );
  });

  it("rejects empty files, directories, and oversized files", async () => {
    await writeFile(path.join(root, "empty.mp4"), Buffer.alloc(0));
    await assert.rejects(
      () => readSafeLocalAsset({ filePath: "empty.mp4", rootDir: root }),
      /empty/i,
    );
    await mkdir(path.join(root, "folder.mp4"));
    await assert.rejects(
      () => readSafeLocalAsset({ filePath: "folder.mp4", rootDir: root }),
      /regular file/,
    );
    await writeFile(path.join(root, "long.mp4"), mp4Bytes());
    await assert.rejects(
      () =>
        readSafeLocalAsset({
          filePath: "long.mp4",
          rootDir: root,
          maxBytes: 8,
        }),
      /8 byte upload limit/,
    );
  });

  describe("content sniff", () => {
    it("rejects bytes that do not match the extension", async () => {
      await writeFile(path.join(root, "fake.png"), SECRET_TEXT);
      await assert.rejects(
        () => readSafeLocalAsset({ filePath: "fake.png", rootDir: root }),
        /does not look like image\/png/,
      );
      await writeFile(path.join(root, "fake.mp4"), PNG_1X1);
      await assert.rejects(
        () => readSafeLocalAsset({ filePath: "fake.mp4", rootDir: root }),
        /does not look like video\/mp4/,
      );
    });

    it("accepts an opaque .bin but not a plain-text one", async () => {
      await writeFile(path.join(root, "cache.bin"), OPAQUE_BIN);
      const read = await readSafeLocalAsset({
        filePath: "cache.bin",
        rootDir: root,
      });
      assert.equal(read.contentType, "application/octet-stream");

      await writeFile(path.join(root, "secret.bin"), SECRET_TEXT);
      await assert.rejects(
        () => readSafeLocalAsset({ filePath: "secret.bin", rootDir: root }),
        /looks like plain text/,
      );
      // Multi-byte UTF-8 text is still text.
      await writeFile(path.join(root, "unicode.bin"), "naïve café — 日本語\n");
      await assert.rejects(
        () => readSafeLocalAsset({ filePath: "unicode.bin", rootDir: root }),
        /looks like plain text/,
      );
    });

    it("checks the formats Studio checks, and binary STL structure", () => {
      const ok = (type: string, bytes: Buffer) =>
        assert.equal(assetContentMismatch(type, bytes), null, type);
      const bad = (type: string, bytes: Buffer) =>
        assert.match(
          assetContentMismatch(type, bytes) ?? "",
          /does not look like/,
          type,
        );

      ok("image/png", PNG_1X1);
      ok("image/gif", GIF_1X1);
      ok("video/mp4", mp4Bytes());
      ok("video/quicktime", mp4Bytes());
      ok("video/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]));
      ok(
        "audio/wav",
        Buffer.concat([
          Buffer.from("RIFF"),
          Buffer.alloc(4),
          Buffer.from("WAVEfmt "),
        ]),
      );
      ok("audio/mpeg", Buffer.from("ID3\u0004\u0000\u0000", "latin1"));
      ok("audio/mpeg", Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      ok(
        "model/gltf-binary",
        Buffer.from("glTF\u0002\u0000\u0000\u0000", "latin1"),
      );
      ok("model/gltf+json", Buffer.from('  {"asset":{"version":"2.0"}}'));
      ok("model/obj", Buffer.from("# exported\nv 0 0 0\n"));
      ok(
        "application/vnd.fbx",
        Buffer.from("Kaydara FBX Binary  \u0000", "latin1"),
      );
      ok("model/vnd.usdz+zip", Buffer.from("PK\u0003\u0004rest", "latin1"));
      ok("model/stl", Buffer.from("solid cube\nendsolid cube\n"));
      ok("model/stl", binaryStl(2));
      ok(
        "image/avif",
        Buffer.concat([
          Buffer.alloc(4),
          Buffer.from("ftypavif"),
          Buffer.alloc(8),
        ]),
      );
      ok(
        "image/heic",
        Buffer.concat([
          Buffer.alloc(4),
          Buffer.from("ftypheic"),
          Buffer.alloc(8),
        ]),
      );

      bad("image/png", GIF_1X1);
      bad("image/gif", PNG_1X1);
      bad("video/webm", mp4Bytes());
      bad("audio/wav", PNG_1X1);
      bad("model/gltf-binary", SECRET_TEXT);
      bad("model/gltf+json", Buffer.from("not json"));
      bad("model/gltf+json", Buffer.from('{"a":1}\u0000\u0000'));
      bad("model/obj", Buffer.from("hello world"));
      bad("application/vnd.fbx", SECRET_TEXT);
      bad("model/vnd.usdz+zip", SECRET_TEXT);
      bad("image/avif", mp4Bytes());
      // Plain text that is neither ASCII STL nor a plausible binary STL.
      bad(
        "model/stl",
        Buffer.from("this is not a mesh at all, just prose padding".repeat(4)),
      );
      // Declares more triangles than the file holds.
      const truncated = binaryStl(5).subarray(0, 120);
      bad("model/stl", truncated);
    });
  });

  describe("symlink and junction escapes", () => {
    it("rejects a directory link that leads outside the root, as in the M01 proof of concept", async (t) => {
      const skip = await tryLink(
        outside,
        path.join(root, "linkdir"),
        "junction",
      );
      if (skip) return t.skip(skip);

      await assert.rejects(
        () =>
          readSafeLocalAsset({
            filePath: path.join("linkdir", "secret.bin"),
            rootDir: root,
          }),
        (error: Error) => {
          assert.match(error.message, /symbolic link or junction/);
          assert.ok(error.message.includes(root), error.message);
          return true;
        },
      );
      await assert.rejects(
        () =>
          readSafeLocalAsset({
            filePath: path.join(root, "linkdir", "secret.png"),
            rootDir: root,
          }),
        /symbolic link or junction/,
      );
    });

    it("rejects a file symlink that leads outside the root", async (t) => {
      const skip = await tryLink(
        path.join(outside, "secret.bin"),
        path.join(root, "innocent.bin"),
        "file",
      );
      if (skip) return t.skip(skip);

      await assert.rejects(
        () => readSafeLocalAsset({ filePath: "innocent.bin", rootDir: root }),
        /symbolic link or junction/,
      );
    });

    it("allows a file symlink that stays inside the root", async (t) => {
      await writeFile(path.join(root, "real.mp4"), mp4Bytes());
      const skip = await tryLink(
        path.join(root, "real.mp4"),
        path.join(root, "alias.mp4"),
        "file",
      );
      if (skip) return t.skip(skip);

      const read = await readSafeLocalAsset({
        filePath: "alias.mp4",
        rootDir: root,
      });
      assert.equal(read.contentType, "video/mp4");
    });
  });

  it("refuses a filesystem root unless it was set explicitly", async () => {
    const fsRoot = path.parse(process.cwd()).root;
    await assert.rejects(
      () =>
        readSafeLocalAsset({ filePath: "any.mp4", rootDir: fsRoot, env: {} }),
      /filesystem root/,
    );
    await assert.rejects(
      () =>
        readSafeLocalAsset({
          filePath: "oc-mcp-no-such-file.mp4",
          rootDir: fsRoot,
          env: { OFFLINECREATOR_UPLOAD_ROOT: fsRoot },
        }),
      /not found/i,
    );
  });

  it(
    "does not block on a FIFO named like an asset",
    { timeout: 5000 },
    async (t) => {
      if (process.platform === "win32") {
        return t.skip("named pipes (mkfifo) are POSIX only");
      }
      const fifo = path.join(root, "pipe.bin");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return t.skip("mkfifo is not available on this host");
      }
      await assert.rejects(
        () => readSafeLocalAsset({ filePath: "pipe.bin", rootDir: root }),
        /regular file/,
      );
    },
  );
});
