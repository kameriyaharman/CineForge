/**
 * Magnific (formerly Freepik) Video Upscaler client — server only.
 * Docs: https://docs.magnific.com/api-reference/video/video-upscaler/upscale-video
 *
 *   POST https://api.magnific.com/v1/ai/video-upscaler            → { data: { task_id, status } }
 *   GET  https://api.magnific.com/v1/ai/video-upscaler/{task_id}  → { data: { status, generated[] } }
 *   Auth header: x-magnific-api-key
 *   Status: CREATED | IN_PROGRESS | COMPLETED | FAILED
 */

const MAGNIFIC_BASE_URL = "https://api.magnific.com";
const REQUEST_TIMEOUT_MS = 30_000;

export type MagnificResolution = "720p" | "1k" | "2k" | "4k";
export type MagnificTaskStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

/** Request body for POST /v1/ai/video-upscaler (all fields except `video` optional). */
export interface MagnificVideoUpscaleInput {
  video: string;
  resolution?: MagnificResolution;
  /** 0–100. Low values keep faces/identity intact; high values invent detail. */
  creativity?: number;
  /** 0–100 */
  sharpen?: number;
  /** 0–100 */
  smart_grain?: number;
  fps_boost?: boolean;
  flavor?: "vivid" | "natural";
  output_format?: "h264" | "prores_422_hq";
  webhook_url?: string;
}

export interface MagnificTask {
  taskId: string;
  status: MagnificTaskStatus;
  generated: string[];
}

export class MagnificError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MagnificError";
  }
}

export function isMagnificConfigured(): boolean {
  return Boolean(process.env.MAGNIFIC_API_KEY);
}

function apiKey(): string {
  const key = process.env.MAGNIFIC_API_KEY;
  if (!key) throw new MagnificError("MAGNIFIC_API_KEY is not set.", null);
  return key;
}

const TASK_STATUSES: readonly MagnificTaskStatus[] = [
  "CREATED",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
];

function parseTask(json: unknown): MagnificTask {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  const taskId = data?.task_id;
  const status = data?.status;
  const generated = data?.generated;
  if (typeof taskId !== "string" || !TASK_STATUSES.includes(status as MagnificTaskStatus)) {
    throw new MagnificError("Unexpected Magnific response shape.", null, json);
  }
  return {
    taskId,
    status: status as MagnificTaskStatus,
    generated: Array.isArray(generated)
      ? generated.filter((u): u is string => typeof u === "string")
      : [],
  };
}

async function magnificFetch(path: string, init: RequestInit): Promise<MagnificTask> {
  let res: Response;
  try {
    res = await fetch(`${MAGNIFIC_BASE_URL}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "x-magnific-api-key": apiKey(),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof MagnificError) throw err;
    throw new MagnificError(
      `Magnific request failed: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body; handled below.
  }

  if (!res.ok) {
    throw new MagnificError(`Magnific API returned HTTP ${res.status}.`, res.status, json);
  }
  return parseTask(json);
}

/** Creates an upscale task. Returns immediately; the render runs on Magnific's side. */
export function submitVideoUpscale(input: MagnificVideoUpscaleInput): Promise<MagnificTask> {
  return magnificFetch("/v1/ai/video-upscaler", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getVideoUpscaleTask(taskId: string): Promise<MagnificTask> {
  return magnificFetch(`/v1/ai/video-upscaler/${encodeURIComponent(taskId)}`, {
    method: "GET",
  });
}
