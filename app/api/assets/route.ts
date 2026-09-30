import { NextResponse, type NextRequest } from "next/server";
import { assetUrl } from "@/lib/assets";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";

/**
 * GET /api/assets?kind=VIDEO|IMAGE&cursor=<assetId>&limit=24
 * The signed-in user's library, newest first, with short-lived playable links.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 48;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LibraryAsset {
  id: string;
  kind: "IMAGE" | "VIDEO";
  role: "RENDER" | "UPSCALE" | "IMAGE" | "UPLOAD";
  url: string | null;
  contentType: string;
  byteSize: number | null;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  clipId: string | null;
  createdAt: string;
}

interface LibraryResponse {
  assets: LibraryAsset[];
  nextCursor: string | null;
}

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest): Promise<NextResponse<LibraryResponse | { error: string; code: string }>> {
  const session = verifySession(req);
  if (!session.ok) return error(session.status, session.code, session.message);

  const params = req.nextUrl.searchParams;
  const kindParam = params.get("kind");
  const kind = kindParam === "VIDEO" || kindParam === "IMAGE" ? kindParam : undefined;
  const cursor = params.get("cursor");
  if (cursor && !UUID_PATTERN.test(cursor)) return error(400, "INVALID_CURSOR", "Malformed cursor.");
  const limitRaw = Number(params.get("limit") ?? 24);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : 24;

  try {
    const rows = await prisma.asset.findMany({
      where: { userId: session.userId, ...(kind ? { kind } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        kind: true,
        role: true,
        storageKey: true,
        contentType: true,
        byteSize: true,
        prompt: true,
        meta: true,
        clipId: true,
        createdAt: true,
      },
    });

    const page = rows.slice(0, limit);
    const assets: LibraryAsset[] = await Promise.all(
      page.map(async (a) => ({
        id: a.id,
        kind: a.kind,
        role: a.role,
        url: await assetUrl(a.storageKey),
        contentType: a.contentType,
        byteSize: a.byteSize !== null ? Number(a.byteSize) : null,
        prompt: a.prompt,
        meta: (a.meta as Record<string, unknown> | null) ?? null,
        clipId: a.clipId,
        createdAt: a.createdAt.toISOString(),
      })),
    );

    return NextResponse.json(
      { assets, nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[assets:GET] list failed:", err);
    return error(500, "DATABASE_ERROR", "Could not load the library.");
  }
}
