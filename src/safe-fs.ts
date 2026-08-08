import { open } from "node:fs/promises";
import path from "node:path";
import {
  MCP_MAX_INPUT_BYTES,
  sniffImageType,
  type SafeImageData,
} from "./safe-image.js";

export {
  decodeSafeImageBase64,
  MCP_MAX_INPUT_BYTES,
  sniffImageType,
} from "./safe-image.js";

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export type SafeImageRead = SafeImageData;

/**
 * Read a local image for MCP upload_input with hard limits:
 * - must live under cwd (or OFFLINECREATOR_UPLOAD_ROOT)
 * - extension allowlist
 * - max byte size
 * - magic-byte content sniff
 */
export async function readSafeLocalImage(input: {
  filePath: string;
  maxBytes?: number;
  rootDir?: string;
}): Promise<SafeImageRead> {
  const maxBytes = input.maxBytes ?? MCP_MAX_INPUT_BYTES;
  if (!input.filePath || input.filePath.includes("\0")) {
    throw new Error("Invalid file path.");
  }

  const root = path.resolve(input.rootDir ?? process.cwd());
  // Absolute paths are resolved as-is, then must still fall under root.
  const resolved = path.isAbsolute(input.filePath)
    ? path.resolve(input.filePath)
    : path.resolve(root, input.filePath);

  if (!isPathInsideRoot(resolved, root)) {
    throw new Error(
      "filePath must stay inside the upload root (project working directory).",
    );
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      "Only .png, .jpg, .jpeg, .webp, or .gif image files can be uploaded.",
    );
  }

  const handle = await open(resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("filePath must point to a regular file.");
    }
    if (stat.size <= 0) {
      throw new Error("Image file is empty.");
    }
    if (stat.size > maxBytes) {
      throw new Error(`Image exceeds the ${maxBytes} byte upload limit.`);
    }

    const bytes = Buffer.alloc(stat.size);
    await handle.read(bytes, 0, stat.size, 0);
    const contentType = sniffImageType(bytes);
    if (!contentType) {
      throw new Error("File content is not a recognized image.");
    }

    return { bytes, contentType, resolvedPath: resolved };
  } finally {
    await handle.close();
  }
}

export function isPathInsideRoot(resolvedPath: string, rootDir: string) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(resolvedPath);
  if (resolved === root) return false; // must be a file, not the root dir itself
  const relative = path.relative(root, resolved);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}
