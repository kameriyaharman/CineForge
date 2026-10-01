"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Download,
  ImagePlus,
  Loader2,
  Redo2,
  Sparkles,
  Square,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { formatInr, formatUsd, refreshAccount, useAccount } from "@/components/account-control";
import { SegmentedControl } from "@/components/segmented-control";
import { EDIT_PROMPT_IDEAS, EDIT_PROMPT_MAX, EDIT_TOOLS, getEditTool, type EditToolId } from "@/lib/edit-tools";
import { estimateImageCost } from "@/lib/prices";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

interface LibraryImage {
  id: string;
  kind: "IMAGE" | "VIDEO";
  role: string;
  url: string | null;
  contentType: string;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface JobImage {
  url: string;
  width: number | null;
  height: number | null;
  assetId: string | null;
}

interface JobStatus {
  generationId: string;
  status: "IN_QUEUE" | "GENERATING" | "COMPLETED" | "FAILED";
  images: JobImage[];
  modelLabel: string;
  error?: string;
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

const POLL_MS = 2000;
const MAX_WAIT_MS = 11 * 60 * 1000;
const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"];
const UPLOAD_MAX = 20 * 1024 * 1024;

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

/** Natural pixel size of an image file, read in the browser. */
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

function cleanPrompt(p: string | null): string {
  return (p ?? "").replace(/\[[A-Z]+:[^\]]*\]/g, "").trim();
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function EditPage() {
  const router = useRouter();
  const account = useAccount();
  const [source, setSource] = useState<LibraryImage | null>(null);
  const [library, setLibrary] = useState<LibraryImage[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toolId, setToolId] = useState<EditToolId>("edit-klein");
  const [options, setOptions] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<JobStatus["status"] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ image: JobImage; tool: EditToolId; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const tool = getEditTool(toolId) ?? EDIT_TOOLS[0];
  const option = options[tool.id] ?? tool.options[0]!.value;
  const trimmed = prompt.trim();
  const ready = Boolean(source) && !busy && (!tool.needsPrompt || trimmed.length >= 3);

  const notify = useCallback((tone: Toast["tone"], title: string, message?: string) => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l, { id, tone, title, message }]);
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);

