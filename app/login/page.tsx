"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Aperture, KeyRound, Loader2 } from "lucide-react";

interface SessionError {
  error: string;
  code: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [accessKey, setAccessKey] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessKey.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ accessKey: accessKey.trim() }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => null)) as SessionError | null;
      setError(data?.error ?? `Sign-in failed (${res.status}).`);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#0B0F17] px-4 font-sans text-slate-100 antialiased">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.18),transparent)]"
      />
      <form
        onSubmit={handleSubmit}
        noValidate
        className="relative w-full max-w-sm space-y-5 rounded-2xl border border-indigo-500/20 bg-[#0F1420]/90 p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg border border-indigo-400/40 bg-indigo-500/10 shadow-[0_0_20px_-4px_rgba(129,140,248,0.6)]">
            <Aperture className="size-5 text-indigo-300" aria-hidden />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Cine<span className="text-indigo-300">Forge</span>
          </span>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="access-key"
            className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400"
          >
            Studio Access Key
          </label>
          <div className="relative">
            <KeyRound
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-600"
              aria-hidden
            />
            <input
              id="access-key"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              disabled={submitting}
              className="h-12 w-full rounded-lg border border-white/[0.08] bg-[#0B0F17] pl-9 pr-3 text-sm text-slate-100 outline-none transition-all focus:border-indigo-400/70 focus:shadow-[0_0_20px_-6px_rgba(129,140,248,0.7)]"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-2 text-xs text-rose-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !accessKey.trim()}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-indigo-400/60 bg-gradient-to-r from-indigo-600 to-violet-600 text-sm font-semibold uppercase tracking-[0.2em] text-white shadow-[0_0_30px_-6px_rgba(129,140,248,0.75)] transition-all hover:shadow-[0_0_45px_-4px_rgba(139,92,246,0.95)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Enter Studio
        </button>
      </form>
    </main>
  );
}
