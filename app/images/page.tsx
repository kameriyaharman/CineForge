"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Dice5,
  Download,
  Expand,
  ImageIcon,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { SegmentedControl, type SegmentOption } from "@/components/segmented-control";
import {
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_ASPECT_OPTIONS,
  IMAGE_COUNT_OPTIONS,
  IMAGE_MODELS,
  modelsFor,
  IMAGE_PROMPT_MAX,
  IMAGE_PROMPT_MIN,
  STYLE_PRESETS,
  getImageModel,
  normalizeImageSettings,
  type ImageAspectRatio,
  type ImageCount,
  type ImageModel,
  type ImageSettings,
} from "@/lib/image-models";
import { SOUL_LIKENESS_OPTIONS, type SoulHero } from "@/lib/soul-options";
import { estimateImageCost } from "@/lib/prices";
import { formatInr, formatUsd, refreshAccount, useAccount } from "@/components/account-control";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

type Phase = "IN_QUEUE" | "GENERATING" | "COMPLETED" | "FAILED";

interface StudioImage {
  url: string;
  width: number | null;
  height: number | null;
  assetId: string | null;
}

interface GenerationStatus {
  generationId: string;
  status: Phase;
  queuePosition?: number;
  images: StudioImage[];
  requested: number;
  modelLabel: string;
  aspectRatio: string;
  quality: string | null;
  seed: number | null;
  error?: string;
  note?: string;
}

interface RecentImage {
  id: string;
  url: string | null;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface Viewing {
  url: string;
  assetId: string | null;
  prompt: string;
  caption: string;
}

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEY = "cineforge.imageSettings";
const POLL_MS = 2000;
const MAX_WAIT_MS = 11 * 60 * 1000;
const MAX_POLL_FAILURES = 6;

const PLACEHOLDER =
  "A lone detective in a rain-soaked trench coat under a flickering streetlamp, Mumbai alley at night, steam rising, reflections on wet stone…";

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function aspectStyle(ratio: string): string {
  const [w, h] = ratio.split(":");
  return `${w ?? 16} / ${h ?? 9}`;
}

function errorText(data: unknown, status: number): string {
  if (typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return `Request failed (HTTP ${status}).`;
}

function isStatus(value: unknown): value is GenerationStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GenerationStatus).generationId === "string" &&
    typeof (value as GenerationStatus).status === "string" &&
    Array.isArray((value as GenerationStatus).images)
  );
}

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v ? v : null;
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

function loadSettings(): ImageSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return normalizeImageSettings(JSON.parse(raw) as Partial<ImageSettings>);
  } catch {
    // storage blocked or corrupt — use defaults
  }
  return DEFAULT_IMAGE_SETTINGS;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

