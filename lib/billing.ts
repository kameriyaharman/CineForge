import { prisma } from "@/lib/prisma";

/**
 * Test Mode + spend tracking — server only.
 *
 * Test Mode: nothing is sent to Fal; routes return sample results for free.
 * Live mode: each paid request records its estimated Fal cost, and requests
 * that would push this month past the user's limit are refused up front.
 *
 * Prices are Fal list prices (Sept 2026) and are estimates — Fal's own
 * dashboard is the source of truth.
 */

import { PRICES, estimateImageCost, estimateTrainingCost } from "@/lib/prices";

export { PRICES, estimateImageCost, estimateTrainingCost };

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Start of the current month in India time (the owner's timezone). */
function monthStart(now = new Date()): Date {
  const IST_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS);
}

export interface AccountState {
  testMode: boolean;
  monthlyLimitUsd: number | null;
  spentThisMonthUsd: number;
}

export async function getAccountState(userId: string): Promise<AccountState> {
  const [user, sum] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { testMode: true, monthlyLimitUsd: true } }),
    prisma.spendLog.aggregate({
      where: { userId, createdAt: { gte: monthStart() } },
      _sum: { amountUsd: true },
    }),
  ]);
  return {
    // Unknown user → behave as Test Mode, never spend by accident.
    testMode: user?.testMode ?? true,
    monthlyLimitUsd: user?.monthlyLimitUsd ?? null,
    spentThisMonthUsd: round(sum._sum.amountUsd ?? 0),
  };
}

export async function isTestMode(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { testMode: true } });
  return user?.testMode ?? true;
}

export class SpendLimitError extends Error {
  constructor(
    readonly spent: number,
    readonly limit: number,
    readonly estimate: number,
  ) {
    super(
      `Monthly limit reached: $${spent.toFixed(2)} of $${limit.toFixed(2)} used, and this needs about $${estimate.toFixed(2)}. Raise the limit or turn on Test Mode.`,
    );
    this.name = "SpendLimitError";
  }
}

/** Throws SpendLimitError if `estimate` would take this month past the limit. */
export async function assertWithinLimit(userId: string, estimate: number): Promise<void> {
  const state = await getAccountState(userId);
  if (state.monthlyLimitUsd === null) return;
  if (state.spentThisMonthUsd + estimate > state.monthlyLimitUsd + 1e-9) {
    throw new SpendLimitError(state.spentThisMonthUsd, state.monthlyLimitUsd, estimate);
  }
}

/** Records a paid request's estimated cost. Never throws. */
export async function recordSpend(
  userId: string,
  kind: "IMAGE" | "VIDEO" | "TRAINING",
  refId: string | null,
  amountUsd: number,
  description: string,
): Promise<void> {
  try {
    await prisma.spendLog.create({
      data: { userId, kind, refId, amountUsd: round(amountUsd), description: description.slice(0, 200) },
    });
  } catch (err) {
    console.error("[billing] could not record spend:", err);
  }
}

/** Marks provider request ids created in Test Mode. */
export const TEST_PREFIX = "test-";
export function isTestRequest(requestId: string | null | undefined): boolean {
  return typeof requestId === "string" && requestId.startsWith(TEST_PREFIX);
}