  /* --------------------------------- Data --------------------------------- */

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/assets?kind=IMAGE&limit=48", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return [];
      }
      const data = (await res.json()) as { assets?: LibraryImage[] };
      const list = Array.isArray(data.assets) ? data.assets : [];
      setLibrary(list);
      return list;
    } catch {
      return [];
    } finally {
      setLibraryLoading(false);
    }
  }, [router]);

  useEffect(() => {
    (async () => {
      const list = await loadLibrary();
      const wanted = new URLSearchParams(window.location.search).get("asset");
      if (!wanted) {
        if (list.length === 0) setPickerOpen(true);
        return;
      }
      const found = list.find((a) => a.id === wanted);
      if (found) {
        setSource(found);
        return;
      }
      const res = await fetch(`/api/assets/${wanted}?info=1`, { cache: "no-store" });
      if (res.ok) {
        const { asset } = (await res.json()) as { asset: LibraryImage };
        if (asset.kind === "IMAGE") setSource(asset);
      } else {
        setPickerOpen(true);
      }
    })();
  }, [loadLibrary]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(t);
  }, [busy]);

  /* -------------------------------- Actions -------------------------------- */

  const chooseSource = (img: LibraryImage) => {
    if (busy) return;
    setSource(img);
    setResult(null);
    setError(null);
    setPickerOpen(false);
    window.history.replaceState(null, "", `/edit?asset=${img.id}`);
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
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(await readError(res));
      const { asset } = (await res.json()) as { asset: LibraryImage };
      setLibrary((l) => [asset, ...l]);
      chooseSource(asset);
      notify("success", "Image uploaded", "Saved to your Library.");
    } catch (err) {
      notify("error", "Upload failed", err instanceof Error ? err.message : undefined);
    } finally {
      setUploading(false);
    }
  };

  const run = async () => {
    if (!source || busy) return;
    if (tool.needsPrompt && trimmed.length < 3) {
      notify("error", "Describe the change", "Write what should change, e.g. “change the jacket to red”.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase("IN_QUEUE");
    const runTool = tool.id as EditToolId;
    const runLabel = tool.needsPrompt ? trimmed : `${tool.label} · ${tool.options.find((o) => o.value === option)?.label}`;

    try {
      const res = await fetch("/api/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceAssetId: source.id, tool: tool.id, option, prompt: trimmed || undefined }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(await readError(res));
      const { generationId } = (await res.json()) as { generationId: string };
      jobRef.current = generationId;
      void refreshAccount();

      const started = Date.now();
      let failures = 0;
      for (;;) {
        await sleep(POLL_MS, controller.signal);
        if (Date.now() - started > MAX_WAIT_MS) throw new Error("This is taking too long. Check the Library shortly.");
        const poll = await fetch(`/api/images/${generationId}`, { cache: "no-store", signal: controller.signal }).catch(
          () => null,
        );
        if (!poll || poll.status >= 500) {
          if (++failures >= 6) throw new Error("Lost contact with the server. Check the Library shortly.");
          continue;
        }
        if (!poll.ok) throw new Error(await readError(poll));
        failures = 0;
        const status = (await poll.json()) as JobStatus;
        setPhase(status.status);
        if (status.status === "COMPLETED") {
          const image = status.images[0];
          if (!image) throw new Error("No image came back.");
          setResult({ image, tool: runTool, label: runLabel });
          setSplit(50);
          notify("success", "Done", "Saved to your Library as a new image. The original is unchanged.");
          void loadLibrary();
          break;
        }
        if (status.status === "FAILED") throw new Error(status.error ?? "The edit failed.");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      notify("error", "Edit failed", message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setPhase(null);
    }
  };

  const cancel = async () => {
    const id = jobRef.current;
    abortRef.current?.abort();
    setBusy(false);
    setPhase(null);
    if (id) await fetch(`/api/images/${id}`, { method: "DELETE" }).catch(() => undefined);
    notify("info", "Cancelled");
  };

  /** Use the result as the new source, to stack edits (e.g. edit → upscale). */
  const continueFromResult = async () => {
    if (!result?.image.assetId) return;
    const res = await fetch(`/api/assets/${result.image.assetId}?info=1`, { cache: "no-store" });
    if (!res.ok) {
      notify("error", "Could not open the result", await readError(res));
      return;
    }
    const { asset } = (await res.json()) as { asset: LibraryImage };
    chooseSource(asset);
    setPrompt("");
    notify("info", "Now editing the result", "Apply another edit, upscale or remove the background.");
  };

  /* -------------------------------- Render -------------------------------- */

  const estimate = estimateImageCost(tool.id, option, 1);
  const checker =
    "bg-[length:20px_20px] bg-[linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%),linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%)] bg-[position:0_0,10px_10px] bg-[#0f172a]";

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#0B0F17] text-slate-100">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.16),transparent)]"
      />
      <AppHeader status={<>{tool.label}</>} />

      <main className="relative z-10 mx-auto grid max-w-[1440px] items-start gap-6 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[400px_minmax(0,1fr)]">
        {/* ============================== Controls ============================== */}
        <section className="space-y-6 rounded-2xl border border-indigo-500/20 bg-[#0F1420]/90 p-5 sm:p-6">
          <div className="flex items-center gap-2.5">
            <Wand2 className="size-4 text-violet-300" aria-hidden />
            <h1 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">Edit Studio</h1>
          </div>

          {/* Source */}
          <div className="space-y-2">
            <span className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Image</span>
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
                <p className="text-[11px] text-slate-500">{source ? "From your Library" : "Pick one from the Library or upload"}</p>
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
          </div>

          {/* Tool */}
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-2 block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Tool</legend>
            <div role="radiogroup" aria-label="Tool" className="grid gap-2 sm:grid-cols-2">
              {EDIT_TOOLS.map((t) => {
                const selected = t.id === tool.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setToolId(t.id)}
                    className={cx(
                      "rounded-xl border p-3 text-left transition-all disabled:opacity-60",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                      selected
                        ? "border-indigo-400/60 bg-indigo-500/[0.12]"
                        : "border-white/[0.08] bg-[#0B0F17] hover:border-white/20",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-100">{t.label}</span>
                      {selected && <CheckCircle2 className="size-4 shrink-0 text-indigo-300" aria-hidden />}
                    </div>
                    <p className="mt-1 text-xs leading-snug text-slate-400">{t.tagline}</p>
                    <p className="mt-1.5 font-mono text-[10px] text-slate-500">{t.priceLabel}</p>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Prompt */}
          {tool.needsPrompt && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <label htmlFor="edit-prompt" className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
                  What should change?
                </label>
                <span className="font-mono text-[11px] text-slate-500">
                  {trimmed.length}/{EDIT_PROMPT_MAX}
                </span>
              </div>
              <textarea
                id="edit-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value.slice(0, EDIT_PROMPT_MAX + 50))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void run();
                  }
                }}
                disabled={busy}
                rows={4}
                placeholder="e.g. Change the outfit to a red saree, keep the face and pose the same"
                className="block w-full resize-none rounded-xl border border-white/[0.08] bg-[#0B0F17] p-3 text-sm leading-relaxed text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400/60 disabled:opacity-60"
              />
              <div className="flex flex-wrap gap-1.5">
                {EDIT_PROMPT_IDEAS.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    disabled={busy}
                    onClick={() => setPrompt(idea)}
                    className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-400 hover:border-white/20 hover:text-slate-200 disabled:opacity-50"
                  >
                    {idea}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">
                Say what to change and what to keep. The original stays in your Library.
              </p>
            </div>
          )}

          <SegmentedControl<string>
            label={tool.optionLabel}
            options={tool.options}
            value={option}
            onChange={(v) => setOptions((o) => ({ ...o, [tool.id]: v }))}
            disabled={busy}
          />

          {/* Run */}
          {busy ? (
            <div className="space-y-3">
              <button
                type="button"
                disabled
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-indigo-400/40 bg-gradient-to-r from-indigo-600/60 via-violet-600/60 to-indigo-600/60 text-sm font-semibold uppercase tracking-[0.18em] text-white/90"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {phase === "IN_QUEUE" ? "Queued" : "Working"} · {Math.floor(elapsed / 1000)}s
              </button>
              <button
                type="button"
                onClick={cancel}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-white/10 text-xs uppercase tracking-[0.18em] text-slate-400 hover:border-rose-400/40 hover:text-rose-300"
              >
                <Square className="size-3.5" aria-hidden />
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={run}
              aria-disabled={!ready}
              className={cx(
                "flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold uppercase tracking-[0.18em] transition-all",
                ready
                  ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 text-white shadow-[0_0_30px_-6px_rgba(129,140,248,0.75)] hover:-translate-y-0.5"
                  : "border border-white/10 bg-white/[0.04] text-slate-500",
              )}
            >
              <Sparkles className="size-4" aria-hidden />
              {tool.group === "upscale" ? "Upscale" : tool.group === "remove-bg" ? "Remove background" : "Apply edit"}
            </button>
          )}
          {account && (
            <p className={cx("text-center text-[11px]", account.testMode ? "text-amber-200/80" : "text-slate-500")}>
              {account.testMode
                ? "Test Mode · free sample, no credit used"
                : `Estimated cost: ${formatUsd(estimate)} (${formatInr(estimate)})`}
            </p>
          )}
        </section>

        {/* ============================== Canvas ============================== */}
        <section className="space-y-4">
          {pickerOpen && (
            <div className="rounded-2xl border border-white/[0.08] bg-[#0F1420]/90 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Choose from Library</h2>
                <button type="button" onClick={() => setPickerOpen(false)} className="text-slate-500 hover:text-slate-300">
                  <X className="size-4" aria-hidden />
                  <span className="sr-only">Close</span>
                </button>
              </div>
              {libraryLoading ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-7">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="aspect-square animate-pulse rounded-lg bg-white/[0.04]" />
                  ))}
                </div>
              ) : library.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No images yet. Upload one on the left, or{" "}
                  <Link href="/images" className="text-indigo-300 hover:text-indigo-200">
                    make one in Image Studio
                  </Link>
                  .
                </p>
              ) : (
                <div className="grid max-h-[340px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5 xl:grid-cols-7">
                  {library.map((img) => (
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
            {!source ? (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex h-80 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.1] text-center"
              >
                <ImagePlus className="size-9 text-slate-700" aria-hidden />
                <span className="text-slate-300">Choose an image to edit</span>
                <span className="text-xs text-slate-500">From your Library, or upload your own</span>
              </button>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    {result ? "Before / After" : "Original"}
                  </p>
                  {result && (
                    <p className="truncate text-xs text-slate-500" title={result.label}>
                      {getEditTool(result.tool)?.needsPrompt ? `${getEditTool(result.tool)?.label} · ` : ""}
                      {result.label}
                    </p>
                  )}
                </div>

                <div
                  className={cx(
                    "relative mx-auto flex max-h-[70vh] w-full items-center justify-center overflow-hidden rounded-xl",
                    result?.tool === "remove-bg" ? checker : "bg-black",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={(result ? result.image.url : source.url) ?? ""}
                    alt={result ? "Edited image" : "Original image"}
                    className="max-h-[70vh] w-auto object-contain"
                  />
                  {result && source.url && result.tool !== "remove-bg" && (
                    <div
                      className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black"
                      style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={source.url} alt="Original image" className="max-h-[70vh] w-auto object-contain" />
                    </div>
                  )}
                  {result && result.tool !== "remove-bg" && (
                    <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${split}%` }} />
                  )}
                  {busy && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[2px]">
                      <Loader2 className="size-7 animate-spin text-indigo-300" aria-hidden />
                      <p className="text-sm text-slate-200">{phase === "IN_QUEUE" ? "Waiting in queue…" : "Working on it…"}</p>
                    </div>
                  )}
                </div>

                {result && result.tool !== "remove-bg" && (
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
                    <span>Before</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={split}
                      onChange={(e) => setSplit(Number(e.target.value))}
                      aria-label="Compare before and after"
                      className="flex-1 accent-indigo-400"
                    />
                    <span>After</span>
                  </div>
                )}

                {error && !busy && (
                  <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] p-3 text-sm text-rose-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {error}
                  </div>
                )}

                {result && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <a
                      href={result.image.assetId ? `/api/assets/${result.image.assetId}?download=1` : result.image.url}
                      className="flex h-9 items-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-3 text-sm text-indigo-100 hover:bg-indigo-500/25"
                    >
                      <Download className="size-4" aria-hidden />
                      Download
                    </a>
                    {result.image.assetId && (
                      <button
                        type="button"
                        onClick={continueFromResult}
                        className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-slate-300 hover:border-white/20"
                      >
                        <Redo2 className="size-4" aria-hidden />
                        Keep editing this result
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setResult(null)}
                      className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-slate-300 hover:border-white/20"
                    >
                      <ArrowRightLeft className="size-4" aria-hidden />
                      Back to original
                    </button>
                    <Link
                      href="/library?kind=IMAGE"
                      className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-slate-400 hover:text-slate-200"
                    >
                      Open Library →
                    </Link>
                  </div>
                )}
              </>
            )}
          </div>
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
