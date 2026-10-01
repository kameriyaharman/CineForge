/** Checks a file really is the image type it claims, from its first bytes. */
export function imageSniffer(contentType: string) {
  return (head: Buffer): string | null => {
    const isJpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const isPng =
      head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp =
      head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
    const ok =
      (contentType === "image/jpeg" && isJpeg) ||
      (contentType === "image/png" && isPng) ||
      (contentType === "image/webp" && isWebp);
    return ok ? null : "The file is not a valid JPEG, PNG or WebP image.";
  };
}

export const IMAGE_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
