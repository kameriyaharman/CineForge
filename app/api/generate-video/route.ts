import { ApiError, ValidationError, fal } from "@fal-ai/client";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  MagnificError,
  getVideoUpscaleTask,
  isMagnificConfigured,
  submitVideoUpscale,
  type MagnificVideoUpscaleInput,
} from "@/lib/magnific";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Honoured on Vercel-style hosts; Railway keeps the connection open without it.
export const maxDuration = 800;

const HUNYUAN_T2V_ENDPOINT = "fal-ai/hunyuan-video";
const PROMPT_MIN_LENGTH = 10;
const PROMPT_MAX_LENGTH = 2000;
const POLL_INTERVAL_MS = 3000;
/** Give up if Fal hasn't started the job within 5 minutes (queue backlog). */
const START_TIMEOUT_SECONDS = 300;
/** Default project that clips land in when the client doesn't pick one. */
const DEFAULT_PROJECT_TITLE = "Studio Sessions";

/**
 * Magnific upscale settings for delivery masters.
 *  - resolution "2k": Magnific takes a target resolution, not a multiplier.
 *    Hunyuan outputs ~1024x576, so 2x lands at ~2K. Use "4k" for true 4K
 *    (Magnific bills per frame, and 4K costs more per frame).
 *  - creativity 3 (of 0–100): very low, so faces and Soul ID identity are not
 *    re-invented by the upscaler.
 *  - The video upscaler has no HDR control; `flavor: "vivid"` is the closest
 *    contrast/colour option and is also the API default.
 */
const UPSCALE_SETTINGS = {
  resolution: "2k",
  creativity: 3,
  flavor: "vivid",
  output_format: "h264",
} as const satisfies Omit<MagnificVideoUpscaleInput, "video">;
const UPSCALE_POLL_INTERVAL_MS = 10_000;
const UPSCALE_MAX_WAIT_MS = 30 * 60 * 1000;
const UPSCALE_MAX_POLL_FAILURES = 6;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const falKey = process.env.FAL_KEY;
if (falKey) {
  fal.config({ credentials: falKey });
}

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

const CAMERA_MOVEMENTS = [
  "STATIC",
  "PAN LEFT",
  "PAN RIGHT",
  "TILT UP",
  "ZOOM IN",
  "ZOOM IN FAST",
  "ZOOM OUT",
  "DOLLY ZOOM",
  "CINEMATIC DOLLY ZOOM",
] as const;

type CameraMovement = (typeof CAMERA_MOVEMENTS)[number];

interface GenerateVideoBody {
  prompt: string;
  cameraMovement: CameraMovement | null;
  activeCharacterId: string | null;
  projectId: string | null;
}

/** Input schema for fal-ai/hunyuan-video (text-to-video). */
interface HunyuanVideoInput {
  prompt: string;
  seed?: number;
  pro_mode?: boolean;
  aspect_ratio?: "16:9" | "9:16";
  resolution?: "480p" | "580p" | "720p";
  num_frames?: 129 | 85;
  enable_safety_checker?: boolean;
}

interface FalFile {
  url: string;
  content_type?: string;
  file_name?: string;
  file_size?: number;
}

interface HunyuanVideoOutput {
  video: FalFile;
  seed: number;
}

/** The character data this route needs from the database. */
interface CharacterReference {
  id: string;
  characterName: string;
  referenceImageUrl: string;
  faceIdStatus: "PENDING" | "PROCESSING" | "READY" | "FAILED";
}

/**
 * Output of Step A. `keyframeUrl` is a still of the character, in the scene,
 * with their face locked by IP-Adapter-FaceID. While Step A is not yet live it
 * is null, and Step B falls back to text-only conditioning.
 */
interface IdentityPlan {
  mode: "none" | "text-conditioned" | "keyframe";
  keyframeUrl: string | null;
  note: string;
}

interface GenerateVideoSuccess {
  clipId: string;
  projectId: string;
  /** false if the video rendered but the COMPLETED write to the database failed. */
  persisted: boolean;
  requestId: string;
  videoUrl: string;
  contentType: string;
  fileSize?: number;
  seed: number;
  finalPrompt: string;
  cameraMovement: CameraMovement | null;
  character: { id: string; characterName: string } | null;
  identityMode: IdentityPlan["mode"];
  upscale: {
    status: "QUEUED" | "SKIPPED";
    resolution: string | null;
    reason?: string;
  };
}

interface GenerateVideoError {
  error: string;
  code: string;
  details?: unknown;
}

