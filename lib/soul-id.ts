import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { ApiError } from "@fal-ai/client";
import archiver from "archiver";
import {
  SpendLimitError,
  TEST_PREFIX,
  assertWithinLimit,
  estimateTrainingCost,
  isTestMode,
  isTestRequest,
  recordSpend,
} from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { TEST_LORA_KEY, TEST_TRAINING_DELAY_MS } from "@/lib/test-mode";
import { getFal } from "@/lib/render-pipeline";
import type { SoulHero, SoulTrainingPreset } from "@/lib/soul-options";
import { SOUL_PHOTO_MIN, isSoulTrainingPreset } from "@/lib/soul-options";
import {
  archiveFromUrl,
  deleteObject,
  getObjectStream,
  isStorageConfigured,
  presignGet,
  uploadReadable,
} from "@/lib/storage";

/**
 * Soul ID — server only.
 * Photos live privately in the bucket. Training zips them, hands Fal a
 * short-lived link, and copies the trained LoRA back into the bucket so it
 * never expires.
 */

const TRAINERS: Record<SoulTrainingPreset, { endpoint: string; input: (zipUrl: string, trigger: string) => Record<string, unknown> }> = {
  // Fal bills fast training linearly by steps ($2 at 1000), so 500 steps ≈ $1.
  trial: {
    endpoint: "fal-ai/flux-lora-fast-training",
    input: (zipUrl, trigger) => ({
      images_data_url: zipUrl,
      trigger_word: trigger,
      create_masks: true,
      is_style: false,
      steps: 500,
    }),
  },
  fast: {
    endpoint: "fal-ai/flux-lora-fast-training",
    input: (zipUrl, trigger) => ({
      images_data_url: zipUrl,
      trigger_word: trigger,
      create_masks: true,
      is_style: false,
      steps: 1000,
    }),
  },
  portrait: {
    endpoint: "fal-ai/flux-lora-portrait-trainer",
    input: (zipUrl, trigger) => ({
      images_data_url: zipUrl,
      trigger_phrase: trigger,
      steps: 2500,
      multiresolution_training: true,
      subject_crop: true,
      create_masks: true,
    }),
  },
};

/** A training still unfinished after this long is failed. */
export const TRAINING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Links handed to Fal must outlive a slow queue. */
const TRAINING_LINK_TTL_S = 6 * 60 * 60;

export class SoulError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SoulError";
  }
}

export function soulPrefix(userId: string, characterId: string): string {
  return `users/${userId}/soul/${characterId}`;
}

function zipKey(userId: string, characterId: string): string {
  return `${soulPrefix(userId, characterId)}/training.zip`;
}

/** A rare, per-hero token the LoRA learns the face under. */
export function newTriggerWord(): string {
  return `cf${randomBytes(4).toString("hex")}`;
}

export const heroSelect = {
  id: true,
  userId: true,
  characterName: true,
  referenceImageUrl: true,
  soulStatus: true,
  soulPreset: true,
  triggerWord: true,
  loraKey: true,
  trainingRequestId: true,
  trainingError: true,
  trainingStartedAt: true,
  trainingFinishedAt: true,
  createdAt: true,
  _count: { select: { photos: true } },
  photos: { select: { storageKey: true }, orderBy: { createdAt: "asc" as const }, take: 1 },
} as const;

type HeroRow = NonNullable<Awaited<ReturnType<typeof loadHero>>>;

export async function loadHero(id: string, userId: string) {
  return prisma.character.findFirst({ where: { id, userId }, select: heroSelect });
}

