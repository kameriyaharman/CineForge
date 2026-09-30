import { fal } from "@fal-ai/client";
import {
  MagnificError,
  getVideoUpscaleTask,
  isMagnificConfigured,
  submitVideoUpscale,
  type MagnificResolution,
  type MagnificVideoUpscaleInput,
} from "@/lib/magnific";
import { prisma } from "@/lib/prisma";

/**
 * Shared render pipeline — server only.
 * Used by POST /api/generate-video (submit) and
 * GET/DELETE /api/generate-video/[clipId] (status, finalise, cancel).
 */

export const HUNYUAN_T2V_ENDPOINT = "fal-ai/hunyuan-video";

/** A job still waiting in Fal's queue after this long is cancelled. */
export const QUEUE_TIMEOUT_MS = 15 * 60 * 1000;
/** A job that has started rendering but not finished after this long is failed. */
export const RENDER_TIMEOUT_MS = 30 * 60 * 1000;
/** An upscale with no result after this long (e.g. server restarted) is abandoned. */
export const UPSCALE_STALE_MS = 40 * 60 * 1000;

/**
 * Magnific upscale settings for delivery masters.
 *  - resolution: Magnific's video upscaler takes a target resolution
 *    ("720p" | "1k" | "2k" | "4k"), not a multiplier. Default "4k"; override
 *    with MAGNIFIC_RESOLUTION on Railway to cut cost (billed per frame, and
 *    4K costs the most per frame).
 *  - creativity 3 (of 0–100): very low, so faces are not re-invented.
 *  - The video API has no HDR or resolution-factor parameter (those exist only
 *    on Magnific's image upscaler); `flavor: "vivid"` is the closest
 *    contrast/colour control and is the API default.
 */
const MAGNIFIC_RESOLUTIONS = ["720p", "1k", "2k", "4k"] as const;

function resolveUpscaleResolution(): MagnificResolution {
  const raw = process.env.MAGNIFIC_RESOLUTION?.trim().toLowerCase();
  if (!raw) return "4k";
  if ((MAGNIFIC_RESOLUTIONS as readonly string[]).includes(raw)) return raw as MagnificResolution;
  console.warn(`[upscale] MAGNIFIC_RESOLUTION="${raw}" is not one of ${MAGNIFIC_RESOLUTIONS.join(", ")}; using 4k.`);
  return "4k";
}

export function getUpscaleSettings(): Omit<MagnificVideoUpscaleInput, "video"> & {
  resolution: MagnificResolution;
} {
  return {
    resolution: resolveUpscaleResolution(),
    creativity: 3,
    flavor: "vivid",
    output_format: "h264",
  };
}

const UPSCALE_POLL_INTERVAL_MS = 10_000;
const UPSCALE_MAX_WAIT_MS = 30 * 60 * 1000;
const UPSCALE_MAX_POLL_FAILURES = 6;

/* ------------------------------- Fal client ------------------------------- */

export class FalNotConfiguredError extends Error {
  constructor() {
    super("FAL_KEY is not set.");
    this.name = "FalNotConfiguredError";
  }
}

let configuredKey: string | null = null;

/** Returns the Fal client, configured from the current process.env.FAL_KEY. */
export function getFal(): typeof fal {
  const key = process.env.FAL_KEY?.trim();
  if (!key) throw new FalNotConfiguredError();
  if (key !== configuredKey) {
    fal.config({ credentials: key });
    configuredKey = key;
  }
  return fal;
}

export function isFalConfigured(): boolean {
  return Boolean(process.env.FAL_KEY?.trim());
}

/* --------------------------------- Types --------------------------------- */

/** Input schema for fal-ai/hunyuan-video (text-to-video). */
export interface HunyuanVideoInput {
  prompt: string;
  seed?: number;
  pro_mode?: boolean;
  aspect_ratio?: "16:9" | "9:16";
  resolution?: "480p" | "580p" | "720p";
  num_frames?: 129 | 85;
  enable_safety_checker?: boolean;
}