type ParseResult =
  | { ok: true; data: GenerateVideoBody }
  | { ok: false; code: string; message: string; details?: unknown };

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function errorResponse(
  status: number,
  code: string,
  error: string,
  details?: unknown,
): NextResponse<GenerateVideoError> {
  return NextResponse.json(
    { error, code, details },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Accepts "ZOOM IN", "zoom in", "Zoom-In", "zoom_in" etc. */
function normalizeCameraMovement(value: string): CameraMovement | null {
  const normalized = value.trim().toUpperCase().replace(/[\s_-]+/g, " ");
  return (CAMERA_MOVEMENTS as readonly string[]).includes(normalized)
    ? (normalized as CameraMovement)
    : null;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function parseBody(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "INVALID_BODY", message: "Request body must be a JSON object." };
  }
  const raw = body as Record<string, unknown>;
  const { prompt, cameraMovement, projectId } = raw;
  // `activeCharacterId` is the canonical field; `characterId` is accepted for older clients.
  const characterIdRaw = isBlank(raw.activeCharacterId) ? raw.characterId : raw.activeCharacterId;

  if (typeof prompt !== "string") {
    return { ok: false, code: "MISSING_FIELDS", message: "`prompt` is required and must be a string." };
  }
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length < PROMPT_MIN_LENGTH || trimmedPrompt.length > PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      code: "INVALID_PROMPT",
      message: `\`prompt\` must be ${PROMPT_MIN_LENGTH}–${PROMPT_MAX_LENGTH} characters.`,
    };
  }

  let movement: CameraMovement | null = null;
  if (!isBlank(cameraMovement)) {
    if (typeof cameraMovement !== "string") {
      return { ok: false, code: "INVALID_CAMERA", message: "`cameraMovement` must be a string." };
    }
    movement = normalizeCameraMovement(cameraMovement);
    if (!movement) {
      return {
        ok: false,
        code: "INVALID_CAMERA",
        message: "`cameraMovement` is not a supported value.",
        details: { allowed: CAMERA_MOVEMENTS },
      };
    }
  }

  let activeCharacterId: string | null = null;
  if (!isBlank(characterIdRaw)) {
    if (typeof characterIdRaw !== "string" || !UUID_PATTERN.test(characterIdRaw)) {
      return {
        ok: false,
        code: "INVALID_CHARACTER_ID",
        message: "`activeCharacterId` must be a valid UUID.",
      };
    }
    activeCharacterId = characterIdRaw.toLowerCase();
  }

  let project: string | null = null;
  if (!isBlank(projectId)) {
    if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) {
      return { ok: false, code: "INVALID_PROJECT_ID", message: "`projectId` must be a valid UUID." };
    }
    project = projectId.toLowerCase();
  }

  return {
    ok: true,
    data: {
      prompt: trimmedPrompt,
      cameraMovement: movement,
      activeCharacterId,
      projectId: project,
    },
  };
}

/* ------------------------- Step A: identity layer ------------------------- */
/*
 * STEP A — Face vector reference (Replicate IP-Adapter-FaceID)
 * ─────────────────────────────────────────────────────────────
 * Hunyuan text-to-video has never seen the character's face, so a name in the
 * prompt cannot make the face consistent. Real identity lock is a two-model
 * pipeline:
 *
 *   character.referenceImageUrl ──► Replicate IP-Adapter-FaceID (pinned version)
 *       input:  the reference face image + the scene prompt (+ camera framing)
 *       output: one still keyframe — this character, in this scene
 *                         │
 *                         ▼
 *   fal-ai/hunyuan-video-image-to-video
 *       input:  { image_url: keyframeUrl, prompt: finalPrompt,
 *                 aspect_ratio: "16:9", i2v_stability: true }
 *       output: the clip, animated from a frame that already has the right face
 *
 * Wiring it in:
 *   1. Pin the Replicate model version in env (REPLICATE_FACEID_VERSION) and
 *      read its input schema — field names differ between community versions.
 *   2. Run it asynchronously (Replicate prediction + webhook), store the face
 *      embedding in Character.faceIdVectors and set faceIdStatus = READY.
 *   3. Return { mode: "keyframe", keyframeUrl } below and switch Step B to the
 *      image-to-video endpoint when keyframeUrl is present.
 *
 * Until then this returns a text-conditioned plan so renders still work.
 */
function planIdentity(character: CharacterReference | null): IdentityPlan {
  if (!character) {
    return { mode: "none", keyframeUrl: null, note: "No Soul ID selected." };
  }
  return {
    mode: "text-conditioned",
    keyframeUrl: null,
    note:
      character.faceIdStatus === "READY"
        ? "Face embedding exists; keyframe generation not yet wired — using text conditioning."
        : `Face ID is ${character.faceIdStatus}; using text conditioning only.`,
  };
}

