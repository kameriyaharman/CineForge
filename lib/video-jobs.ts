import { archiveClipVideo } from "@/lib/assets";
import { prisma } from "@/lib/prisma";
import { getVideoModel, type VideoModelId } from "@/lib/video-models";

/**
 * Video Studio (image-to-video) jobs — server only.
 * Each run is a VideoClip with `model` set; Fal does the rendering.
 */

/** Renders still unfinished after this long are failed. */
export const I2V_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PROJECT_TITLE = "Studio Sessions";

export const I2V_ENDPOINTS: Record<VideoModelId, string> = {
  "veo31-lite": "fal-ai/veo3.1/lite/image-to-video",
  wan22: "fal-ai/wan/v2.2-a14b/image-to-video",
  "ltx2-fast": "fal-ai/ltx-2/image-to-video/fast",
  "kling3-std": "fal-ai/kling-video/v3/standard/image-to-video",
};

export interface I2VRequest {
  model: VideoModelId;
  imageUrl: string;
  prompt: string;
  durationSec: number;
  resolution: string | null;
  aspectRatio: string | null;
  withAudio: boolean;
  seed: number | null;
}

/** Fal input in each model's own schema (field names and value types differ). */
export function buildI2VInput(req: I2VRequest): Record<string, unknown> {
  const seed = req.seed ?? undefined;
  switch (req.model) {
    case "veo31-lite":
      return {
        prompt: req.prompt,
        image_url: req.imageUrl,
        duration: `${req.durationSec}s`,
        resolution: req.resolution ?? "720p",
        aspect_ratio: req.aspectRatio ?? "auto",
        generate_audio: req.withAudio,
        seed,
      };
    case "wan22":
      return {
        prompt: req.prompt,
        image_url: req.imageUrl,
        // 16 fps; 17–161 frames allowed.
        num_frames: Math.min(161, Math.max(17, Math.round(req.durationSec * 16) + 1)),
        frames_per_second: 16,
        resolution: req.resolution ?? "480p",
        aspect_ratio: req.aspectRatio ?? "auto",
        enable_safety_checker: true,
        seed,
      };
    case "ltx2-fast":
      return {
        prompt: req.prompt,
        image_url: req.imageUrl,
        duration: req.durationSec,
        resolution: req.resolution ?? "1080p",
        fps: 25,
        generate_audio: req.withAudio,
      };
    case "kling3-std":
      return {
        prompt: req.prompt || undefined,
        start_image_url: req.imageUrl,
        duration: String(req.durationSec),
        generate_audio: req.withAudio,
        negative_prompt: "blur, distort, and low quality",
        cfg_scale: 0.5,
      };
  }
}

/** The video URL from any of the models' outputs. */
export function videoUrlFrom(data: unknown): string | null {
  const url = (data as { video?: { url?: unknown } } | null)?.video?.url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/** The user's default project (created on first use). */
export async function defaultProjectId(userId: string): Promise<string> {
  const existing = await prisma.project.findFirst({
    where: { userId, title: DEFAULT_PROJECT_TITLE },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.project.create({
    data: { userId, title: DEFAULT_PROJECT_TITLE, description: "Clips rendered from the studio dashboard." },
    select: { id: true },
  });
  return created.id;
}

export async function markClipFailedIfRunning(clipId: string, message: string): Promise<void> {
  await prisma.videoClip
    .updateMany({ where: { id: clipId, status: "PROCESSING" }, data: { status: "FAILED", errorMessage: message } })
    .catch((err) => console.error(`[videos] could not mark ${clipId} failed:`, err));
}

/** Records the finished clip (first caller wins) and copies it into the Library. */
export async function finalizeI2VClip(clipId: string, videoUrl: string, seed: number | null): Promise<void> {
  const claimed = await prisma.videoClip.updateMany({
    where: { id: clipId, status: "PROCESSING", rawVideoUrl: null },
    data: {
      status: "COMPLETED",
      rawVideoUrl: videoUrl,
      ...(seed !== null && Number.isInteger(seed) && seed <= 2_147_483_647 ? { seed } : {}),
    },
  });
  if (claimed.count === 0) return;
  const clip = await prisma.videoClip.findUnique({
    where: { id: clipId },
    select: { model: true, durationSec: true, withAudio: true, sourceAssetId: true },
  });
  console.info(`[videos] clip ${clipId} completed (${clip?.model})`);
  await archiveClipVideo(clipId, "RENDER", videoUrl, clipMeta(clip));
}

export function clipMeta(
  clip: { model: string | null; durationSec: number | null; withAudio: boolean | null; sourceAssetId: string | null } | null,
): Record<string, string | number | boolean | null> {
  return {
    model: clip?.model ?? null,
    modelLabel: getVideoModel(clip?.model)?.label ?? null,
    durationSec: clip?.durationSec ?? null,
    withAudio: clip?.withAudio ?? null,
    sourceAssetId: clip?.sourceAssetId ?? null,
  };
}
