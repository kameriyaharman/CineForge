import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { archiveFromUrl, isStorageConfigured, presignGet } from "@/lib/storage";

/**
 * Asset library — copies finished renders into the CineForge bucket and hands
 * out short-lived links to them. Server only.
 */

type ClipRole = "RENDER" | "UPSCALE";

/**
 * Copies a clip's video (raw render or upscaled master) into the bucket and
 * records it as an Asset. Safe to call more than once: the (clip, role) pair is
 * unique, so a repeat call does nothing. Never throws — the provider URL keeps
 * working as a fallback if archiving fails.
 */
export async function archiveClipVideo(
  clipId: string,
  role: ClipRole,
  sourceUrl: string,
  /** Values that differ from the clip's render settings, e.g. the upscale resolution. */
  metaOverrides: Record<string, string | number> = {},
): Promise<void> {
  if (!isStorageConfigured()) {
    console.warn("[assets] DEV NOTICE: S3_* storage variables not set — keeping provider links only.");
    return;
  }

  try {
    const existing = await prisma.asset.findUnique({
      where: { clipId_role: { clipId, role } },
      select: { id: true },
    });
    if (existing) return;

    const clip = await prisma.videoClip.findUnique({
      where: { id: clipId },
      select: {
        prompt: true,
        cameraMovement: true,
        resolution: true,
        numFrames: true,
        aspectRatio: true,
        project: { select: { userId: true } },
        character: { select: { characterName: true } },
      },
    });
    if (!clip) return;

    const userId = clip.project.userId;
    const stamp = new Date().toISOString().slice(0, 10);
    const key = `users/${userId}/videos/${stamp}/${clipId}-${role.toLowerCase()}.mp4`;

    const started = Date.now();
    const stored = await archiveFromUrl(sourceUrl, key, "video/mp4");

    await prisma.asset.create({
      data: {
        userId,
        clipId,
        kind: "VIDEO",
        role,
        storageKey: key,
        contentType: stored.contentType,
        byteSize: stored.byteSize !== null ? BigInt(stored.byteSize) : null,
        sourceUrl,
        prompt: clip.prompt,
        meta: {
          cameraMovement: clip.cameraMovement,
          resolution: clip.resolution,
          numFrames: clip.numFrames,
          aspectRatio: clip.aspectRatio,
          characterName: clip.character?.characterName ?? null,
          ...metaOverrides,
        } satisfies Prisma.InputJsonObject,
      },
    });

    console.info(
      `[assets] clip ${clipId} ${role} archived`,
      JSON.stringify({ key, bytes: stored.byteSize, ms: Date.now() - started }),
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return; // raced; already archived
    console.error(`[assets] clip ${clipId} ${role} archive failed (provider link still works):`, err);
  }
}

/** Presigned link for an asset; null if storage is unavailable. */
export async function assetUrl(storageKey: string, downloadName?: string): Promise<string | null> {
  if (!isStorageConfigured()) return null;
  try {
    return await presignGet(storageKey, downloadName);
  } catch (err) {
    console.error(`[assets] presign failed for ${storageKey}:`, err);
    return null;
  }
}

/**
 * Copies finished clips from before the Asset Library existed (or whose copy
 * failed) into the bucket. Idempotent; runs in the background on server start.
 * Clips whose provider links have already expired are skipped with a log line.
 */
export async function backfillClipArchives(limit = 100): Promise<void> {
  if (!isStorageConfigured()) return;
  try {
    const clips = await prisma.videoClip.findMany({
      where: {
        rawVideoUrl: { not: null },
        status: { in: ["COMPLETED", "PROCESSING"] },
        assets: { none: { role: "RENDER" } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, rawVideoUrl: true, upscaledVideoUrl: true, assets: { select: { role: true } } },
    });
    const pendingUpscales = await prisma.videoClip.findMany({
      where: { upscaledVideoUrl: { not: null }, assets: { none: { role: "UPSCALE" } } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, upscaledVideoUrl: true },
    });
    if (clips.length === 0 && pendingUpscales.length === 0) return;

    console.info(
      `[assets] backfill: ${clips.length} render(s) and ${pendingUpscales.length} upscale(s) to copy into the library`,
    );
    for (const clip of clips) {
      if (clip.rawVideoUrl) await archiveClipVideo(clip.id, "RENDER", clip.rawVideoUrl);
    }
    for (const clip of pendingUpscales) {
      if (clip.upscaledVideoUrl) await archiveClipVideo(clip.id, "UPSCALE", clip.upscaledVideoUrl);
    }
    console.info("[assets] backfill finished");
  } catch (err) {
    console.error("[assets] backfill failed:", err);
  }
}
