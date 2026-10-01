/**
 * Image editing tools (Step 4). Data only — shared by the Edit page and API.
 * Each run is stored as an ImageGeneration whose `model` is the tool id.
 */

export interface EditOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export interface EditTool {
  readonly id: string;
  readonly label: string;
  readonly group: "prompt" | "upscale" | "remove-bg";
  readonly tagline: string;
  readonly priceLabel: string;
  /** Size / factor choices; first is the default. */
  readonly options: readonly EditOption[];
  readonly optionLabel: string;
  readonly needsPrompt: boolean;
}

export const EDIT_TOOLS = [
  {
    id: "edit-klein",
    label: "Prompt edit · Budget",
    group: "prompt",
    tagline: "FLUX.2 Klein — cheapest, good for quick changes",
    priceLabel: "≈ ₹0.25 per edit",
    options: [
      { value: "1", label: "1 MP", hint: "Draft size" },
      { value: "2", label: "2 MP", hint: "Sharper" },
    ],
    optionLabel: "Size",
    needsPrompt: true,
  },
  {
    id: "edit-nano",
    label: "Prompt edit · Pro",
    group: "prompt",
    tagline: "Nano Banana Pro — best at following detailed edits",
    priceLabel: "≈ ₹13 per edit (4K ≈ ₹26)",
    options: [
      { value: "1K", label: "1K", hint: "Standard" },
      { value: "2K", label: "2K", hint: "Sharper" },
      { value: "4K", label: "4K", hint: "Double price" },
    ],
    optionLabel: "Size",
    needsPrompt: true,
  },
  {
    id: "upscale",
    label: "Upscale",
    group: "upscale",
    tagline: "SeedVR2 — sharper, bigger image",
    priceLabel: "≈ ₹1 (2×) · ≈ ₹3.5 (4×)",
    options: [
      { value: "2", label: "2×", hint: "Double width and height" },
      { value: "4", label: "4×", hint: "Four times — for print / 4K" },
    ],
    optionLabel: "Factor",
    needsPrompt: false,
  },
  {
    id: "remove-bg",
    label: "Remove background",
    group: "remove-bg",
    tagline: "BiRefNet — clean cut-out with transparent background",
    priceLabel: "≈ ₹0.20",
    options: [
      { value: "general", label: "General", hint: "Products, objects, people" },
      { value: "portrait", label: "Portrait", hint: "Best for people and hair" },
    ],
    optionLabel: "Mode",
    needsPrompt: false,
  },
] as const satisfies readonly EditTool[];

export type EditToolId = (typeof EDIT_TOOLS)[number]["id"];

export function getEditTool(id: unknown): EditTool | undefined {
  return EDIT_TOOLS.find((t) => t.id === id);
}

export function isEditToolId(id: unknown): id is EditToolId {
  return EDIT_TOOLS.some((t) => t.id === id);
}

/** Quick prompt ideas shown as chips on the Edit page. */
export const EDIT_PROMPT_IDEAS = [
  "Change the outfit to a black leather jacket",
  "Replace the background with a rainy neon street at night",
  "Make it golden hour with warm sunlight",
  "Add light rain and wet reflections",
  "Turn it into a night scene with moonlight",
  "Remove the people in the background",
] as const;

export const EDIT_PROMPT_MAX = 1000;
