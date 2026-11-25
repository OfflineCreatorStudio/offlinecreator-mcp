import { isGifImage, sniffImageType } from "./safe-image.js";

/**
 * Local magic-byte check for upload_asset over stdio. It mirrors the
 * signatures Studio checks on POST /generations/:id/assets (src/lib/media.ts
 * matchesMagicBytes), and adds what Studio cannot check: binary STL structure
 * and "this .bin is really a text file".
 *
 * Returns null when the bytes fit the declared type, otherwise a message.
 */
export function assetContentMismatch(
  contentType: string,
  bytes: Buffer,
): string | null {
  if (contentType === "application/octet-stream") {
    // Opaque draft-cache bundles have no signature, but they are never text.
    return looksLikeText(bytes)
      ? ".bin files upload as opaque binary data, and this file looks like plain text, so it was not uploaded."
      : null;
  }
  return matchesSignature(contentType, bytes)
    ? null
    : `File content does not look like ${contentType}. Check that the extension matches the real file format.`;
}

function matchesSignature(contentType: string, bytes: Buffer): boolean {
  switch (contentType) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
      return sniffImageType(bytes) === contentType;
    case "image/gif":
      return isGifImage(bytes);
    case "image/avif":
      return isIsoBrand(bytes, ["avif", "avis"]);
    case "image/heic":
    case "image/heif":
      return isIsoBrand(bytes, [
        "heic",
        "heix",
        "hevc",
        "hevx",
        "mif1",
        "msf1",
      ]);
    case "video/mp4":
    case "video/quicktime":
      return ascii(bytes, 4, 8) === "ftyp";
    case "video/webm":
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    case "audio/wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
    case "audio/mpeg":
      return (
        ascii(bytes, 0, 3) === "ID3" ||
        (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
      );
    case "model/gltf-binary":
      return ascii(bytes, 0, 4) === "glTF";
    case "model/gltf+json":
      return startsWithText(bytes, /^\{/);
    case "model/obj":
      return startsWithText(bytes, /^(#|v |o |g |mtllib )/);
    case "model/stl":
      return isAsciiStl(bytes) || isBinaryStl(bytes);
    case "application/vnd.fbx":
      return ascii(bytes, 0, 12) === "Kaydara FBX ";
    case "model/vnd.usdz+zip":
      return ascii(bytes, 0, 2) === "PK";
    default:
      return false;
  }
}

function isIsoBrand(bytes: Buffer, brands: string[]) {
  if (ascii(bytes, 4, 8) !== "ftyp") return false;
  const header = ascii(bytes, 8, Math.min(bytes.length, 32));
  return brands.some((brand) => header.includes(brand));
}

function isAsciiStl(bytes: Buffer) {
  return ascii(bytes, 0, Math.min(bytes.length, 64))
    .trimStart()
    .startsWith("solid");
}

/** 80-byte header, uint32 triangle count, then 50 bytes per triangle. */
function isBinaryStl(bytes: Buffer) {
  if (bytes.length < 84) return false;
  const triangles = bytes.readUInt32LE(80);
  return triangles > 0 && 84 + triangles * 50 <= bytes.length;
}

/** Text formats start with a known token and contain no NUL bytes early on. */
function startsWithText(bytes: Buffer, start: RegExp) {
  const prefix = ascii(bytes, 0, Math.min(bytes.length, 12)).trimStart();
  return start.test(prefix) && !bytes.subarray(0, 4096).includes(0);
}

const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function looksLikeText(bytes: Buffer) {
  try {
    // stream: true tolerates a multi-byte character cut off at the window edge.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, 4096),
      { stream: true },
    );
    return !CONTROL_BYTES.test(text);
  } catch {
    return false;
  }
}

function ascii(bytes: Buffer, start: number, end: number) {
  if (bytes.length < end) return "";
  return bytes.subarray(start, end).toString("latin1");
}
