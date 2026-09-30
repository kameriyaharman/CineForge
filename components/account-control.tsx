"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FlaskConical, Loader2, Wallet, X } from "lucide-react";

/* -------------------------------------------------------------------------- */
/*                         Shared account state (client)                      */
/* -------------------------------------------------------------------------- */

export interface AccountState {
  testMode: boolean;
  monthlyLimitUsd: number | null;
  spentThisMonthUsd: number;
}

/** Rough conversion for display only. */
const INR_PER_USD = 88;

let current: AccountState | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: AccountState) {
  current = next;
  listeners.forEach((l) => l());
}

/** Re-reads settings and spend from the server (e.g. after a paid request). */
export function refreshAccount(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch("/api/settings", { cache: "no-store" })
    .then(async (res) => {
      if (res.ok) emit((await res.json()) as AccountState);
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function saveAccount(patch: Partial<Pick<AccountState, "testMode" | "monthlyLimitUsd">>): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg ?? `Could not save (HTTP ${res.status}).`);
  }
  emit(data as AccountState);
}

/** Current account state; `null` until loaded. */
export function useAccount(): AccountState | null {
  const state = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
  useEffect(() => {
    if (!current) void refreshAccount();
  }, []);
  return state;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatInr(usd: number): string {
  return `≈ ₹${Math.round(usd * INR_PER_USD).toLocaleString("en-IN")}`;
}

/* -------------------------------------------------------------------------- */
/*                                  Components                                */
/* -------------------------------------------------------------------------- */

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Header pill + popover: Test Mode switch, spend this month, monthly limit. */
export function AccountControl() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitText, setLimitText] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setLimitText(account?.monthlyLimitUsd != null ? String(account.monthlyLimitUsd) : "");
      setError(null);
      void refreshAccount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = useCallback(async () => {
    if (!account) return;
    const next = !account.testMode;
    if (
      !next &&
      !window.confirm(
        "Turn Test Mode OFF?\n\nImages, videos and Soul ID training will run for real and use your Fal credit.",
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await saveAccount({ testMode: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [account]);

  const saveLimit = async () => {
    const trimmed = limitText.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setError("Enter a dollar amount like 5, or leave it empty for no limit.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveAccount({ monthlyLimitUsd: value });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const test = account?.testMode ?? true;
  const limit = account?.monthlyLimitUsd ?? null;
  const spent = account?.spentThisMonthUsd ?? 0;
  const pct = limit ? Math.min(100, (spent / Math.max(limit, 0.01)) * 100) : 0;

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cx(
          "flex h-9 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors sm:px-3",
          !account && "border-white/10 text-slate-500",
          account && test && "border-amber-400/50 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25",
          account && !test && "border-emerald-400/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20",
        )}
      >
        {test ? <FlaskConical className="size-4" aria-hidden /> : <Wallet className="size-4" aria-hidden />}
        <span className="hidden sm:inline">{!account ? "…" : test ? "Test Mode" : `Live · ${formatUsd(spent)}`}</span>
        <span className="sm:hidden">{!account ? "…" : test ? "Test" : "Live"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Test Mode and spending"
          className="absolute right-0 top-11 z-50 w-[min(340px,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-[#111727] p-4 text-sm shadow-2xl"
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">Spending</p>
            <button type="button" onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300">
              <X className="size-4" aria-hidden />
              <span className="sr-only">Close</span>
            </button>
          </div>

          {/* Test Mode switch */}
          <div className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#0B0F17] p-3">
            <div>
              <p className="font-medium text-slate-100">Test Mode</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                {test
                  ? "On: nothing is sent to Fal. You get sample results and no credit is used."
                  : "Off: everything runs for real and uses your Fal credit."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={test}
              aria-label="Test Mode"
              onClick={toggle}
              disabled={!account || saving}
              className={cx(
                "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60",
                test ? "bg-amber-500" : "bg-slate-600",
              )}
            >
              <span
                className={cx(
                  "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                  test ? "left-[22px]" : "left-0.5",
                )}
              />
            </button>
          </div>

          {/* Spend */}
          <div className="mt-3 rounded-xl border border-white/[0.08] bg-[#0B0F17] p-3">
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-slate-400">Spent this month (estimate)</p>
              <p className="font-mono text-slate-100">
                {formatUsd(spent)} <span className="text-xs text-slate-500">{formatInr(spent)}</span>
              </p>
            </div>
            {limit !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={cx("h-full rounded-full", pct >= 90 ? "bg-rose-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400")}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
            <label htmlFor="monthly-limit" className="mt-3 block text-xs text-slate-400">
              Monthly limit (USD) — paid work stops at this amount
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="monthly-limit"
                inputMode="decimal"
                value={limitText}
                onChange={(e) => setLimitText(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))}
                placeholder="No limit"
                className="h-9 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-[#0F1420] px-3 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400/60"
              />
              <button
                type="button"
                onClick={saveLimit}
                disabled={saving}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-3 text-xs text-indigo-100 hover:bg-indigo-500/25 disabled:opacity-60"
              >
                {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                Save
              </button>
            </div>
            {limitText.trim() !== "" && Number.isFinite(Number(limitText)) && (
              <p className="mt-1 text-[11px] text-slate-500">{formatInr(Number(limitText))} per month</p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Estimates from Fal’s list prices. Your exact bill is on fal.ai → Billing.
            </p>
          </div>

          {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Amber strip under the header while Test Mode is on. */
export function TestModeBanner() {
  const account = useAccount();
  if (!account?.testMode) return null;
  return (
    <div className="relative z-10 border-b border-amber-400/20 bg-amber-500/[0.08]">
      <p className="mx-auto flex max-w-[1440px] items-center gap-2 px-4 py-2 text-xs text-amber-100 sm:px-8">
        <FlaskConical className="size-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-semibold">Test Mode is on.</strong> Nothing is sent to Fal and no credit is used —
          results are samples. Switch it off from the button at the top right when you want real results.
        </span>
      </p>
    </div>
  );
}
