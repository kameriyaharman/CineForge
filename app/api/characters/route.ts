import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma, type Character } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHARACTER_NAME_MAX = 80;
const URL_MAX_LENGTH = 2048;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const PROBE_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Letters (any script), numbers, spaces and a few name punctuation marks.
const CHARACTER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u;

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

interface RegisterCharacterBody {
  userId: string;
  characterName: string;
  referenceImageUrl: string;
}

interface ReferenceImageMeta {
  contentType: AllowedImageType;
  byteSize: number | null;
  host: string;
  finalUrl: string;
  probedAt: string;
}

interface RegisterCharacterSuccess {
  character: Character;
}

type CharacterSummary = Pick<
  Character,
  "id" | "characterName" | "referenceImageUrl" | "faceIdStatus" | "createdAt"
>;

interface ListCharactersSuccess {
  characters: CharacterSummary[];
}

interface ApiErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

type ParseResult =
  | { ok: true; data: RegisterCharacterBody }
  | { ok: false; code: string; message: string; details?: unknown };

interface ProbeResponse {
  status: number;
  headers: IncomingHttpHeaders;
}

/** Any failure of the reference-image checks. Carries the HTTP status to return. */
class ReferenceImageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 422,
    readonly code: string,
  ) {
    super(message);
    this.name = "ReferenceImageError";
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function errorResponse(
  status: number,
  code: string,
  error: string,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error, code, details },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/* ------------------------------ 1. Validation ----------------------------- */

function parseBody(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "INVALID_BODY", message: "Request body must be a JSON object." };
  }
  const { userId, characterName, referenceImageUrl } = body as Record<string, unknown>;

  const missing = (
    [
      ["userId", userId],
      ["characterName", characterName],
      ["referenceImageUrl", referenceImageUrl],
    ] as const
  )
    .filter(([, value]) => value === undefined || value === null || value === "")
    .map(([field]) => field);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "MISSING_FIELDS",
      message: `Missing required field(s): ${missing.join(", ")}.`,
      details: { missing },
    };
  }

  if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
    return { ok: false, code: "INVALID_USER_ID", message: "`userId` must be a valid UUID." };
  }

  if (typeof characterName !== "string") {
    return { ok: false, code: "INVALID_NAME", message: "`characterName` must be a string." };
  }
  const name = characterName.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > CHARACTER_NAME_MAX) {
    return {
      ok: false,
      code: "INVALID_NAME",
      message: `\`characterName\` must be 1–${CHARACTER_NAME_MAX} characters.`,
    };
  }
  if (!CHARACTER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      code: "INVALID_NAME",
      message:
        "`characterName` may contain letters, numbers, spaces, and . ' _ - and must start with a letter or number.",
    };
  }

  if (typeof referenceImageUrl !== "string" || referenceImageUrl.length > URL_MAX_LENGTH) {
    return {
      ok: false,
      code: "INVALID_URL",
      message: `\`referenceImageUrl\` must be a string of at most ${URL_MAX_LENGTH} characters.`,
    };
  }
  let url: URL;
  try {
    url = new URL(referenceImageUrl.trim());
  } catch {
    return { ok: false, code: "INVALID_URL", message: "`referenceImageUrl` is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, code: "INVALID_URL", message: "`referenceImageUrl` must use https." };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "`referenceImageUrl` must not contain credentials.",
    };
  }
  url.hash = "";

  return {
    ok: true,
    data: {
      userId: userId.toLowerCase(),
      characterName: name,
      referenceImageUrl: url.toString(),
    },
  };
}

/* ------------------------- 3. Session guardrail --------------------------- */
/*
 * The body's `userId` is attacker-controlled and never trusted on its own.
 * `verifySession` (lib/session.ts) checks the signed `cf_session` token and
 * rejects the request if the body's userId differs from the session (403).
 */

/* ------------------------ 2a. SSRF / IP protection ------------------------ */

function isBlockedIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved + broadcast
  );
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Everything starting with "::" — unspecified (::), loopback (::1),
  // IPv4-mapped (::ffff:7f00:1 / ::ffff:127.0.0.1) and IPv4-compatible forms.
  // URL parsing rewrites [::ffff:127.0.0.1] to hex, so match the prefix, not the text.
  if (lower.startsWith("::")) return true;
  return (
    lower.startsWith("fc") || // unique local
    lower.startsWith("fd") || // unique local (incl. AWS fd00:ec2::254 metadata)
    /^fe[89ab]/.test(lower) || // link-local
    lower.startsWith("ff") || // multicast
    lower.startsWith("64:ff9b:") // NAT64 → could map to private IPv4
  );
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an IP at all → block
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

