/**
 * Estimated Fal prices (USD, list prices Sept 2026). Shared by pages and API.
 * Estimates only — Fal's dashboard is the source of truth.
 */

export const PRICES = {
  video: { hunyuan: 0.4 },
  image: {
    // Replicate FLUX.2 Klein 4B: $0.001 per megapixel (quality = megapixels).
    "flux-2-klein": { "1": 0.001, "2": 0.002, "4": 0.004 },
    // Edits: Klein bills input + output megapixels; Nano Banana Pro per image.
    "edit-klein": { "1": 0.003, "2": 0.004 },
    "edit-nano": { "1K": 0.15, "2K": 0.15, "4K": 0.3 },
    // SeedVR2: $0.001 per output megapixel (estimate for a ~2 MP source).
    upscale: { "2": 0.01, "4": 0.04 },
    // BiRefNet: billed per compute second, effectively a fraction of a cent.
    "remove-bg": 0.002,
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

