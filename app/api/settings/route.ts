import type { NextRequest } from "next/server";
import { json, jsonError } from "@/lib/api-helpers";
import { getAccountState } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/session";

/**
 * GET /api/settings → { testMode, monthlyLimitUsd, spentThisMonthUsd }
 * PUT /api/settings   { testMode?: boolean, monthlyLimitUsd?: number | null }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT_USD = 100_000;

export async function GET(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  try {
    return json(await getAccountState(session.userId));
  } catch (err) {
    console.error("[settings] read failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not load settings.");
  }
}

export async function PUT(req: NextRequest) {
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    if (typeof raw !== "object" || raw === null) throw new Error();
    body = raw as Record<string, unknown>;
  } catch {
    return jsonError(400, "INVALID_JSON", "Body must be a JSON object.");
  }

  const data: { testMode?: boolean; monthlyLimitUsd?: number | null } = {};
  if ("testMode" in body) {
    if (typeof body.testMode !== "boolean") return jsonError(400, "INVALID_BODY", "testMode must be true or false.");
    data.testMode = body.testMode;
  }
  if ("monthlyLimitUsd" in body) {
    const v = body.monthlyLimitUsd;
    if (v === null) data.monthlyLimitUsd = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_LIMIT_USD) {
      data.monthlyLimitUsd = Math.round(v * 100) / 100;
    } else return jsonError(400, "INVALID_BODY", `Monthly limit must be between 0 and ${MAX_LIMIT_USD} USD, or empty.`);
  }
  if (Object.keys(data).length === 0) return jsonError(400, "INVALID_BODY", "Nothing to update.");

  try {
    const updated = await prisma.user.updateMany({ where: { id: session.userId }, data });
    if (updated.count === 0) return jsonError(404, "USER_NOT_FOUND", "Signed-in user no longer exists.");
    console.info(`[settings] user ${session.userId} updated ${JSON.stringify(data)}`);
    return json(await getAccountState(session.userId));
  } catch (err) {
    console.error("[settings] update failed:", err);
    return jsonError(500, "DATABASE_ERROR", "Could not save settings.");
  }
}
