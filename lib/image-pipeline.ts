import { archiveGenerationImages } from "@/lib/assets";
import { Prisma } from "@/lib/generated/prisma/client";
import type { EditToolId } from "@/lib/edit-tools";
import type { ImageAspectRatio, ImageModelId } from "@/lib/image-models";
import { prisma } from "@/lib/prisma";
import { getFal } from "@/lib/render-pipeline";
import { createPrediction, encodeReplicateIds } from "@/lib/replicate";

/**
 * Image Studio pipeline — server only.
 * Maps a CineForge model id to its Fal endpoint and input shape, and finalises
 * finished generations (records outputs, copies images into the Library).
 */

/** A generation still unfinished after this long is cancelled. */
export const IMAGE_TIMEOUT_MS = 10 * 60 * 1000;

/** A text-to-image model or an edit tool — both run as an ImageGeneration. */
export type JobModel = ImageModelId | EditToolId;
export type Provider = "fal" | "replicate";

export interface ImageRequest {
  model: JobModel;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  numImages: number;
  quality: string | null;
  seed: number | null;
  /** Soul ID LoRA (required for the Soul ID model). */
  lora?: { url: string; scale: number };
  /** Edits: short-lived link to the source image. */
  sourceUrl?: string;
}

const KLEIN_REPLICATE = "black-forest-labs/flux-2-klein-4b";

export function providerFor(model: JobModel): Provider {
  return model === "flux-2-klein" || model === "edit-klein" ? "replicate" : "fal";
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

/** FLUX + LoRA is billed per megapixel, rounded up, so sizes stay just under 1 MP / 2 MP. */
const SOUL_SIZES: Record<"standard" | "hd", Record<ImageAspectRatio, Size>> = {
  standard: {
    "16:9": { width: 1312, height: 736 },
    "21:9": { width: 1504, height: 640 },
    "4:3": { width: 1152, height: 864 },
    "1:1": { width: 992, height: 992 },
    "3:4": { width: 864, height: 1152 },
    "9:16": { width: 736, height: 1312 },
  },
  hd: {
    "16:9": { width: 1888, height: 1056 },
    "21:9": { width: 2144, height: 912 },
    "4:3": { width: 1632, height: 1216 },
    "1:1": { width: 1408, height: 1408 },
    "3:4": { width: 1216, height: 1632 },
    "9:16": { width: 1056, height: 1888 },
  },
};

export function falEndpointFor(model: JobModel): string {
  switch (model) {
    case "flux-2-klein":
    case "edit-klein":
      throw new Error(`${model} runs on Replicate, not Fal.`);
    case "edit-nano":
      return "fal-ai/nano-banana-pro/edit";
    case "upscale":
      return "fal-ai/seedvr/upscale/image";
    case "remove-bg":
      return "fal-ai/birefnet/v2";
    case "flux-2-flash":
      return "fal-ai/flux-2/flash";
    case "flux-pro-ultra":
      return "fal-ai/flux-pro/v1.1-ultra";
    case "seedream-4.5":
      return "fal-ai/bytedance/seedream/v4.5/text-to-image";
    case "nano-banana-pro":
      return "fal-ai/nano-banana-pro";
    case "flux-lora-soul":
      return "fal-ai/flux-lora";
  }
}

/** Builds the Fal input for each model's own schema. */
export function buildFalInput(req: ImageRequest): Record<string, unknown> {
  const seed = req.seed ?? undefined;
  switch (req.model) {
    case "flux-2-klein":
    case "edit-klein":
      throw new Error(`${req.model} runs on Replicate.`);
    case "edit-nano":
      if (!req.sourceUrl) throw new Error("Edit needs a source image.");
      return {
        prompt: req.prompt,
        image_urls: [req.sourceUrl],
        aspect_ratio: "auto",
        resolution: req.quality ?? "1K",
        num_images: 1,
        output_format: "png",
        seed,
      };
    case "upscale":
      if (!req.sourceUrl) throw new Error("Upscale needs a source image.");
      return {
        image_url: req.sourceUrl,
        upscale_mode: "factor",
        upscale_factor: req.quality === "4" ? 4 : 2,
        output_format: "jpg",
        seed,
      };
    case "remove-bg":
      if (!req.sourceUrl) throw new Error("Background removal needs a source image.");
      return {
        image_url: req.sourceUrl,
        model: req.quality === "portrait" ? "Portrait" : "General Use (Heavy)",
        operating_resolution: "2048x2048",
        output_format: "png",
        refine_foreground: true,
      };
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
    case "flux-lora-soul": {
      if (!req.lora) throw new Error("Soul ID model needs a trained LoRA.");
      const tier = req.quality === "hd" ? "hd" : "standard";
      return {
        prompt: req.prompt,
        image_size: SOUL_SIZES[tier][req.aspectRatio],
        loras: [{ path: req.lora.url, scale: req.lora.scale }],
        num_images: req.numImages,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        output_format: "jpeg",
        enable_safety_checker: true,
        seed,
      };
    }
  }
}

/** One Replicate input per image (Klein makes one image per prediction). */
export function buildReplicateInputs(req: ImageRequest): Record<string, unknown>[] {
  const base: Record<string, unknown> =
    req.model === "edit-klein"
      ? {
          prompt: req.prompt,
          images: req.sourceUrl ? [req.sourceUrl] : [],
          aspect_ratio: "match_input_image",
          output_megapixels: req.quality ?? "1",
          output_format: "jpg",
          output_quality: 90,
        }
      : {
          prompt: req.prompt,
          aspect_ratio: req.aspectRatio,
          output_megapixels: req.quality ?? "1",
          output_format: "jpg",
          output_quality: 90,
        };
  return Array.from({ length: Math.max(1, req.numImages) }, (_, i) => ({
    ...base,
    // Distinct seeds keep variations different; a fixed seed stays reproducible.
    ...(req.seed !== null ? { seed: req.seed + i } : {}),
  }));
}

/**
 * Sends the job to its provider and returns the id stored as
 * ImageGeneration.providerRequestId (Fal request id, or "rep:id1,id2").
 */
export async function submitToProvider(req: ImageRequest): Promise<string> {
  if (providerFor(req.model) === "replicate") {
    const ids: string[] = [];
    for (const input of buildReplicateInputs(req)) {
      const prediction = await createPrediction(KLEIN_REPLICATE, input);
      ids.push(prediction.id);
    }
    return encodeReplicateIds(ids);
  }
  const { request_id } = await getFal().queue.submit(falEndpointFor(req.model), { input: buildFalInput(req) });
  return request_id;
}

/** Turns Replicate output URLs into GeneratedImage records. */
export function replicateImages(urls: string[]): GeneratedImage[] {
  return urls
    .filter((u) => u.startsWith("https://"))
    .map((url) => {
      const ext = url.split("?")[0]!.split(".").pop()?.toLowerCase();
      const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return { url, width: null, height: null, contentType };
    });
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
  // Most models return `images: [...]`; upscale / background removal return `image`.
  const list = Array.isArray(record.images) ? record.images : record.image ? [record.image] : [];
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
