import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  decodeSafeImageBase64,
  describeUploadRoot,
  isFilesystemRoot,
  isPathInsideRoot,
  readExactly,
  readSafeLocalImage,
  type ReadableHandle,
} from "./safe-fs.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * Try to create a link. Returns a skip reason when this OS/user cannot make
 * one (Windows file symlinks need Developer Mode or elevation; directory
 * junctions do not), or null on success.
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

describe("safe-fs", () => {
  let base: string;
  let root: string;
  let outside: string;

  before(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "oc-mcp-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.png"), PNG_1X1);
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("keeps paths inside the upload root", () => {
    const root = path.resolve("/tmp/oc-upload-root");
    assert.equal(isPathInsideRoot(path.join(root, "a.png"), root), true);
    assert.equal(
      isPathInsideRoot(path.join(root, "..", "secret.png"), root),
      false,
    );
    assert.equal(isPathInsideRoot(root, root), false);
  });

  it("treats only a whole '..' segment as an escape", () => {
    const root = path.resolve("/tmp/oc-upload-root");
    assert.equal(isPathInsideRoot(path.join(root, "..hero.png"), root), true);
    assert.equal(isPathInsideRoot(path.join(root, "a", "..b.png"), root), true);
    assert.equal(isPathInsideRoot(path.join(root, "...png"), root), true);
    assert.equal(isPathInsideRoot(path.dirname(root), root), false);
    assert.equal(
      isPathInsideRoot(path.join(root, "..", "x", "a.png"), root),
      false,
    );
  });

  it("reads an in-root PNG and rejects escape attempts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-mcp-"));
    try {
      const imagePath = path.join(dir, "shot.png");
      await writeFile(imagePath, PNG_1X1);

      const ok = await readSafeLocalImage({
        filePath: "shot.png",
        rootDir: dir,
      });
      assert.equal(ok.contentType, "image/png");
      assert.equal(ok.bytes.equals(PNG_1X1), true);

      await assert.rejects(
        () =>
          readSafeLocalImage({
            filePath: path.join("..", "outside.png"),
            rootDir: dir,
          }),
        /upload root/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a legitimate file name that starts with two dots", async () => {
    await writeFile(path.join(root, "..hero.png"), PNG_1X1);
    for (const filePath of ["..hero.png", path.join(root, "..hero.png")]) {
      const read = await readSafeLocalImage({ filePath, rootDir: root });
      assert.equal(read.contentType, "image/png");
    }
  });

  it("names the upload root in jail errors", async () => {
    await assert.rejects(
      () =>
        readSafeLocalImage({
          filePath: path.join(outside, "secret.png"),
          rootDir: root,
        }),
      (error: Error) => {
        assert.match(error.message, /must stay inside the upload root/);
        assert.ok(error.message.includes(root), error.message);
        assert.match(error.message, /OFFLINECREATOR_UPLOAD_ROOT/);
        return true;
      },
    );
  });

  it("reports a missing file without touching anything outside the root", async () => {
    await assert.rejects(
      () => readSafeLocalImage({ filePath: "absent.png", rootDir: root }),
      (error: Error) => {
        assert.match(error.message, /not found/i);
        assert.ok(error.message.includes(root), error.message);
        return true;
      },
    );
  });

  describe("symlink and junction escapes", () => {
    it("rejects a directory link (symlink or junction) that leads outside the root", async (t) => {
      // A junction needs no privilege on Windows; on POSIX this is a symlink.
      const skip = await tryLink(
        outside,
        path.join(root, "linkdir"),
        "junction",
      );
      if (skip) return t.skip(skip);

      await assert.rejects(
        () =>
          readSafeLocalImage({
            filePath: path.join("linkdir", "secret.png"),
            rootDir: root,
          }),
        (error: Error) => {
          assert.match(error.message, /symbolic link or junction/);
          assert.ok(error.message.includes(root), error.message);
          // The real target is not echoed back to the caller.
          assert.ok(!error.message.includes(outside), error.message);
          return true;
        },
      );
      // Absolute spelling of the same path is rejected too.
      await assert.rejects(
        () =>
          readSafeLocalImage({
            filePath: path.join(root, "linkdir", "secret.png"),
            rootDir: root,
          }),
        /symbolic link or junction/,
      );
    });

    it("rejects a file symlink that leads outside the root", async (t) => {
      const skip = await tryLink(
        path.join(outside, "secret.png"),
        path.join(root, "innocent.png"),
        "file",
      );
      if (skip) return t.skip(skip);

      await assert.rejects(
        () => readSafeLocalImage({ filePath: "innocent.png", rootDir: root }),
        /symbolic link or junction/,
      );
    });

    it("allows a file symlink that stays inside the root", async (t) => {
      await writeFile(path.join(root, "real.png"), PNG_1X1);
      const skip = await tryLink(
        path.join(root, "real.png"),
        path.join(root, "alias.png"),
        "file",
      );
      if (skip) return t.skip(skip);

      const read = await readSafeLocalImage({
        filePath: "alias.png",
        rootDir: root,
      });
      assert.equal(read.bytes.equals(PNG_1X1), true);
    });

    it("accepts files when the root itself is reached through a link", async (t) => {
      const realRoot = path.join(base, "real-root");
      await mkdir(realRoot);
      await writeFile(path.join(realRoot, "shot.png"), PNG_1X1);
      const skip = await tryLink(
        realRoot,
        path.join(base, "root-link"),
        "junction",
      );
      if (skip) return t.skip(skip);

      const read = await readSafeLocalImage({
        filePath: "shot.png",
        rootDir: path.join(base, "root-link"),
      });
      assert.equal(read.bytes.equals(PNG_1X1), true);
    });
  });

  describe("breadth of the upload root", () => {
    const fsRoot = path.parse(process.cwd()).root;

    it("recognises filesystem and drive roots", () => {
      assert.equal(isFilesystemRoot(fsRoot), true);
      assert.equal(isFilesystemRoot(root), false);
    });

    it("refuses a filesystem root unless it was set explicitly", async () => {
      await assert.rejects(
        () =>
          readSafeLocalImage({ filePath: "any.png", rootDir: fsRoot, env: {} }),
        (error: Error) => {
          assert.match(error.message, /filesystem root/);
          assert.match(error.message, /OFFLINECREATOR_UPLOAD_ROOT/);
          return true;
        },
      );
      // Explicit opt-in is allowed through; the file just does not exist.
      await assert.rejects(
        () =>
          readSafeLocalImage({
            filePath: "oc-mcp-no-such-file.png",
            rootDir: fsRoot,
            env: { OFFLINECREATOR_UPLOAD_ROOT: fsRoot },
          }),
        /not found/i,
      );
    });

    it("describes the root for the startup log", () => {
      assert.match(
        describeUploadRoot(root, { OFFLINECREATOR_UPLOAD_ROOT: root }),
        /OFFLINECREATOR_UPLOAD_ROOT/,
      );
      assert.match(describeUploadRoot(root, {}), /default: working directory/);
      assert.match(describeUploadRoot(fsRoot, {}), /filesystem root.*refused/);
      assert.match(describeUploadRoot(os.homedir(), {}), /home directory/);
      assert.ok(describeUploadRoot(root, {}).includes(root));
    });
  });

  describe("GIF is refused up front", () => {
    it("rejects a .gif name before looking at the file", async () => {
      // No such file: the message must be about GIF, not "not found".
      await assert.rejects(
        () => readSafeLocalImage({ filePath: "anim.gif", rootDir: root }),
        (error: Error) => {
          assert.match(error.message, /GIF/);
          assert.match(error.message, /PNG, JPEG, or WebP/);
          assert.match(error.message, /same generationId/);
          return true;
        },
      );
    });

    it("rejects GIF bytes hiding behind a .png name", async () => {
      await writeFile(path.join(root, "sneaky.png"), GIF_1X1);
      await assert.rejects(
        () => readSafeLocalImage({ filePath: "sneaky.png", rootDir: root }),
        /GIF images cannot be used as upload_input/,
      );
    });

    it("rejects GIF base64 with or without a declared contentType", () => {
      assert.throws(
        () =>
          decodeSafeImageBase64({
            imageBase64: GIF_1X1.toString("base64"),
            contentType: "image/gif",
          }),
        /PNG, JPEG, or WebP/,
      );
      assert.throws(
        () =>
          decodeSafeImageBase64({ imageBase64: GIF_1X1.toString("base64") }),
        /PNG, JPEG, or WebP/,
      );
      // Declared GIF is refused before the payload is even decoded.
      assert.throws(
        () =>
          decodeSafeImageBase64({
            imageBase64: "!!!",
            contentType: "image/gif",
          }),
        /GIF/,
      );
    });
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

  describe("file reads", () => {
    it("rejects empty files, directories, and oversized files", async () => {
      await writeFile(path.join(root, "empty.png"), Buffer.alloc(0));
      await assert.rejects(
        () => readSafeLocalImage({ filePath: "empty.png", rootDir: root }),
        /empty/i,
      );

      await mkdir(path.join(root, "folder.png"));
      await assert.rejects(
        () => readSafeLocalImage({ filePath: "folder.png", rootDir: root }),
        /regular file/,
      );

      await writeFile(path.join(root, "big.png"), PNG_1X1);
      await assert.rejects(
        () =>
          readSafeLocalImage({
            filePath: "big.png",
            rootDir: root,
            maxBytes: 8,
          }),
        /8 byte upload limit/,
      );
    });

    it("rejects a non-image behind an image extension", async () => {
      await writeFile(path.join(root, "notes.png"), "just some text");
      await assert.rejects(
        () => readSafeLocalImage({ filePath: "notes.png", rootDir: root }),
        /not a recognized image/,
      );
    });

    it("does not block on a FIFO", { timeout: 5000 }, async (t) => {
      if (process.platform === "win32") {
        return t.skip("named pipes (mkfifo) are POSIX only");
      }
      const fifo = path.join(root, "pipe.png");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return t.skip("mkfifo is not available on this host");
      }
      await assert.rejects(
        () => readSafeLocalImage({ filePath: "pipe.png", rootDir: root }),
        /regular file/,
      );
    });

    describe("readExactly", () => {
      function fakeHandle(options: {
        chunk: number;
        available: number;
        statSize: number;
      }): ReadableHandle {
        return {
          async read(buffer, offset, length, position) {
            const bytesRead = Math.max(
              0,
              Math.min(options.chunk, length, options.available - position),
            );
            buffer.fill(7, offset, offset + bytesRead);
            return { bytesRead };
          },
          async stat() {
            return { size: options.statSize };
          },
        };
      }

      it("loops over short reads until the whole file is read", async () => {
        const bytes = await readExactly(
          fakeHandle({ chunk: 3, available: 10, statSize: 10 }),
          10,
        );
        assert.equal(bytes.equals(Buffer.alloc(10, 7)), true);
      });

      it("fails instead of returning zero-filled bytes when the file shrank", async () => {
        await assert.rejects(
          () =>
            readExactly(
              fakeHandle({ chunk: 4, available: 6, statSize: 6 }),
              10,
            ),
          /changed while it was being read/,
        );
      });

      it("fails when the file grew after it was measured", async () => {
        await assert.rejects(
          () =>
            readExactly(
              fakeHandle({ chunk: 10, available: 12, statSize: 12 }),
              10,
            ),
          /changed while it was being read/,
        );
      });
    });
  });
});
