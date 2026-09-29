import { ApiError } from "@fal-ai/client";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  FalNotConfiguredError,
  HUNYUAN_T2V_ENDPOINT,
  QUEUE_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  UPSCALE_STALE_MS,
  completeWithoutUpscale,
  finalizeRawVideo,
  getFal,
  isHunyuanOutput,
  markClipFailed,
} from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";

/**
 * GET    /api/generate-video/{clipId}  — progress; finalises the clip when Fal is done
 * DELETE /api/generate-video/{clipId}  — cancel a render that hasn't finished
 *
 * Each GET is short (one Fal status call), so nothing here comes near
 * Railway's 5-minute request limit.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ClipPhase = "IN_QUEUE" | "RENDERING" | "UPSCALING" | "COMPLETED" | "FAILED";

interface ClipStatusResponse {
  clipId: string;
  status: ClipPhase;
  queuePosition?: number;
  /** Best available video: the upscaled master if ready, otherwise the raw render. */
  videoUrl?: string;
  rawVideoUrl?: string;
  upscaledVideoUrl?: string;
  seed?: number;
  finalPrompt: string;
  cameraMovement: string | null;
  characterName: string | null;
  error?: string;
  /** Non-fatal note, e.g. why the upscale was skipped. */
  note?: string;
}

interface ApiErrorBody {
  error: string;
  code: string;
}

const clipSelect = {
  id: true,
  status: true,
  prompt: true,
  cameraMovement: true,
  rawVideoUrl: true,
  upscaledVideoUrl: true,
  providerRequestId: true,
  seed: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
  character: { select: { characterName: true } },
} as const;

function errorResponse(status: number, code: string, error: string): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

