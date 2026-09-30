import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import { deleteObject, isStorageConfigured } from "@/lib/storage";

/** DELETE /api/soul-id/{heroId}/photos/{photoId} — remove one training photo. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ heroId: string; photoId: string }> },
) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  const { heroId, photoId } = await params;
  if (!UUID_PATTERN.test(heroId) || !UUID_PATTERN.test(photoId)) return jsonError(400, "INVALID_ID", "Malformed id.");

  try {
    const photo = await prisma.characterPhoto.findFirst({
      where: { id: photoId.toLowerCase(), characterId: heroId.toLowerCase(), character: { userId: session.userId } },
      select: { id: true, storageKey: true, character: { select: { soulStatus: true } } },
    });
    if (!photo) return jsonError(404, "NOT_FOUND", "Photo not found.");
    if (photo.character.soulStatus === "TRAINING") {
      return jsonError(409, "TRAINING", "Photos can't change while training runs.");
    }
    if (isStorageConfigured()) await deleteObject(photo.storageKey).catch(() => undefined);
    await prisma.characterPhoto.delete({ where: { id: photo.id } });
    return json({ deleted: true });
  } catch (err) {
    console.error("[soul-id] photo delete failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not delete the photo.");
  }
}
