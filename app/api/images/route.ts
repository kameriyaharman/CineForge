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
import { markGenerationFailed, providerFor, submitToProvider } from "@/lib/image-pipeline";
import { handleSubmitError } from "@/lib/job-errors";
import { isReplicateConfigured } from "@/lib/replicate";
import { prisma } from "@/lib/prisma";
import { isFalConfigured } from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";
import { loraLinkFor } from "@/lib/soul-id";
import {
  SpendLimitError,
  TEST_PREFIX,
  assertWithinLimit,
  estimateImageCost,
  isTestMode,
  recordSpend,
} from "@/lib/billing";
import { TEST_LORA_KEY } from "@/lib/test-mode";
import { isSoulLikeness } from "@/lib/soul-options";

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
  characterId: string | null;
  likeness: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  let characterId: string | null = null;
  if (b.characterId !== undefined && b.characterId !== null && b.characterId !== "") {
    if (typeof b.characterId !== "string" || !UUID_RE.test(b.characterId)) {
      return { ok: false, message: "Malformed Soul ID hero id." };
    }
    characterId = b.characterId.toLowerCase();
  }
  if (model.soul && !characterId) return { ok: false, message: "Pick a Soul ID hero for this model." };
  if (!model.soul && characterId) return { ok: false, message: "Soul ID heroes work with the FLUX Soul ID model only." };

  let likeness = 1.0;
  if (b.likeness !== undefined && b.likeness !== null) {
    if (!isSoulLikeness(b.likeness)) return { ok: false, message: "Likeness must be Loose, Balanced or Strong." };
    likeness = b.likeness;
  }

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
      characterId,
      likeness,
    },
  };
}

export async function POST(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return errorResponse(session.status, session.code, session.message);

  let testMode: boolean;
  try {
    testMode = await isTestMode(session.userId);
  } catch (err) {
    console.error("[images] could not read account:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not load your account.");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return errorResponse(400, "INVALID_BODY", parsed.message);
  const body = parsed.body;
  if (!testMode) {
    const provider = providerFor(body.model);
    if (provider === "fal" && !isFalConfigured()) {
      return errorResponse(500, "SERVER_MISCONFIGURED", "Image engine is not configured (FAL_KEY).");
    }
    if (provider === "replicate" && !isReplicateConfigured()) {
      return errorResponse(
        500,
        "REPLICATE_NOT_CONFIGURED",
        "The Budget model needs a Replicate API token (REPLICATE_API_TOKEN on Railway). Pick another model meanwhile.",
      );
    }
  }
  let finalPrompt = buildImagePrompt(body.prompt, getStylePreset(body.styleId));

  // Soul ID: the hero must be trained, and the prompt carries its trigger word.
  let lora: { url: string; scale: number } | undefined;
  if (body.characterId) {
    try {
      const hero = await prisma.character.findFirst({
        where: { id: body.characterId, userId: session.userId },
        select: { characterName: true, soulStatus: true, triggerWord: true, loraKey: true },
      });
      if (!hero) return errorResponse(404, "HERO_NOT_FOUND", "Soul ID hero not found.");
      if (hero.soulStatus !== "READY" || !hero.loraKey || !hero.triggerWord) {
        return errorResponse(409, "HERO_NOT_READY", `${hero.characterName} hasn't finished training yet.`);
      }
      if (hero.loraKey === TEST_LORA_KEY && !testMode) {
        return errorResponse(
          409,
          "HERO_TRAINED_IN_TEST_MODE",
          `${hero.characterName} was only trained in Test Mode. Train it for real first (Soul ID page).`,
        );
      }
      lora = testMode ? undefined : { url: await loraLinkFor(hero.loraKey), scale: body.likeness };
      finalPrompt = `photo of ${hero.triggerWord}, ${finalPrompt}`;
    } catch (err) {
      console.error("[images] hero lookup failed:", err);
      return errorResponse(500, "DATABASE_ERROR", "Could not load the Soul ID hero.");
    }
  }

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
        characterId: body.characterId,
        loraScale: body.characterId ? body.likeness : null,
        status: "PROCESSING",
      },
      select: { id: true },
    });
    generationId = row.id;
  } catch (err) {
    console.error("[images] could not create generation:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not start the generation.");
  }

  // Test Mode: nothing goes to Fal; the status route returns sample images.
  if (testMode) {
    await prisma.imageGeneration.update({
      where: { id: generationId },
      data: { providerRequestId: `${TEST_PREFIX}${generationId}` },
    });
    console.info(`[images] generation ${generationId} started in TEST MODE (no Fal call)`);
    return NextResponse.json(
      { generationId, status: "IN_QUEUE", statusUrl: `/api/images/${generationId}`, finalPrompt, testMode: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  const estimate = estimateImageCost(body.model, body.quality, body.numImages);
  try {
    await assertWithinLimit(session.userId, estimate);
  } catch (err) {
    if (err instanceof SpendLimitError) {
      await markGenerationFailed(generationId, err.message);
      return errorResponse(402, "SPEND_LIMIT_REACHED", err.message);
    }
    throw err;
  }

  try {
    const requestId = await submitToProvider({
      model: body.model,
      prompt: finalPrompt,
      aspectRatio: body.aspectRatio,
      numImages: body.numImages,
      quality: body.quality,
      seed: body.seed,
      lora,
    });
    await prisma.imageGeneration.update({ where: { id: generationId }, data: { providerRequestId: requestId } });
    await recordSpend(
      session.userId,
      "IMAGE",
      generationId,
      estimate,
      `${getImageModel(body.model)?.label ?? body.model} × ${body.numImages}${body.quality ? ` · ${body.quality}` : ""}`,
    );
    console.info(
      `[images] generation ${generationId} submitted (${providerFor(body.model)} ${requestId}) · ${body.model} · ${body.aspectRatio} · x${body.numImages}${body.quality ? ` · ${body.quality}` : ""} · style=${body.styleId}${body.characterId ? ` · soul=${body.characterId} @${body.likeness}` : ""}`,
    );
    return NextResponse.json(
      { generationId, status: "IN_QUEUE", statusUrl: `/api/images/${generationId}`, finalPrompt },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const e = await handleSubmitError(err, generationId, "images");
    return errorResponse(e.status, e.code, e.message, e.details);
  }
}