/** Static checks on the hostname before any network activity. */
function assertAllowedHost(url: URL): void {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new ReferenceImageError("Reference image host is not allowed.", 400, "HOST_NOT_ALLOWED");
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new ReferenceImageError("Reference image host is not allowed.", 400, "HOST_NOT_ALLOWED");
  }
  if (url.port && url.port !== "443") {
    throw new ReferenceImageError(
      "Reference image must be served on the standard https port.",
      400,
      "PORT_NOT_ALLOWED",
    );
  }
}

/**
 * DNS lookup used for the actual socket connection. Checking the IP here —
 * at connect time — closes the DNS-rebinding gap where a host resolves to a
 * public IP during validation and a private one when the request is sent.
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 4);
      return;
    }
    const list = addresses as LookupAddress[];
    const blocked = list.length === 0 || list.some((a) => isBlockedAddress(a.address));
    if (blocked) {
      const error = Object.assign(new Error(`Blocked address for host ${hostname}`), {
        code: "EBLOCKEDADDRESS",
      }) as NodeJS.ErrnoException;
      callback(error, "", 4);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    } else {
      const first = list[0]!;
      callback(null, first.address, first.family);
    }
  });
};

/* ------------------------ 2b. Image metadata probe ------------------------ */

/** One HEAD (or ranged GET) request. Resolves on response headers; never reads the body. */
function probeOnce(
  url: URL,
  method: "HEAD" | "GET",
  extraHeaders: Record<string, string> = {},
): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: 443,
        path: `${url.pathname}${url.search}`,
        method,
        lookup: safeLookup,
        timeout: PROBE_TIMEOUT_MS,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: {
          "User-Agent": "CineForge-SoulID/1.0",
          Accept: "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1",
          ...extraHeaders,
        },
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
        res.destroy(); // never download the payload
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

