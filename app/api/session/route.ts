import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, createSessionToken } from "@/lib/session";

/**
 * Interim owner sign-in until real accounts exist.
 *   POST   /api/session  { accessKey }  → sets the signed cf_session cookie
 *   DELETE /api/session                  → clears it
 *
 * The owner is the user whose id is NEXT_PUBLIC_CINEFORGE_USER_ID; the row is
 * created on first sign-in. OWNER_ACCESS_KEY must be at least 16 characters.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Per-process brute-force limiter (one Railway replica).
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function keysMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const ownerKey = process.env.OWNER_ACCESS_KEY;
  const ownerId = process.env.NEXT_PUBLIC_CINEFORGE_USER_ID?.toLowerCase();
  if (!process.env.SESSION_SECRET || !ownerKey || ownerKey.length < 16 || !ownerId || !UUID_PATTERN.test(ownerId)) {
    console.error("[session] SESSION_SECRET, OWNER_ACCESS_KEY (16+ chars) and NEXT_PUBLIC_CINEFORGE_USER_ID are required.");
    return json(500, { error: "Sign-in is not configured.", code: "SERVER_MISCONFIGURED" });
  }

  if (rateLimited(clientIp(req))) {
    return json(429, { error: "Too many attempts. Wait a minute.", code: "RATE_LIMITED" });
  }

  let accessKey: unknown;
  try {
    ({ accessKey } = (await req.json()) as { accessKey?: unknown });
  } catch {
    return json(400, { error: "Request body is not valid JSON.", code: "INVALID_JSON" });
  }
  if (typeof accessKey !== "string" || accessKey.length === 0 || accessKey.length > 512) {
    return json(400, { error: "Access key is required.", code: "MISSING_FIELDS" });
  }
  if (!keysMatch(accessKey, ownerKey)) {
    return json(401, { error: "Invalid access key.", code: "INVALID_CREDENTIALS" });
  }

  try {
    await prisma.user.upsert({
      where: { id: ownerId },
      update: {},
      create: {
        id: ownerId,
        email: process.env.OWNER_EMAIL?.trim() || `owner+${ownerId.slice(0, 8)}@cineforge.local`,
        name: "Studio Owner",
      },
    });
  } catch (err) {
    console.error("[session] Could not create owner user:", err);
    return json(500, { error: "Database is unavailable.", code: "DATABASE_ERROR" });
  }

  const res = json(200, { ok: true, userId: ownerId });
  res.cookies.set(SESSION_COOKIE, createSessionToken(ownerId, SESSION_TTL_SECONDS), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = json(200, { ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
