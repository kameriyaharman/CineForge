import { ApiError, ValidationError } from "@fal-ai/client";
import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import { SpendLimitError, TEST_PREFIX, assertWithinLimit, isTestMode, recordSpend } from "@/lib/billing";
import { metaNum, nearestAspect } from "@/lib/aspect";
import { IMAGE_UPLOAD_TYPES } from "@/lib/image-sniff";
import { prisma } from "@/lib/prisma";
import { getFal, isFalConfigured } from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import {
  I2V_ENDPOINTS,
  buildI2VInput,
  defaultProjectId,
  markClipFailedIfRunning,
} from "@/lib/video-jobs";
import {
  CAMERA_MOVES,
  VIDEO_PROMPT_MAX,
  estimateVideoCost,
  getVideoModel,
  type VideoModelId,
} from "@/lib/video-models";

/**
 * POST /api/videos — animate a Library image (image-to-video).
 * Body: { sourceAssetId, model, prompt, camera?, durationSec, resolution?, aspectRatio?, withAudio?, seed? }
 * Returns 202 { clipId, statusUrl }; poll GET /api/videos/{clipId}.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // ---- validate ----
  const model = getVideoModel(b.model);
  if (!model) return jsonError(400, "INVALID_MODEL", "Unknown video model.");
  if (typeof b.sourceAssetId !== "string" || !UUID_PATTERN.test(b.sourceAssetId)) {
    return jsonError(400, "INVALID_SOURCE", "Pick an image to animate.");
  }
  const userPrompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (model.promptRequired && userPrompt.length < 3) {
    return jsonError(400, "PROMPT_REQUIRED", "Describe the motion — what moves, and how.");
  }
  if (userPrompt.length > VIDEO_PROMPT_MAX) {
    return jsonError(400, "PROMPT_TOO_LONG", `Keep it under ${VIDEO_PROMPT_MAX} characters.`);
  }
  const camera = CAMERA_MOVES.find((c) => c.value === (b.camera ?? "none"));
  if (!camera) return jsonError(400, "INVALID_CAMERA", "Unknown camera move.");

  const durationSec = typeof b.durationSec === "number" ? b.durationSec : model.durations[0]!;
  if (!(model.durations as readonly number[]).includes(durationSec)) {
    return jsonError(400, "INVALID_DURATION", `${model.label} offers ${model.durations.join(", ")} seconds.`);
  }
  let resolution: string | null = null;
  if (model.resolutions.length > 0) {
    resolution = typeof b.resolution === "string" ? b.resolution : model.resolutions[0]!;
    if (!(model.resolutions as readonly string[]).includes(resolution)) {
      return jsonError(400, "INVALID_RESOLUTION", `${model.label} offers ${model.resolutions.join(", ")}.`);
    }
  }
  let aspectRatio: string | null = null;
  if (model.aspects.length > 0) {
    aspectRatio = typeof b.aspectRatio === "string" ? b.aspectRatio : model.aspects[0]!;
    if (!(model.aspects as readonly string[]).includes(aspectRatio)) {
      return jsonError(400, "INVALID_ASPECT", `${model.label} offers ${model.aspects.join(", ")}.`);
    }
  }
  const withAudio = model.audio ? b.withAudio === true : false;
  let seed: number | null = null;
  if (b.seed !== undefined && b.seed !== null && b.seed !== "") {
    if (typeof b.seed !== "number" || !Number.isInteger(b.seed) || b.seed < 0 || b.seed > 2_147_483_647) {
      return jsonError(400, "INVALID_SEED", "Seed must be a whole number.");
    }
    seed = b.seed;
  }
  const finalPrompt = [userPrompt, camera.text].filter(Boolean).join(" ").trim();

  // ---- account + source ----
  let testMode: boolean;
  try {
    testMode = await isTestMode(session.userId);
  } catch (err) {
    console.error("[videos] could not read account:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load your account.");
  }
  if (!testMode && !isFalConfigured()) return jsonError(500, "SERVER_MISCONFIGURED", "Fal is not configured (FAL_KEY).");

  const source = await prisma.asset.findFirst({
    where: { id: b.sourceAssetId.toLowerCase(), userId: session.userId, kind: "IMAGE" },
    select: { id: true, storageKey: true, contentType: true, meta: true },
  });
  if (!source) return jsonError(404, "SOURCE_NOT_FOUND", "That image is no longer in your Library.");
  if (!testMode && !(IMAGE_UPLOAD_TYPES as readonly string[]).includes(source.contentType)) {
    return jsonError(409, "SOURCE_IS_SAMPLE", "This is a Test Mode sample, not a real image. Pick a real image.");
  }
  const meta = (source.meta ?? {}) as Record<string, unknown>;
  const heroId = typeof meta.characterId === "string" ? meta.characterId : null;

  // ---- create clip ----
  let clipId: string;
  try {
    const projectId = await defaultProjectId(session.userId);
    const hero = heroId
      ? await prisma.character.findFirst({ where: { id: heroId, userId: session.userId }, select: { id: true } })
      : null;
    const clip = await prisma.videoClip.create({
      data: {
        projectId,
        characterId: hero?.id ?? null,
        prompt: finalPrompt || "(no prompt)",
        cameraMovement: camera.value === "none" ? null : camera.label.toUpperCase(),
        resolution,
        aspectRatio:
          aspectRatio && aspectRatio !== "auto"
            ? aspectRatio
            : nearestAspect(metaNum(meta, "width"), metaNum(meta, "height"), meta.aspectRatio),
        model: model.id,
        sourceAssetId: source.id,
        durationSec,
        withAudio,
        status: "PROCESSING",
      },
      select: { id: true },
    });
    clipId = clip.id;
  } catch (err) {
    console.error("[videos] could not create clip:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not start the video.");
  }

  if (testMode) {
    await prisma.videoClip.update({ where: { id: clipId }, data: { providerRequestId: `${TEST_PREFIX}${clipId}` } });
    console.info(`[videos] clip ${clipId} (${model.id}) started in TEST MODE (no Fal call)`);
    return json({ clipId, statusUrl: `/api/videos/${clipId}`, testMode: true }, 202);
  }

  const estimate = estimateVideoCost(model.id, durationSec, resolution, withAudio);
  try {
    await assertWithinLimit(session.userId, estimate);
  } catch (err) {
    if (err instanceof SpendLimitError) {
      await markClipFailedIfRunning(clipId, err.message);
      return jsonError(402, "SPEND_LIMIT_REACHED", err.message);
    }
    throw err;
  }

  try {
    const imageUrl = await presignGet(source.storageKey, undefined, 6 * 60 * 60);
    const endpoint = I2V_ENDPOINTS[model.id as VideoModelId];
    const input = buildI2VInput({
      model: model.id as VideoModelId,
      imageUrl,
      prompt: finalPrompt,
      durationSec,
      resolution,
      aspectRatio,
      withAudio,
      seed,
    });
    const { request_id: requestId } = await getFal().queue.submit(endpoint, { input });
    await prisma.videoClip.update({ where: { id: clipId }, data: { providerRequestId: requestId } });
    await recordSpend(
      session.userId,
      "VIDEO",
      clipId,
      estimate,
      `${model.label} · ${durationSec}s${resolution ? ` · ${resolution}` : ""}${withAudio ? " · sound" : ""}`,
    );
    console.info(
      `[videos] clip ${clipId} submitted as Fal ${requestId} · ${model.id} · ${durationSec}s · ${resolution ?? "auto"} · audio=${withAudio}`,
    );
    return json({ clipId, statusUrl: `/api/videos/${clipId}` }, 202);
  } catch (err) {
    if (err instanceof ValidationError) {
      await markClipFailedIfRunning(clipId, `Fal rejected the settings: ${JSON.stringify(err.fieldErrors)}`.slice(0, 500));
      return jsonError(422, "PROVIDER_VALIDATION_FAILED", "The video model rejected these settings.");
    }
    if (err instanceof ApiError) {
      console.error(`[videos] Fal submit error ${err.status}:`, err.body);
      await markClipFailedIfRunning(clipId, `Fal submit error ${err.status}.`);
      if (err.status === 402) {
        return jsonError(402, "PROVIDER_PAYMENT_REQUIRED", "The Fal account has no credit. Top up at fal.ai and retry.");
      }
      if (err.status === 401 || err.status === 403) return jsonError(502, "PROVIDER_AUTH_FAILED", "Fal rejected the API key.");
      if (err.status === 429) return jsonError(429, "PROVIDER_RATE_LIMITED", "Too many renders at once. Try again shortly.");
      return jsonError(502, "PROVIDER_ERROR", "The video model returned an error.");
    }
    console.error("[videos] unexpected submit error:", err);
    await markClipFailedIfRunning(clipId, err instanceof Error ? err.message : "Unexpected error.");
    return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}
