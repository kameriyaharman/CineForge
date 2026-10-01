import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import {
  SpendLimitError,
  TEST_PREFIX,
  assertWithinLimit,
  estimateImageCost,
  isTestMode,
  recordSpend,
} from "@/lib/billing";
import { EDIT_PROMPT_MAX, getEditTool, type EditToolId } from "@/lib/edit-tools";
import { IMAGE_ASPECT_OPTIONS } from "@/lib/image-models";
import { markGenerationFailed, providerFor, submitToProvider } from "@/lib/image-pipeline";
import { IMAGE_UPLOAD_TYPES } from "@/lib/image-sniff";
import { handleSubmitError } from "@/lib/job-errors";
import { prisma } from "@/lib/prisma";
import { isFalConfigured } from "@/lib/render-pipeline";
import { isReplicateConfigured } from "@/lib/replicate";
import { verifySession } from "@/lib/session";
import { presignGet } from "@/lib/storage";

/**
 * POST /api/edits — run an edit tool on a Library image.
 * Body: { sourceAssetId, tool, option?, prompt? }
 * Returns 202 { generationId, statusUrl }; poll GET /api/images/{generationId}.
 * The result is saved to the Library as a new image (the original is kept).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nearest of our aspect ratios, for display and Test Mode samples. */
function nearestAspect(width: number | null, height: number | null, fallback: unknown): string {
  if (typeof fallback === "string" && IMAGE_ASPECT_OPTIONS.some((o) => o.value === fallback)) return fallback;
  if (!width || !height) return "1:1";
  const r = width / height;
  let best = "1:1";
  let diff = Infinity;
  for (const o of IMAGE_ASPECT_OPTIONS) {
    const [w, h] = o.value.split(":").map(Number);
    const d = Math.abs(Math.log(r / (w! / h!)));
    if (d < diff) {
      diff = d;
      best = o.value;
    }
  }
  return best;
}

function num(meta: unknown, key: string): number | null {
  const v = (meta as Record<string, unknown> | null)?.[key];
  return typeof v === "number" ? v : null;
}

export async function POST(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);

  let b: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (typeof raw !== "object" || raw === null) throw new Error();
    b = raw as Record<string, unknown>;
  } catch {
    return jsonError(400, "INVALID_JSON", "Body must be a JSON object.");
  }

  const tool = getEditTool(b.tool);
  if (!tool) return jsonError(400, "INVALID_TOOL", "Unknown edit tool.");
  if (typeof b.sourceAssetId !== "string" || !UUID_PATTERN.test(b.sourceAssetId)) {
    return jsonError(400, "INVALID_SOURCE", "Pick an image to edit.");
  }
  const option =
    b.option === undefined || b.option === null ? tool.options[0]!.value : tool.options.find((o) => o.value === b.option)?.value;
  if (!option) return jsonError(400, "INVALID_OPTION", `${tool.label} doesn't offer that option.`);

  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (tool.needsPrompt && prompt.length < 3) return jsonError(400, "PROMPT_REQUIRED", "Describe the change you want.");
  if (prompt.length > EDIT_PROMPT_MAX) return jsonError(400, "PROMPT_TOO_LONG", `Keep it under ${EDIT_PROMPT_MAX} characters.`);

  let testMode: boolean;
  try {
    testMode = await isTestMode(session.userId);
  } catch (err) {
    console.error("[edits] could not read account:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load your account.");
  }
  const model = tool.id as EditToolId;
  if (!testMode) {
    if (providerFor(model) === "fal" && !isFalConfigured()) {
      return jsonError(500, "SERVER_MISCONFIGURED", "Fal is not configured (FAL_KEY).");
    }
    if (providerFor(model) === "replicate" && !isReplicateConfigured()) {
      return jsonError(
        500,
        "REPLICATE_NOT_CONFIGURED",
        "Budget edit needs a Replicate API token (REPLICATE_API_TOKEN on Railway). Use Prompt edit · Pro meanwhile.",
      );
    }
  }

  const source = await prisma.asset.findFirst({
    where: { id: b.sourceAssetId.toLowerCase(), userId: session.userId, kind: "IMAGE" },
    select: { id: true, storageKey: true, contentType: true, meta: true, prompt: true },
  });
  if (!source) return jsonError(404, "SOURCE_NOT_FOUND", "That image is no longer in your Library.");
  if (!testMode && !(IMAGE_UPLOAD_TYPES as readonly string[]).includes(source.contentType)) {
    return jsonError(
      409,
      "SOURCE_IS_SAMPLE",
      "This is a Test Mode sample, not a real image. Pick a real image or upload one.",
    );
  }

  const aspectRatio = nearestAspect(
    num(source.meta, "width"),
    num(source.meta, "height"),
    (source.meta as Record<string, unknown> | null)?.aspectRatio,
  );
  const label = tool.needsPrompt ? prompt : `${tool.label} · ${tool.options.find((o) => o.value === option)?.label}`;

  let generationId: string;
  try {
    const row = await prisma.imageGeneration.create({
      data: {
        userId: session.userId,
        model,
        prompt: tool.needsPrompt ? prompt : (source.prompt ?? label),
        finalPrompt: label,
        aspectRatio,
        quality: option,
        numImages: 1,
        sourceAssetId: source.id,
        status: "PROCESSING",
      },
      select: { id: true },
    });
    generationId = row.id;
  } catch (err) {
    console.error("[edits] could not create job:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not start the edit.");
  }

  if (testMode) {
    await prisma.imageGeneration.update({
      where: { id: generationId },
      data: { providerRequestId: `${TEST_PREFIX}${generationId}` },
    });
    console.info(`[edits] ${tool.id} ${generationId} started in TEST MODE (no provider call)`);
    return json({ generationId, statusUrl: `/api/images/${generationId}`, testMode: true }, 202);
  }

  const estimate = estimateImageCost(model, option, 1);
  try {
    await assertWithinLimit(session.userId, estimate);
  } catch (err) {
    if (err instanceof SpendLimitError) {
      await markGenerationFailed(generationId, err.message);
      return jsonError(402, "SPEND_LIMIT_REACHED", err.message);
    }
    throw err;
  }

  try {
    const sourceUrl = await presignGet(source.storageKey, undefined, 60 * 60);
    const requestId = await submitToProvider({
      model,
      prompt,
      aspectRatio: "1:1", // unused by edit tools: they keep the source's shape
      numImages: 1,
      quality: option,
      seed: null,
      sourceUrl,
    });
    await prisma.imageGeneration.update({ where: { id: generationId }, data: { providerRequestId: requestId } });
    await recordSpend(session.userId, "IMAGE", generationId, estimate, `${tool.label} · ${option}`);
    console.info(`[edits] ${tool.id} ${generationId} submitted (${providerFor(model)} ${requestId}) on asset ${source.id}`);
    return json({ generationId, statusUrl: `/api/images/${generationId}` }, 202);
  } catch (err) {
    const e = await handleSubmitError(err, generationId, "edits");
    return jsonError(e.status, e.code, e.message);
  }
}
