import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getEditTool } from "@/lib/edit-tools";
import { getImageModel, getStylePreset } from "@/lib/image-models";
import type { GeneratedImage } from "@/lib/image-pipeline";
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
  metaOverrides: Record<string, string | number | boolean | null> = {},
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

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

/**
 * Copies every image of an Image Studio generation into the bucket and records
 * each as an IMAGE asset. Idempotent per image (the storage key is unique).
 * Never throws — the page falls back to the provider links.
 */
export async function archiveGenerationImages(generationId: string, images: GeneratedImage[]): Promise<void> {
  if (!isStorageConfigured()) {
    console.warn("[assets] DEV NOTICE: S3_* storage variables not set — keeping provider links only.");
    return;
  }
  try {
    const gen = await prisma.imageGeneration.findUnique({
      where: { id: generationId },
      select: {
        userId: true,
        prompt: true,
        model: true,
        stylePreset: true,
        aspectRatio: true,
        quality: true,
        seed: true,
        loraScale: true,
        createdAt: true,
        characterId: true,
        sourceAssetId: true,
        character: { select: { characterName: true } },
      },
    });
    if (!gen) return;
    const stamp = gen.createdAt.toISOString().slice(0, 10);
    const model = getImageModel(gen.model) ?? getEditTool(gen.model);
    const style = getStylePreset(gen.stylePreset);

    await Promise.all(
      images.map(async (image, index) => {
        const ext = IMAGE_EXTENSIONS[image.contentType.toLowerCase()] ?? "png";
        const key = `users/${gen.userId}/images/${stamp}/${generationId}-${index + 1}.${ext}`;
        try {
          const existing = await prisma.asset.findUnique({ where: { storageKey: key }, select: { id: true } });
          if (existing) return;
          const stored = await archiveFromUrl(image.url, key, image.contentType);
          await prisma.asset.create({
            data: {
              userId: gen.userId,
              generationId,
              kind: "IMAGE",
              role: "IMAGE",
              storageKey: key,
              contentType: stored.contentType,
              byteSize: stored.byteSize !== null ? BigInt(stored.byteSize) : null,
              sourceUrl: image.url,
              prompt: gen.prompt,
              meta: {
                model: gen.model,
                modelLabel: model?.label ?? gen.model,
                style: style && style.id !== "none" ? style.label : null,
                aspectRatio: gen.aspectRatio,
                quality: gen.quality,
                width: image.width,
                height: image.height,
                seed: gen.seed,
                index: index + 1,
                characterName: gen.character?.characterName ?? null,
                characterId: gen.characterId,
                editOf: gen.sourceAssetId,
                tool: gen.sourceAssetId ? gen.model : null,
                likeness: gen.loraScale,
              } satisfies Prisma.InputJsonObject,
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
          console.error(`[assets] image ${index + 1} of generation ${generationId} archive failed:`, err);
        }
      }),
    );
    console.info(`[assets] generation ${generationId}: ${images.length} image(s) archived`);
  } catch (err) {
    console.error(`[assets] generation ${generationId} archive failed:`, err);
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
