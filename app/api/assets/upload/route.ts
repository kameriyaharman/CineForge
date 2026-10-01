import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { json, jsonError } from "@/lib/api-helpers";
import { IMAGE_EXT, IMAGE_UPLOAD_TYPES, imageSniffer } from "@/lib/image-sniff";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import {
  UploadTooLargeError,
  UploadTypeError,
  deleteObject,
  isStorageConfigured,
  presignGet,
  uploadStream,
} from "@/lib/storage";

/**
 * POST /api/assets/upload — add your own image to the Library (e.g. to edit it).
 * Body: raw image bytes. Headers: Content-Type (image/jpeg|png|webp),
 * X-File-Name (optional, URI-encoded). Streamed straight into the bucket.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  if (!isStorageConfigured()) return jsonError(500, "STORAGE_NOT_CONFIGURED", "Storage is not configured.");

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(IMAGE_UPLOAD_TYPES as readonly string[]).includes(contentType)) {
    return jsonError(415, "UNSUPPORTED_TYPE", "Use a JPEG, PNG or WebP image. (iPhone HEIC: export as JPEG first.)");
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BYTES) {
    return jsonError(413, "TOO_LARGE", "Images must be under 20 MB.");
  }
  if (!req.body) return jsonError(400, "EMPTY", "No file received.");

  let fileName: string | null = null;
  try {
    const raw = req.headers.get("x-file-name");
    fileName = raw ? decodeURIComponent(raw).slice(0, 200) : null;
  } catch {
    fileName = null;
  }

  // Pixel size measured by the browser (optional) — helps edits keep the shape.
  const dim = (h: string) => {
    const n = Number(req.headers.get(h));
    return Number.isInteger(n) && n > 0 && n < 50_000 ? n : null;
  };
  const width = dim("x-image-width");
  const height = dim("x-image-height");

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true } });
  if (!user) return jsonError(404, "USER_NOT_FOUND", "Signed-in user no longer exists.");

  const id = randomUUID();
  const key = `users/${session.userId}/uploads/${new Date().toISOString().slice(0, 10)}/${id}.${IMAGE_EXT[contentType]}`;
  try {
    const stored = await uploadStream(req.body, key, contentType, MAX_BYTES, imageSniffer(contentType));
    const asset = await prisma.asset.create({
      data: {
        id,
        userId: session.userId,
        kind: "IMAGE",
        role: "UPLOAD",
        storageKey: key,
        contentType,
        byteSize: BigInt(stored.byteSize),
        prompt: null,
        meta: { uploaded: true, fileName, width, height },
      },
      select: { id: true, createdAt: true },
    });
    return json(
      {
        asset: {
          id: asset.id,
          kind: "IMAGE",
          role: "UPLOAD",
          url: await presignGet(key).catch(() => null),
          contentType,
          byteSize: stored.byteSize,
          prompt: null,
          meta: { uploaded: true, fileName, width, height },
          clipId: null,
          createdAt: asset.createdAt.toISOString(),
        },
      },
      201,
    );
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    if (err instanceof UploadTooLargeError) return jsonError(413, "TOO_LARGE", "Images must be under 20 MB.");
    if (err instanceof UploadTypeError) return jsonError(415, "UNSUPPORTED_TYPE", err.message);
    console.error("[assets] upload failed:", err);
    return jsonError(500, "UPLOAD_FAILED", "Could not save the image. Try again.");
  }
}