export interface FalFile {
  url: string;
  content_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface HunyuanVideoOutput {
  video: FalFile;
  seed: number;
}

export function isHunyuanOutput(data: unknown): data is HunyuanVideoOutput {
  if (typeof data !== "object" || data === null) return false;
  const video = (data as { video?: unknown }).video;
  return (
    typeof video === "object" &&
    video !== null &&
    typeof (video as { url?: unknown }).url === "string"
  );
}

/* ------------------------------ Clip updates ------------------------------ */

/** Best-effort status write; a DB hiccup here must not mask the real error. */
export async function markClipFailed(clipId: string, message: string): Promise<void> {
  try {
    await prisma.videoClip.update({
      where: { id: clipId },
      data: { status: "FAILED", errorMessage: message.slice(0, 2000) },
    });
  } catch (err) {
    console.error(`[render] Could not mark clip ${clipId} FAILED:`, err);
  }
}

export type FinalizeResult =
  | { claimed: true; upscaleQueued: boolean }
  | { claimed: false };

/**
 * Stores the raw Fal video on the clip exactly once, even if several status
 * polls see the COMPLETED job at the same moment. Starts the Magnific sweep
 * when configured (the clip stays PROCESSING until it finishes); otherwise
 * the clip is COMPLETED immediately.
 */
export async function finalizeRawVideo(
  clipId: string,
  output: HunyuanVideoOutput,
): Promise<FinalizeResult> {
  const upscaleEnabled = isMagnificConfigured();
  const seed =
    Number.isSafeInteger(output.seed) && Math.abs(output.seed) <= 2_147_483_647
      ? output.seed
      : null;

  const { count } = await prisma.videoClip.updateMany({
    where: { id: clipId, status: "PROCESSING", rawVideoUrl: null },
    data: {
      status: upscaleEnabled ? "PROCESSING" : "COMPLETED",
      rawVideoUrl: output.video.url,
      seed,
      errorMessage: null,
    },
  });
  if (count === 0) return { claimed: false };

  console.info(
    `[render] clip ${clipId} raw video ready`,
    JSON.stringify({ videoUrl: output.video.url, fileSize: output.video.file_size, seed }),
  );

  if (upscaleEnabled) {
    void runUpscaleSweep(clipId, output.video.url).catch((err: unknown) =>
      console.error(`[upscale] clip ${clipId} sweep crashed:`, err),
    );
  } else {
    console.warn(
      "[render] DEV NOTICE: MAGNIFIC_API_KEY is not set — skipping the upscale and delivering the raw video.",
    );
  }
  return { claimed: true, upscaleQueued: upscaleEnabled };
}

/* --------------------------- Magnific upscale ---------------------------- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Upscale unavailable or failed: the raw master is still deliverable. */
export async function completeWithoutUpscale(clipId: string, reason: string): Promise<void> {
  try {
    await prisma.videoClip.update({
      where: { id: clipId },
      data: { status: "COMPLETED", errorMessage: `Upscale skipped: ${reason}`.slice(0, 2000) },
    });
    console.warn(`[upscale] clip ${clipId} COMPLETED without upscale — ${reason}`);
  } catch (err) {
    console.error(`[upscale] clip ${clipId} could not be finalised:`, err);
  }
}

/**
 * Submits the raw video to Magnific, polls until done, then writes
 * `upscaledVideoUrl` and flips the clip to COMPLETED. Never throws.
 * Runs inside the long-lived Node process; if the server restarts mid-upscale,
 * the status route completes the clip without the upscale after UPSCALE_STALE_MS.
 */
async function runUpscaleSweep(clipId: string, rawVideoUrl: string): Promise<void> {
  let taskId: string;
  try {
    const settings = getUpscaleSettings();
    const task = await submitVideoUpscale({ video: rawVideoUrl, ...settings });
    taskId = task.taskId;
    console.info(
      `[upscale] clip ${clipId} → Magnific task ${taskId} (${settings.resolution}, creativity ${settings.creativity})`,
    );
  } catch (err) {
    const detail =
      err instanceof MagnificError
        ? `${err.message}${err.body ? ` ${JSON.stringify(err.body).slice(0, 300)}` : ""}`
        : String(err);
    console.error(`[upscale] clip ${clipId} submit failed:`, detail);
    await completeWithoutUpscale(clipId, "Magnific rejected the upscale request.");
    return;
  }

  const deadline = Date.now() + UPSCALE_MAX_WAIT_MS;
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    await sleep(UPSCALE_POLL_INTERVAL_MS);

    let task;
    try {
      task = await getVideoUpscaleTask(taskId);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      console.warn(
        `[upscale] clip ${clipId} poll ${consecutiveFailures}/${UPSCALE_MAX_POLL_FAILURES} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (consecutiveFailures >= UPSCALE_MAX_POLL_FAILURES) {
        await completeWithoutUpscale(clipId, `lost contact with Magnific task ${taskId}.`);
        return;
      }
      continue;
    }

    if (task.status === "COMPLETED") {
      const upscaledUrl = task.generated[0];
      if (!upscaledUrl) {
        await completeWithoutUpscale(clipId, `Magnific task ${taskId} returned no file.`);
        return;
      }
      try {
        await prisma.videoClip.update({
          where: { id: clipId },
          data: { status: "COMPLETED", upscaledVideoUrl: upscaledUrl, errorMessage: null },
        });
        console.info(
          `[upscale] clip ${clipId} COMPLETED`,
          JSON.stringify({ taskId, upscaledVideoUrl: upscaledUrl }),
        );
      } catch (err) {
        console.error(
          `[upscale] clip ${clipId} upscaled but DB write failed — recover manually:`,
          JSON.stringify({ taskId, upscaledVideoUrl: upscaledUrl }),
          err,
        );
      }
      return;
    }

    if (task.status === "FAILED") {
      await completeWithoutUpscale(clipId, `Magnific task ${taskId} failed.`);
      return;
    }
  }

  await completeWithoutUpscale(clipId, `Magnific task ${taskId} timed out after 30 minutes.`);
}
