/**
 * Next.js runs register() once when the server starts (not during `next build`).
 * The Node-only work lives in instrumentation-node.ts; this branch pattern keeps
 * it (and the database driver) out of the edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
