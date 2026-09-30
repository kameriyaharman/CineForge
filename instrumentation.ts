/**
 * Next.js runs register() once when the server starts (not during `next build`).
 * Only the Node runtime has the full server environment, so this runs there.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { validateEnvOnBoot } = await import("./lib/env");
  validateEnvOnBoot();

  // Copy older finished renders into the Asset Library, after startup settles.
  setTimeout(() => {
    void import("./lib/assets").then(({ backfillClipArchives }) => backfillClipArchives());
  }, 5_000);
}
