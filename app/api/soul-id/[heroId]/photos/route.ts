import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import { soulPrefix } from "@/lib/soul-id";
import { SOUL_PHOTO_MAX, SOUL_PHOTO_MAX_BYTES, SOUL_PHOTO_TYPES } from "@/lib/soul-options";
import {
  UploadTooLargeError,
  UploadTypeError,
  deleteObject,
  isStorageConfigured,
  presignGet,
  uploadStream,
} from "@/lib/storage";

/**
 * POST /api/soul-id/{heroId}/photos — upload ONE training photo.
 * Body: the raw image bytes. Headers: Content-Type (image/jpeg|png|webp),
 * X-File-Name (optional, URI-encoded). Streamed straight into the bucket.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Checks the file really is the image type it claims (by its first bytes). */
function sniffer(contentType: string) {
  return (head: Buffer): string | null => {
    const isJpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const isPng = head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
    const ok =
      (contentType === "image/jpeg" && isJpeg) ||
      (contentType === "image/png" && isPng) ||
      (contentType === "image/webp" && isWebp);
    return ok ? null : "The file is not a valid JPEG, PNG or WebP image.";
  };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ heroId: string }> }) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  if (!isStorageConfigured()) return jsonError(500, "STORAGE_NOT_CONFIGURED", "Photo storage is not configured.");

  const { heroId } = await params;
  if (!UUID_PATTERN.test(heroId)) return jsonError(400, "INVALID_ID", "Malformed hero id.");

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(SOUL_PHOTO_TYPES as readonly string[]).includes(contentType)) {
    return jsonError(415, "UNSUPPORTED_TYPE", "Use JPEG, PNG or WebP photos. (iPhone HEIC: export as JPEG first.)");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > SOUL_PHOTO_MAX_BYTES) return jsonError(413, "TOO_LARGE", "Each photo must be under 15 MB.");
  if (!req.body) return jsonError(400, "EMPTY", "No file received.");

  let fileName: string | null = null;
  try {
    const raw = req.headers.get("x-file-name");
    fileName = raw ? decodeURIComponent(raw).slice(0, 200) : null;
  } catch {
    fileName = null;
  }

  const hero = await prisma.character.findFirst({
    where: { id: heroId.toLowerCase(), userId: session.userId },
    select: { id: true, soulStatus: true, _count: { select: { photos: true } } },
  });
  if (!hero) return jsonError(404, "NOT_FOUND", "Hero not found.");
  if (hero.soulStatus === "TRAINING") return jsonError(409, "TRAINING", "Photos can't change while training runs.");
  if (hero._count.photos >= SOUL_PHOTO_MAX) {
    return jsonError(409, "TOO_MANY", `A hero can have at most ${SOUL_PHOTO_MAX} photos.`);
  }

  const photoId = randomUUID();
  const key = `${soulPrefix(session.userId, hero.id)}/photos/${photoId}.${EXT[contentType]}`;
  try {
    const stored = await uploadStream(req.body, key, contentType, SOUL_PHOTO_MAX_BYTES, sniffer(contentType));
    await prisma.characterPhoto.create({
      data: {
        id: photoId,
        characterId: hero.id,
        storageKey: key,
        contentType,
        byteSize: BigInt(stored.byteSize),
        fileName,
      },
    });
    return json({ photo: { id: photoId, fileName, url: await presignGet(key).catch(() => null) } }, 201);
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    if (err instanceof UploadTooLargeError) return jsonError(413, "TOO_LARGE", "Each photo must be under 15 MB.");
    if (err instanceof UploadTypeError) return jsonError(415, "UNSUPPORTED_TYPE", err.message);
    console.error(`[soul-id] photo upload failed for hero ${hero.id}:`, err);
    return jsonError(500, "UPLOAD_FAILED", "Could not save the photo. Try again.");
  }
}
