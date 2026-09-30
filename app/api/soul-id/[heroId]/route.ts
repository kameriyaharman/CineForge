import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import { deleteHeroFiles, loadHero, refreshTraining, toSoulHero } from "@/lib/soul-id";
import type { SoulPhoto } from "@/lib/soul-options";
import { isStorageConfigured, presignGet } from "@/lib/storage";

/**
 * GET    /api/soul-id/{heroId} — hero with photos; advances training if running
 * DELETE /api/soul-id/{heroId} — delete the hero and all its files
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ heroId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  const { heroId } = await params;
  if (!UUID_PATTERN.test(heroId)) return jsonError(400, "INVALID_ID", "Malformed hero id.");

  try {
    const row = await loadHero(heroId.toLowerCase(), session.userId);
    if (!row) return jsonError(404, "NOT_FOUND", "Hero not found.");
    const fresh = await refreshTraining(row);
    const photoRows = await prisma.characterPhoto.findMany({
      where: { characterId: fresh.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, storageKey: true, fileName: true },
    });
    const photos: SoulPhoto[] = await Promise.all(
      photoRows.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        url: isStorageConfigured() ? await presignGet(p.storageKey).catch(() => null) : null,
      })),
    );
    return json({ hero: await toSoulHero(fresh), photos });
  } catch (err) {
    console.error("[soul-id] detail failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load the hero.");
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  const { heroId } = await params;
  if (!UUID_PATTERN.test(heroId)) return jsonError(400, "INVALID_ID", "Malformed hero id.");

  try {
    const row = await loadHero(heroId.toLowerCase(), session.userId);
    if (!row) return jsonError(404, "NOT_FOUND", "Hero not found.");
    if (row.soulStatus === "TRAINING") {
      return jsonError(409, "TRAINING", "Wait for training to finish before deleting this hero.");
    }
    if (isStorageConfigured()) await deleteHeroFiles(row.userId, row.id, row.loraKey);
    await prisma.character.delete({ where: { id: row.id } });
    console.info(`[soul-id] hero ${row.id} deleted`);
    return json({ deleted: true });
  } catch (err) {
    console.error("[soul-id] delete failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not delete the hero.");
  }
}
