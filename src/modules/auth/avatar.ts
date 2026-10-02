export interface DetectedImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** With the dot. Chosen by us from what the bytes are, never taken from the upload. */
  extension: ".png" | ".jpg" | ".webp";
}

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, DetectedImage["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export const mimeTypeOf = (extension: string) =>
  MIME_BY_EXTENSION[extension] ?? "application/octet-stream";

/** Decides what an upload really is from its first bytes (PNG, JPEG or WebP); the filename and browser mime type are only hints. */
export function detectImage(data: Buffer): DetectedImage | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return { mimeType: "image/png", extension: ".png" };
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return { mimeType: "image/jpeg", extension: ".jpg" };
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { mimeType: "image/webp", extension: ".webp" };
  return null;
}
