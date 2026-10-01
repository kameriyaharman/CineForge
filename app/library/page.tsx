"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Download,
  Film,
  FolderOpen,
  ImageIcon,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

interface LibraryAsset {
  id: string;
  kind: "IMAGE" | "VIDEO";
  role: "RENDER" | "UPSCALE" | "IMAGE" | "UPLOAD";
  url: string | null;
  contentType: string;
  byteSize: number | null;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  clipId: string | null;
  createdAt: string;
}

interface LibraryResponse {
  assets: LibraryAsset[];
  nextCursor: string | null;
}

type Filter = "ALL" | "VIDEO" | "IMAGE";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "VIDEO", label: "Videos" },
  { value: "IMAGE", label: "Images" },
];

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function isLibraryResponse(value: unknown): value is LibraryResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { assets?: unknown }).assets)
  );
}

function errorMessage(value: unknown, status: number): string {
  if (typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string") {
    return (value as { error: string }).error;
  }
  return `Request failed (${status}).`;
}

/** Prompt without the pipeline's [CHARACTER: …] [CAMERA: …] tags. */
function cleanPrompt(prompt: string | null): string {
  return (prompt ?? "").replace(/\s*\[(?:CHARACTER|CAMERA):[^\]]*\]/g, "").trim();
}

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value ? value : null;
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const value = meta?.[key];
  return typeof value === "number" ? value : null;
}

