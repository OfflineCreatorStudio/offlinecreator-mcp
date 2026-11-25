import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GIF_INPUT_MESSAGE,
  isGifImage,
  MCP_MAX_INPUT_BYTES,
  sniffImageType,
  type SafeImageData,
} from "./safe-image.js";

export {
  decodeSafeImageBase64,
  MCP_MAX_INPUT_BYTES,
  sniffImageType,
} from "./safe-image.js";

// GIF is deliberately absent: Studio's /input route returns 415 for it after
// the generation is reserved. A .gif name gets its own message below.
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export type SafeImageRead = SafeImageData;

/**
 * Read a local image for MCP upload_input with hard limits:
 * - must live under cwd (or OFFLINECREATOR_UPLOAD_ROOT), after symlinks and
 *   junctions are resolved
 * - extension allowlist (PNG, JPEG, WebP; GIF is refused up front)
 * - max byte size
 * - magic-byte content sniff
 */
export async function readSafeLocalImage(input: {
  filePath: string;
  maxBytes?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SafeImageRead> {
  const file = await readJailedFile({
    filePath: input.filePath,
    maxBytes: input.maxBytes ?? MCP_MAX_INPUT_BYTES,
    rootDir: input.rootDir,
    env: input.env,
    label: "Image",
    check: (lexicalPath) => {
      const ext = path.extname(lexicalPath).toLowerCase();
      if (ext === ".gif") throw new Error(GIF_INPUT_MESSAGE);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(
          "Only .png, .jpg, .jpeg, or .webp image files can be uploaded as upload_input source images.",
        );
      }
    },
  });

  const contentType = sniffImageType(file.bytes);
  if (!contentType) {
    if (isGifImage(file.bytes)) throw new Error(GIF_INPUT_MESSAGE);
    throw new Error(
      "File content is not a recognized image (PNG, JPEG, or WebP).",
    );
  }
  return { bytes: file.bytes, contentType, resolvedPath: file.resolvedPath };
}

/**
 * Lexical containment only: no filesystem access, so it cannot see symlinks or
 * junctions. {@link readJailedFile} adds the realpath comparison.
 */
export function isPathInsideRoot(resolvedPath: string, rootDir: string) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(resolvedPath);
  if (resolved === root) return false; // must be a file, not the root dir itself
  const relative = path.relative(root, resolved);
  return (
    relative !== "" &&
    // A leading ".." is an escape only as a whole segment: "..hero.png" is a name.
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** True for `/`, a drive root such as `C:\`, or a UNC share root. */
export function isFilesystemRoot(dir: string) {
  const resolved = path.resolve(dir);
  return path.parse(resolved).root === resolved;
}

function samePath(a: string, b: string) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** True when the root came from OFFLINECREATOR_UPLOAD_ROOT rather than the cwd fallback. */
export function isExplicitUploadRoot(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = env.OFFLINECREATOR_UPLOAD_ROOT?.trim();
  return Boolean(configured) && samePath(configured!, rootDir);
}

/** One stderr line for startup: which folder uploads are limited to, and any warning. */
export function describeUploadRoot(
  rootDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const root = path.resolve(rootDir);
  if (isExplicitUploadRoot(root, env)) {
    return `upload root ${root} (OFFLINECREATOR_UPLOAD_ROOT)`;
  }
  const fallback = `upload root ${root} (default: working directory)`;
  if (isFilesystemRoot(root)) {
    return `${fallback}. This is a filesystem root, so local file uploads are refused until OFFLINECREATOR_UPLOAD_ROOT is set to a project folder.`;
  }
  if (samePath(root, os.homedir())) {
    return `${fallback}. Warning: this is your home directory; set OFFLINECREATOR_UPLOAD_ROOT to a narrower folder.`;
  }
  return `${fallback}. Set OFFLINECREATOR_UPLOAD_ROOT to change it.`;
}

export type JailedFileRead<T> = {
  bytes: Buffer;
  /** Real path of the file that was read (links resolved). */
  resolvedPath: string;
  /** Whatever `check` returned for the path the caller asked for. */
  checked: T;
};

/**
 * Read a regular file that must live inside the upload root, for both stdio
 * upload tools. Containment is checked lexically first (cheap, no I/O), then
 * again on the realpath of both the root and the file so a symlink or Windows
 * junction inside the root cannot lead out of it.
 */
export async function readJailedFile<T>(input: {
  filePath: string;
  maxBytes: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  /** "Image" / "Asset", used in error text. */
  label: string;
  /** Runs on the requested path before any file is touched (extension rules). */
  check: (lexicalPath: string) => T;
}): Promise<JailedFileRead<T>> {
  if (!input.filePath || input.filePath.includes("\0")) {
    throw new Error("Invalid file path.");
  }

  const root = path.resolve(input.rootDir ?? process.cwd());
  const explicitRoot = isExplicitUploadRoot(root, input.env);
  if (isFilesystemRoot(root) && !explicitRoot) {
    throw filesystemRootError(root);
  }
  // Absolute paths are resolved as-is, then must still fall under root.
  const lexical = path.isAbsolute(input.filePath)
    ? path.resolve(input.filePath)
    : path.resolve(root, input.filePath);
  if (!isPathInsideRoot(lexical, root)) throw outsideRootError(root);

  const checked = input.check(lexical);

  const realRoot = await realpathOrNull(root);
  if (!realRoot) {
    throw new Error(`The upload root does not exist: ${root}`);
  }
  if (isFilesystemRoot(realRoot) && !explicitRoot) {
    throw filesystemRootError(root);
  }
  const real = await realpathOrNull(lexical);
  if (!real) {
    throw new Error(`File not found inside the upload root (${root}).`);
  }
  if (!isPathInsideRoot(real, realRoot)) throw linkEscapeError(root);

  // Check the type before opening: open() on a FIFO named *.bin would block.
  const before = await stat(real);
  if (!before.isFile()) {
    throw new Error("filePath must point to a regular file.");
  }

  const handle = await open(
    real,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    // bigint: NTFS file ids are 64-bit and lose precision as a JS number, so
    // two different files could otherwise compare equal.
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error("filePath must point to a regular file.");
    }
    const openedSize = Number(opened.size);
    if (openedSize <= 0) throw new Error(`${input.label} file is empty.`);
    if (openedSize > input.maxBytes) {
      throw new Error(
        `${input.label} exceeds the ${input.maxBytes} byte upload limit.`,
      );
    }

    // A path swapped for a link between realpath and open must still land
    // inside the root, and be the very file that was opened.
    const after = await realpathOrNull(lexical);
    if (!after || !isPathInsideRoot(after, realRoot)) {
      throw linkEscapeError(root);
    }
    const identity = await stat(after, { bigint: true });
    if (
      opened.ino !== BigInt(0) &&
      (identity.ino !== opened.ino || identity.dev !== opened.dev)
    ) {
      throw new Error(
        "File changed while it was being opened; try the upload again.",
      );
    }

    const bytes = await readExactly(handle, openedSize);
    return { bytes, resolvedPath: real, checked };
  } finally {
    await handle.close();
  }
}

/** The slice of a FileHandle that {@link readExactly} needs. */
export type ReadableHandle = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
};

/**
 * Read exactly `size` bytes. A single handle.read() may return fewer bytes
 * than asked for, and a file truncated after stat() would otherwise upload
 * as trailing zero bytes.
 */
export async function readExactly(
  handle: ReadableHandle,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) {
      throw new Error(
        "File changed while it was being read; try the upload again.",
      );
    }
    offset += bytesRead;
  }
  // The file may also have grown since stat(): reject rather than upload a prefix.
  if ((await handle.stat()).size !== size) {
    throw new Error(
      "File changed while it was being read; try the upload again.",
    );
  }
  return bytes;
}

async function realpathOrNull(target: string) {
  try {
    return await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a path segment is a file. ELOOP: a symlink cycle.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP")
      return null;
    throw error;
  }
}

function outsideRootError(root: string) {
  return new Error(
    `filePath must stay inside the upload root (${root}). Set OFFLINECREATOR_UPLOAD_ROOT to a folder that contains the file.`,
  );
}

function linkEscapeError(root: string) {
  return new Error(
    `filePath resolves outside the upload root (${root}) through a symbolic link or junction. Copy the file into the upload root instead.`,
  );
}

function filesystemRootError(root: string) {
  return new Error(
    `The upload root is the filesystem root (${root}), which would expose every file. Set OFFLINECREATOR_UPLOAD_ROOT to the project folder you want to upload from.`,
  );
}