function toProbeError(err: unknown): ReferenceImageError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = (err as Error | undefined)?.name;
  if (code === "EBLOCKEDADDRESS") {
    return new ReferenceImageError("Reference image host is not allowed.", 400, "HOST_NOT_ALLOWED");
  }
  if (code === "ETIMEDOUT" || name === "TimeoutError" || name === "AbortError") {
    return new ReferenceImageError(
      "Timed out while checking the reference image.",
      422,
      "IMAGE_PROBE_TIMEOUT",
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ReferenceImageError(
      "Reference image host could not be resolved.",
      422,
      "HOST_UNRESOLVABLE",
    );
  }
  return new ReferenceImageError("Could not reach the reference image URL.", 422, "IMAGE_UNREACHABLE");
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Inspects the reference image without downloading it: HEAD first, falling
 * back to a 1-byte ranged GET for hosts that reject HEAD. Follows up to
 * MAX_REDIRECTS redirects, re-validating every hop.
 */
async function probeReferenceImage(rawUrl: string): Promise<ReferenceImageMeta> {
  let current = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedHost(current);

    let res: ProbeResponse;
    try {
      res = await probeOnce(current, "HEAD");
      if (res.status === 405 || res.status === 403 || res.status === 501) {
        res = await probeOnce(current, "GET", { Range: "bytes=0-0" });
      }
    } catch (err) {
      throw toProbeError(err);
    }

    // Redirect → validate and follow.
    if (res.status >= 300 && res.status < 400) {
      const location = headerValue(res.headers, "location");
      if (!location) {
        throw new ReferenceImageError(
          "Reference image redirect is invalid.",
          422,
          "IMAGE_BAD_REDIRECT",
        );
      }
      const next = new URL(location, current);
      if (next.protocol !== "https:") {
        throw new ReferenceImageError(
          "Reference image redirects to a non-https URL.",
          422,
          "IMAGE_BAD_REDIRECT",
        );
      }
      current = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new ReferenceImageError(
        `Reference image URL returned HTTP ${res.status}.`,
        422,
        "IMAGE_UNREACHABLE",
      );
    }

    // Content-type allow-list.
    const contentType = (headerValue(res.headers, "content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)) {
      throw new ReferenceImageError(
        `Reference image must be JPEG, PNG or WebP (got "${contentType || "unknown"}").`,
        422,
        "IMAGE_UNSUPPORTED_TYPE",
      );
    }

    // Size: Content-Range ("bytes 0-0/12345") for ranged GETs, else Content-Length.
    const rangeTotal = headerValue(res.headers, "content-range")?.match(/\/(\d+)$/)?.[1] ?? null;
    const lengthHeader =
      rangeTotal ?? (res.status === 206 ? null : headerValue(res.headers, "content-length"));
    const byteSize =
      lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;

    if (byteSize !== null && byteSize > MAX_IMAGE_BYTES) {
      throw new ReferenceImageError(
        `Reference image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
        422,
        "IMAGE_TOO_LARGE",
      );
    }
    if (byteSize === 0) {
      throw new ReferenceImageError("Reference image is empty.", 422, "IMAGE_EMPTY");
    }

    return {
      contentType: contentType as AllowedImageType,
      byteSize,
      host: current.hostname,
      finalUrl: current.toString(),
      probedAt: new Date().toISOString(),
    };
  }

  throw new ReferenceImageError(
    "Too many redirects for reference image.",
    422,
    "IMAGE_TOO_MANY_REDIRECTS",
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Route                                   */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/characters?userId=<uuid> — list the caller's Soul ID characters.
 *   400  missing / invalid userId
 *   401 / 403  same session guardrail as POST
 *   200  { characters: [...] } newest first (max 60)
 */
export async function GET(
  req: NextRequest,
): Promise<NextResponse<ListCharactersSuccess | ApiErrorBody>> {
  const rawUserId = req.nextUrl.searchParams.get("userId");
  if (!rawUserId) {
    return errorResponse(400, "MISSING_FIELDS", "Missing required query parameter: userId.");
  }
  if (!UUID_PATTERN.test(rawUserId)) {
    return errorResponse(400, "INVALID_USER_ID", "`userId` must be a valid UUID.");
  }

  const session = verifySession(req, rawUserId.toLowerCase());
  if (!session.ok) {
    return errorResponse(session.status, session.code, session.message);
  }

  try {
    const characters = await prisma.character.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: {
        id: true,
        characterName: true,
        referenceImageUrl: true,
        faceIdStatus: true,
        createdAt: true,
      },
    });
    return NextResponse.json(
      { characters },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[characters:GET] Failed to list characters:", err);
    return errorResponse(500, "DATABASE_ERROR", "Could not load characters.");
  }
}

/**
 * POST /api/characters — register a Soul ID character.
 *
 * Order of checks (cheapest first, network last):
 *   400  body invalid / fields missing
 *   401  no or invalid session      403  body userId ≠ session userId
 *   404  user does not exist
 *   409  character name already used by this user
 *   400  image host is private / loopback / metadata
 *   422  image unreachable, wrong type, or over 15 MB
 *   201  saved (faceIdStatus = PENDING, ready for IP-Adapter-FaceID)
 *   500  database or server failure
 */
export async function POST(
  req: NextRequest,
): Promise<NextResponse<RegisterCharacterSuccess | ApiErrorBody>> {
  // 1. Parse + validate body.
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
  const { characterName, referenceImageUrl } = parsed.data;

  // 3. Session guardrail — reject spoofed userId before touching the database.
  const session = verifySession(req, parsed.data.userId);
  if (!session.ok) {
    return errorResponse(session.status, session.code, session.message);
  }
  const userId = session.userId;

  try {
    // User must exist.
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      return errorResponse(404, "USER_NOT_FOUND", "User not found.");
    }

    // Duplicate name for this user (case-insensitive) — checked before the network probe.
    const duplicate = await prisma.character.findFirst({
      where: { userId, characterName: { equals: characterName, mode: "insensitive" } },
      select: { id: true },
    });
    if (duplicate) {
      return errorResponse(
        409,
        "CHARACTER_NAME_TAKEN",
        `A character named "${characterName}" already exists for this user.`,
        { existingCharacterId: duplicate.id },
      );
    }

    // 2. SSRF-safe image inspection (headers only).
    const meta = await probeReferenceImage(referenceImageUrl);

    // 4. Persist.
    const character = await prisma.character.create({
      data: {
        userId,
        characterName,
        referenceImageUrl: meta.finalUrl,
        referenceImageMeta: { ...meta, sessionEnforced: session.enforced } satisfies Prisma.InputJsonObject,
        faceIdStatus: "PENDING",
      },
    });

    return NextResponse.json(
      { character },
      {
        status: 201,
        headers: {
          Location: `/api/characters/${character.id}`,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (err) {
    if (err instanceof ReferenceImageError) {
      return errorResponse(err.status, err.code, err.message);
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      switch (err.code) {
        case "P2002": // unique constraint — lost a race with a concurrent request
          return errorResponse(
            409,
            "CHARACTER_NAME_TAKEN",
            `A character named "${characterName}" already exists for this user.`,
          );
        case "P2003": // foreign key — user deleted mid-request
          return errorResponse(404, "USER_NOT_FOUND", "User not found.");
        case "P1001":
        case "P1002":
        case "P1008":
          console.error(`[characters:POST] Database unreachable (${err.code}).`);
          return errorResponse(500, "DATABASE_UNAVAILABLE", "Database is unavailable.");
        default:
          console.error(`[characters:POST] Prisma error ${err.code}:`, err.message);
          return errorResponse(500, "DATABASE_ERROR", "Could not save the character.");
      }
    }

    if (err instanceof Prisma.PrismaClientInitializationError) {
      console.error("[characters:POST] Database connection failed:", err.message);
      return errorResponse(500, "DATABASE_UNAVAILABLE", "Database is unavailable.");
    }

    console.error("[characters:POST] Unexpected error:", err);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}