export async function toSoulHero(row: HeroRow): Promise<SoulHero> {
  let coverUrl: string | null = null;
  const first = row.photos[0]?.storageKey;
  if (first && isStorageConfigured()) {
    coverUrl = await presignGet(first).catch(() => null);
  } else if (/^https:\/\//.test(row.referenceImageUrl)) {
    coverUrl = row.referenceImageUrl;
  }
  return {
    id: row.id,
    name: row.characterName,
    coverUrl,
    photoCount: row._count.photos,
    status: row.soulStatus,
    preset: isSoulTrainingPreset(row.soulPreset) ? row.soulPreset : null,
    triggerWord: row.triggerWord,
    error: row.trainingError,
    trainingStartedAt: row.trainingStartedAt?.toISOString() ?? null,
    trainingFinishedAt: row.trainingFinishedAt?.toISOString() ?? null,
    testOnly: row.loraKey === TEST_LORA_KEY,
    createdAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Training                                 */
/* -------------------------------------------------------------------------- */

/** Zips the hero's photos into the bucket, streaming one photo at a time. */
async function buildTrainingZip(userId: string, characterId: string): Promise<string> {
  const photos = await prisma.characterPhoto.findMany({
    where: { characterId },
    select: { storageKey: true, contentType: true },
    orderBy: { createdAt: "asc" },
  });
  const key = zipKey(userId, characterId);
  const archive = archiver("zip", { zlib: { level: 0 } }); // photos are already compressed
  const out = new PassThrough();
  archive.pipe(out);
  const uploaded = uploadReadable(out, key, "application/zip");

  const done = new Promise<void>((resolve, reject) => {
    archive.on("error", reject);
    out.on("error", reject);
    archive.on("end", () => resolve());
  });

  for (const [i, photo] of photos.entries()) {
    const ext = photo.contentType === "image/png" ? "png" : photo.contentType === "image/webp" ? "webp" : "jpg";
    const stream = await getObjectStream(photo.storageKey);
    const entryDone = new Promise<void>((resolve) => archive.once("entry", () => resolve()));
    archive.append(stream, { name: `photo_${String(i + 1).padStart(2, "0")}.${ext}` });
    await entryDone;
  }
  await archive.finalize();
  await Promise.all([done, uploaded]);
  return key;
}

/**
 * Starts (or restarts) training. Claims the hero first so two clicks can't
 * start two paid trainings.
 */
export async function startTraining(characterId: string, userId: string, preset: SoulTrainingPreset): Promise<void> {
  if (!isStorageConfigured()) throw new SoulError(500, "STORAGE_NOT_CONFIGURED", "Photo storage is not configured.");

  const hero = await loadHero(characterId, userId);
  if (!hero) throw new SoulError(404, "NOT_FOUND", "Hero not found.");
  if (hero._count.photos < SOUL_PHOTO_MIN) {
    throw new SoulError(422, "NOT_ENOUGH_PHOTOS", `Add at least ${SOUL_PHOTO_MIN} photos before training.`);
  }

  const testMode = await isTestMode(userId);
  if (!testMode) {
    try {
      await assertWithinLimit(userId, estimateTrainingCost(preset));
    } catch (err) {
      if (err instanceof SpendLimitError) throw new SoulError(402, "SPEND_LIMIT_REACHED", err.message);
      throw err;
    }
  }

  const trigger = hero.triggerWord ?? newTriggerWord();
  const claimed = await prisma.character.updateMany({
    where: { id: characterId, userId, soulStatus: { not: "TRAINING" } },
    data: {
      soulStatus: "TRAINING",
      soulPreset: preset,
      triggerWord: trigger,
      trainingRequestId: null,
      trainingError: null,
      trainingStartedAt: new Date(),
      trainingFinishedAt: null,
    },
  });
  if (claimed.count === 0) throw new SoulError(409, "ALREADY_TRAINING", "This hero is already training.");

  if (testMode) {
    await prisma.character.update({
      where: { id: characterId },
      data: { trainingRequestId: `${TEST_PREFIX}${characterId}-${Date.now()}` },
    });
    console.info(`[soul-id] hero ${characterId} training started in TEST MODE (no Fal call)`);
    return;
  }

  try {
    const key = await buildTrainingZip(userId, characterId);
    const zipUrl = await presignGet(key, undefined, TRAINING_LINK_TTL_S);
    const trainer = TRAINERS[preset];
    const { request_id: requestId } = await getFal().queue.submit(trainer.endpoint, {
      input: trainer.input(zipUrl, trigger),
    });
    await prisma.character.update({ where: { id: characterId }, data: { trainingRequestId: requestId } });
    await recordSpend(
      userId,
      "TRAINING",
      characterId,
      estimateTrainingCost(preset),
      `Soul ID training · ${hero.characterName} · ${preset}`,
    );
    console.info(
      `[soul-id] hero ${characterId} training submitted as Fal ${requestId} · ${preset} · ${hero._count.photos} photos`,
    );
  } catch (err) {
    const message =
      err instanceof ApiError
        ? err.status === 402
          ? "The Fal account has no credit. Top up at fal.ai and retry."
          : `Fal refused the training (HTTP ${err.status}).`
        : "Could not start training.";
    console.error(
      `[soul-id] hero ${characterId} training start failed:`,
      err instanceof ApiError ? `HTTP ${err.status} ${JSON.stringify(err.body ?? null)}` : err,
    );
    await prisma.character.update({
      where: { id: characterId },
      data: { soulStatus: "FAILED", trainingError: message, trainingFinishedAt: new Date() },
    });
    await deleteObject(zipKey(userId, characterId)).catch(() => undefined);
    throw new SoulError(err instanceof ApiError && err.status === 402 ? 402 : 502, "TRAINING_START_FAILED", message);
  }
}

async function failTraining(hero: HeroRow, message: string): Promise<void> {
  await prisma.character.updateMany({
    where: { id: hero.id, soulStatus: "TRAINING" },
    data: { soulStatus: "FAILED", trainingError: message, trainingFinishedAt: new Date() },
  });
  await deleteObject(zipKey(hero.userId, hero.id)).catch(() => undefined);
}

/**
 * Checks Fal for a hero that is training and finalises it when done.
 * Cheap to call on every page poll. Returns the fresh row.
 */
export async function refreshTraining(hero: HeroRow): Promise<HeroRow> {
  if (hero.soulStatus !== "TRAINING") return hero;
  const endpoint = TRAINERS[isSoulTrainingPreset(hero.soulPreset) ? hero.soulPreset : "fast"].endpoint;
  const age = Date.now() - (hero.trainingStartedAt?.getTime() ?? hero.createdAt.getTime());

  // Test Mode: "finishes" after a short wait with no real face file.
  if (isTestRequest(hero.trainingRequestId)) {
    if (age < TEST_TRAINING_DELAY_MS) return hero;
    await prisma.character.updateMany({
      where: { id: hero.id, soulStatus: "TRAINING", trainingRequestId: hero.trainingRequestId },
      data: {
        soulStatus: "READY",
        // Keep a real face file from an earlier live training if there is one.
        loraKey: hero.loraKey && hero.loraKey !== TEST_LORA_KEY ? hero.loraKey : TEST_LORA_KEY,
        trainingError: null,
        trainingFinishedAt: new Date(),
      },
    });
    return (await loadHero(hero.id, hero.userId)) ?? hero;
  }

  try {
    if (!hero.trainingRequestId) {
      // Zipping/submitting happens inside the start request; a long gap means it died.
      if (age > 15 * 60 * 1000) await failTraining(hero, "Training was interrupted before it reached Fal. Try again.");
      return (await loadHero(hero.id, hero.userId)) ?? hero;
    }

    const fal = getFal();
    const status = await fal.queue.status(endpoint, { requestId: hero.trainingRequestId, logs: false });
    if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS") {
      if (age > TRAINING_TIMEOUT_MS) {
        await fal.queue.cancel(endpoint, { requestId: hero.trainingRequestId }).catch(() => undefined);
        await failTraining(hero, "Training ran for over 2 hours and was cancelled.");
        return (await loadHero(hero.id, hero.userId)) ?? hero;
      }
      return hero;
    }

    let output: unknown;
    try {
      output = (await fal.queue.result(endpoint, { requestId: hero.trainingRequestId })).data;
    } catch (err) {
      console.error(`[soul-id] hero ${hero.id} training result error:`, err instanceof ApiError ? err.body : err);
      await failTraining(hero, "Fal reported the training failed. Check the photos and try again.");
      return (await loadHero(hero.id, hero.userId)) ?? hero;
    }

    const loraUrl = (output as { diffusers_lora_file?: { url?: unknown } } | null)?.diffusers_lora_file?.url;
    if (typeof loraUrl !== "string" || !loraUrl.startsWith("https://")) {
      console.error(`[soul-id] hero ${hero.id} training returned no LoRA:`, output);
      await failTraining(hero, "Training finished but returned no model file.");
      return (await loadHero(hero.id, hero.userId)) ?? hero;
    }

    // Keep our own copy — provider links expire.
    const key = `${soulPrefix(hero.userId, hero.id)}/lora-${Date.now()}.safetensors`;
    await archiveFromUrl(loraUrl, key, "application/octet-stream");
    const previous = hero.loraKey === TEST_LORA_KEY ? null : hero.loraKey;
    const updated = await prisma.character.updateMany({
      where: { id: hero.id, soulStatus: "TRAINING", trainingRequestId: hero.trainingRequestId },
      data: { soulStatus: "READY", loraKey: key, trainingError: null, trainingFinishedAt: new Date() },
    });
    if (updated.count === 0) {
      await deleteObject(key).catch(() => undefined); // another poll finished it first
    } else {
      console.info(`[soul-id] hero ${hero.id} is READY (${key})`);
      if (previous && previous !== key) await deleteObject(previous).catch(() => undefined);
      await deleteObject(zipKey(hero.userId, hero.id)).catch(() => undefined);
    }
    return (await loadHero(hero.id, hero.userId)) ?? hero;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      await failTraining(hero, "Fal no longer knows this training job.");
      return (await loadHero(hero.id, hero.userId)) ?? hero;
    }
    console.error(
      `[soul-id] hero ${hero.id} status check failed:`,
      err instanceof ApiError ? `HTTP ${err.status} ${JSON.stringify(err.body ?? null)}` : err,
    );
    return hero; // try again on the next poll
  }
}

/** A fresh link to the hero's LoRA for one generation. */
export async function loraLinkFor(loraKey: string): Promise<string> {
  return presignGet(loraKey, undefined, 60 * 60);
}

/** Removes every stored file for the hero (photos, zip, LoRA). */
export async function deleteHeroFiles(userId: string, characterId: string, loraKey: string | null): Promise<void> {
  const photos = await prisma.characterPhoto.findMany({ where: { characterId }, select: { storageKey: true } });
  const keys = [...photos.map((p) => p.storageKey), zipKey(userId, characterId), ...(loraKey && loraKey !== TEST_LORA_KEY ? [loraKey] : [])];
  await Promise.all(keys.map((k) => deleteObject(k).catch(() => undefined)));
}
