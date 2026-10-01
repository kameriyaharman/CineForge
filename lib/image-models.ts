/**
 * Image Studio catalog — the text-to-image models, aspect ratios and style
 * presets the user picks from. Shared by the page (to draw the choices) and the
 * API (to validate them), so it holds data only — no secrets, no Fal calls.
 *
 * Prices are Fal's list prices at the time of writing, shown as a guide only.
 */

export const IMAGE_ASPECT_OPTIONS = [
  { value: "16:9", label: "16:9", hint: "Landscape · film frame" },
  { value: "21:9", label: "21:9", hint: "Anamorphic · ultra-wide" },
  { value: "4:3", label: "4:3", hint: "Classic landscape" },
  { value: "1:1", label: "1:1", hint: "Square" },
  { value: "3:4", label: "3:4", hint: "Portrait · poster" },
  { value: "9:16", label: "9:16", hint: "Vertical · Reels / Shorts" },
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_OPTIONS)[number]["value"];

export const IMAGE_COUNT_OPTIONS = [
  { value: 1, label: "1", hint: "One image" },
  { value: 2, label: "2", hint: "Two variations" },
  { value: 3, label: "3", hint: "Three variations" },
  { value: 4, label: "4", hint: "Four variations" },
] as const;

export type ImageCount = (typeof IMAGE_COUNT_OPTIONS)[number]["value"];

export interface ImageQualityOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export interface ImageModel {
  /** CineForge id, stored on each generation. */
  readonly id: string;
  readonly label: string;
  readonly vendor: string;
  /** One line on what it's good at. */
  readonly tagline: string;
  /** Approximate price per image, for the picker. */
  readonly priceLabel: string;
  readonly speedLabel: string;
  readonly aspects: readonly ImageAspectRatio[];
  /** Output-size choices, when the model offers them. First is the default. */
  readonly qualities?: readonly ImageQualityOption[];
  /** Uses a trained Soul ID face; only offered when a hero is selected. */
  readonly soul?: boolean;
}

export const IMAGE_MODELS = [
  {
    id: "flux-2-klein",
    label: "FLUX.2 Klein · Budget",
    vendor: "Black Forest Labs · via Replicate",
    tagline: "Cheapest — great for drafts and exploring ideas",
    priceLabel: "≈ $0.001 / image (≈ ₹0.09) at 1 MP",
    speedLabel: "~2 s",
    aspects: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
    qualities: [
      { value: "1", label: "1 MP", hint: "Draft size · ≈ ₹0.09 per image" },
      { value: "2", label: "2 MP", hint: "Sharper · ≈ ₹0.18 per image" },
      { value: "4", label: "4 MP", hint: "Largest · ≈ ₹0.35 per image" },
    ],
  },
  {
    id: "flux-2-flash",
    label: "FLUX.2 Flash",
    vendor: "Black Forest Labs",
    tagline: "Fast, cheap drafts to explore ideas",
    priceLabel: "≈ $0.01 / image",
    speedLabel: "~3 s",
    aspects: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
  },
  {
    id: "flux-pro-ultra",
    label: "FLUX1.1 Pro Ultra",
    vendor: "Black Forest Labs",
    tagline: "Photoreal 4MP stills, strong film look",
    priceLabel: "≈ $0.06 / image",
    speedLabel: "~10 s",
    aspects: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
  },
  {
    id: "seedream-4.5",
    label: "Seedream 4.5",
    vendor: "ByteDance",
    tagline: "Sharp 2K+ detail, good with text in frame",
    priceLabel: "≈ $0.04 / image",
    speedLabel: "~15 s",
    aspects: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
  },
  {
    id: "nano-banana-pro",
    label: "Nano Banana Pro",
    vendor: "Google",
    tagline: "Best prompt understanding, up to 4K",
    priceLabel: "≈ $0.15 / image (4K costs more)",
    speedLabel: "~20 s",
    aspects: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
    qualities: [
      { value: "1K", label: "1K", hint: "Standard size · cheapest" },
      { value: "2K", label: "2K", hint: "Sharper" },
      { value: "4K", label: "4K", hint: "Print / key art · highest price" },
    ],
  },
  {
    id: "flux-lora-soul",
    label: "FLUX Soul ID",
    vendor: "Black Forest Labs + your hero",
    tagline: "Your trained hero's face in any scene",
    priceLabel: "≈ $0.035 / image (HD ≈ $0.07)",
    speedLabel: "~10 s",
    aspects: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
    qualities: [
      { value: "standard", label: "Standard", hint: "About 1 megapixel · cheapest" },
      { value: "hd", label: "HD", hint: "About 2 megapixels · double price" },
    ],
    soul: true,
  },
] as const satisfies readonly ImageModel[];

export type ImageModelId = (typeof IMAGE_MODELS)[number]["id"];

export interface StylePreset {
  readonly id: string;
  readonly label: string;
  /** Appended to the user's prompt. Empty for "None". */
  readonly suffix: string;
}