function downloadHref(img: { url: string; assetId: string | null }): string {
  return img.assetId ? `/api/assets/${img.assetId}?download=1` : img.url;
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function ImageStudioPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState<ImageSettings>(DEFAULT_IMAGE_SETTINGS);
  const [seedText, setSeedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [result, setResult] = useState<GenerationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ count: number; aspect: ImageAspectRatio } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [recent, setRecent] = useState<RecentImage[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [heroes, setHeroes] = useState<SoulHero[]>([]);
  const [heroesLoaded, setHeroesLoaded] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef<string | null>(null);
  const hydrated = useRef(false);

  const model: ImageModel = getImageModel(settings.model) ?? IMAGE_MODELS[0];
  const activeHero = heroes.find((h) => h.id === settings.characterId) ?? null;
  const trimmed = prompt.trim();
  const ready = trimmed.length >= IMAGE_PROMPT_MIN && trimmed.length <= IMAGE_PROMPT_MAX && !busy;

  /* ------------------------------ Persistence ------------------------------ */

  useEffect(() => {
    setSettings(loadSettings());
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(t);
  }, [busy]);

  /* -------------------------------- Toasts -------------------------------- */

  const notify = useCallback((tone: Toast["tone"], title: string, message?: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, tone, title, message }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);

  /* ----------------------------- Recent images ----------------------------- */

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/assets?kind=IMAGE&limit=18", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const data = (await res.json()) as { assets?: RecentImage[] };
      if (res.ok && Array.isArray(data.assets)) setRecent(data.assets);
    } catch {
      // the strip is optional; keep what we have
    } finally {
      setRecentLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  /* ------------------------------ Soul ID heroes ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/soul-id", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { heroes?: SoulHero[] };
        if (cancelled || !Array.isArray(data.heroes)) return;
        const ready = data.heroes.filter((h) => h.status === "READY");
        setHeroes(ready);
        // ?hero=<id> from the Soul ID page wins; otherwise keep the saved hero only if still ready.
        const wanted = new URLSearchParams(window.location.search).get("hero");
        setSettings((s) => {
          if (wanted && ready.some((h) => h.id === wanted)) return normalizeImageSettings({ ...s, characterId: wanted });
          if (s.characterId && !ready.some((h) => h.id === s.characterId)) {
            return normalizeImageSettings({ ...s, characterId: null });
          }
          return s;
        });
      } catch {
        // Soul ID is optional here
      } finally {
        if (!cancelled) setHeroesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------ Settings UI ------------------------------ */

  const update = (patch: Partial<ImageSettings>) =>
    setSettings((s) => normalizeImageSettings({ ...s, ...patch }));

  const aspectOptions = useMemo(
    () =>
      IMAGE_ASPECT_OPTIONS.filter((o) => (model.aspects as readonly string[]).includes(o.value)) as readonly SegmentOption<ImageAspectRatio>[],
    [model],
  );

  /* ------------------------------- Generate ------------------------------- */

  const generate = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (trimmed.length < IMAGE_PROMPT_MIN) {
      notify("error", "Add a prompt", "Describe the image you want first.");
      return;
    }
    if (trimmed.length > IMAGE_PROMPT_MAX) {
      notify("error", "Prompt too long", `Keep it under ${IMAGE_PROMPT_MAX} characters.`);
      return;
    }
    let seed: number | null = null;
    if (seedText.trim()) {
      const n = Number(seedText.trim());
      if (!Number.isInteger(n) || n < 0 || n > 2_147_483_647) {
        notify("error", "Invalid seed", "Use a whole number, or leave it empty for random.");
        return;
      }
      seed = n;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase("IN_QUEUE");
    setQueuePosition(null);
    setPending({ count: settings.numImages, aspect: settings.aspectRatio });

    try {
      const res = await fetch("/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          model: settings.model,
          aspectRatio: settings.aspectRatio,
          numImages: settings.numImages,
          style: settings.style,
          quality: settings.quality,
          characterId: settings.characterId,
          likeness: settings.characterId ? settings.likeness : undefined,
          seed,
        }),
        signal: controller.signal,
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // handled below
      }
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok || typeof (data as { generationId?: unknown })?.generationId !== "string") {
        throw new Error(errorText(data, res.status));
      }
      const generationId = (data as { generationId: string }).generationId;
      void refreshAccount();
      generationRef.current = generationId;

      const started = Date.now();
      let failures = 0;
      for (;;) {
        await sleep(POLL_MS, controller.signal);
        if (Date.now() - started > MAX_WAIT_MS) throw new Error("This is taking too long. Try again.");
        let status: GenerationStatus | null = null;
        try {
          const poll = await fetch(`/api/images/${generationId}`, { cache: "no-store", signal: controller.signal });
          const body: unknown = await poll.json().catch(() => null);
          if (poll.status === 401) {
            router.replace("/login");
            return;
          }
          if (poll.ok && isStatus(body)) {
            status = body;
            failures = 0;
          } else if (poll.status >= 500 || poll.status === 502) {
            failures += 1;
          } else {
            throw new Error(errorText(body, poll.status));
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          if (err instanceof Error && !(err instanceof TypeError)) throw err;
          failures += 1;
        }
        if (failures >= MAX_POLL_FAILURES) throw new Error("Lost contact with the server. Check the Library shortly.");
        if (!status) continue;

        setPhase(status.status);
        setQueuePosition(status.queuePosition ?? null);
        if (status.status === "COMPLETED") {
          setResult(status);
          notify(
            "success",
            `${status.images.length} image${status.images.length === 1 ? "" : "s"} ready`,
            status.note ?? "Saved to your Library.",
          );
          void loadRecent();
          break;
        }
        if (status.status === "FAILED") throw new Error(status.error ?? "The generation failed.");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      setPhase("FAILED");
      notify("error", "Generation failed", message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setPending(null);
    }
  };

  const cancel = async () => {
    const id = generationRef.current;
    abortRef.current?.abort();
    setBusy(false);
    setPending(null);
    setPhase(null);
    if (id) {
      await fetch(`/api/images/${id}`, { method: "DELETE" }).catch(() => undefined);
      notify("info", "Cancelled");
    }
  };

  const onPromptKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void generate();
    }
  };

  const reuse = (img: RecentImage) => {
    if (busy) return;
    if (img.prompt) setPrompt(img.prompt);
    const seed = metaNumber(img.meta, "seed");
    setSeedText(seed !== null ? String(seed) : "");
    const heroId = metaString(img.meta, "characterId");
    update({
      characterId: heroId && heroes.some((h) => h.id === heroId) ? heroId : null,
      likeness: metaNumber(img.meta, "likeness") ?? settings.likeness,
      model: (metaString(img.meta, "model") ?? settings.model) as ImageSettings["model"],
      aspectRatio: (metaString(img.meta, "aspectRatio") ?? settings.aspectRatio) as ImageAspectRatio,
      quality: metaString(img.meta, "quality"),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    notify("info", "Settings loaded", "Prompt, model, format and seed copied from that image.");
  };

  /* -------------------------------- Render -------------------------------- */

  const seconds = Math.floor(elapsed / 1000);
  const caption =
    phase === "IN_QUEUE"
      ? queuePosition !== null && queuePosition > 0
        ? `Waiting in queue · position ${queuePosition}`
        : "Sending to the model…"
      : "Generating…";

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#0B0F17] text-slate-100">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.16),transparent)]"
      />
      <AppHeader
        status={
          <>
            <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
            {activeHero ? `${activeHero.name} · ` : ""}
            {model.label} · {settings.aspectRatio} · ×{settings.numImages}
            {settings.quality ? ` · ${settings.quality}` : ""}
          </>
        }
      />

      <main className="relative z-10 mx-auto grid max-w-[1440px] items-start gap-6 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[420px_minmax(0,1fr)] xl:grid-cols-[460px_minmax(0,1fr)]">
        {/* ================================ Controls ================================ */}
        <section className="rounded-2xl border border-indigo-500/20 bg-[#0F1420]/90 p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur sm:p-6">
          <div className="mb-6 flex items-center gap-2.5">
            <Wand2 className="size-4 text-violet-300" aria-hidden />
            <h1 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">Image Studio</h1>
          </div>

          <form onSubmit={generate} noValidate className="space-y-6">
            {/* Prompt */}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <label htmlFor="image-prompt" className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
                  Prompt
                </label>
                <span
                  className={cx(
                    "font-mono text-[11px] tabular-nums",
                    trimmed.length > IMAGE_PROMPT_MAX ? "text-rose-400" : "text-slate-500",
                  )}
                >
                  {trimmed.length}/{IMAGE_PROMPT_MAX}
                </span>
              </div>
              <div className="group relative rounded-xl p-px transition-all duration-300 focus-within:bg-gradient-to-br focus-within:from-indigo-500/70 focus-within:via-violet-500/50 focus-within:to-fuchsia-500/40">
                <textarea
                  id="image-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onPromptKey}
                  disabled={busy}
                  rows={6}
                  placeholder={PLACEHOLDER}
                  className="block min-h-36 w-full resize-none rounded-[11px] border border-white/[0.08] bg-[#0B0F17] p-4 text-[15px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-600 group-focus-within:border-transparent disabled:opacity-60"
                />
              </div>
              <p className="text-xs text-slate-500">
                Press{" "}
                <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                  ⌘/Ctrl + Enter
                </kbd>{" "}
                to generate.
              </p>
            </div>

            {/* Soul ID */}
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
                Soul ID
              </legend>
              {heroesLoaded && heroes.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No trained heroes yet.{" "}
                  <Link href="/soul-id" className="text-indigo-300 hover:text-indigo-200">
                    Train one in Soul ID →
                  </Link>
                </p>
              ) : (
                <div role="radiogroup" aria-label="Soul ID hero" className="flex flex-wrap gap-1.5">
                  {[{ id: null as string | null, name: "No hero", coverUrl: null as string | null }, ...heroes].map((h) => {
                    const selected = settings.characterId === h.id;
                    return (
                      <button
                        key={h.id ?? "none"}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => update({ characterId: h.id })}
                        className={cx(
                          "flex h-9 items-center gap-2 rounded-full border pl-1 pr-3 text-xs transition-all disabled:opacity-60",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                          h.id === null && "pl-3",
                          selected
                            ? "border-indigo-400/60 bg-indigo-500/20 text-indigo-100"
                            : "border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-slate-200",
                        )}
                      >
                        {h.id !== null &&
                          (h.coverUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={h.coverUrl}
                              alt=""
                              className="size-7 rounded-full object-cover"
                              onError={(e) => {
                                e.currentTarget.style.visibility = "hidden";
                              }}
                            />
                          ) : (
                            <span className="flex size-7 items-center justify-center rounded-full bg-indigo-500/20 text-[10px] font-semibold">
                              {h.name.slice(0, 2).toUpperCase()}
                            </span>
                          ))}
                        {h.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {activeHero && (
                <>
                  <p className="text-[11px] text-slate-500">
                    {activeHero.name}&apos;s trained face is added to every image. Describe the scene, outfit and mood —
                    no need to describe the face.
                  </p>
                  <SegmentedControl<number>
                    label="Likeness"
                    options={SOUL_LIKENESS_OPTIONS}
                    value={settings.likeness}
                    onChange={(likeness) => update({ likeness })}
                    disabled={busy}
                  />
                </>
              )}
            </fieldset>

            {/* Model */}
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Model</legend>
              <div role="radiogroup" aria-label="Model" className="grid gap-2 sm:grid-cols-2">
                {modelsFor(settings.characterId !== null).map((m) => {
                  const selected = m.id === settings.model;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => update({ model: m.id as ImageSettings["model"] })}
                      className={cx(
                        "rounded-xl border p-3 text-left transition-all disabled:opacity-60",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                        selected
                          ? "border-indigo-400/60 bg-indigo-500/[0.12] shadow-[0_0_20px_-8px_rgba(129,140,248,0.8)]"
                          : "border-white/[0.08] bg-[#0B0F17] hover:border-white/20",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-100">{m.label}</span>
                        {selected && <CheckCircle2 className="size-4 shrink-0 text-indigo-300" aria-hidden />}
                      </div>
                      <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">{m.vendor}</p>
                      <p className="mt-1.5 text-xs leading-snug text-slate-400">{m.tagline}</p>
                      <p className="mt-2 font-mono text-[10px] text-slate-500">
                        {m.priceLabel} · {m.speedLabel}
                      </p>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Style */}
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Style</legend>
              <div role="radiogroup" aria-label="Style" className="flex flex-wrap gap-1.5">
                {STYLE_PRESETS.map((s) => {
                  const selected = s.id === settings.style;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={s.suffix || "Use your prompt as written"}
                      onClick={() => update({ style: s.id })}
                      className={cx(
                        "h-8 rounded-full border px-3 text-xs transition-all disabled:opacity-60",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                        selected
                          ? "border-violet-400/60 bg-violet-500/20 text-violet-100"
                          : "border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-slate-200",
                      )}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Output settings */}
            <div className="space-y-3">
              <span className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Output</span>
              <SegmentedControl
                label="Format"
                options={aspectOptions}
                value={settings.aspectRatio}
                onChange={(aspectRatio) => update({ aspectRatio })}
                disabled={busy}
              />
              <SegmentedControl<ImageCount>
                label="Images"
                options={IMAGE_COUNT_OPTIONS}
                value={settings.numImages}
                onChange={(numImages) => update({ numImages })}
                disabled={busy}
              />
              {model.qualities && settings.quality && (
                <SegmentedControl<string>
                  label="Size"
                  options={model.qualities}
                  value={settings.quality}
                  onChange={(quality) => update({ quality })}
                  disabled={busy}
                />
              )}
              <div className="flex items-start gap-3">
                <label htmlFor="seed" className="mt-2 w-20 shrink-0 text-xs text-slate-400">
                  Seed
                </label>
                <div className="flex min-w-0 flex-1 gap-2">
                  <input
                    id="seed"
                    inputMode="numeric"
                    value={seedText}
                    onChange={(e) => setSeedText(e.target.value.replace(/[^\d]/g, "").slice(0, 10))}
                    disabled={busy}
                    placeholder="Random"
                    className="h-10 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-[#0B0F17] px-3 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400/60 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => setSeedText(String(Math.floor(Math.random() * 2_147_483_647)))}
                    disabled={busy}
                    title="Pick a random seed"
                    className="flex size-10 items-center justify-center rounded-lg border border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-slate-200 disabled:opacity-60"
                  >
                    <Dice5 className="size-4" aria-hidden />
                    <span className="sr-only">Random seed</span>
                  </button>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Same seed + same prompt gives the same image. Leave it empty for a new take every time.
              </p>
            </div>

            {/* Generate */}
            {busy ? (
              <div className="space-y-3">
                <button
                  type="button"
                  disabled
                  aria-busy="true"
                  className="flex h-14 w-full items-center justify-center gap-2.5 rounded-xl border border-indigo-400/40 bg-gradient-to-r from-indigo-600/60 via-violet-600/60 to-indigo-600/60 text-sm font-semibold uppercase tracking-[0.2em] text-white/90"
                >
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Generating · {seconds}s
                </button>
                <button
                  type="button"
                  onClick={cancel}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 hover:border-rose-400/40 hover:text-rose-300"
                >
                  <Square className="size-3.5" aria-hidden />
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="submit"
                aria-disabled={!ready}
                className={cx(
                  "group flex h-14 w-full items-center justify-center gap-2.5 rounded-xl text-sm font-semibold uppercase tracking-[0.22em] transition-all",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                  ready
                    ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 text-white shadow-[0_0_30px_-6px_rgba(129,140,248,0.75)] hover:-translate-y-0.5"
                    : "border border-white/10 bg-white/[0.04] text-slate-500",
                )}
              >
                <Sparkles className="size-4" aria-hidden />
                Generate {settings.numImages > 1 ? `${settings.numImages} images` : "image"}
              </button>
            )}
            <CostLine usd={estimateImageCost(settings.model, settings.quality, settings.numImages)} />
          </form>
        </section>

        {/* ================================ Results ================================ */}
        <div className="space-y-6 lg:sticky lg:top-6">
          <section className="rounded-2xl border border-white/[0.06] bg-[#0F1420]/70 p-4 backdrop-blur sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <ImageIcon className="size-4 text-indigo-300" aria-hidden />
                <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">Results</h2>
              </div>
              {result && (
                <p className="font-mono text-[11px] text-slate-500">
                  {result.modelLabel} · {result.aspectRatio}
                  {result.quality ? ` · ${result.quality}` : ""}
                  {result.seed !== null ? ` · seed ${result.seed}` : ""}
                </p>
              )}
            </div>

            {busy && pending ? (
              <div className={cx("grid gap-3", pending.count > 1 && "sm:grid-cols-2")}>
                {Array.from({ length: pending.count }, (_, i) => (
                  <div
                    key={i}
                    style={{ aspectRatio: aspectStyle(pending.aspect) }}
                    className="relative flex max-h-[70vh] items-center justify-center overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03]"
                  >
                    <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-indigo-500/[0.06] via-transparent to-violet-500/[0.08]" />
                    {i === 0 && (
                      <div className="relative flex flex-col items-center gap-2 text-center">
                        <Loader2 className="size-6 animate-spin text-indigo-300" aria-hidden />
                        <p className="text-xs text-slate-400">{caption}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.04] px-6 py-14 text-center">
                <AlertTriangle className="size-7 text-rose-300" aria-hidden />
                <p className="max-w-md text-sm text-rose-200">{error}</p>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setPhase(null);
                  }}
                  className="mt-1 flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-slate-300 hover:border-white/20"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Dismiss
                </button>
              </div>
            ) : result && result.images.length > 0 ? (
              <div className={cx("grid gap-3", result.images.length > 1 && "sm:grid-cols-2")}>
                {result.images.map((img, i) => (
                  <figure
                    key={img.url}
                    className="group relative overflow-hidden rounded-xl border border-white/[0.07] bg-black"
                    style={{ aspectRatio: aspectStyle(result.aspectRatio) }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={`Generated image ${i + 1}`}
                      className="size-full cursor-zoom-in object-contain"
                      onClick={() =>
                        setViewing({
                          url: img.url,
                          assetId: img.assetId,
                          prompt: trimmed,
                          caption: `${result.modelLabel} · ${result.aspectRatio}${img.width && img.height ? ` · ${img.width}×${img.height}` : ""}`,
                        })
                      }
                    />
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                      <IconButton
                        label="View full size"
                        onClick={() =>
                          setViewing({ url: img.url, assetId: img.assetId, prompt: trimmed, caption: result.modelLabel })
                        }
                      >
                        <Expand className="size-4" aria-hidden />
                      </IconButton>
                      <a
                        href={downloadHref(img)}
                        download
                        target={img.assetId ? undefined : "_blank"}
                        rel="noreferrer"
                        className="pointer-events-auto flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/60 text-slate-200 backdrop-blur hover:border-indigo-400/60"
                        title="Download"
                      >
                        <Download className="size-4" aria-hidden />
                        <span className="sr-only">Download</span>
                      </a>
                      {img.assetId && (
                        <Link
                          href={`/edit?asset=${img.assetId}`}
                          className="pointer-events-auto flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/60 text-slate-200 backdrop-blur hover:border-indigo-400/60"
                          title="Edit, upscale or remove background"
                        >
                          <Wand2 className="size-4" aria-hidden />
                          <span className="sr-only">Edit</span>
                        </Link>
                      )}
                    </div>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/[0.1] px-6 py-20 text-center">
                <Sparkles className="size-8 text-slate-700" aria-hidden />
                <p className="text-sm text-slate-400">Your images appear here.</p>
                <p className="max-w-sm text-xs text-slate-500">
                  Pick a model and style, write a prompt, and generate up to 4 variations. Every image is saved to your
                  Library.
                </p>
              </div>
            )}
            {result?.note && <p className="mt-3 text-xs text-amber-300/80">{result.note}</p>}
          </section>

          {/* Recent */}
          <section className="rounded-2xl border border-white/[0.06] bg-[#0F1420]/50 p-4 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Recent images</h2>
              <a href="/library" className="text-xs text-indigo-300 hover:text-indigo-200">
                Open Library →
              </a>
            </div>
            {recentLoading ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="aspect-square animate-pulse rounded-lg bg-white/[0.04]" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <p className="text-xs text-slate-500">Nothing yet. Your first generation will show up here.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                {recent.map((img) => (
                  <div key={img.id} className="group relative aspect-square overflow-hidden rounded-lg border border-white/[0.06] bg-black">
                    {img.url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={img.url}
                        alt={img.prompt ?? "Generated image"}
                        loading="lazy"
                        className="size-full cursor-zoom-in object-cover transition-transform duration-300 group-hover:scale-105"
                        onClick={() =>
                          setViewing({
                            url: img.url!,
                            assetId: img.id,
                            prompt: img.prompt ?? "",
                            caption: [metaString(img.meta, "modelLabel"), metaString(img.meta, "aspectRatio")]
                              .filter(Boolean)
                              .join(" · "),
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => reuse(img)}
                      disabled={busy}
                      title="Reuse prompt & settings"
                      className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/60 text-slate-200 opacity-100 backdrop-blur transition-opacity hover:border-indigo-400/60 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      <span className="sr-only">Reuse prompt and settings</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {viewing && <Viewer viewing={viewing} onClose={() => setViewing(null)} />}

      {/* Toasts */}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur",
              t.tone === "success" && "border-emerald-400/30 bg-emerald-950/80 text-emerald-100",
              t.tone === "error" && "border-rose-400/30 bg-rose-950/80 text-rose-100",
              t.tone === "info" && "border-indigo-400/30 bg-[#141a2a]/90 text-slate-100",
            )}
          >
            <p className="font-medium">{t.title}</p>
            {t.message && <p className="mt-0.5 text-xs opacity-80">{t.message}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Components                                 */
/* -------------------------------------------------------------------------- */

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="pointer-events-auto flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/60 text-slate-200 backdrop-blur hover:border-indigo-400/60"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function Viewer({ viewing, onClose }: { viewing: Viewing; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={viewing.url} alt={viewing.prompt || "Generated image"} className="mx-auto max-h-[78vh] w-auto rounded-xl object-contain" />
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {viewing.caption && <p className="font-mono text-[11px] text-slate-400">{viewing.caption}</p>}
            {viewing.prompt && <p className="mt-1 line-clamp-3 text-sm text-slate-300">{viewing.prompt}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <a
              href={downloadHref(viewing)}
              download
              target={viewing.assetId ? undefined : "_blank"}
              rel="noreferrer"
              className="flex h-9 items-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-3 text-sm text-indigo-100 hover:bg-indigo-500/25"
            >
              <Download className="size-4" aria-hidden />
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-slate-300 hover:border-white/20"
            >
              <X className="size-4" aria-hidden />
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "Free sample in Test Mode" or the estimated Fal cost of this run. */
function CostLine({ usd }: { usd: number }) {
  const account = useAccount();
  if (!account) return null;
  return account.testMode ? (
    <p className="text-center text-[11px] text-amber-200/80">Test Mode · free sample, no Fal credit used</p>
  ) : (
    <p className="text-center text-[11px] text-slate-500">
      Estimated Fal cost: {formatUsd(usd)} ({formatInr(usd)})
    </p>
  );
}
