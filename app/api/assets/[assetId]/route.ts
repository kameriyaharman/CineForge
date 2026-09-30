import { NextResponse, type NextRequest } from "next/server";
import { assetUrl } from "@/lib/assets";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";
import { deleteObject } from "@/lib/storage";

/**
 * GET    /api/assets/{id}            → redirects to a short-lived link (?download=1 saves the file)
 * DELETE /api/assets/{id}            → removes the file from the bucket and the library
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

async function loadOwned(req: NextRequest, params: Promise<{ assetId: string }>) {
  const session = verifySession(req);
  if (!session.ok) return { response: error(session.status, session.code, session.message) } as const;
  const { assetId } = await params;
  if (!UUID_PATTERN.test(assetId)) return { response: error(400, "INVALID_ASSET_ID", "Malformed asset id.") } as const;
  const asset = await prisma.asset.findFirst({
    where: { id: assetId.toLowerCase(), userId: session.userId },
    select: { id: true, storageKey: true, kind: true, contentType: true, createdAt: true },
  });
  if (!asset) return { response: error(404, "ASSET_NOT_FOUND", "File not found.") } as const;
  return { asset } as const;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const loaded = await loadOwned(req, params);
    if ("response" in loaded) return loaded.response;
    const { asset } = loaded;
    const download = req.nextUrl.searchParams.get("download") === "1";
    const ext = asset.storageKey.split(".").pop() ?? (asset.kind === "VIDEO" ? "mp4" : "png");
    const name = `cineforge-${asset.createdAt.toISOString().slice(0, 10)}-${asset.id.slice(0, 8)}.${ext}`;
    const url = await assetUrl(asset.storageKey, download ? name : undefined);
    if (!url) return error(503, "STORAGE_UNAVAILABLE", "Storage is unavailable.");
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[assets:GET one] failed:", err);
    return error(500, "INTERNAL_ERROR", "Could not open the file.");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const loaded = await loadOwned(req, params);
    if ("response" in loaded) return loaded.response;
    const { asset } = loaded;
    await deleteObject(asset.storageKey).catch((err: unknown) =>
      console.warn(`[assets:DELETE] bucket delete failed for ${asset.storageKey}:`, err),
    );
    await prisma.asset.delete({ where: { id: asset.id } });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[assets:DELETE] failed:", err);
    return error(500, "INTERNAL_ERROR", "Could not delete the file.");
  }
}