export const STYLE_PRESETS = [
  { id: "none", label: "None", suffix: "" },
  {
    id: "cinematic",
    label: "Cinematic",
    suffix:
      "cinematic film still, anamorphic lens, shallow depth of field, dramatic lighting, rich color grading, 35mm film grain",
  },
  {
    id: "photoreal",
    label: "Photoreal",
    suffix: "ultra-realistic photograph, natural skin texture, 85mm lens, soft natural light, high detail",
  },
  {
    id: "noir",
    label: "Noir",
    suffix: "film noir, high-contrast black and white, hard shadows, venetian-blind light, smoky atmosphere",
  },
  {
    id: "golden-hour",
    label: "Golden Hour",
    suffix: "golden hour backlight, warm sun flare, long soft shadows, dreamy haze",
  },
  {
    id: "neon",
    label: "Neon Night",
    suffix: "rain-soaked neon night, cyan and magenta reflections, moody cyberpunk atmosphere",
  },
  {
    id: "anime",
    label: "Anime",
    suffix: "high-quality anime key visual, clean line art, cel shading, vibrant palette",
  },
  {
    id: "concept-art",
    label: "Concept Art",
    suffix: "cinematic concept art, matte painting, epic scale, painterly detail",
  },
  {
    id: "product",
    label: "Product",
    suffix: "premium product photography, studio lighting, seamless backdrop, crisp reflections",
  },
] as const satisfies readonly StylePreset[];

export type StylePresetId = (typeof STYLE_PRESETS)[number]["id"];

export const IMAGE_PROMPT_MIN = 3;
export const IMAGE_PROMPT_MAX = 2000;

export interface ImageSettings {
  model: ImageModelId;
  aspectRatio: ImageAspectRatio;
  numImages: ImageCount;
  style: StylePresetId;
  /** Only for models with `qualities`. */
  quality: string | null;
  /** Soul ID hero whose trained face to use; forces the Soul ID model. */
  characterId: string | null;
  /** LoRA strength for the Soul ID face. */
  likeness: number;
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  model: "flux-2-klein",
  aspectRatio: "16:9",
  numImages: 2,
  style: "cinematic",
  quality: null,
  characterId: null,
  likeness: 1.0,
};

export const SOUL_IMAGE_MODEL_ID = "flux-lora-soul";

/** Models offered in the picker: the Soul ID model with a hero, the others without. */
export function modelsFor(hasHero: boolean): readonly ImageModel[] {
  return IMAGE_MODELS.filter((m) => Boolean((m as ImageModel).soul) === hasHero);
}

export function getImageModel(id: unknown): ImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return IMAGE_ASPECT_OPTIONS.some((o) => o.value === value);
}

export function isImageCount(value: unknown): value is ImageCount {
  return IMAGE_COUNT_OPTIONS.some((o) => o.value === value);
}

export function getStylePreset(id: unknown): StylePreset | undefined {
  return STYLE_PRESETS.find((s) => s.id === id);
}

/** The prompt actually sent to the model. */
export function buildImagePrompt(prompt: string, style: StylePreset | undefined): string {
  const base = prompt.trim();
  if (!style || !style.suffix) return base;
  return `${base.replace(/[.\s]+$/, "")}. ${style.suffix}`;
}

/** Keeps saved settings valid when the model list or a model's options change. */
export function normalizeImageSettings(input: Partial<ImageSettings>): ImageSettings {
  const characterId = typeof input.characterId === "string" && input.characterId ? input.characterId : null;
  const picked = getImageModel(input.model);
  const model =
    characterId !== null
      ? getImageModel(SOUL_IMAGE_MODEL_ID)!
      : picked && !picked.soul
        ? picked
        : getImageModel(DEFAULT_IMAGE_SETTINGS.model)!;
  const aspectRatio =
    isImageAspectRatio(input.aspectRatio) && model.aspects.includes(input.aspectRatio)
      ? input.aspectRatio
      : model.aspects.includes(DEFAULT_IMAGE_SETTINGS.aspectRatio)
        ? DEFAULT_IMAGE_SETTINGS.aspectRatio
        : (model.aspects[0] ?? DEFAULT_IMAGE_SETTINGS.aspectRatio);
  const numImages = isImageCount(input.numImages) ? input.numImages : DEFAULT_IMAGE_SETTINGS.numImages;
  const style = getStylePreset(input.style)?.id ?? DEFAULT_IMAGE_SETTINGS.style;
  const quality = model.qualities
    ? (model.qualities.find((q) => q.value === input.quality)?.value ?? model.qualities[0]?.value ?? null)
    : null;
  return {
    model: model.id as ImageModelId,
    aspectRatio,
    numImages,
    style: style as StylePresetId,
    quality,
    characterId,
    likeness:
      typeof input.likeness === "number" && [0.8, 1.0, 1.2].includes(input.likeness)
        ? input.likeness
        : DEFAULT_IMAGE_SETTINGS.likeness,
  };
}
