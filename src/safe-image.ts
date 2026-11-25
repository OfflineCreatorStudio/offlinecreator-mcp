export const MCP_MAX_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * Source-image types Studio's POST /generations/:id/input route accepts
 * (INPUT_MEDIA_TYPES: JPEG, PNG, WebP). Anything else gets a 415 from Studio
 * after the generation is already reserved, so it is refused here first.
 */
export type ImageContentType = "image/png" | "image/jpeg" | "image/webp";

/**
 * What a caller may still declare. GIF is named only so it can be refused
 * with an actionable message instead of a type error or a Studio 415.
 */
export type RequestedImageContentType = ImageContentType | "image/gif";

export type SafeImageData = {
  bytes: Buffer;
  contentType: ImageContentType;
  resolvedPath: string;
};

export const GIF_INPUT_MESSAGE =
  "GIF images cannot be used as upload_input source images: Studio accepts PNG, JPEG, or WebP only. " +
  "Convert the GIF (a single frame is fine) to PNG, JPEG, or WebP and call upload_input again with the same generationId.";

const IMAGE_SIGNATURES: Array<{
  contentType: ImageContentType;
  match: (header: Buffer) => boolean;
}> = [
  {
    contentType: "image/png",
    match: (header) =>
      header.length >= 8 &&
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47,
  },
  {
    contentType: "image/jpeg",
    match: (header) =>
      header.length >= 3 &&
      header[0] === 0xff &&
      header[1] === 0xd8 &&
      header[2] === 0xff,
  },
  {
    contentType: "image/webp",
    match: (header) =>
      header.length >= 12 &&
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

export function decodeSafeImageBase64(input: {
  imageBase64: string;
  maxBytes?: number;
  contentType?: RequestedImageContentType;
}): SafeImageData {
  // Refuse a declared GIF before decoding anything.
  if (input.contentType === "image/gif") throw new Error(GIF_INPUT_MESSAGE);

  const maxBytes = input.maxBytes ?? MCP_MAX_INPUT_BYTES;
  const raw = input.imageBase64.includes(",")
    ? input.imageBase64.split(",")[1]!
    : input.imageBase64;
  if (raw.length > Math.ceil(maxBytes * 1.4) + 64) {
    throw new Error("imageBase64 exceeds the upload size limit.");
  }

  const bytes = Buffer.from(raw, "base64");
  if (bytes.byteLength <= 0) {
    throw new Error("imageBase64 decoded to an empty buffer.");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Image exceeds the ${maxBytes} byte upload limit.`);
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    if (isGifImage(bytes)) throw new Error(GIF_INPUT_MESSAGE);
    throw new Error(
      "imageBase64 is not a recognized image (PNG, JPEG, or WebP).",
    );
  }
  if (input.contentType && input.contentType !== sniffed) {
    throw new Error("contentType does not match image bytes.");
  }

  return {
    bytes,
    contentType: sniffed,
    resolvedPath: "(base64)",
  };
}

/** Magic-byte sniff for the source-image types Studio accepts (never GIF). */
export function sniffImageType(bytes: Buffer): ImageContentType | null {
  const header = bytes.subarray(0, 16);
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.match(header)) return signature.contentType;
  }
  return null;
}

/** GIF87a / GIF89a signature. upload_asset still accepts GIF; upload_input does not. */
export function isGifImage(bytes: Buffer): boolean {
  if (bytes.length < 6) return false;
  const tag = bytes.subarray(0, 6).toString("ascii");
  return tag === "GIF87a" || tag === "GIF89a";
}
