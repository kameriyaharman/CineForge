import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Prisma } from "@/lib/generated/prisma/client";
import { getEditTool } from "@/lib/edit-tools";
import { getImageModel } from "@/lib/image-models";
import { prisma } from "@/lib/prisma";
import { isStorageConfigured, uploadReadable } from "@/lib/storage";

/**
 * Test Mode results — server only. Sample images/videos made locally so the
 * whole flow (queue → result → Library) can be tried without paying Fal.
 */

/** How long a sample "takes", so loading states can be seen. */
export const TEST_IMAGE_DELAY_MS = 3_000;
export const TEST_VIDEO_DELAY_MS = 8_000;
export const TEST_TRAINING_DELAY_MS = 20_000;
/** Marks a Soul ID "trained" in Test Mode (there is no real LoRA file). */
export const TEST_LORA_KEY = "test:no-lora";

const ASPECT_SIZE: Record<string, [number, number]> = {
  "16:9": [1600, 900],
  "21:9": [1680, 720],
  "4:3": [1600, 1200],
  "1:1": [1200, 1200],
  "3:4": [1200, 1600],
  "9:16": [900, 1600],
};

function esc(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function wrap(text: string, max: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > max) {
      out.push(line.trim());
      line = w;
      if (out.length === lines) break;
    } else line += " " + w;
  }
  if (out.length < lines && line.trim()) out.push(line.trim());
  if (words.join(" ").length > out.join(" ").length && out.length) out[out.length - 1] += "…";
  return out;
}

