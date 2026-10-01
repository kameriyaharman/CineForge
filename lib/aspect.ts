import { IMAGE_ASPECT_OPTIONS } from "@/lib/image-models";

/** Nearest of our aspect ratios for an image (meta.aspectRatio wins, else width/height). */
export function nearestAspect(width: number | null, height: number | null, known: unknown): string | null {
  if (typeof known === "string" && IMAGE_ASPECT_OPTIONS.some((o) => o.value === known)) return known;
  if (!width || !height) return null;
  const r = width / height;
  let best: string | null = null;
  let diff = Infinity;
  for (const o of IMAGE_ASPECT_OPTIONS) {
    const [w, h] = o.value.split(":").map(Number);
    const d = Math.abs(Math.log(r / (w! / h!)));
    if (d < diff) {
      diff = d;
      best = o.value;
    }
  }
  return best;
}

export function metaNum(meta: unknown, key: string): number | null {
  const v = (meta as Record<string, unknown> | null)?.[key];
  return typeof v === "number" ? v : null;
}
