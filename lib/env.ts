/**
 * Startup check for the server's environment variables.
 * Called once from instrumentation.ts when the Node server boots.
 *
 * Required: the app cannot serve requests correctly without these. In
 * production a missing one stops the server from starting, so Railway reports
 * a failed deploy instead of the site silently throwing errors.
 * Optional: features degrade gracefully and a developer notice is logged.
 */

interface EnvRule {
  name: string;
  reason: string;
  check?: (value: string) => string | null;
}

const REQUIRED: EnvRule[] = [
  { name: "DATABASE_URL", reason: "PostgreSQL connection" },
  {
    name: "SESSION_SECRET",
    reason: "signing sign-in sessions",
    check: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  { name: "FAL_KEY", reason: "Hunyuan video renders on Fal" },
  {
    name: "OWNER_ACCESS_KEY",
    reason: "owner sign-in at /login",
    check: (v) => (v.length < 16 ? "must be at least 16 characters" : null),
  },
  {
    name: "NEXT_PUBLIC_CINEFORGE_USER_ID",
    reason: "owner account id",
    check: (v) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
        ? null
        : "must be a UUID",
  },
];

const OPTIONAL: EnvRule[] = [
  { name: "MAGNIFIC_API_KEY", reason: "4K upscale — without it clips are delivered as the raw render" },
  { name: "S3_BUCKET", reason: "asset library storage — without it renders keep only expiring provider links" },
  {
    name: "REPLICATE_API_TOKEN",
    reason: "Budget image model and Budget prompt edit (FLUX.2 Klein) — without it those two options fail; Fal models still work",
  },
];

export interface EnvReport {
  missing: string[];
  invalid: string[];
  optionalMissing: string[];
}

export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const rule of REQUIRED) {
    const value = env[rule.name]?.trim();
    if (!value) {
      missing.push(`${rule.name} (${rule.reason})`);
      continue;
    }
    const problem = rule.check?.(value);
    if (problem) invalid.push(`${rule.name} ${problem}`);
  }
  const optionalMissing = OPTIONAL.filter((r) => !env[r.name]?.trim()).map(
    (r) => `${r.name} — ${r.reason}`,
  );
  return { missing, invalid, optionalMissing };
}

export function validateEnvOnBoot(): void {
  const { missing, invalid, optionalMissing } = checkEnv();

  for (const notice of optionalMissing) {
    console.warn(`[env] DEV NOTICE: ${notice}.`);
  }

  if (missing.length === 0 && invalid.length === 0) {
    console.info("[env] All required environment variables are set.");
    return;
  }

  const lines = [
    ...missing.map((m) => `  • missing ${m}`),
    ...invalid.map((i) => `  • invalid: ${i}`),
  ];
  const message = `[env] Required environment variables are not configured:\n${lines.join("\n")}`;

  if (process.env.NODE_ENV === "production") {
    console.error(message);
    console.error("[env] CineForge cannot start. Set the variables above in Railway → Variables, then redeploy.");
    // Next.js swallows errors thrown from instrumentation and keeps serving a
    // broken app; exiting makes Railway mark the deploy as failed instead.
    process.exit(1);
  }
  console.warn(`${message}\n[env] Continuing because NODE_ENV is not production.`);
}
