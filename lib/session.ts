import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * CineForge interim session layer (until full auth is wired in).
 *
 * Token format, sent as the `cf_session` cookie or `Authorization: Bearer`:
 *     <userId>.<expiresAtUnixSeconds>.<base64url HMAC-SHA256(userId.expiresAt)>
 * signed with SESSION_SECRET.
 *
 * Production: SESSION_SECRET is mandatory; every request needs a valid token.
 * Development: if SESSION_SECRET is unset, the claimed userId (or
 * NEXT_PUBLIC_CINEFORGE_USER_ID) is trusted, with a warning.
 */

export const SESSION_COOKIE = "cf_session";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionResult =
  | { ok: true; userId: string; enforced: boolean }
  | { ok: false; status: 401 | 403 | 500; code: string; message: string };

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Issues a token for `userId`. Call from your login route and set it as an httpOnly cookie. */
export function createSessionToken(userId: string, ttlSeconds = 60 * 60 * 24 * 7): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set.");
  const payload = `${userId.toLowerCase()}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  return `${payload}.${sign(payload, secret)}`;
}

function readToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim() || null;
  return req.cookies.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Resolves the signed-in user.
 * @param claimedUserId optional userId sent by the client; if present it must
 *   match the session, otherwise the request is treated as spoofed (403).
 */
export function verifySession(req: NextRequest, claimedUserId?: string | null): SessionResult {
  const claimed = claimedUserId ? claimedUserId.toLowerCase() : null;
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[session] SESSION_SECRET is not set in production.");
      return {
        ok: false,
        status: 500,
        code: "SERVER_MISCONFIGURED",
        message: "Authentication is not configured.",
      };
    }
    const devUserId = claimed ?? process.env.NEXT_PUBLIC_CINEFORGE_USER_ID?.toLowerCase() ?? null;
    if (!devUserId || !UUID_PATTERN.test(devUserId)) {
      return {
        ok: false,
        status: 401,
        code: "UNAUTHENTICATED",
        message: "No session, and no development user is configured.",
      };
    }
    console.warn("[session] ⚠ SESSION_SECRET unset — trusting client userId (development only).");
    return { ok: true, userId: devUserId, enforced: false };
  }

  const token = readToken(req);
  if (!token) {
    return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Sign in required." };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, code: "INVALID_SESSION", message: "Invalid session." };
  }
  const [tokenUserId = "", expiresAt = "", signature = ""] = parts;

  const expected = Buffer.from(sign(`${tokenUserId}.${expiresAt}`, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, status: 401, code: "INVALID_SESSION", message: "Invalid session." };
  }
  if (!UUID_PATTERN.test(tokenUserId)) {
    return { ok: false, status: 401, code: "INVALID_SESSION", message: "Invalid session." };
  }
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) * 1000 < Date.now()) {
    return { ok: false, status: 401, code: "SESSION_EXPIRED", message: "Session expired." };
  }

  const sessionUserId = tokenUserId.toLowerCase();
  if (claimed && claimed !== sessionUserId) {
    console.warn(`[session] Spoof attempt: session ${sessionUserId} claimed userId ${claimed}.`);
    return {
      ok: false,
      status: 403,
      code: "USER_ID_MISMATCH",
      message: "userId does not match the signed-in account.",
    };
  }

  return { ok: true, userId: sessionUserId, enforced: true };
}