function ok(body: ClipStatusResponse): NextResponse<ClipStatusResponse> {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Loads the clip only if it belongs to the signed-in user. */
async function loadOwnedClip(clipId: string, userId: string) {
  return prisma.videoClip.findFirst({
    where: { id: clipId, project: { userId } },
    select: clipSelect,
  });
}

type OwnedClip = NonNullable<Awaited<ReturnType<typeof loadOwnedClip>>>;

function describe(clip: OwnedClip): ClipStatusResponse {
  const base = {
    clipId: clip.id,
    finalPrompt: clip.prompt,
    cameraMovement: clip.cameraMovement,
    characterName: clip.character?.characterName ?? null,
    seed: clip.seed ?? undefined,
    rawVideoUrl: clip.rawVideoUrl ?? undefined,
    upscaledVideoUrl: clip.upscaledVideoUrl ?? undefined,
  };

  if (clip.status === "FAILED") {
    return { ...base, status: "FAILED", error: clip.errorMessage ?? "The render failed." };
  }
  if (clip.status === "COMPLETED") {
    return {
      ...base,
      status: "COMPLETED",
      videoUrl: clip.upscaledVideoUrl ?? clip.rawVideoUrl ?? undefined,
      note: clip.errorMessage ?? undefined,
    };
  }
  if (clip.rawVideoUrl) {
    return { ...base, status: "UPSCALING", videoUrl: clip.rawVideoUrl };
  }
  return { ...base, status: "RENDERING" };
}

async function resolveClip(
  req: NextRequest,
  params: Promise<{ clipId: string }>,
): Promise<{ clip: OwnedClip } | { response: NextResponse<ApiErrorBody> }> {
  const session = verifySession(req);
  if (!session.ok) {
    return { response: errorResponse(session.status, session.code, session.message) };
  }
  const { clipId } = await params;
  if (!UUID_PATTERN.test(clipId)) {
    return { response: errorResponse(400, "INVALID_CLIP_ID", "Malformed clip id.") };
  }
  const clip = await loadOwnedClip(clipId.toLowerCase(), session.userId);
  if (!clip) {
    return { response: errorResponse(404, "CLIP_NOT_FOUND", "Clip not found.") };
  }
  return { clip };
}

/* ---------------------------------- GET ---------------------------------- */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<NextResponse<ClipStatusResponse | ApiErrorBody>> {
  let clip: OwnedClip;
  try {
    const resolved = await resolveClip(req, params);
    if ("response" in resolved) return resolved.response;
    clip = resolved.clip;
  } catch (err) {
    console.error("[clip-status] Lookup failed:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not load the clip.");
  }

  // Finished (or failed) — answer from the database.
  if (clip.status !== "PROCESSING") return ok(describe(clip));

  // Raw video saved; Magnific upscale in progress.
  if (clip.rawVideoUrl) {
    if (Date.now() - clip.updatedAt.getTime() > UPSCALE_STALE_MS) {
      await completeWithoutUpscale(clip.id, "the upscale was interrupted (server restarted).");
      const refreshed = await loadOwnedClipById(clip.id);
      return ok(describe(refreshed ?? clip));
    }
    return ok(describe(clip));
  }

  // Still with Fal.
  const requestId = clip.providerRequestId;
  const ageMs = Date.now() - clip.createdAt.getTime();
  if (!requestId) {
    if (ageMs > 2 * 60 * 1000) {
      await markClipFailed(clip.id, "The render was never submitted to Fal.");
      return ok({ ...describe(clip), status: "FAILED", error: "The render was never submitted." });
    }
    return ok({ ...describe(clip), status: "IN_QUEUE" });
  }

  try {
    const fal = getFal();
    const status = await fal.queue.status(HUNYUAN_T2V_ENDPOINT, { requestId, logs: false });

    if (status.status === "IN_QUEUE") {
      if (ageMs > QUEUE_TIMEOUT_MS) {
        await fal.queue.cancel(HUNYUAN_T2V_ENDPOINT, { requestId }).catch(() => undefined);
        const message = "Fal did not start the render within 15 minutes, so it was cancelled.";
        await markClipFailed(clip.id, message);
        return ok({ ...describe(clip), status: "FAILED", error: message });
      }
      return ok({ ...describe(clip), status: "IN_QUEUE", queuePosition: status.queue_position });
    }

    if (status.status === "IN_PROGRESS") {
      if (ageMs > RENDER_TIMEOUT_MS) {
        await fal.queue.cancel(HUNYUAN_T2V_ENDPOINT, { requestId }).catch(() => undefined);
        const message = "The render ran for over 30 minutes without finishing and was cancelled.";
        await markClipFailed(clip.id, message);
        return ok({ ...describe(clip), status: "FAILED", error: message });
      }
      return ok({ ...describe(clip), status: "RENDERING" });
    }

    // COMPLETED — fetch the output. A failed render surfaces here as an ApiError.
    let output: unknown;
    try {
      output = (await fal.queue.result(HUNYUAN_T2V_ENDPOINT, { requestId })).data;
    } catch (err) {
      const detail =
        err instanceof ApiError ? `Fal reported the render failed (HTTP ${err.status}).` : "Fal reported the render failed.";
      console.error(`[clip-status] clip ${clip.id} result error:`, err instanceof ApiError ? err.body : err);
      await markClipFailed(clip.id, detail);
      return ok({ ...describe(clip), status: "FAILED", error: detail });
    }

    if (!isHunyuanOutput(output)) {
      console.error(`[clip-status] clip ${clip.id} unexpected output:`, output);
      await markClipFailed(clip.id, "Fal finished but returned no video.");
      return ok({ ...describe(clip), status: "FAILED", error: "The render returned no video." });
    }

    await finalizeRawVideo(clip.id, output);
    const refreshed = await loadOwnedClipById(clip.id);
    return ok(describe(refreshed ?? clip));
  } catch (err) {
    if (err instanceof FalNotConfiguredError) {
      return errorResponse(500, "SERVER_MISCONFIGURED", "Video engine is not configured.");
    }
    if (err instanceof ApiError) {
      console.error(`[clip-status] Fal status error ${err.status}:`, err.body);
      if (err.status === 404) {
        await markClipFailed(clip.id, "Fal no longer knows this render.");
        return ok({ ...describe(clip), status: "FAILED", error: "The render was lost by Fal." });
      }
      return errorResponse(502, "PROVIDER_ERROR", "Could not reach the video engine. Retrying…");
    }
    console.error("[clip-status] Unexpected error:", err);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

async function loadOwnedClipById(clipId: string) {
  return prisma.videoClip.findUnique({ where: { id: clipId }, select: clipSelect });
}

/* --------------------------------- DELETE -------------------------------- */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<NextResponse<ClipStatusResponse | ApiErrorBody>> {
  let clip: OwnedClip;
  try {
    const resolved = await resolveClip(req, params);
    if ("response" in resolved) return resolved.response;
    clip = resolved.clip;
  } catch (err) {
    console.error("[clip-status] Lookup failed:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not load the clip.");
  }

  // Only a render still with Fal can be cancelled.
  if (clip.status !== "PROCESSING" || clip.rawVideoUrl) {
    return ok(describe(clip));
  }

  if (clip.providerRequestId) {
    try {
      await getFal().queue.cancel(HUNYUAN_T2V_ENDPOINT, { requestId: clip.providerRequestId });
    } catch (err) {
      console.warn(`[clip-status] cancel failed for clip ${clip.id}:`, err);
    }
  }
  await markClipFailed(clip.id, "Cancelled by user.");
  console.info(`[clip-status] clip ${clip.id} cancelled by user`);
  const refreshed = await loadOwnedClipById(clip.id);
  return ok(describe(refreshed ?? clip));
}
