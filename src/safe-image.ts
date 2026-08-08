export const MCP_MAX_INPUT_BYTES = 10 * 1024 * 1024;

export type ImageContentType =
  "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type SafeImageData = {
  bytes: Buffer;
  contentType: ImageContentType;
  resolvedPath: string;
};

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
    contentType: "image/gif",
    match: (header) => {
      if (header.length < 6) return false;
      const tag = header.subarray(0, 6).toString("ascii");
      return tag === "GIF87a" || tag === "GIF89a";
    },
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
  contentType?: ImageContentType;
}): SafeImageData {
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
    throw new Error("imageBase64 is not a recognized image.");
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

export function sniffImageType(bytes: Buffer): ImageContentType | null {
  const header = bytes.subarray(0, 16);
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.match(header)) return signature.contentType;
  }
  return null;
}
