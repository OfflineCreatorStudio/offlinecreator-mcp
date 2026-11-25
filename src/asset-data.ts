export const MCP_MAX_ASSET_BYTES = 250 * 1024 * 1024;

export const ASSET_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "model/gltf-binary",
  "model/gltf+json",
  "model/obj",
  "model/stl",
  "application/vnd.fbx",
  "model/vnd.usdz+zip",
  "application/octet-stream",
]);

export type SafeAssetData = {
  bytes: Buffer;
  contentType: string;
  resolvedPath: string;
};

export function decodeSafeAssetBase64(input: {
  assetBase64: string;
  contentType: string;
  maxBytes?: number;
}): SafeAssetData {
  if (!ASSET_CONTENT_TYPES.has(input.contentType)) {
    throw new Error("Unsupported contentType.");
  }
  const maxBytes = input.maxBytes ?? MCP_MAX_ASSET_BYTES;
  const raw = input.assetBase64.includes(",")
    ? input.assetBase64.split(",")[1]!
    : input.assetBase64;
  if (raw.length > Math.ceil(maxBytes * 1.4) + 64) {
    throw new Error("assetBase64 exceeds the upload size limit.");
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) {
    throw new Error("assetBase64 decoded to an invalid size.");
  }
  return { bytes, contentType: input.contentType, resolvedPath: "(base64)" };
}