/* ------------------------ Step B: prompt assembly ------------------------ */

/**
 * "A hacker on a rooftop." + Kaira Vance + ZOOM IN →
 * "A hacker on a rooftop. [CHARACTER: Kaira Vance] [CAMERA: ZOOM IN]"
 *
 * The reference image URL is deliberately NOT put in the prompt: the text model
 * cannot read images, and the URL would just be noise tokens.
 */
function buildFinalPrompt(
  prompt: string,
  cameraMovement: CameraMovement | null,
  character: CharacterReference | null,
): string {
  const base = prompt.replace(/\s+/g, " ").trim();
  const tags: string[] = [];
  if (character) {
    // Strip bracket characters so a name can't break out of its tag.
    tags.push(`[CHARACTER: ${character.characterName.replace(/[[\]]/g, "")}]`);
  }
  if (cameraMovement) {
    tags.push(`[CAMERA: ${cameraMovement}]`);
  }
  if (tags.length === 0) return base;
  const withPunctuation = /[.!?]$/.test(base) ? base : `${base}.`;
  return `${withPunctuation} ${tags.join(" ")}`;
}

function isHunyuanOutput(data: unknown): data is HunyuanVideoOutput {
  if (typeof data !== "object" || data === null) return false;
  const video = (data as { video?: unknown }).video;
  return (
    typeof video === "object" &&
    video !== null &&
    typeof (video as { url?: unknown }).url === "string"
  );
}

