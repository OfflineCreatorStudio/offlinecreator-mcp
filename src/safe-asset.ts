import path from "node:path";
import { MCP_MAX_ASSET_BYTES, type SafeAssetData } from "./asset-data.js";
import { assetContentMismatch } from "./asset-sniff.js";
import { readJailedFile } from "./safe-fs.js";

export { decodeSafeAssetBase64, MCP_MAX_ASSET_BYTES } from "./asset-data.js";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "model/obj",
  ".stl": "model/stl",
  ".fbx": "application/vnd.fbx",
  ".usdz": "model/vnd.usdz+zip",
  ".bin": "application/octet-stream",
};

/**
 * Read a local file for MCP upload_asset: inside the upload root (links
 * resolved), known extension, size limit, and a magic-byte sniff so the
 * extension cannot vouch for arbitrary content.
 */
export async function readSafeLocalAsset(input: {
  filePath: string;
  maxBytes?: number;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SafeAssetData> {
  const file = await readJailedFile({
    filePath: input.filePath,
    maxBytes: input.maxBytes ?? MCP_MAX_ASSET_BYTES,
    rootDir: input.rootDir,
    env: input.env,
    label: "Asset",
    check: (lexicalPath) => {
      const contentType =
        CONTENT_TYPES[path.extname(lexicalPath).toLowerCase()];
      if (!contentType) throw new Error("Unsupported asset extension.");
      return contentType;
    },
  });
  const mismatch = assetContentMismatch(file.checked, file.bytes);
  if (mismatch) throw new Error(mismatch);
  return {
    bytes: file.bytes,
    contentType: file.checked,
    resolvedPath: file.resolvedPath,
  };
}
