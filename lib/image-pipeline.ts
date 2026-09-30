import { archiveGenerationImages } from "@/lib/assets";
import { Prisma } from "@/lib/generated/prisma/client";
import type { ImageAspectRatio, ImageModelId } from "@/lib/image-models";
import { prisma } from "@/lib/prisma";

/**
 * Image Studio pipeline — server only.
 * Maps a CineForge model id to its Fal endpoint and input shape, and finalises
 * finished generations (records outputs, copies images into the Library).
 */

/** A generation still unfinished after this long is cancelled. */
export const IMAGE_TIMEOUT_MS = 10 * 60 * 1000;

export interface ImageRequest {
  model: ImageModelId;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  numImages: number;
  quality: string | null;
  seed: number | null;
}

type Size = { width: number; height: number };

/** FLUX.2 Flash: custom sizes 512–2048 px; multiples of 16 keep FLUX happy. */
const FLUX2_SIZES: Record<ImageAspectRatio, Size> = {
  "16:9": { width: 1920, height: 1088 },
  "21:9": { width: 2016, height: 864 },
  "4:3": { width: 1600, height: 1200 },
  "1:1": { width: 1440, height: 1440 },
  "3:4": { width: 1200, height: 1600 },
  "9:16": { width: 1088, height: 1920 },
};

/** Seedream 4.5: total pixels must be between 2560×1440 and 4096×4096. */
const SEEDREAM_SIZES: Record<ImageAspectRatio, Size> = {
  "16:9": { width: 2560, height: 1440 },
  "21:9": { width: 3024, height: 1296 },
  "4:3": { width: 2400, height: 1800 },
  "1:1": { width: 2048, height: 2048 },
  "3:4": { width: 1800, height: 2400 },
  "9:16": { width: 1440, height: 2560 },
};

export function falEndpointFor(model: ImageModelId): string {
  switch (model) {
    case "flux-2-flash":
      return "fal-ai/flux-2/flash";
    case "flux-pro-ultra":
      return "fal-ai/flux-pro/v1.1-ultra";
    case "seedream-4.5":
      return "fal-ai/bytedance/seedream/v4.5/text-to-image";
    case "nano-banana-pro":
      return "fal-ai/nano-banana-pro";
  }
}

/** Builds the Fal input for each model's own schema. */
export function buildFalInput(req: ImageRequest): Record<string, unknown> {
  const seed = req.seed ?? undefined;
  switch (req.model) {
    case "flux-2-flash":
      return {
        prompt: req.prompt,
        image_size: FLUX2_SIZES[req.aspectRatio],
        num_images: req.numImages,
        output_format: "png",
        enable_safety_checker: true,
        seed,
      };
    case "flux-pro-ultra":
      return {
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        num_images: req.numImages,
        output_format: "jpeg",
        safety_tolerance: "2",
        seed,
      };
    case "seedream-4.5":
      return {
        prompt: req.prompt,
        image_size: SEEDREAM_SIZES[req.aspectRatio],
        num_images: req.numImages,
        max_images: 1,
        enable_safety_checker: true,
        seed,
      };
    case "nano-banana-pro":
      return {
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        resolution: req.quality ?? "1K",
        num_images: req.numImages,
        output_format: "png",
        seed,
      };
  }
}

export interface GeneratedImage {
  url: string;
  width: number | null;
  height: number | null;
  contentType: string;
}

/** Pulls the image list out of any of the models' outputs. */
export function parseImageOutput(data: unknown): { images: GeneratedImage[]; seed: number | null } {
  if (typeof data !== "object" || data === null) return { images: [], seed: null };
  const record = data as Record<string, unknown>;
  const list = Array.isArray(record.images) ? record.images : [];
  const nsfw = Array.isArray(record.has_nsfw_concepts) ? record.has_nsfw_concepts : [];
  const images: GeneratedImage[] = [];
  list.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const img = item as Record<string, unknown>;
    if (typeof img.url !== "string" || !img.url.startsWith("https://")) return;
    if (nsfw[index] === true) return; // blocked by the provider's safety filter (usually a black frame)
    images.push({
      url: img.url,
      width: typeof img.width === "number" ? img.width : null,
      height: typeof img.height === "number" ? img.height : null,
      contentType: typeof img.content_type === "string" ? img.content_type : "image/png",
    });
  });
  const seed = typeof record.seed === "number" && Number.isInteger(record.seed) ? record.seed : null;
  return { images, seed };
}

export async function markGenerationFailed(id: string, message: string): Promise<void> {
  await prisma.imageGeneration
    .updateMany({ where: { id, status: "PROCESSING" }, data: { status: "FAILED", errorMessage: message } })
    .catch((err) => console.error(`[images] could not mark ${id} failed:`, err));
}

/**
 * Records a finished generation and copies its images into the Library.
 * Only the first caller to finish claims it, so parallel polls don't double-archive.
 */
export async function finalizeGeneration(
  id: string,
  images: GeneratedImage[],
  seed: number | null,
): Promise<void> {
  const claimed = await prisma.imageGeneration.updateMany({
    where: { id, status: "PROCESSING" },
    data: {
      status: "COMPLETED",
      outputs: images as unknown as Prisma.InputJsonArray,
      ...(seed !== null && seed <= 2_147_483_647 ? { seed } : {}),
    },
  });
  if (claimed.count === 0) return;
  console.info(`[images] generation ${id} completed with ${images.length} image(s)`);
  await archiveGenerationImages(id, images);
}