/** A labelled placeholder image in the requested aspect ratio. */
export function sampleImageSvg(opts: {
  aspectRatio: string;
  prompt: string;
  modelLabel: string;
  heroName: string | null;
  index: number;
}): { svg: string; width: number; height: number } {
  const [width, height] = ASPECT_SIZE[opts.aspectRatio] ?? [1600, 900];
  const hue = (opts.prompt.length * 37 + opts.index * 70) % 360;
  const size = Math.round(Math.min(width, height) / 14);
  const lines = wrap(opts.prompt, Math.max(24, Math.round(width / (size * 0.55))), 3);
  const cy = height / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,18%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,38%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<rect x="${size * 0.6}" y="${size * 0.6}" width="${width - size * 1.2}" height="${height - size * 1.2}" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="3" stroke-dasharray="14 10"/>
<g font-family="DejaVu Sans, Arial, sans-serif" text-anchor="middle" fill="#fff">
<text x="${width / 2}" y="${cy - size * 1.6}" font-size="${size}" font-weight="700">TEST MODE · SAMPLE ${opts.index + 1}</text>
<text x="${width / 2}" y="${cy - size * 0.6}" font-size="${size * 0.45}" fill="#c7d2fe">${esc(opts.modelLabel)}${opts.heroName ? ` · Soul ID: ${esc(opts.heroName)}` : ""} · no Fal credit used</text>
${lines.map((l, i) => `<text x="${width / 2}" y="${cy + size * (0.6 + i * 0.7)}" font-size="${size * 0.5}" fill="#e2e8f0">${esc(l)}</text>`).join("\n")}
</g></svg>`;
  return { svg, width, height };
}

/** Finishes a Test Mode image generation: sample images, saved like real ones. */
export async function finalizeTestGeneration(generationId: string): Promise<void> {
  const gen = await prisma.imageGeneration.findUnique({
    where: { id: generationId },
    select: {
      userId: true,
      model: true,
      prompt: true,
      aspectRatio: true,
      numImages: true,
      quality: true,
      stylePreset: true,
      loraScale: true,
      characterId: true,
      sourceAssetId: true,
      createdAt: true,
      character: { select: { characterName: true } },
    },
  });
  if (!gen) return;
  const modelLabel = getImageModel(gen.model)?.label ?? getEditTool(gen.model)?.label ?? gen.model;
  const heroName = gen.character?.characterName ?? null;
  const samples = Array.from({ length: gen.numImages }, (_, index) =>
    sampleImageSvg({ aspectRatio: gen.aspectRatio, prompt: gen.prompt, modelLabel, heroName, index }),
  );
  const outputs = samples.map((s) => ({
    url: `data:image/svg+xml;base64,${Buffer.from(s.svg).toString("base64")}`,
    width: s.width,
    height: s.height,
    contentType: "image/svg+xml",
  }));

  const claimed = await prisma.imageGeneration.updateMany({
    where: { id: generationId, status: "PROCESSING" },
    data: { status: "COMPLETED", outputs: outputs as unknown as Prisma.InputJsonArray },
  });
  if (claimed.count === 0 || !isStorageConfigured()) return;

  const stamp = gen.createdAt.toISOString().slice(0, 10);
  await Promise.all(
    samples.map(async (s, index) => {
      const key = `users/${gen.userId}/images/${stamp}/${generationId}-${index + 1}.svg`;
      try {
        await uploadReadable(Readable.from(Buffer.from(s.svg)), key, "image/svg+xml");
        await prisma.asset.create({
          data: {
            userId: gen.userId,
            generationId,
            kind: "IMAGE",
            role: "IMAGE",
            storageKey: key,
            contentType: "image/svg+xml",
            byteSize: BigInt(Buffer.byteLength(s.svg)),
            prompt: gen.prompt,
            meta: {
              testMode: true,
              model: gen.model,
              modelLabel,
              aspectRatio: gen.aspectRatio,
              quality: gen.quality,
              width: s.width,
              height: s.height,
              index: index + 1,
              characterName: heroName,
              characterId: gen.characterId,
              likeness: gen.loraScale,
              editOf: gen.sourceAssetId,
              tool: gen.sourceAssetId ? gen.model : null,
            } satisfies Prisma.InputJsonObject,
          },
        });
      } catch (err) {
        console.error(`[test-mode] sample image ${index + 1} of ${generationId} not saved:`, err);
      }
    }),
  );
  console.info(`[test-mode] generation ${generationId} completed with ${samples.length} sample image(s)`);
}

/** Public path of the bundled sample clip for an aspect ratio. */
export function sampleVideoPath(aspectRatio: string | null): string {
  return aspectRatio === "9:16" ? "/test-media/sample-9x16.mp4" : "/test-media/sample-16x9.mp4";
}

/** Copies the bundled sample clip into the bucket as the clip's render. */
export async function archiveTestClip(clipId: string, publicPath: string): Promise<void> {
  if (!isStorageConfigured()) return;
  try {
    const clip = await prisma.videoClip.findUnique({
      where: { id: clipId },
      select: {
        prompt: true,
        cameraMovement: true,
        resolution: true,
        numFrames: true,
        aspectRatio: true,
        project: { select: { userId: true } },
        character: { select: { characterName: true } },
        assets: { where: { role: "RENDER" }, select: { id: true } },
      },
    });
    if (!clip || clip.assets.length > 0) return;
    const userId = clip.project.userId;
    const key = `users/${userId}/videos/${new Date().toISOString().slice(0, 10)}/${clipId}-render.mp4`;
    const file = path.join(process.cwd(), "public", publicPath);
    await uploadReadable(createReadStream(file), key, "video/mp4");
    await prisma.asset.create({
      data: {
        userId,
        clipId,
        kind: "VIDEO",
        role: "RENDER",
        storageKey: key,
        contentType: "video/mp4",
        prompt: clip.prompt,
        meta: {
          testMode: true,
          cameraMovement: clip.cameraMovement,
          resolution: clip.resolution,
          numFrames: clip.numFrames,
          aspectRatio: clip.aspectRatio,
          characterName: clip.character?.characterName ?? null,
        } satisfies Prisma.InputJsonObject,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    console.error(`[test-mode] sample clip for ${clipId} not saved:`, err);
  }
}