function durationFromFrames(frames: number | null): string | null {
  if (frames === 85) return "3.5s";
  if (frames === 129) return "5.4s";
  return frames ? `${frames}f` : null;
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function badgesFor(asset: LibraryAsset): string[] {
  const badges: string[] = [];
  if (asset.meta?.testMode === true) badges.push("Test sample");
  if (asset.role === "UPLOAD") badges.push("Uploaded");
  const tool = metaString(asset.meta, "tool");
  if (tool) {
    // Edits: just say what was done.
    const q = metaString(asset.meta, "quality");
    if (tool === "upscale") badges.push(`Upscaled ${q ?? ""}×`.replace(" ×", "×"));
    else if (tool === "remove-bg") badges.push("Cut-out");
    else badges.push(tool === "edit-nano" ? "Edited · Pro" : "Edited · Budget");
    return badges;
  }
  if (asset.role === "UPSCALE") badges.push("Upscaled");
  const res = metaString(asset.meta, "resolution");
  if (res) badges.push(/k$/i.test(res) ? res.toUpperCase() : res);
  const dur = durationFromFrames(metaNumber(asset.meta, "numFrames"));
  if (dur) badges.push(dur);
  const model = metaString(asset.meta, "modelLabel");
  if (model) badges.push(model);
  const quality = metaString(asset.meta, "quality");
  if (quality) badges.push(quality);
  const style = metaString(asset.meta, "style");
  if (style) badges.push(style);
  const ar = metaString(asset.meta, "aspectRatio");
  if (ar) badges.push(ar);
  return badges;
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function LibraryPage() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<LibraryAsset | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const requestRef = useRef<number>(0);

  const load = useCallback(async (which: Filter, cursor: string | null) => {
    const requestId = ++requestRef.current;
    const params = new URLSearchParams({ limit: "24" });
    if (which !== "ALL") params.set("kind", which);
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`/api/assets?${params.toString()}`, { cache: "no-store" });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // handled below
    }
    if (requestId !== requestRef.current) return null; // a newer request superseded this one
    if (!res.ok || !isLibraryResponse(data)) throw new Error(errorMessage(data, res.status));
    return data;
  }, []);

  // First page whenever the filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load(filter, null)
      .then((data) => {
        if (cancelled || !data) return;
        setAssets(data.assets);
        setNextCursor(data.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the library.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await load(filter, nextCursor);
      if (data) {
        setAssets((list) => [...list, ...data.assets.filter((a) => !list.some((b) => b.id === a.id))]);
        setNextCursor(data.nextCursor);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (asset: LibraryAsset) => {
    if (!window.confirm("Delete this file from your library? This can't be undone.")) return;
    setDeletingId(asset.id);
    try {
      const res = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      if (!res.ok) {
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          // ignore
        }
        throw new Error(errorMessage(data, res.status));
      }
      setAssets((list) => list.filter((a) => a.id !== asset.id));
      setOpen((current) => (current?.id === asset.id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the file.");
    } finally {
      setDeletingId(null);
    }
  };

  // Close the viewer on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#0B0F17] font-sans text-slate-100 antialiased">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.14),transparent)]"
      />
      <AppHeader />

      <main className="relative z-10 mx-auto max-w-[1440px] px-4 py-6 sm:px-8 sm:py-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2.5 text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">
              <FolderOpen className="size-4 text-violet-300" aria-hidden />
              Asset Library
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Every render is saved here permanently. Links from the render engines expire; these don&apos;t.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="Filter"
            className="flex gap-1 rounded-lg border border-white/[0.08] bg-[#0F1420] p-1"
          >
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cx(
                  "h-8 rounded-md px-3 text-xs transition-all",
                  filter === f.value
                    ? "bg-indigo-500/25 text-indigo-100 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.55)]"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-rose-400/30 bg-rose-500/[0.07] p-3 text-sm text-rose-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="text-rose-300/70 hover:text-rose-200">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-white/[0.06] bg-[#0F1420]">
                <div className="aspect-video animate-pulse bg-white/[0.04]" />
                <div className="space-y-2 p-3">
                  <div className="h-2.5 w-3/4 animate-pulse rounded-full bg-white/[0.05]" />
                  <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-white/[0.04]" />
                </div>
              </div>
            ))}
          </div>
        ) : assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/[0.1] px-6 py-20 text-center">
            {filter === "IMAGE" ? (
              <ImageIcon className="size-10 text-slate-700" aria-hidden />
            ) : (
              <Film className="size-10 text-slate-700" aria-hidden />
            )}
            <div>
              <p className="text-slate-300">Nothing here yet</p>
              <p className="mt-1 text-sm text-slate-500">
                {filter === "IMAGE"
                  ? "Images you generate will appear here."
                  : "Finished renders are saved here automatically."}
              </p>
            </div>
            <Link
              href={filter === "IMAGE" ? "/images" : "/"}
              className="flex h-10 items-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-4 text-sm text-indigo-100 transition-all hover:bg-indigo-500/25"
            >
              <Sparkles className="size-4" aria-hidden />
              {filter === "IMAGE" ? "Open Image Studio" : "Open Studio"}
            </Link>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {assets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  deleting={deletingId === asset.id}
                  onOpen={() => setOpen(asset)}
                  onDelete={() => void remove(asset)}
                />
              ))}
            </div>
            {nextCursor && (
              <div className="mt-8 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="flex h-10 items-center gap-2 rounded-lg border border-white/10 px-5 text-sm text-slate-300 transition-colors hover:border-white/20 hover:bg-white/5 disabled:opacity-60"
                >
                  {loadingMore && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {open && <Viewer asset={open} onClose={() => setOpen(null)} onDelete={() => void remove(open)} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Components                                 */
/* -------------------------------------------------------------------------- */

function AssetCard({
  asset,
  deleting,
  onOpen,
  onDelete,
}: {
  asset: LibraryAsset;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prompt = cleanPrompt(asset.prompt);
  const character = metaString(asset.meta, "characterName");

  return (
    <article
      className={cx(
        "group overflow-hidden rounded-xl border bg-[#0F1420] transition-all",
        asset.role === "UPSCALE" ? "border-emerald-400/25" : "border-white/[0.06]",
        "hover:border-indigo-400/40 hover:shadow-[0_0_30px_-10px_rgba(129,140,248,0.6)]",
        deleting && "pointer-events-none opacity-50",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => void videoRef.current?.play().catch(() => undefined)}
        onMouseLeave={() => {
          const v = videoRef.current;
          if (v) {
            v.pause();
            v.currentTime = 0;
          }
        }}
        className="relative block aspect-video w-full overflow-hidden bg-black"
        aria-label="Open"
      >
        {asset.url ? (
          asset.kind === "VIDEO" ? (
            <video
              ref={videoRef}
              src={asset.url}
              muted
              loop
              playsInline
              preload="metadata"
              className="size-full object-contain"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- presigned bucket URLs
            <img src={asset.url} alt={prompt || "Generated image"} className="size-full object-contain" />
          )
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-slate-600">Unavailable</div>
        )}
        {asset.kind === "VIDEO" && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-100 transition-opacity group-hover:opacity-0">
            <span className="flex size-10 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/20">
              <Play className="size-4 translate-x-px text-white" aria-hidden />
            </span>
          </span>
        )}
        <span className="absolute left-2 top-2 flex flex-wrap gap-1">
          {badgesFor(asset).map((b) => (
            <span
              key={b}
              className={cx(
                "rounded px-1.5 py-0.5 font-mono text-[10px] backdrop-blur",
                b === "Upscaled" ? "bg-emerald-500/25 text-emerald-100" : "bg-black/60 text-slate-200",
              )}
            >
              {b}
            </span>
          ))}
        </span>
      </button>
      <div className="space-y-2 p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-sm text-slate-300">{prompt || "Untitled"}</p>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[11px] text-slate-500">
            {character ? `${character} · ` : ""}
            {formatDate(asset.createdAt)}
          </p>
          <div className="flex shrink-0 gap-1">
            {asset.kind === "IMAGE" && (
              <Link
                href={`/edit?asset=${asset.id}`}
                aria-label="Edit"
                title="Edit, upscale or remove background"
                className="flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
              >
                <Wand2 className="size-4" aria-hidden />
              </Link>
            )}
            <a
              href={`/api/assets/${asset.id}?download=1`}
              aria-label="Download"
              title="Download"
              className="flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
            >
              <Download className="size-4" aria-hidden />
            </a>
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete"
              title="Delete"
              className="flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Viewer({
  asset,
  onClose,
  onDelete,
}: {
  asset: LibraryAsset;
  onClose: () => void;
  onDelete: () => void;
}) {
  const prompt = cleanPrompt(asset.prompt);
  const character = metaString(asset.meta, "characterName");
  const camera = metaString(asset.meta, "cameraMovement");
  const details: [string, string | null][] = [
    ["Soul ID", character],
    ["Camera", camera],
    ["Output", badgesFor(asset).filter((b) => b !== "Upscaled").join(" · ") || null],
    ["Version", asset.role === "UPSCALE" ? "Upscaled master" : asset.role === "RENDER" ? "Raw render" : null],
    ["Size", formatBytes(asset.byteSize)],
    ["Created", formatDate(asset.createdAt)],
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Asset viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0F1420] shadow-2xl lg:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
          {asset.url && asset.kind === "VIDEO" ? (
            <video src={asset.url} controls autoPlay loop playsInline className="max-h-[70vh] w-full object-contain" />
          ) : asset.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- presigned bucket URLs
            <img src={asset.url} alt={prompt || "Generated image"} className="max-h-[70vh] w-full object-contain" />
          ) : (
            <p className="p-10 text-sm text-slate-500">File unavailable.</p>
          )}
        </div>
        <aside className="w-full shrink-0 space-y-4 overflow-y-auto p-5 lg:w-80">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm leading-relaxed text-slate-200">{prompt || "Untitled"}</p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <dl className="space-y-2 text-xs">
            {details
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-right font-mono text-slate-200">{v}</dd>
                </div>
              ))}
          </dl>
          <div className="flex gap-2 pt-2">
            <a
              href={`/api/assets/${asset.id}?download=1`}
              className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-500/15 text-xs font-medium text-indigo-100 transition-all hover:bg-indigo-500/25"
            >
              <Download className="size-3.5" aria-hidden />
              Download
            </a>
            <button
              type="button"
              onClick={onDelete}
              className="flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-slate-400 transition-colors hover:border-rose-400/40 hover:text-rose-300"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
