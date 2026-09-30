import { ApiError } from "@fal-ai/client";
import { NextResponse, type NextRequest } from "next/server";
import { assetUrl } from "@/lib/assets";
import { getImageModel } from "@/lib/image-models";
import {
  IMAGE_TIMEOUT_MS,
  falEndpointFor,
  finalizeGeneration,
  markGenerationFailed,
  parseImageOutput,
  type GeneratedImage,
} from "@/lib/image-pipeline";
import { isTestRequest } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { TEST_IMAGE_DELAY_MS, finalizeTestGeneration } from "@/lib/test-mode";
import { FalNotConfiguredError, getFal } from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";

/**
 * GET    /api/images/{generationId} — progress; finalises when Fal is done
 * DELETE /api/images/{generationId} — cancel an unfinished generation
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Phase = "IN_QUEUE" | "GENERATING" | "COMPLETED" | "FAILED";

interface StudioImage {
  url: string;
  width: number | null;
  height: number | null;
  /** Library asset id once the image is saved to the bucket. */
  assetId: string | null;
}

interface GenerationStatus {
  generationId: string;
  status: Phase;
  queuePosition?: number;
  images: StudioImage[];
  requested: number;
  model: string;
  modelLabel: string;
  aspectRatio: string;
  quality: string | null;
  seed: number | null;
  error?: string;
  /** e.g. some images were blocked by the model's safety filter. */
  note?: string;
}

const select = {
  id: true,
  model: true,
  status: true,
  aspectRatio: true,
  quality: true,
  numImages: true,
  seed: true,
  providerRequestId: true,
  outputs: true,
  errorMessage: true,
  createdAt: true,
  assets: {
    where: { kind: "IMAGE" as const },
    select: { id: true, storageKey: true, meta: true },
    orderBy: { storageKey: "asc" as const },
  },
} as const;

async function load(id: string, userId?: string) {
  return prisma.imageGeneration.findFirst({ where: { id, ...(userId ? { userId } : {}) }, select });
}
type Generation = NonNullable<Awaited<ReturnType<typeof load>>>;

