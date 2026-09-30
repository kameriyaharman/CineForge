import { ApiError, ValidationError } from "@fal-ai/client";
import { NextResponse, type NextRequest } from "next/server";
import {
  IMAGE_PROMPT_MAX,
  IMAGE_PROMPT_MIN,
  buildImagePrompt,
  getImageModel,
  getStylePreset,
  isImageAspectRatio,
  isImageCount,
  type ImageAspectRatio,
  type ImageModelId,
} from "@/lib/image-models";
import { buildFalInput, falEndpointFor, markGenerationFailed } from "@/lib/image-pipeline";
import { prisma } from "@/lib/prisma";
import { FalNotConfiguredError, getFal, isFalConfigured } from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";

/**
 * POST /api/images — start an Image Studio generation.
 *
 * Body: { prompt, model, aspectRatio, numImages, style, quality?, seed? }
 * Returns 202 { generationId, statusUrl }; the page then polls
 * GET /api/images/{generationId} until the images are ready.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SEED = 2_147_483_647;

function errorResponse(status: number, code: string, error: string, details?: unknown) {
  return NextResponse.json(
    { error, code, ...(details !== undefined ? { details } : {}) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

interface ParsedBody {
  prompt: string;
  model: ImageModelId;
  aspectRatio: ImageAspectRatio;
  numImages: number;
  styleId: string;
  quality: string | null;
  seed: number | null;
}

function parseBody(raw: unknown): { ok: true; body: ParsedBody } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, message: "Body must be a JSON object." };
  const b = raw as Record<string, unknown>;

  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (prompt.length < IMAGE_PROMPT_MIN) return { ok: false, message: "Describe the image you want." };
  if (prompt.length > IMAGE_PROMPT_MAX) {
    return { ok: false, message: `Prompt must be under ${IMAGE_PROMPT_MAX} characters.` };
  }

  const model = getImageModel(b.model);
  if (!model) return { ok: false, message: "Unknown image model." };

  if (!isImageAspectRatio(b.aspectRatio) || !model.aspects.includes(b.aspectRatio)) {
    return { ok: false, message: `${model.label} does not support that aspect ratio.` };
  }
  if (!isImageCount(b.numImages)) return { ok: false, message: "Number of images must be 1–4." };

  const style = getStylePreset(b.style ?? "none");
  if (!style) return { ok: false, message: "Unknown style preset." };

  let quality: string | null = null;
  if (model.qualities) {
    const picked = model.qualities.find((q) => q.value === b.quality);
    if (b.quality !== undefined && b.quality !== null && !picked) {
      return { ok: false, message: `${model.label} does not offer that size.` };
    }
    quality = picked?.value ?? model.qualities[0]?.value ?? null;
  }

  let seed: number | null = null;
  if (b.seed !== undefined && b.seed !== null && b.seed !== "") {
    const n = typeof b.seed === "string" ? Number(b.seed) : b.seed;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_SEED) {
      return { ok: false, message: `Seed must be a whole number from 0 to ${MAX_SEED}.` };
    }
    seed = n;
  }

  return {
    ok: true,
    body: {
      prompt,
      model: model.id as ImageModelId,
      aspectRatio: b.aspectRatio,
      numImages: b.numImages,
      styleId: style.id,
      quality,
      seed,
    },
  };
}

export async function POST(req: NextRequest) {
  if (!isFalConfigured()) {
    return errorResponse(500, "SERVER_MISCONFIGURED", "Image engine is not configured (FAL_KEY).");
  }

  const session = verifySession(req);
  if (!session.ok) return errorResponse(session.status, session.code, session.message);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return errorResponse(400, "INVALID_BODY", parsed.message);
  const body = parsed.body;
  const finalPrompt = buildImagePrompt(body.prompt, getStylePreset(body.styleId));

  let generationId: string;
  try {
    // The owner row exists once they've signed in; make sure in dev too.
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true } });
    if (!user) return errorResponse(404, "USER_NOT_FOUND", "Signed-in user no longer exists.");

    const row = await prisma.imageGeneration.create({
      data: {
        userId: session.userId,
        model: body.model,
        prompt: body.prompt,
        finalPrompt,
        stylePreset: body.styleId,
        aspectRatio: body.aspectRatio,
        quality: body.quality,
        numImages: body.numImages,
        seed: body.seed,
        status: "PROCESSING",
      },
      select: { id: true },
    });
    generationId = row.id;
  } catch (err) {
    console.error("[images] could not create generation:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not start the generation.");
  }

  const endpoint = falEndpointFor(body.model);
  const input = buildFalInput({
    model: body.model,
    prompt: finalPrompt,
    aspectRatio: body.aspectRatio,
    numImages: body.numImages,
    quality: body.quality,
    seed: body.seed,
  });

  try {
    const { request_id: requestId } = await getFal().queue.submit(endpoint, { input });
    await prisma.imageGeneration.update({ where: { id: generationId }, data: { providerRequestId: requestId } });
    console.info(
      `[images] generation ${generationId} submitted as Fal ${requestId} · ${body.model} · ${body.aspectRatio} · x${body.numImages}${body.quality ? ` · ${body.quality}` : ""} · style=${body.styleId}`,
    );
    return NextResponse.json(
      { generationId, status: "IN_QUEUE", statusUrl: `/api/images/${generationId}`, finalPrompt },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof FalNotConfiguredError) {
      await markGenerationFailed(generationId, "FAL_KEY is not set.");
      return errorResponse(500, "SERVER_MISCONFIGURED", "Image engine is not configured.");
    }
    if (err instanceof ValidationError) {
      await markGenerationFailed(generationId, `Provider validation failed: ${JSON.stringify(err.fieldErrors)}`);
      return errorResponse(422, "PROVIDER_VALIDATION_FAILED", "The image model rejected these settings.", err.fieldErrors);
    }
    if (err instanceof ApiError) {
      console.error(`[images] Fal submit error ${err.status}:`, err.body);
      await markGenerationFailed(generationId, `Fal submit error ${err.status}.`);
      switch (err.status) {
        case 401:
        case 403:
          return errorResponse(502, "PROVIDER_AUTH_FAILED", "Fal rejected the API key.");
        case 402:
          return errorResponse(402, "PROVIDER_PAYMENT_REQUIRED", "The Fal account has no credit. Top up at fal.ai and retry.");
        case 429:
          return errorResponse(429, "PROVIDER_RATE_LIMITED", "Too many generations at once. Try again shortly.");
        default:
          return errorResponse(502, "PROVIDER_ERROR", "The image model returned an error.");
      }
    }
    console.error("[images] Unexpected submit error:", err);
    await markGenerationFailed(generationId, err instanceof Error ? err.message : "Unexpected error.");
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}
