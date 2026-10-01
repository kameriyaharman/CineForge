/**
 * Video Studio (image-to-video) catalog — data only, shared by page and API.
 * Prices are Fal list prices (Sept/Oct 2026), USD per second of output video.
 */

export interface VideoOption<T extends string | number = string | number> {
  readonly value: T;
  readonly label: string;
  readonly hint: string;
}

export interface VideoModel {
  readonly id: string;
  readonly label: string;
  readonly vendor: string;
  readonly tagline: string;
  readonly priceLabel: string;
  /** Seconds the user can pick; first is the default. */
  readonly durations: readonly number[];
  /** Resolutions; empty = the model picks (follows the image). First is the default. */
  readonly resolutions: readonly string[];
  /** Format choices; empty = follows the image. */
  readonly aspects: readonly string[];
  /** Whether sound can be generated (and turned off to save money). */
  readonly audio: boolean;
  /** Is a motion prompt required? */
  readonly promptRequired: boolean;
  /** USD per second: [resolution][audio ? "audio" : "silent"]; "*" = any resolution. */
  readonly price: Readonly<Record<string, { silent: number; audio: number }>>;
}

export const VIDEO_MODELS = [
  {
    id: "veo31-lite",
    label: "Veo 3.1 Lite",
    vendor: "Google",
    tagline: "Best value — natural motion, optional sound",
    priceLabel: "≈ ₹2.6/s silent · ₹4.4/s with sound (720p)",
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    aspects: ["auto", "16:9", "9:16"],
    audio: true,
    promptRequired: true,
    price: { "720p": { silent: 0.03, audio: 0.05 }, "1080p": { silent: 0.05, audio: 0.08 } },
  },
  {
    id: "wan22",
    label: "Wan 2.2 · Budget",
    vendor: "Alibaba",
    tagline: "Cheap drafts, good camera moves, no sound",
    priceLabel: "≈ ₹3.5/s at 480p",
    durations: [3, 5, 10],
    resolutions: ["480p", "580p", "720p"],
    aspects: ["auto", "16:9", "9:16", "1:1"],
    audio: false,
    promptRequired: true,
    price: {
      "480p": { silent: 0.04, audio: 0.04 },
      "580p": { silent: 0.06, audio: 0.06 },
      "720p": { silent: 0.08, audio: 0.08 },
    },
  },
  {
    id: "ltx2-fast",
    label: "LTX-2 Fast",
    vendor: "Lightricks",
    tagline: "Full HD, long shots up to 20 s, with sound",
    priceLabel: "≈ ₹3.5/s at 1080p",
    durations: [6, 8, 10, 15, 20],
    resolutions: ["1080p", "1440p"],
    aspects: [],
    audio: true,
    promptRequired: true,
    price: { "1080p": { silent: 0.04, audio: 0.04 }, "1440p": { silent: 0.08, audio: 0.08 } },
  },
  {
    id: "kling3-std",
    label: "Kling 3 Standard",
    vendor: "Kuaishou",
    tagline: "Most cinematic motion and faces",
    priceLabel: "≈ ₹7.4/s silent · ₹11/s with sound",
    durations: [5, 10],
    resolutions: [],
    aspects: [],
    audio: true,
    promptRequired: false,
    price: { "*": { silent: 0.084, audio: 0.126 } },
  },
] as const satisfies readonly VideoModel[];

export type VideoModelId = (typeof VIDEO_MODELS)[number]["id"];

export function getVideoModel(id: unknown): VideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** Camera moves added to the motion prompt (user-picked, optional). */
export const CAMERA_MOVES = [
  { value: "none", label: "None", text: "" },
  { value: "static", label: "Static", text: "Static locked-off camera." },
  { value: "push-in", label: "Push in", text: "Slow cinematic dolly push-in toward the subject." },
  { value: "pull-back", label: "Pull back", text: "Slow dolly pull-back revealing the scene." },
  { value: "pan-left", label: "Pan left", text: "Smooth camera pan to the left." },
  { value: "pan-right", label: "Pan right", text: "Smooth camera pan to the right." },
  { value: "orbit", label: "Orbit", text: "Camera slowly orbits around the subject." },
  { value: "crane-up", label: "Crane up", text: "Camera cranes up and rises above the scene." },
  { value: "handheld", label: "Handheld", text: "Subtle handheld camera following the subject." },
] as const;

export type CameraMoveId = (typeof CAMERA_MOVES)[number]["value"];

export const VIDEO_PROMPT_MAX = 1500;

export const ASPECT_LABELS: Record<string, string> = {
  auto: "Match image",
  "16:9": "16:9",
  "9:16": "9:16",
  "1:1": "1:1",
};

/** Estimated USD for one clip. */
export function estimateVideoCost(
  modelId: string,
  durationSec: number,
  resolution: string | null,
  withAudio: boolean,
): number {
  const model = getVideoModel(modelId);
  if (!model) return 0;
  const row = model.price[resolution ?? ""] ?? model.price["*"] ?? Object.values(model.price)[0];
  if (!row) return 0;
  return Math.round((withAudio && model.audio ? row.audio : row.silent) * durationSec * 10000) / 10000;
}
