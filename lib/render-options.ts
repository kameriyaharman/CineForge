/**
 * Render settings the user picks on the dashboard. Shared by the page (to draw
 * the choices) and the API (to validate them) — safe to import on both sides.
 *
 * These are exactly the values fal-ai/hunyuan-video accepts. Fal bills this
 * model per video, so resolution and length change render time, not price.
 */

export const DURATION_OPTIONS = [
  { value: 85, label: "3.5s", hint: "85 frames · faster" },
  { value: 129, label: "5.4s", hint: "129 frames · longer shot" },
] as const;

export const RESOLUTION_OPTIONS = [
  { value: "480p", label: "480p", hint: "Fastest" },
  { value: "580p", label: "580p", hint: "Balanced" },
  { value: "720p", label: "720p", hint: "Sharpest · slowest" },
] as const;

export const ASPECT_RATIO_OPTIONS = [
  { value: "16:9", label: "16:9", hint: "Landscape · film" },
  { value: "9:16", label: "9:16", hint: "Vertical · Reels / Shorts" },
] as const;

export type NumFrames = (typeof DURATION_OPTIONS)[number]["value"];
export type VideoResolution = (typeof RESOLUTION_OPTIONS)[number]["value"];
export type AspectRatio = (typeof ASPECT_RATIO_OPTIONS)[number]["value"];

export interface RenderSettings {
  numFrames: NumFrames;
  resolution: VideoResolution;
  aspectRatio: AspectRatio;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  numFrames: 85,
  resolution: "480p",
  aspectRatio: "16:9",
};

export function isNumFrames(value: unknown): value is NumFrames {
  return DURATION_OPTIONS.some((o) => o.value === value);
}

export function isVideoResolution(value: unknown): value is VideoResolution {
  return RESOLUTION_OPTIONS.some((o) => o.value === value);
}

export function isAspectRatio(value: unknown): value is AspectRatio {
  return ASPECT_RATIO_OPTIONS.some((o) => o.value === value);
}

export function durationLabel(numFrames: number): string {
  return DURATION_OPTIONS.find((o) => o.value === numFrames)?.label ?? `${numFrames} frames`;
}
