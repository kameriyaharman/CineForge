import type { NextRequest } from "next/server";
import { UUID_PATTERN, json, jsonError } from "@/lib/api-helpers";
import { isFalConfigured } from "@/lib/render-pipeline";
import { verifySession } from "@/lib/session";
import { SoulError, loadHero, startTraining, toSoulHero } from "@/lib/soul-id";
import { isSoulTrainingPreset } from "@/lib/soul-options";

/**
 * POST /api/soul-id/{heroId}/train — { preset: "fast" | "portrait" }
 * Zips the photos, starts a paid Fal training, returns 202 with the hero.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ heroId: string }> }) {
  if (!isFalConfigured()) return jsonError(500, "SERVER_MISCONFIGURED", "Training engine is not configured (FAL_KEY).");
  const session = verifySession(req);
  if (!session.ok) return jsonError(session.status, session.code, session.message);
  const { heroId } = await params;
  if (!UUID_PATTERN.test(heroId)) return jsonError(400, "INVALID_ID", "Malformed hero id.");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const preset = (body as { preset?: unknown })?.preset;
  if (!isSoulTrainingPreset(preset)) return jsonError(400, "INVALID_PRESET", "Choose Fast or Portrait HQ.");

  try {
    await startTraining(heroId.toLowerCase(), session.userId, preset);
    const hero = await loadHero(heroId.toLowerCase(), session.userId);
    return json({ hero: hero ? await toSoulHero(hero) : null }, 202);
  } catch (err) {
    if (err instanceof SoulError) return jsonError(err.status, err.code, err.message);
    console.error("[soul-id] train failed:", err);
    return jsonError(500, "INTERNAL_ERROR", "Could not start training.");
  }
}
