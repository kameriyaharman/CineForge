import { NextResponse, type NextRequest } from "next/server";
import { UUID_PATTERN, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import { isStorageConfigured, presignGet } from "@/lib/storage";

/** GET /api/soul-id/{heroId}/cover — redirects to the hero's first photo. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ heroId: string }> }) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  const { heroId } = await params;
  if (!UUID_PATTERN.test(heroId)) return jsonError(400, "INVALID_ID", "Malformed hero id.");
  if (!isStorageConfigured()) return jsonError(404, "NO_COVER", "No photo yet.");

  const photo = await prisma.characterPhoto.findFirst({
    where: { characterId: heroId.toLowerCase(), character: { userId: session.userId } },
    orderBy: { createdAt: "asc" },
    select: { storageKey: true },
  });
  if (!photo) return jsonError(404, "NO_COVER", "No photo yet.");
  const url = await presignGet(photo.storageKey);
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, max-age=600" } });
}