/** Uses the requested project if the user owns it, otherwise their default project. */
async function resolveProjectId(userId: string, requested: string | null): Promise<string | null> {
  if (requested) {
    const owned = await prisma.project.findFirst({
      where: { id: requested, userId },
      select: { id: true },
    });
    return owned?.id ?? null;
  }
  const existing = await prisma.project.findFirst({
    where: { userId, title: DEFAULT_PROJECT_TITLE },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.project.create({
    data: {
      userId,
      title: DEFAULT_PROJECT_TITLE,
      description: "Clips rendered from the studio dashboard.",
    },
    select: { id: true },
  });
  return created.id;
}

/** Best-effort status write; a DB hiccup here must not mask the real error. */
async function markClipFailed(clipId: string, message: string): Promise<void> {
  try {
    await prisma.videoClip.update({
      where: { id: clipId },
      data: { status: "FAILED", errorMessage: message.slice(0, 2000) },
    });
  } catch (err) {
    console.error(`[generate-video] Could not mark clip ${clipId} FAILED:`, err);
  }
}

/* --------------------- Step C: Magnific upscale sweep --------------------- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Upscale unavailable or failed: the raw master is still deliverable. */
async function completeWithoutUpscale(clipId: string, reason: string): Promise<void> {
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
 * Runs after the response has been sent. Submits the raw Fal video to Magnific,
 * polls until done, then writes `upscaledVideoUrl` and flips the clip to
 * COMPLETED. Never throws.
 *
 * Runs inside the long-lived Railway Node process. A redeploy mid-upscale
 * leaves the clip in PROCESSING with its raw video saved; a Magnific
 * `webhook_url` route is the durable replacement for this poller.
 */
async function runUpscaleSweep(clipId: string, rawVideoUrl: string): Promise<void> {
  let taskId: string;
  try {
    const task = await submitVideoUpscale({ video: rawVideoUrl, ...UPSCALE_SETTINGS });
    taskId = task.taskId;
    console.info(
      `[upscale] clip ${clipId} → Magnific task ${taskId} (${UPSCALE_SETTINGS.resolution}, creativity ${UPSCALE_SETTINGS.creativity})`,
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

/* -------------------------------------------------------------------------- */
/*                                    Route                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/generate-video
 * Body: { prompt, cameraMovement?, activeCharacterId?, projectId? }
 *
 *   400  invalid body
 *   401  no / invalid / expired session      403  (reserved: userId mismatch)
 *   404  character or project not found for this user
 *   200  { clipId, videoUrl (raw), upscale }  — row PROCESSING while Magnific
 *        upscales, then COMPLETED with upscaledVideoUrl (or COMPLETED directly
 *        when MAGNIFIC_API_KEY is not set)
 *   4xx/5xx from the provider — VideoClip row FAILED with errorMessage
 */
export async function POST(
  req: NextRequest,
): Promise<NextResponse<GenerateVideoSuccess | GenerateVideoError>> {
  if (!falKey) {
    console.error("[generate-video] FAL_KEY is not set.");
    return errorResponse(500, "SERVER_MISCONFIGURED", "Video engine is not configured.");
  }

  // 1. Session — who is rendering.
  const session = verifySession(req);
  if (!session.ok) {
    return errorResponse(session.status, session.code, session.message);
  }
  const userId = session.userId;

  // 2. Body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
  const parsed = parseBody(body);
  if (!parsed.ok) {
    return errorResponse(400, parsed.code, parsed.message, parsed.details);
  }
  const { prompt, cameraMovement, activeCharacterId } = parsed.data;

  // 3. Character + project lookups (scoped to this user) and clip creation.
  let character: CharacterReference | null = null;
  let projectId: string;
  let clipId: string;
  let finalPrompt: string;
  let identity: IdentityPlan;

  try {
    if (activeCharacterId) {
      // Scoped by userId: another user's character id behaves exactly like a missing one.
      character = await prisma.character.findFirst({
        where: { id: activeCharacterId, userId },
        select: { id: true, characterName: true, referenceImageUrl: true, faceIdStatus: true },
      });
      if (!character) {
        return errorResponse(404, "CHARACTER_NOT_FOUND", "Selected character was not found.");
      }
    }

    const resolvedProject = await resolveProjectId(userId, parsed.data.projectId);
    if (!resolvedProject) {
      return errorResponse(404, "PROJECT_NOT_FOUND", "Project not found.");
    }
    projectId = resolvedProject;

    // Step A — identity plan (see block comment above planIdentity).
    identity = planIdentity(character);

    // Step B — prompt with character + camera tags.
    finalPrompt = buildFinalPrompt(prompt, cameraMovement, character);

    const clip = await prisma.videoClip.create({
      data: {
        projectId,
        characterId: character?.id ?? null,
        prompt: finalPrompt,
        cameraMovement,
        status: "PROCESSING",
      },
      select: { id: true },
    });
    clipId = clip.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      console.error(`[generate-video] Prisma error ${err.code}:`, err.message);
      if (err.code === "P1001" || err.code === "P1002" || err.code === "P1008") {
        return errorResponse(500, "DATABASE_UNAVAILABLE", "Database is unavailable.");
      }
      return errorResponse(500, "DATABASE_ERROR", "Could not prepare the render.");
    }
    console.error("[generate-video] Setup failed:", err);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }

  console.info(
    `[generate-video] clip ${clipId} PROCESSING · character=${character?.characterName ?? "none"} · identity=${identity.mode} · ${identity.note}`,
  );

  // Hunyuan on Fal takes aspect_ratio + resolution, not pixel dimensions.
  // 16:9 at 580p is the closest supported preset to 1024x576.
  const input: HunyuanVideoInput = {
    prompt: finalPrompt,
    aspect_ratio: "16:9",
    resolution: "580p",
    num_frames: 129,
    enable_safety_checker: true,
  };

  let requestId: string | null = null;

  // Client disconnected → cancel the Fal job so it isn't billed.
  const onClientAbort = () => {
    if (requestId) {
      fal.queue.cancel(HUNYUAN_T2V_ENDPOINT, { requestId }).catch((err: unknown) => {
        console.warn(`[generate-video] cancel failed for ${requestId}:`, err);
      });
    }
  };
  req.signal.addEventListener("abort", onClientAbort, { once: true });

  // 4. Render + status tracking.
  try {
    const result = await fal.subscribe(HUNYUAN_T2V_ENDPOINT, {
      input,
      mode: "polling",
      pollInterval: POLL_INTERVAL_MS,
      startTimeout: START_TIMEOUT_SECONDS,
      abortSignal: req.signal,
      logs: false,
      onEnqueue: (id: string) => {
        requestId = id;
        // Store the Fal job id immediately so a webhook or support ticket can find this clip.
        prisma.videoClip
          .update({ where: { id: clipId }, data: { providerRequestId: id } })
          .catch((err: unknown) =>
            console.error(`[generate-video] Could not store request id on clip ${clipId}:`, err),
          );
      },
      onQueueUpdate: (update) => {
        if (update.status === "IN_QUEUE") {
          console.info(
            `[generate-video] clip ${clipId} queued at position ${update.queue_position}`,
          );
        }
      },
    });

    if (!isHunyuanOutput(result.data)) {
      console.error("[generate-video] Unexpected output shape:", result.data);
      await markClipFailed(clipId, "Provider returned no video.");
      return errorResponse(502, "INVALID_PROVIDER_OUTPUT", "The render finished but returned no video.");
    }

    const { video, seed } = result.data;
    // Prefer the id from onEnqueue; never overwrite it with an empty value.
    const finalRequestId = result.requestId || requestId || "";

    // The video exists and has been paid for — a failed bookkeeping write must
    // not turn that into an error for the user. Log everything needed to recover.
    // With Magnific configured, the clip stays PROCESSING until the upscale
    // sweep writes upscaledVideoUrl; otherwise the raw master completes it.
    const upscaleEnabled = isMagnificConfigured();
    let persisted = true;
    try {
      await prisma.videoClip.update({
        where: { id: clipId },
        data: {
          status: upscaleEnabled ? "PROCESSING" : "COMPLETED",
          rawVideoUrl: video.url,
          seed: Number.isSafeInteger(seed) && Math.abs(seed) <= 2_147_483_647 ? seed : null,
          ...(finalRequestId ? { providerRequestId: finalRequestId } : {}),
          errorMessage: null,
        },
      });
    } catch (dbErr) {
      persisted = false;
      console.error(
        `[generate-video] clip ${clipId} rendered but COMPLETED write failed — recover manually:`,
        JSON.stringify({ clipId, requestId: finalRequestId, videoUrl: video.url, seed }),
        dbErr,
      );
    }

    // Step C — fire-and-forget upscale. The user gets the raw clip now; the
    // 2K master lands in the database when Magnific finishes.
    if (upscaleEnabled && persisted) {
      void runUpscaleSweep(clipId, video.url).catch((err: unknown) =>
        console.error(`[upscale] clip ${clipId} sweep crashed:`, err),
      );
    } else if (!upscaleEnabled) {
      console.warn("[generate-video] MAGNIFIC_API_KEY not set — skipping upscale.");
    }

    console.info(
      `[generate-video] clip ${clipId} ${
        !persisted ? "RENDERED (not persisted)" : upscaleEnabled ? "RAW READY → UPSCALING" : "COMPLETED"
      }`,
      JSON.stringify({
        requestId: finalRequestId,
        videoUrl: video.url,
        contentType: video.content_type,
        fileSize: video.file_size,
        seed,
      }),
    );

    return NextResponse.json(
      {
        clipId,
        projectId,
        persisted,
        requestId: finalRequestId,
        videoUrl: video.url,
        contentType: video.content_type ?? "video/mp4",
        fileSize: video.file_size,
        seed,
        finalPrompt,
        cameraMovement,
        character: character
          ? { id: character.id, characterName: character.characterName }
          : null,
        identityMode: identity.mode,
        upscale:
          upscaleEnabled && persisted
            ? { status: "QUEUED", resolution: UPSCALE_SETTINGS.resolution }
            : {
                status: "SKIPPED",
                resolution: null,
                reason: !upscaleEnabled
                  ? "Upscaler not configured."
                  : "Clip record could not be saved.",
              },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (req.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      await markClipFailed(clipId, "Cancelled by client.");
      return errorResponse(499, "CLIENT_CLOSED_REQUEST", "Request was cancelled.");
    }

    if (err instanceof ValidationError) {
      await markClipFailed(clipId, `Provider validation failed: ${JSON.stringify(err.fieldErrors)}`);
      return errorResponse(
        422,
        "PROVIDER_VALIDATION_FAILED",
        "The video engine rejected the request parameters.",
        err.fieldErrors,
      );
    }

    if (err instanceof ApiError) {
      console.error(`[generate-video] Fal API error ${err.status}:`, err.body);
      await markClipFailed(clipId, `Fal API error ${err.status}.`);
      switch (err.status) {
        case 401:
        case 403:
          return errorResponse(502, "PROVIDER_AUTH_FAILED", "Video engine authentication failed.");
        case 408:
        case 504:
          return errorResponse(
            504,
            "PROVIDER_TIMEOUT",
            "The render queue is busy and the job did not start in time. Please retry.",
          );
        case 429:
          return errorResponse(
            429,
            "PROVIDER_RATE_LIMITED",
            "Too many renders in progress. Try again shortly.",
          );
        default:
          return errorResponse(502, "PROVIDER_ERROR", "The video engine returned an error.", {
            clipId,
            requestId,
          });
      }
    }

    console.error("[generate-video] Unexpected error:", err);
    await markClipFailed(clipId, err instanceof Error ? err.message : "Unexpected error.");
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.", { clipId });
  } finally {
    req.signal.removeEventListener("abort", onClientAbort);
  }
}
