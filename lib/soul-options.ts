/**
 * Soul ID choices shared by the page and the API. Data only.
 *
 * Prices are Fal's list prices at the time of writing, shown as a guide.
 */

export const SOUL_TRAINING_PRESETS = [
  {
    value: "fast",
    label: "Fast",
    hint: "≈ $2 per hero · a few minutes · good likeness",
    priceLabel: "≈ $2",
  },
  {
    value: "portrait",
    label: "Portrait HQ",
    hint: "≈ $6 per hero · slower · sharper, more detailed faces",
    priceLabel: "≈ $6",
  },
] as const;

export type SoulTrainingPreset = (typeof SOUL_TRAINING_PRESETS)[number]["value"];

export function isSoulTrainingPreset(value: unknown): value is SoulTrainingPreset {
  return SOUL_TRAINING_PRESETS.some((p) => p.value === value);
}

/** How strongly the trained face is applied when generating. */
export const SOUL_LIKENESS_OPTIONS = [
  { value: 0.8, label: "Loose", hint: "More freedom for style and scene; face less exact" },
  { value: 1.0, label: "Balanced", hint: "Recommended" },
  { value: 1.2, label: "Strong", hint: "Closest likeness; can look stiff" },
] as const;

export type SoulLikeness = (typeof SOUL_LIKENESS_OPTIONS)[number]["value"];

export function isSoulLikeness(value: unknown): value is SoulLikeness {
  return SOUL_LIKENESS_OPTIONS.some((o) => o.value === value);
}

export const SOUL_PHOTO_MIN = 10;
export const SOUL_PHOTO_RECOMMENDED = "15–20";
export const SOUL_PHOTO_MAX = 30;
export const SOUL_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const SOUL_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const SOUL_NAME_MAX = 80;

export type SoulStatus = "NONE" | "TRAINING" | "READY" | "FAILED";

/** What the Soul ID list and detail endpoints return for each hero. */
export interface SoulHero {
  id: string;
  name: string;
  coverUrl: string | null;
  photoCount: number;
  status: SoulStatus;
  preset: SoulTrainingPreset | null;
  triggerWord: string | null;
  error: string | null;
  trainingStartedAt: string | null;
  trainingFinishedAt: string | null;
  createdAt: string;
}

export interface SoulPhoto {
  id: string;
  url: string | null;
  fileName: string | null;
}
