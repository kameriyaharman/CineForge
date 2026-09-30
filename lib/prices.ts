/**
 * Estimated Fal prices (USD, list prices Sept 2026). Shared by pages and API.
 * Estimates only — Fal's dashboard is the source of truth.
 */

export const PRICES = {
  video: { hunyuan: 0.4 },
  image: {
    "flux-2-flash": 0.01, // $0.005/MP, our sizes are ~2 MP
    "flux-pro-ultra": 0.06,
    "seedream-4.5": 0.04,
    "nano-banana-pro": { "1K": 0.15, "2K": 0.15, "4K": 0.3 },
    "flux-lora-soul": { standard: 0.035, hd: 0.07 },
  },
  training: { trial: 1, fast: 2, portrait: 6 },
} as const;

export function estimateImageCost(model: string, quality: string | null, count: number): number {
  const table = PRICES.image as Record<string, number | Record<string, number>>;
  const entry = table[model];
  let each = 0;
  if (typeof entry === "number") each = entry;
  else if (entry) each = entry[quality ?? ""] ?? Math.max(...Object.values(entry));
  return round(each * count);
}

export function estimateTrainingCost(preset: string): number {
  return (PRICES.training as Record<string, number>)[preset] ?? PRICES.training.portrait;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

