import { ApiError, ValidationError } from "@fal-ai/client";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ASPECT_RATIO_OPTIONS,
  DEFAULT_RENDER_SETTINGS,
  DURATION_OPTIONS,
  RESOLUTION_OPTIONS,
  isAspectRatio,
  isNumFrames,
  isVideoResolution,
  type RenderSettings,
} from "@/lib/render-options";
import {
  FalNotConfiguredError,
  HUNYUAN_T2V_ENDPOINT,
  getFal,
  isFalConfigured,
  markClipFailed,
  type HunyuanVideoInput,
} from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROMPT_MIN_LENGTH = 10;
const PROMPT_MAX_LENGTH = 2000;
/** Default project that clips land in when the client doesn't pick one. */
const DEFAULT_PROJECT_TITLE = "Studio Sessions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  settings: RenderSettings;
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

interface GenerateVideoAccepted {
  clipId: string;
  settings: RenderSettings;
  projectId: string;
  requestId: string;
  status: "IN_QUEUE";
  /** Poll this for progress and the final video. */
  statusUrl: string;
  finalPrompt: string;
  cameraMovement: CameraMovement | null;
  character: { id: string; characterName: string } | null;
  identityMode: IdentityPlan["mode"];
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

  // Render settings chosen on the dashboard. Omitted → defaults (older clients).
  const numFrames = isBlank(raw.numFrames) ? DEFAULT_RENDER_SETTINGS.numFrames : Number(raw.numFrames);
  if (!isNumFrames(numFrames)) {
    return {
      ok: false,
      code: "INVALID_DURATION",
      message: "`numFrames` is not a supported duration.",
      details: { allowed: DURATION_OPTIONS.map((o) => o.value) },
    };
  }
  const resolution = isBlank(raw.resolution) ? DEFAULT_RENDER_SETTINGS.resolution : raw.resolution;
  if (!isVideoResolution(resolution)) {
    return {
      ok: false,
      code: "INVALID_RESOLUTION",
      message: "`resolution` is not supported.",
      details: { allowed: RESOLUTION_OPTIONS.map((o) => o.value) },
    };
  }
  const aspectRatio = isBlank(raw.aspectRatio) ? DEFAULT_RENDER_SETTINGS.aspectRatio : raw.aspectRatio;
  if (!isAspectRatio(aspectRatio)) {
    return {
      ok: false,
      code: "INVALID_ASPECT_RATIO",
      message: "`aspectRatio` is not supported.",
      details: { allowed: ASPECT_RATIO_OPTIONS.map((o) => o.value) },
    };
  }

  return {
    ok: true,
    data: {
      prompt: trimmedPrompt,
      cameraMovement: movement,
      activeCharacterId,
      projectId: project,
      settings: { numFrames, resolution, aspectRatio },
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

/* -------------------------------------------------------------------------- */
/*                                    Route                                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/generate-video
 * Body: { prompt, cameraMovement?, activeCharacterId?, projectId? }
 *
 * Submits the render to Fal's queue and returns immediately (Railway closes
 * requests after 5 minutes; renders can take longer). The client then polls
 * GET /api/generate-video/{clipId}, which also finalises the clip and starts
 * the Magnific upscale when Fal finishes.
 *
 *   202  { clipId, requestId, status: "IN_QUEUE", statusUrl, ... }
 *   400  invalid body          401  no / invalid / expired session
 *   404  character or project not found for this user
 *   4xx/5xx from Fal — clip marked FAILED with errorMessage
 */
export async function POST(
  req: NextRequest,
): Promise<NextResponse<GenerateVideoAccepted | GenerateVideoError>> {
  if (!isFalConfigured()) {
    console.error("[generate-video] FAL_KEY is not set in this deployment's environment.");
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
  const { prompt, cameraMovement, activeCharacterId, settings } = parsed.data;

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
        resolution: settings.resolution,
        numFrames: settings.numFrames,
        aspectRatio: settings.aspectRatio,
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

  // Settings come from the dashboard (validated above). Fal bills Hunyuan per
  // video, so these change render time, not price.
  const input: HunyuanVideoInput = {
    prompt: finalPrompt,
    aspect_ratio: settings.aspectRatio,
    resolution: settings.resolution,
    num_frames: settings.numFrames,
    enable_safety_checker: true,
  };

  // 4. Submit to Fal's queue — returns in about a second.
  try {
    const { request_id: requestId } = await getFal().queue.submit(HUNYUAN_T2V_ENDPOINT, { input });

    await prisma.videoClip.update({
      where: { id: clipId },
      data: { providerRequestId: requestId },
    });

    console.info(
      `[generate-video] clip ${clipId} submitted as Fal ${requestId} · ${settings.resolution} · ${settings.numFrames} frames · ${settings.aspectRatio} · character=${character?.characterName ?? "none"} · identity=${identity.mode}`,
    );

    return NextResponse.json(
      {
        clipId,
        settings,
        projectId,
        requestId,
        status: "IN_QUEUE",
        statusUrl: `/api/generate-video/${clipId}`,
        finalPrompt,
        cameraMovement,
        character: character
          ? { id: character.id, characterName: character.characterName }
          : null,
        identityMode: identity.mode,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof FalNotConfiguredError) {
      await markClipFailed(clipId, "FAL_KEY is not set.");
      return errorResponse(500, "SERVER_MISCONFIGURED", "Video engine is not configured.");
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
      console.error(`[generate-video] Fal submit error ${err.status}:`, err.body);
      await markClipFailed(clipId, `Fal submit error ${err.status}.`);
      switch (err.status) {
        case 401:
        case 403:
          return errorResponse(502, "PROVIDER_AUTH_FAILED", "Video engine rejected the API key.");
        case 402:
          return errorResponse(
            402,
            "PROVIDER_PAYMENT_REQUIRED",
            "The Fal account has no credit. Top up at fal.ai and retry.",
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
          });
      }
    }

    console.error("[generate-video] Unexpected submit error:", err);
    await markClipFailed(clipId, err instanceof Error ? err.message : "Unexpected error.");
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.", { clipId });
  }
}
