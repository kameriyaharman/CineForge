import { ApiError, ValidationError } from "@fal-ai/client";
import { markGenerationFailed } from "@/lib/image-pipeline";
import { FalNotConfiguredError } from "@/lib/render-pipeline";
import { ReplicateError, ReplicateNotConfiguredError } from "@/lib/replicate";

/**
 * Maps a provider submit error (Fal or Replicate) to an HTTP answer and marks
 * the generation FAILED with a message the user can act on.
 */
export async function handleSubmitError(
  err: unknown,
  generationId: string,
  tag: string,
): Promise<{ status: number; code: string; message: string; details?: unknown }> {
  if (err instanceof FalNotConfiguredError) {
    await markGenerationFailed(generationId, "FAL_KEY is not set.");
    return { status: 500, code: "SERVER_MISCONFIGURED", message: "Fal is not configured (FAL_KEY)." };
  }
  if (err instanceof ReplicateNotConfiguredError) {
    const message = "The Budget model needs a Replicate API token. Add REPLICATE_API_TOKEN on Railway, or pick another model.";
    await markGenerationFailed(generationId, message);
    return { status: 500, code: "REPLICATE_NOT_CONFIGURED", message };
  }
  if (err instanceof ValidationError) {
    await markGenerationFailed(generationId, `Provider validation failed: ${JSON.stringify(err.fieldErrors)}`);
    return {
      status: 422,
      code: "PROVIDER_VALIDATION_FAILED",
      message: "The model rejected these settings.",
      details: err.fieldErrors,
    };
  }
  if (err instanceof ApiError || err instanceof ReplicateError) {
    const provider = err instanceof ApiError ? "Fal" : "Replicate";
    const detail = err instanceof ReplicateError ? ` ${err.message}` : "";
    console.error(`[${tag}] ${provider} submit error ${err.status}:`, err instanceof ApiError ? err.body : err.message);
    await markGenerationFailed(generationId, `${provider} submit error ${err.status}.${detail}`.slice(0, 500));
    switch (err.status) {
      case 401:
      case 403:
        return { status: 502, code: "PROVIDER_AUTH_FAILED", message: `${provider} rejected the API key.` };
      case 402:
        return {
          status: 402,
          code: "PROVIDER_PAYMENT_REQUIRED",
          message: `The ${provider} account has no credit. Top it up and retry.`,
        };
      case 422:
        return { status: 422, code: "PROVIDER_VALIDATION_FAILED", message: `${provider} rejected the settings.${detail}` };
      case 429:
        return { status: 429, code: "PROVIDER_RATE_LIMITED", message: "Too many requests at once. Try again shortly." };
      default:
        return { status: 502, code: "PROVIDER_ERROR", message: `${provider} returned an error.${detail}` };
    }
  }
  console.error(`[${tag}] unexpected submit error:`, err);
  await markGenerationFailed(generationId, err instanceof Error ? err.message : "Unexpected error.");
  return { status: 500, code: "INTERNAL_ERROR", message: "Unexpected server error." };
}
