/** Node-only startup work, loaded from instrumentation.ts. */
import { validateEnvOnBoot } from "./lib/env";
import { backfillClipArchives } from "./lib/assets";

validateEnvOnBoot();

// Copy older finished renders into the Asset Library, after startup settles.
setTimeout(() => void backfillClipArchives(), 5_000);
