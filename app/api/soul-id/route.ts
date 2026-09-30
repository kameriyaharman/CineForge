import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { Prisma } from "@/lib/generated/prisma/client";
import { json, jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import { heroSelect, refreshTraining, toSoulHero } from "@/lib/soul-id";
import { SOUL_NAME_MAX } from "@/lib/soul-options";

/**
 * GET  /api/soul-id — the signed-in user's heroes, newest first (advances any training)
 * POST /api/soul-id — { name } → create an empty hero to add photos to
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  try {
    const rows = await prisma.character.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "desc" },
      select: heroSelect,
      take: 100,
    });
    const fresh = await Promise.all(rows.map((r) => refreshTraining(r)));
    return json({ heroes: await Promise.all(fresh.map(toSoulHero)) });
  } catch (err) {
    console.error("[soul-id] list failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load your heroes.");
  }
}

export async function POST(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const name = typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name.trim() : "";
  if (name.length < 2) return jsonError(400, "INVALID_NAME", "Give the hero a name (at least 2 characters).");
  if (name.length > SOUL_NAME_MAX) return jsonError(400, "INVALID_NAME", `Keep the name under ${SOUL_NAME_MAX} characters.`);

  try {
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true } });
    if (!user) return jsonError(404, "USER_NOT_FOUND", "Signed-in user no longer exists.");
    const id = randomUUID();
    const row = await prisma.character.create({
      data: {
        id,
        userId: session.userId,
        characterName: name,
        // Same-origin link that always points at the current first photo.
        referenceImageUrl: `/api/soul-id/${id}/cover`,
        referenceImageMeta: { source: "soul-id-upload" },
      },
      select: heroSelect,
    });
    return json({ hero: await toSoulHero(row) }, 201);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return jsonError(409, "NAME_TAKEN", "You already have a hero with that name.");
    }
    console.error("[soul-id] create failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not create the hero.");
  }
}
