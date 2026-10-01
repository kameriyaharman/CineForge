import { ApiError } from "@fal-ai/client";
import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import { assetUrl } from "@/lib/assets";
import { isTestRequest } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { FalNotConfiguredError, getFal } from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";
import { TEST_VIDEO_DELAY_MS, archiveTestClip, sampleVideoPath } from "@/lib/test-mode";
import {
  I2V_ENDPOINTS,
  I2V_TIMEOUT_MS,
  clipMeta,
  finalizeI2VClip,
  markClipFailedIfRunning,
  videoUrlFrom,
} from "@/lib/video-jobs";
import { getVideoModel, type VideoModelId } from "@/lib/video-models";

/**
 * GET    /api/videos/{clipId} — progress; finalises when Fal is done
 * DELETE /api/videos/{clipId} — cancel an unfinished render
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Phase = "IN_QUEUE" | "RENDERING" | "COMPLETED" | "FAILED";

const select = {
  id: true,
  status: true,
  prompt: true,
  model: true,
  resolution: true,
  aspectRatio: true,
  durationSec: true,
  withAudio: true,
  sourceAssetId: true,
  rawVideoUrl: true,
  providerRequestId: true,
  errorMessage: true,
  seed: true,
  createdAt: true,
  assets: { where: { role: "RENDER" as const }, select: { id: true, storageKey: true } },
} as const;

async function load(id: string, userId?: string) {
  return prisma.videoClip.findFirst({
    where: { id, model: { not: null }, ...(userId ? { project: { userId } } : {}) },
    select,
  });
}
type Clip = NonNullable<Awaited<ReturnType<typeof load>>>;

async function respond(clip: Clip, overrides: { status?: Phase; queuePosition?: number } = {}) {
  const asset = clip.assets[0];
  const videoUrl =
    clip.status === "COMPLETED" ? ((asset ? await assetUrl(asset.storageKey) : null) ?? clip.rawVideoUrl) : null;
  const status: Phase =
    overrides.status ?? (clip.status === "COMPLETED" ? "COMPLETED" : clip.status === "FAILED" ? "FAILED" : "RENDERING");
  return json({
    clipId: clip.id,
    status,
    queuePosition: overrides.queuePosition,
    videoUrl,
    assetId: asset?.id ?? null,
    model: clip.model,
    modelLabel: getVideoModel(clip.model)?.label ?? clip.model,
    durationSec: clip.durationSec,
    resolution: clip.resolution,
    withAudio: clip.withAudio,
    prompt: clip.prompt,
    seed: clip.seed,
    testMode: isTestRequest(clip.providerRequestId),
    error: clip.status === "FAILED" ? (clip.errorMessage ?? "The render failed.") : undefined,
  });
}

async function resolve(req: NextRequest, params: Promise<{ clipId: string }>) {
  const session = verifySession(req);
  if (!session.ok) return { response: jsonError(session.status, session.code, session.message) };
  const { clipId } = await params;
  if (!UUID_PATTERN.test(clipId)) return { response: jsonError(400, "INVALID_ID", "Malformed clip id.") };
  const clip = await load(clipId.toLowerCase(), session.userId);
  if (!clip) return { response: jsonError(404, "NOT_FOUND", "Video not found.") };
  return { clip };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ clipId: string }> }) {
  let clip: Clip;
  try {
    const r = await resolve(req, params);
    if ("response" in r) return r.response;
    clip = r.clip;
  } catch (err) {
    console.error("[videos] lookup failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load the video.");
  }
  if (clip.status !== "PROCESSING") return respond(clip);

  const ageMs = Date.now() - clip.createdAt.getTime();
  const requestId = clip.providerRequestId;

  // Test Mode: finish with the bundled sample clip after a short wait.
  if (isTestRequest(requestId)) {
    if (ageMs < TEST_VIDEO_DELAY_MS) return respond(clip, { status: ageMs < 2_000 ? "IN_QUEUE" : "RENDERING" });
    const publicPath = sampleVideoPath(clip.aspectRatio);
    const claimed = await prisma.videoClip.updateMany({
      where: { id: clip.id, status: "PROCESSING", rawVideoUrl: null },
      data: { rawVideoUrl: publicPath, status: "COMPLETED", errorMessage: "Test Mode sample — no Fal credit used." },
    });
    if (claimed.count > 0) await archiveTestClip(clip.id, publicPath, clipMeta(clip));
    return respond((await load(clip.id)) ?? clip);
  }

  if (!requestId) {
    if (ageMs > 2 * 60 * 1000) {
      await markClipFailedIfRunning(clip.id, "The render was never submitted to Fal.");
      return respond((await load(clip.id)) ?? clip);
    }
    return respond(clip, { status: "IN_QUEUE" });
  }

  const endpoint = I2V_ENDPOINTS[clip.model as VideoModelId];
  if (!endpoint) {
    await markClipFailedIfRunning(clip.id, "Unknown video model.");
    return respond((await load(clip.id)) ?? clip);
  }

  try {
    const fal = getFal();
    const status = await fal.queue.status(endpoint, { requestId, logs: false });
    if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS") {
      if (ageMs > I2V_TIMEOUT_MS) {
        await fal.queue.cancel(endpoint, { requestId }).catch(() => undefined);
        await markClipFailedIfRunning(clip.id, "The render ran for over 30 minutes and was cancelled.");
        return respond((await load(clip.id)) ?? clip);
      }
      return status.status === "IN_QUEUE"
        ? respond(clip, { status: "IN_QUEUE", queuePosition: status.queue_position })
        : respond(clip, { status: "RENDERING" });
    }

    let output: unknown;
    try {
      output = (await fal.queue.result(endpoint, { requestId })).data;
    } catch (err) {
      console.error(`[videos] clip ${clip.id} result error:`, err instanceof ApiError ? err.body : err);
      const detail =
        err instanceof ApiError && err.status === 422
          ? "The model rejected the image or prompt (it may have tripped a content filter)."
          : "The video model reported an error.";
      await markClipFailedIfRunning(clip.id, detail);
      return respond((await load(clip.id)) ?? clip);
    }

    const url = videoUrlFrom(output);
    if (!url) {
      console.error(`[videos] clip ${clip.id} returned no video:`, output);
      await markClipFailedIfRunning(clip.id, "The model finished but returned no video.");
      return respond((await load(clip.id)) ?? clip);
    }
    const seed = (output as { seed?: unknown }).seed;
    await finalizeI2VClip(clip.id, url, typeof seed === "number" ? seed : null);
    return respond((await load(clip.id)) ?? clip);
  } catch (err) {
    if (err instanceof FalNotConfiguredError) return jsonError(500, "SERVER_MISCONFIGURED", "Fal is not configured.");
    if (err instanceof ApiError) {
      console.error(`[videos] Fal status error ${err.status}:`, err.body);
      if (err.status === 404) {
        await markClipFailedIfRunning(clip.id, "Fal no longer knows this render.");
        return respond((await load(clip.id)) ?? clip);
      }
      return jsonError(502, "PROVIDER_ERROR", "Could not reach the video model. Retrying…");
    }
    console.error("[videos] unexpected status error:", err);
    return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ clipId: string }> }) {
  let clip: Clip;
  try {
    const r = await resolve(req, params);
    if ("response" in r) return r.response;
    clip = r.clip;
  } catch (err) {
    console.error("[videos] lookup failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load the video.");
  }
  if (clip.status !== "PROCESSING") return respond(clip);
  const endpoint = I2V_ENDPOINTS[clip.model as VideoModelId];
  if (clip.providerRequestId && endpoint && !isTestRequest(clip.providerRequestId)) {
    await getFal()
      .queue.cancel(endpoint, { requestId: clip.providerRequestId })
      .catch((err) => console.warn(`[videos] cancel failed for ${clip.id}:`, err));
  }
  await markClipFailedIfRunning(clip.id, "Cancelled by user.");
  return respond((await load(clip.id)) ?? clip);
}
