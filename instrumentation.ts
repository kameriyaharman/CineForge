/**
 * Next.js runs register() once when the server starts (not during `next build`).
 * Only the Node runtime has the full server environment, so the check runs there.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { validateEnvOnBoot } = await import("./lib/env");
  validateEnvOnBoot();
}