function errorResponse(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

function storedOutputs(gen: Generation): GeneratedImage[] {
  return Array.isArray(gen.outputs) ? (gen.outputs as unknown as GeneratedImage[]) : [];
}

function metaNumber(meta: unknown, key: string): number | null {
  if (typeof meta !== "object" || meta === null) return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

/** Library copies when saved; otherwise the provider links. */
async function imagesFor(gen: Generation): Promise<StudioImage[]> {
  if (gen.assets.length > 0) {
    const archived = await Promise.all(
      gen.assets.map(async (a): Promise<StudioImage | null> => {
        const url = await assetUrl(a.storageKey);
        return url
          ? { url, width: metaNumber(a.meta, "width"), height: metaNumber(a.meta, "height"), assetId: a.id }
          : null;
      }),
    );
    const ok = archived.filter((x): x is StudioImage => x !== null);
    if (ok.length === gen.assets.length && ok.length >= storedOutputs(gen).length) return ok;
  }
  return storedOutputs(gen).map((o) => ({ url: o.url, width: o.width, height: o.height, assetId: null }));
}

async function respond(gen: Generation, overrides: Partial<GenerationStatus> = {}) {
  const images = gen.status === "COMPLETED" ? await imagesFor(gen) : [];
  const phase: Phase = gen.status === "COMPLETED" ? "COMPLETED" : gen.status === "FAILED" ? "FAILED" : "GENERATING";
  const body: GenerationStatus = {
    generationId: gen.id,
    status: phase,
    images,
    requested: gen.numImages,
    model: gen.model,
    modelLabel: getImageModel(gen.model)?.label ?? gen.model,
    aspectRatio: gen.aspectRatio,
    quality: gen.quality,
    seed: gen.seed,
    ...(gen.status === "FAILED" ? { error: gen.errorMessage ?? "The generation failed." } : {}),
    ...(gen.status === "COMPLETED" && images.length < gen.numImages
      ? { note: `${gen.numImages - images.length} image(s) were blocked by the model's safety filter.` }
      : {}),
    ...overrides,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

async function resolve(req: NextRequest, params: Promise<{ generationId: string }>) {
  const session = verifySession(req);
  if (!session.ok) return { response: errorResponse(session.status, session.code, session.message) };
  const { generationId } = await params;
  if (!UUID_PATTERN.test(generationId)) {
    return { response: errorResponse(400, "INVALID_ID", "Malformed generation id.") };
  }
  const gen = await load(generationId.toLowerCase(), session.userId);
  if (!gen) return { response: errorResponse(404, "NOT_FOUND", "Generation not found.") };
  return { gen };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ generationId: string }> }) {
  let gen: Generation;
  try {
    const r = await resolve(req, params);
    if ("response" in r) return r.response;
    gen = r.gen;
  } catch (err) {
    console.error("[images] lookup failed:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not load the generation.");
  }

  if (gen.status !== "PROCESSING") return respond(gen);

  const ageMs = Date.now() - gen.createdAt.getTime();
  const requestId = gen.providerRequestId;
  const endpoint = falEndpointFor(gen.model as Parameters<typeof falEndpointFor>[0]);

  // Test Mode: finish with sample images after a short, visible wait.
  if (isTestRequest(requestId)) {
    if (ageMs < TEST_IMAGE_DELAY_MS) return respond(gen, { status: "GENERATING" });
    await finalizeTestGeneration(gen.id);
    return respond((await load(gen.id)) ?? gen);
  }

  if (!requestId) {
    if (ageMs > 2 * 60 * 1000) {
      await markGenerationFailed(gen.id, "The generation was never submitted to Fal.");
      return respond((await load(gen.id)) ?? gen);
    }
    return respond(gen, { status: "IN_QUEUE" });
  }

  try {
    const fal = getFal();
    const status = await fal.queue.status(endpoint, { requestId, logs: false });

    if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS") {
      if (ageMs > IMAGE_TIMEOUT_MS) {
        await fal.queue.cancel(endpoint, { requestId }).catch(() => undefined);
        await markGenerationFailed(gen.id, "The image model took over 10 minutes, so the job was cancelled.");
        return respond((await load(gen.id)) ?? gen);
      }
      return status.status === "IN_QUEUE"
        ? respond(gen, { status: "IN_QUEUE", queuePosition: status.queue_position })
        : respond(gen, { status: "GENERATING" });
    }

    let output: unknown;
    try {
      output = (await fal.queue.result(endpoint, { requestId })).data;
    } catch (err) {
      console.error(`[images] generation ${gen.id} result error:`, err instanceof ApiError ? err.body : err);
      const detail =
        err instanceof ApiError && err.status === 422
          ? "The model rejected the prompt (it may have tripped a content filter)."
          : "The image model reported an error.";
      await markGenerationFailed(gen.id, detail);
      return respond((await load(gen.id)) ?? gen);
    }

    const { images, seed } = parseImageOutput(output);
    if (images.length === 0) {
      console.error(`[images] generation ${gen.id} returned no usable images:`, output);
      await markGenerationFailed(gen.id, "No images came back — they may have been blocked by the safety filter.");
      return respond((await load(gen.id)) ?? gen);
    }

    await finalizeGeneration(gen.id, images, seed);
    return respond((await load(gen.id)) ?? gen);
  } catch (err) {
    if (err instanceof FalNotConfiguredError) {
      return errorResponse(500, "SERVER_MISCONFIGURED", "Image engine is not configured.");
    }
    if (err instanceof ApiError) {
      console.error(`[images] Fal status error ${err.status}:`, err.body);
      if (err.status === 404) {
        await markGenerationFailed(gen.id, "Fal no longer knows this job.");
        return respond((await load(gen.id)) ?? gen);
      }
      return errorResponse(502, "PROVIDER_ERROR", "Could not reach the image model. Retrying…");
    }
    console.error("[images] unexpected status error:", err);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ generationId: string }> }) {
  let gen: Generation;
  try {
    const r = await resolve(req, params);
    if ("response" in r) return r.response;
    gen = r.gen;
  } catch (err) {
    console.error("[images] lookup failed:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not load the generation.");
  }
  if (gen.status !== "PROCESSING") return respond(gen);
  if (gen.providerRequestId && !isTestRequest(gen.providerRequestId)) {
    const endpoint = falEndpointFor(gen.model as Parameters<typeof falEndpointFor>[0]);
    await getFal()
      .queue.cancel(endpoint, { requestId: gen.providerRequestId })
      .catch((err) => console.warn(`[images] cancel failed for ${gen.id}:`, err));
  }
  await markGenerationFailed(gen.id, "Cancelled by user.");
  return respond((await load(gen.id)) ?? gen);
}
