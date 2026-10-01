"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  ImagePlus,
  Loader2,
  Sparkles,
  Square,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { formatInr, formatUsd, refreshAccount, useAccount } from "@/components/account-control";
import { SegmentedControl } from "@/components/segmented-control";
import {
  ASPECT_LABELS,
  CAMERA_MOVES,
  VIDEO_MODELS,
  VIDEO_PROMPT_MAX,
  estimateVideoCost,
  getVideoModel,
  type VideoModel,
  type VideoModelId,
} from "@/lib/video-models";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

interface LibraryItem {
  id: string;
  kind: "IMAGE" | "VIDEO";
  role: string;
  url: string | null;
  contentType: string;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface ClipStatus {
  clipId: string;
  status: "IN_QUEUE" | "RENDERING" | "COMPLETED" | "FAILED";
  queuePosition?: number;
  videoUrl: string | null;
  assetId: string | null;
  modelLabel: string;
  durationSec: number | null;
  resolution: string | null;
  withAudio: boolean | null;
  testMode: boolean;
  error?: string;
}

interface Settings {
  model: VideoModelId;
  duration: Record<string, number>;
  resolution: Record<string, string>;
  aspect: Record<string, string>;
  audio: boolean;
  camera: string;
}

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEY = "cineforge.videoSettings";
const POLL_MS = 4000;
const MAX_WAIT_MS = 32 * 60 * 1000;
const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"];
const UPLOAD_MAX = 20 * 1024 * 1024;

const DEFAULT_SETTINGS: Settings = {
  model: "veo31-lite",
  duration: {},
  resolution: {},
  aspect: {},
  audio: false,
  camera: "push-in",
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${res.status}).`;
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

function cleanPrompt(p: string | null): string {
  return (p ?? "").replace(/\[[A-Z]+:[^\]]*\]/g, "").trim();
}

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
      if (!getVideoModel(s.model)) s.model = DEFAULT_SETTINGS.model;
      if (!CAMERA_MOVES.some((c) => c.value === s.camera)) s.camera = DEFAULT_SETTINGS.camera;
      return s;
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function VideoStudioPage() {
  const router = useRouter();
  const account = useAccount();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const hydrated = useRef(false);
  const [source, setSource] = useState<LibraryItem | null>(null);
  const [images, setImages] = useState<LibraryItem[]>([]);
  const [imagesLoading, setImagesLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ClipStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<LibraryItem[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const clipRef = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const model: VideoModel = getVideoModel(settings.model) ?? VIDEO_MODELS[0];
  const duration = (model.durations as readonly number[]).includes(settings.duration[model.id] ?? -1)
    ? settings.duration[model.id]!
    : model.durations[0]!;
  const resolution =
    model.resolutions.length === 0
      ? null
      : (model.resolutions as readonly string[]).includes(settings.resolution[model.id] ?? "")
        ? settings.resolution[model.id]!
        : model.resolutions[0]!;
  const aspect =
    model.aspects.length === 0
      ? null
      : (model.aspects as readonly string[]).includes(settings.aspect[model.id] ?? "")
        ? settings.aspect[model.id]!
        : model.aspects[0]!;
  const withAudio = model.audio && settings.audio;
  const trimmed = prompt.trim();
  const ready = Boolean(source) && !busy && (!model.promptRequired || trimmed.length >= 3);
  const estimate = estimateVideoCost(model.id, duration, resolution, withAudio);

  const notify = useCallback((tone: Toast["tone"], title: string, message?: string) => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l, { id, tone, title, message }]);
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);

  /* ------------------------------- Persistence ------------------------------- */

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
    const t = setInterval(() => setElapsed(Date.now() - started), 500);
    return () => clearInterval(t);
  }, [busy]);

  /* ---------------------------------- Data ---------------------------------- */

  const loadImages = useCallback(async () => {
    try {
      const res = await fetch("/api/assets?kind=IMAGE&limit=48", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return [];
      }
      const data = (await res.json()) as { assets?: LibraryItem[] };
      const list = Array.isArray(data.assets) ? data.assets : [];
      setImages(list);
      return list;
    } catch {
      return [];
    } finally {
      setImagesLoading(false);
    }
  }, [router]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/assets?kind=VIDEO&limit=8", { cache: "no-store" });
      const data = (await res.json()) as { assets?: LibraryItem[] };
      if (res.ok && Array.isArray(data.assets)) setRecent(data.assets);
    } catch {
      // optional
    }
  }, []);

  useEffect(() => {
    void loadRecent();
    (async () => {
      const list = await loadImages();
      const wanted = new URLSearchParams(window.location.search).get("asset");
      if (!wanted) {
        if (list.length === 0) setPickerOpen(true);
        return;
      }
      const found = list.find((a) => a.id === wanted);
      if (found) return setSource(found);
      const res = await fetch(`/api/assets/${wanted}?info=1`, { cache: "no-store" });
      if (res.ok) {
        const { asset } = (await res.json()) as { asset: LibraryItem };
        if (asset.kind === "IMAGE") setSource(asset);
      } else setPickerOpen(true);
    })();
  }, [loadImages, loadRecent]);

  /* --------------------------------- Actions --------------------------------- */

  const chooseSource = (img: LibraryItem) => {
    if (busy) return;
    setSource(img);
    setStatus(null);
    setError(null);
    setPickerOpen(false);
    window.history.replaceState(null, "", `/video?asset=${img.id}`);
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!UPLOAD_TYPES.includes(file.type)) {
      notify("error", "Unsupported file", /hei[cf]/i.test(file.name) ? "Export HEIC photos as JPEG first." : "Use JPEG, PNG or WebP.");
      return;
    }
    if (file.size > UPLOAD_MAX) {
      notify("error", "Too large", "Images must be under 20 MB.");
      return;
    }
    setUploading(true);
    try {
      const size = await imageSize(file);
      const res = await fetch("/api/assets/upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "X-File-Name": encodeURIComponent(file.name),
          ...(size ? { "X-Image-Width": String(size.width), "X-Image-Height": String(size.height) } : {}),
        },
        body: file,
      });
      if (res.status === 401) return router.replace("/login");
      if (!res.ok) throw new Error(await readError(res));
      const { asset } = (await res.json()) as { asset: LibraryItem };
      setImages((l) => [asset, ...l]);
      chooseSource(asset);
      notify("success", "Image uploaded", "Saved to your Library.");
    } catch (err) {
      notify("error", "Upload failed", err instanceof Error ? err.message : undefined);
    } finally {
      setUploading(false);
    }
  };

  const render = async () => {
    if (!source || busy) return;
    if (model.promptRequired && trimmed.length < 3) {
      notify("error", "Describe the motion", "e.g. “she turns toward the camera and smiles, hair moving in the wind”.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetId: source.id,
          model: model.id,
          prompt: trimmed,
          camera: settings.camera,
          durationSec: duration,
          resolution,
          aspectRatio: aspect,
          withAudio,
        }),
        signal: controller.signal,
      });
      if (res.status === 401) return router.replace("/login");
      if (!res.ok) throw new Error(await readError(res));
      const { clipId } = (await res.json()) as { clipId: string };
      clipRef.current = clipId;
      void refreshAccount();

      const started = Date.now();
      let failures = 0;
      for (;;) {
        await sleep(POLL_MS, controller.signal);
        if (Date.now() - started > MAX_WAIT_MS) throw new Error("This is taking very long. The video will appear in your Library when done.");
        const poll = await fetch(`/api/videos/${clipId}`, { cache: "no-store", signal: controller.signal }).catch(() => null);
        if (!poll || poll.status >= 500) {
          if (++failures >= 8) throw new Error("Lost contact with the server. Check the Library shortly.");
          continue;
        }
        if (!poll.ok) throw new Error(await readError(poll));
        failures = 0;
        const s = (await poll.json()) as ClipStatus;
        setStatus(s);
        if (s.status === "COMPLETED") {
          notify("success", "Video ready", s.testMode ? "Test Mode sample — no credit used." : "Saved to your Library.");
          void loadRecent();
          break;
        }
        if (s.status === "FAILED") throw new Error(s.error ?? "The render failed.");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      notify("error", "Video failed", message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  const cancel = async () => {
    const id = clipRef.current;
    abortRef.current?.abort();
    setBusy(false);
    setStatus(null);
    if (id) await fetch(`/api/videos/${id}`, { method: "DELETE" }).catch(() => undefined);
    notify("info", "Cancelled");
  };

  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  /* --------------------------------- Render --------------------------------- */

  const done = status?.status === "COMPLETED" && status.videoUrl;
  const caption =
    status?.status === "IN_QUEUE" || !status
      ? status?.queuePosition
        ? `Waiting in queue · position ${status.queuePosition}`
        : "Sending to the model…"
      : "Rendering frames…";

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#0B0F17] text-slate-100">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.16),transparent)]"
      />
      <AppHeader
        status={
          <>
            {model.label} · {duration}s{resolution ? ` · ${resolution}` : ""}
            {withAudio ? " · sound" : ""}
          </>
        }
      />

      <main className="relative z-10 mx-auto grid max-w-[1440px] items-start gap-6 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[420px_minmax(0,1fr)]">
        {/* ============================== Controls ============================== */}
        <section className="space-y-6 rounded-2xl border border-indigo-500/20 bg-[#0F1420]/90 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <Clapperboard className="size-4 text-violet-300" aria-hidden />
              <h1 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">Video Studio</h1>
            </div>
            <Link href="/" className="text-[11px] text-slate-500 hover:text-slate-300" title="Old text-to-video studio (Hunyuan)">
              Text-to-video →
            </Link>
          </div>

          {/* Source */}
          <div className="space-y-2">
            <span className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Start image</span>
            <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-[#0B0F17] p-2.5">
              <div className={cx("size-14 shrink-0 overflow-hidden rounded-lg", source ? "bg-black" : "bg-white/[0.03]")}>
                {source?.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={source.url} alt="" className="size-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-200">
                  {source ? cleanPrompt(source.prompt) || (source.role === "UPLOAD" ? "Uploaded image" : "Image") : "No image chosen"}
                </p>
                <p className="text-[11px] text-slate-500">
                  {source
                    ? typeof source.meta?.characterName === "string"
                      ? `Soul ID: ${source.meta.characterName}`
                      : "This becomes the first frame"
                    : "From your Library or upload"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                disabled={busy}
                className="h-8 shrink-0 rounded-lg border border-white/10 px-3 text-xs text-slate-300 hover:border-white/20 disabled:opacity-50"
              >
                {source ? "Change" : "Choose"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy || uploading}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 text-xs text-slate-400 hover:border-indigo-400/50 hover:text-indigo-200 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
              {uploading ? "Uploading…" : "Upload your own image"}
            </button>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={upload} />
            <p className="text-[11px] text-slate-500">
              Want your hero&apos;s face? Make the image in{" "}
              <Link href="/images" className="text-indigo-300 hover:text-indigo-200">
                Images
              </Link>{" "}
              with their Soul ID, then animate it here.
            </p>
          </div>

          {/* Model */}
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Model</legend>
            <div role="radiogroup" aria-label="Model" className="grid gap-2 sm:grid-cols-2">
              {VIDEO_MODELS.map((m) => {
                const selected = m.id === model.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set({ model: m.id })}
                    className={cx(
                      "rounded-xl border p-3 text-left transition-all disabled:opacity-60",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                      selected ? "border-indigo-400/60 bg-indigo-500/[0.12]" : "border-white/[0.08] bg-[#0B0F17] hover:border-white/20",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-100">{m.label}</span>
                      {selected && <CheckCircle2 className="size-4 shrink-0 text-indigo-300" aria-hidden />}
                    </div>
                    <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">{m.vendor}</p>
                    <p className="mt-1.5 text-xs leading-snug text-slate-400">{m.tagline}</p>
                    <p className="mt-2 font-mono text-[10px] text-slate-500">{m.priceLabel}</p>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Motion prompt */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label htmlFor="motion" className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
                Motion {model.promptRequired ? "" : "(optional)"}
              </label>
              <span className="font-mono text-[11px] text-slate-500">
                {trimmed.length}/{VIDEO_PROMPT_MAX}
              </span>
            </div>
            <textarea
              id="motion"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, VIDEO_PROMPT_MAX + 50))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void render();
                }
              }}
              disabled={busy}
              rows={4}
              placeholder="What moves and how — e.g. She slowly turns toward the camera and smiles, hair moving in the wind, neon lights flicker behind her."
              className="block w-full resize-none rounded-xl border border-white/[0.08] bg-[#0B0F17] p-3 text-sm leading-relaxed text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400/60 disabled:opacity-60"
            />
            <p className="text-[11px] text-slate-500">Describe the movement, not the picture — the image already shows the scene.</p>
          </div>

          {/* Camera */}
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Camera</legend>
            <div role="radiogroup" aria-label="Camera" className="flex flex-wrap gap-1.5">
              {CAMERA_MOVES.map((c) => {
                const selected = c.value === settings.camera;
                return (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={c.text || "No camera instruction"}
                    onClick={() => set({ camera: c.value })}
                    className={cx(
                      "h-8 rounded-full border px-3 text-xs transition-all disabled:opacity-60",
                      selected
                        ? "border-violet-400/60 bg-violet-500/20 text-violet-100"
                        : "border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-slate-200",
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Output */}
          <div className="space-y-3">
            <span className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Output</span>
            <SegmentedControl<number>
              label="Length"
              options={model.durations.map((d) => ({ value: d, label: `${d}s`, hint: `${d} second clip` }))}
              value={duration}
              onChange={(d) => set({ duration: { ...settings.duration, [model.id]: d } })}
              disabled={busy}
            />
            {resolution && (
              <SegmentedControl<string>
                label="Quality"
                options={model.resolutions.map((r) => ({ value: r, label: r, hint: r === model.resolutions[0] ? "Cheapest" : "Sharper · costs more" }))}
                value={resolution}
                onChange={(r) => set({ resolution: { ...settings.resolution, [model.id]: r } })}
                disabled={busy}
              />
            )}
            {aspect && (
              <SegmentedControl<string>
                label="Format"
                options={model.aspects.map((a) => ({ value: a, label: ASPECT_LABELS[a] ?? a, hint: a === "auto" ? "Same shape as the image" : `Crop to ${a}` }))}
                value={aspect}
                onChange={(a) => set({ aspect: { ...settings.aspect, [model.id]: a } })}
                disabled={busy}
              />
            )}
            {model.audio ? (
              <button
                type="button"
                role="switch"
                aria-checked={settings.audio}
                onClick={() => set({ audio: !settings.audio })}
                disabled={busy}
                className={cx(
                  "flex h-10 w-full items-center justify-between rounded-lg border px-3 text-xs transition-colors disabled:opacity-60",
                  settings.audio ? "border-indigo-400/50 bg-indigo-500/10 text-indigo-100" : "border-white/[0.08] text-slate-400",
                )}
              >
                <span className="flex items-center gap-2">
                  {settings.audio ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
                  Sound (ambience, effects)
                </span>
                <span>{settings.audio ? "On · costs more" : "Off"}</span>
              </button>
            ) : (
              <p className="text-[11px] text-slate-500">This model makes silent video.</p>
            )}
          </div>

          {/* Render */}
          {busy ? (
            <div className="space-y-3">
              <button
                type="button"
                disabled
                className="flex h-14 w-full items-center justify-center gap-2.5 rounded-xl border border-indigo-400/40 bg-gradient-to-r from-indigo-600/60 via-violet-600/60 to-indigo-600/60 text-sm font-semibold uppercase tracking-[0.2em] text-white/90"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Rendering · {formatElapsed(elapsed)}
              </button>
              <button
                type="button"
                onClick={cancel}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 text-xs uppercase tracking-[0.18em] text-slate-400 hover:border-rose-400/40 hover:text-rose-300"
              >
                <Square className="size-3.5" aria-hidden />
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={render}
              aria-disabled={!ready}
              className={cx(
                "flex h-14 w-full items-center justify-center gap-2.5 rounded-xl text-sm font-semibold uppercase tracking-[0.22em] transition-all",
                ready
                  ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 text-white shadow-[0_0_30px_-6px_rgba(129,140,248,0.75)] hover:-translate-y-0.5"
                  : "border border-white/10 bg-white/[0.04] text-slate-500",
              )}
            >
              <Sparkles className="size-4" aria-hidden />
              Make video
            </button>
          )}
          {account && (
            <p className={cx("text-center text-[11px]", account.testMode ? "text-amber-200/80" : "text-slate-500")}>
              {account.testMode
                ? "Test Mode · free sample clip, no credit used"
                : `Estimated Fal cost: ${formatUsd(estimate)} (${formatInr(estimate)})`}
            </p>
          )}
        </section>

        {/* ============================== Monitor ============================== */}
        <section className="space-y-4 lg:sticky lg:top-6">
          {pickerOpen && (
            <div className="rounded-2xl border border-white/[0.08] bg-[#0F1420]/90 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Choose a start image</h2>
                <button type="button" onClick={() => setPickerOpen(false)} className="text-slate-500 hover:text-slate-300">
                  <X className="size-4" aria-hidden />
                  <span className="sr-only">Close</span>
                </button>
              </div>
              {imagesLoading ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-7">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="aspect-square animate-pulse rounded-lg bg-white/[0.04]" />
                  ))}
                </div>
              ) : images.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No images yet. Upload one on the left, or{" "}
                  <Link href="/images" className="text-indigo-300 hover:text-indigo-200">
                    make one in Images
                  </Link>
                  .
                </p>
              ) : (
                <div className="grid max-h-[340px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5 xl:grid-cols-7">
                  {images.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => chooseSource(img)}
                      className={cx(
                        "relative aspect-square overflow-hidden rounded-lg border bg-black",
                        source?.id === img.id ? "border-indigo-400" : "border-white/[0.06] hover:border-white/30",
                      )}
                      title={cleanPrompt(img.prompt) || "Image"}
                    >
                      {img.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img.url} alt="" loading="lazy" className="size-full object-cover" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="rounded-2xl border border-white/[0.06] bg-[#0F1420]/70 p-4 sm:p-6">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <Film className="size-4 text-indigo-300" aria-hidden />
                <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">Monitor</h2>
              </div>
              {done && status && (
                <p className="font-mono text-[11px] text-slate-500">
                  {status.modelLabel} · {status.durationSec}s{status.resolution ? ` · ${status.resolution}` : ""}
                  {status.withAudio ? " · sound" : ""}
                </p>
              )}
            </div>

            <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-black">
              {done && status?.videoUrl ? (
                <video key={status.videoUrl} src={status.videoUrl} controls autoPlay loop playsInline className="size-full object-contain" />
              ) : source?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={source.url} alt="Start image" className={cx("size-full object-contain", busy && "opacity-40")} />
              ) : (
                <button type="button" onClick={() => setPickerOpen(true)} className="flex flex-col items-center gap-3 text-center">
                  <ImagePlus className="size-9 text-slate-700" aria-hidden />
                  <span className="text-slate-300">Choose an image to bring to life</span>
                  <span className="text-xs text-slate-500">From your Library, or upload your own</span>
                </button>
              )}
              {busy && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40">
                  <Loader2 className="size-8 animate-spin text-indigo-300" aria-hidden />
                  <p className="text-sm text-slate-100">{caption}</p>
                  <p className="text-xs text-slate-400">Usually 1–5 minutes. You can leave — it lands in your Library.</p>
                </div>
              )}
            </div>

            {error && !busy && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] p-3 text-sm text-rose-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </div>
            )}

            {done && status && (
              <div className="mt-4 flex flex-wrap gap-2">
                <a
                  href={status.assetId ? `/api/assets/${status.assetId}?download=1` : (status.videoUrl ?? "#")}
                  className="flex h-9 items-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-3 text-sm text-indigo-100 hover:bg-indigo-500/25"
                >
                  <Download className="size-4" aria-hidden />
                  Download
                </a>
                <Link href="/library" className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-slate-400 hover:text-slate-200">
                  Open Library →
                </Link>
              </div>
            )}
          </div>

          {/* Recent videos */}
          {recent.length > 0 && (
            <div className="rounded-2xl border border-white/[0.06] bg-[#0F1420]/50 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Recent videos</h2>
                <Link href="/library" className="text-xs text-indigo-300 hover:text-indigo-200">
                  Library →
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {recent.map((v) => (
                  <a
                    key={v.id}
                    href={v.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="relative aspect-video overflow-hidden rounded-lg border border-white/[0.06] bg-black"
                    title={cleanPrompt(v.prompt)}
                  >
                    {v.url && <video src={v.url} muted playsInline preload="metadata" className="size-full object-cover" />}
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

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
