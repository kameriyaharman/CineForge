/**
 * Minimal Replicate client — server only. Uses the HTTP API directly:
 *   POST /v1/models/{owner}/{name}/predictions   create
 *   GET  /v1/predictions/{id}                    status / output
 *   POST /v1/predictions/{id}/cancel             cancel
 */

const API = "https://api.replicate.com/v1";

export class ReplicateNotConfiguredError extends Error {
  constructor() {
    super("REPLICATE_API_TOKEN is not set.");
    this.name = "ReplicateNotConfiguredError";
  }
}

export class ReplicateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReplicateError";
  }
}

export function isReplicateConfigured(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

function token(): string {
  const t = process.env.REPLICATE_API_TOKEN?.trim();
  if (!t) throw new ReplicateNotConfiguredError();
  return t;
}

export type PredictionStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

export interface Prediction {
  id: string;
  status: PredictionStatus;
  output: unknown;
  error: string | null;
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      (body as { detail?: unknown } | null)?.detail ?? (body as { error?: unknown } | null)?.error ?? text.slice(0, 300);
    throw new ReplicateError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

function toPrediction(body: unknown): Prediction {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    id: String(b.id ?? ""),
    status: (b.status as PredictionStatus) ?? "starting",
    output: b.output ?? null,
    error: typeof b.error === "string" ? b.error : b.error ? JSON.stringify(b.error) : null,
  };
}

/** Starts a prediction on an official model, e.g. "black-forest-labs/flux-2-klein-4b". */
export async function createPrediction(model: string, input: Record<string, unknown>): Promise<Prediction> {
  return toPrediction(await call(`/models/${model}/predictions`, { method: "POST", body: JSON.stringify({ input }) }));
}

export async function getPrediction(id: string): Promise<Prediction> {
  return toPrediction(await call(`/predictions/${encodeURIComponent(id)}`));
}

export async function cancelPrediction(id: string): Promise<void> {
  await call(`/predictions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/** Replicate image outputs are a URL or a list of URLs. */
export function outputUrls(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.filter((u): u is string => typeof u === "string");
  return [];
}

/** Prefix used in ImageGeneration.providerRequestId for Replicate jobs: "rep:id1,id2". */
export const REPLICATE_PREFIX = "rep:";

export function encodeReplicateIds(ids: string[]): string {
  return `${REPLICATE_PREFIX}${ids.join(",")}`;
}

export function decodeReplicateIds(requestId: string | null | undefined): string[] | null {
  if (!requestId?.startsWith(REPLICATE_PREFIX)) return null;
  return requestId.slice(REPLICATE_PREFIX.length).split(",").filter(Boolean);
}
