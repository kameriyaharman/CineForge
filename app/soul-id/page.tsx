"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  ImagePlus,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  UploadCloud,
  UserRound,
  X,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { SegmentedControl } from "@/components/segmented-control";
import {
  SOUL_NAME_MAX,
  SOUL_PHOTO_MAX,
  SOUL_PHOTO_MAX_BYTES,
  SOUL_PHOTO_MIN,
  SOUL_PHOTO_RECOMMENDED,
  SOUL_PHOTO_TYPES,
  SOUL_TRAINING_PRESETS,
  type SoulHero,
  type SoulPhoto,
  type SoulTrainingPreset,
} from "@/lib/soul-options";

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const TRAINING_POLL_MS = 15_000;

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

function minutesSince(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface UploadItem {
  key: string;
  name: string;
  state: "queued" | "uploading" | "done" | "error";
  error?: string;
}

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  message?: string;
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function SoulIdPage() {
  const router = useRouter();
  const [heroes, setHeroes] = useState<SoulHero[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ hero: SoulHero; photos: SoulPhoto[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preset, setPreset] = useState<SoulTrainingPreset>("fast");
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((tone: Toast["tone"], title: string, message?: string) => {
    const id = Date.now() + Math.random();
    setToasts((l) => [...l, { id, tone, title, message }]);
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);

  const handleAuth = useCallback(
    (res: Response) => {
      if (res.status === 401) {
        router.replace("/login");
        return true;
      }
      return false;
    },
    [router],
  );

  /* --------------------------------- Data --------------------------------- */

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/soul-id", { cache: "no-store" });
      if (handleAuth(res)) return;
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { heroes: SoulHero[] };
      setHeroes(data.heroes);
      setListError(null);
      setSelectedId((cur) => cur ?? data.heroes[0]?.id ?? null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load heroes.");
    } finally {
      setListLoading(false);
    }
  }, [handleAuth]);

  const loadDetail = useCallback(
    async (id: string, quiet = false) => {
      if (!quiet) setDetailLoading(true);
      try {
        const res = await fetch(`/api/soul-id/${id}`, { cache: "no-store" });
        if (handleAuth(res)) return;
        if (!res.ok) throw new Error(await readError(res));
        const data = (await res.json()) as { hero: SoulHero; photos: SoulPhoto[] };
        setDetail((prev) => {
          if (prev?.hero.status === "TRAINING" && data.hero.status === "READY") {
            notify("success", `${data.hero.name} is ready`, "Use this hero in the Image Studio now.");
          } else if (prev?.hero.status === "TRAINING" && data.hero.status === "FAILED") {
            notify("error", "Training failed", data.hero.error ?? undefined);
          }
          return data;
        });
        setHeroes((list) => list.map((h) => (h.id === data.hero.id ? data.hero : h)));
      } catch (err) {
        if (!quiet) notify("error", "Could not load hero", err instanceof Error ? err.message : undefined);
      } finally {
        if (!quiet) setDetailLoading(false);
      }
    },
    [handleAuth, notify],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setUploads([]);
    // Drop the previous hero at once so nothing (uploads, training) targets it by mistake.
    setDetail((d) => (d && d.hero.id === selectedId ? d : null));
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // While training, check in regularly (each check also advances the job server-side).
  const training = detail?.hero.status === "TRAINING";
  useEffect(() => {
    if (!training || !selectedId) return;
    const t = setInterval(() => void loadDetail(selectedId, true), TRAINING_POLL_MS);
    return () => clearInterval(t);
  }, [training, selectedId, loadDetail]);

  /* -------------------------------- Actions -------------------------------- */

  const createHero = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (name.length < 2) {
      notify("error", "Name needed", "Give the hero a name first.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/soul-id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (handleAuth(res)) return;
      if (!res.ok) throw new Error(await readError(res));
      const { hero } = (await res.json()) as { hero: SoulHero };
      setHeroes((l) => [hero, ...l]);
      setDetail({ hero, photos: [] });
      setSelectedId(hero.id);
      setNewName("");
      notify("success", `${hero.name} created`, `Now add ${SOUL_PHOTO_RECOMMENDED} photos.`);
    } catch (err) {
      notify("error", "Could not create hero", err instanceof Error ? err.message : undefined);
    } finally {
      setCreating(false);
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (!detail || detail.hero.id !== selectedId) return;
    const heroId = detail.hero.id;
    const room = SOUL_PHOTO_MAX - detail.photos.length;
    if (room <= 0) {
      notify("error", "Photo limit reached", `A hero can have at most ${SOUL_PHOTO_MAX} photos.`);
      return;
    }
    const picked = files.slice(0, room);
    if (files.length > room) notify("info", `Only ${room} more photo(s) fit`, `The limit is ${SOUL_PHOTO_MAX}.`);

    const items: UploadItem[] = picked.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, state: "queued" }));
    setUploads((l) => [...l.filter((u) => u.state !== "done"), ...items]);

    let ok = 0;
    for (const [i, file] of picked.entries()) {
      const item = items[i]!;
      const set = (patch: Partial<UploadItem>) =>
        setUploads((l) => l.map((u) => (u.key === item.key ? { ...u, ...patch } : u)));

      if (!(SOUL_PHOTO_TYPES as readonly string[]).includes(file.type)) {
        set({ state: "error", error: /heic|heif/i.test(file.name) ? "HEIC not supported — export as JPEG" : "Use JPEG, PNG or WebP" });
        continue;
      }
      if (file.size > SOUL_PHOTO_MAX_BYTES) {
        set({ state: "error", error: "Over 15 MB" });
        continue;
      }
      set({ state: "uploading" });
      try {
        const res = await fetch(`/api/soul-id/${heroId}/photos`, {
          method: "POST",
          headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        });
        if (handleAuth(res)) return;
        if (!res.ok) throw new Error(await readError(res));
        const { photo } = (await res.json()) as { photo: SoulPhoto };
        ok += 1;
        set({ state: "done" });
        setDetail((d) => (d && d.hero.id === heroId ? { ...d, photos: [...d.photos, photo] } : d));
      } catch (err) {
        set({ state: "error", error: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    if (ok > 0) {
      notify("success", `${ok} photo${ok === 1 ? "" : "s"} added`);
      void loadDetail(heroId, true);
      void loadList();
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) void uploadFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name));
    if (files.length) void uploadFiles(files);
  };

  const removePhoto = async (photo: SoulPhoto) => {
    if (!detail) return;
    const heroId = detail.hero.id;
    setDetail((d) => (d ? { ...d, photos: d.photos.filter((p) => p.id !== photo.id) } : d));
    const res = await fetch(`/api/soul-id/${heroId}/photos/${photo.id}`, { method: "DELETE" });
    if (!res.ok) {
      notify("error", "Could not remove photo", await readError(res));
      void loadDetail(heroId, true);
    } else {
      void loadList();
    }
  };

  const startTraining = async () => {
    if (!detail || detail.hero.id !== selectedId) return;
    const p = SOUL_TRAINING_PRESETS.find((x) => x.value === preset)!;
    const again = detail.hero.status === "READY" ? " This replaces the current trained face." : "";
    if (
      !window.confirm(
        `Start ${p.label} training for ${detail.hero.name}?\n\nThis uses your Fal credit: ${p.priceLabel}.${again}`,
      )
    )
      return;
    setStarting(true);
    try {
      const res = await fetch(`/api/soul-id/${detail.hero.id}/train`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      if (handleAuth(res)) return;
      if (!res.ok) throw new Error(await readError(res));
      notify("info", "Training started", "You can leave this page — it keeps going.");
      await loadDetail(detail.hero.id, true);
    } catch (err) {
      notify("error", "Could not start training", err instanceof Error ? err.message : undefined);
      await loadDetail(detail.hero.id, true);
    } finally {
      setStarting(false);
    }
  };

  const deleteHero = async () => {
    if (!detail) return;
    if (!window.confirm(`Delete ${detail.hero.name}, all its photos and its trained face? This can't be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/soul-id/${detail.hero.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      const gone = detail.hero.id;
      setHeroes((l) => l.filter((h) => h.id !== gone));
      setSelectedId(heroes.find((h) => h.id !== gone)?.id ?? null);
      notify("success", "Hero deleted");
    } catch (err) {
      notify("error", "Could not delete", err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  /* -------------------------------- Render -------------------------------- */

  const hero = detail?.hero ?? null;
  const photos = detail?.photos ?? [];
  const uploading = uploads.some((u) => u.state === "uploading" || u.state === "queued");
  const enoughPhotos = photos.length >= SOUL_PHOTO_MIN;
  const readyCount = heroes.filter((h) => h.status === "READY").length;

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
            {readyCount} trained hero{readyCount === 1 ? "" : "es"}
          </>
        }
      />

      <main className="relative z-10 mx-auto grid max-w-[1440px] items-start gap-6 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* ============================== Hero list ============================== */}
        <aside className="space-y-4">
          <section className="rounded-2xl border border-indigo-500/20 bg-[#0F1420]/90 p-5">
            <div className="mb-4 flex items-center gap-2.5">
              <Fingerprint className="size-4 text-violet-300" aria-hidden />
              <h1 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">Soul ID</h1>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-slate-400">
              Train a hero once from {SOUL_PHOTO_RECOMMENDED} photos. After that, every image you make with that hero
              keeps the same face.
            </p>
            <form onSubmit={createHero} className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value.slice(0, SOUL_NAME_MAX))}
                placeholder="New hero name"
                aria-label="New hero name"
                disabled={creating}
                className="h-10 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-[#0B0F17] px-3 text-sm outline-none placeholder:text-slate-600 focus:border-indigo-400/60"
              />
              <button
                type="submit"
                disabled={creating}
                className="flex h-10 items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-3 text-sm text-indigo-100 hover:bg-indigo-500/25 disabled:opacity-60"
              >
                {creating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                Create
              </button>
            </form>
          </section>

          <section className="rounded-2xl border border-white/[0.06] bg-[#0F1420]/70 p-3">
            {listLoading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.04]" />
                ))}
              </div>
            ) : listError ? (
              <p className="p-3 text-sm text-rose-300">{listError}</p>
            ) : heroes.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">No heroes yet. Create one above.</p>
            ) : (
              <ul className="space-y-1.5">
                {heroes.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(h.id)}
                      aria-current={h.id === selectedId ? "true" : undefined}
                      className={cx(
                        "flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors",
                        h.id === selectedId
                          ? "border-indigo-400/50 bg-indigo-500/[0.1]"
                          : "border-transparent hover:bg-white/[0.03]",
                      )}
                    >
                      <Cover url={h.coverUrl} name={h.name} className="size-11 rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-100">{h.name}</p>
                        <p className="text-[11px] text-slate-500">{h.photoCount} photos</p>
                      </div>
                      <StatusBadge status={h.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        {/* ============================== Hero detail ============================== */}
        <section className="min-h-[420px] rounded-2xl border border-white/[0.06] bg-[#0F1420]/70 p-4 sm:p-6">
          {!hero ? (
            detailLoading ? (
              <div className="flex h-80 items-center justify-center">
                <Loader2 className="size-6 animate-spin text-indigo-300" aria-hidden />
              </div>
            ) : (
              <div className="flex h-80 flex-col items-center justify-center gap-3 text-center">
                <UserRound className="size-10 text-slate-700" aria-hidden />
                <p className="text-slate-300">Create a hero to get started</p>
                <p className="max-w-sm text-sm text-slate-500">
                  Give them a name, upload photos of their face, then train. Training costs Fal credit once per hero.
                </p>
              </div>
            )
          ) : (
            <div className="space-y-6">
              {/* Title */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Cover url={hero.coverUrl} name={hero.name} className="size-14 rounded-xl" />
                  <div>
                    <h2 className="text-xl font-semibold text-slate-100">{hero.name}</h2>
                    <div className="mt-1 flex items-center gap-2">
                      <StatusBadge status={hero.status} />
                      <span className="text-xs text-slate-500">
                        {photos.length} / {SOUL_PHOTO_MAX} photos
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={deleteHero}
                  disabled={deleting || training}
                  className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-slate-400 hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Delete hero
                </button>
              </div>

              {/* Status panel */}
              {hero.status === "TRAINING" && (
                <div className="flex items-center gap-3 rounded-xl border border-indigo-400/30 bg-indigo-500/[0.08] p-4">
                  <Loader2 className="size-5 shrink-0 animate-spin text-indigo-300" aria-hidden />
                  <div className="text-sm">
                    <p className="text-indigo-100">
                      Training {hero.preset === "portrait" ? "Portrait HQ" : "Fast"} · {minutesSince(hero.trainingStartedAt)} min
                      so far
                    </p>
                    <p className="text-xs text-slate-400">
                      Usually a few minutes (Portrait HQ takes longer). You can leave this page — it keeps going.
                    </p>
                  </div>
                </div>
              )}
              {hero.status === "READY" && (
                <div className="flex flex-col gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3 text-sm">
                    <CheckCircle2 className="size-5 shrink-0 text-emerald-300" aria-hidden />
                    <div>
                      <p className="text-emerald-100">Face trained and ready</p>
                      <p className="text-xs text-slate-400">Trained {formatDate(hero.trainingFinishedAt)}</p>
                    </div>
                  </div>
                  <Link
                    href={`/images?hero=${hero.id}`}
                    className="flex h-10 items-center justify-center gap-2 rounded-lg border border-indigo-400/60 bg-gradient-to-r from-indigo-600 to-violet-600 px-4 text-sm font-medium text-white"
                  >
                    <Sparkles className="size-4" aria-hidden />
                    Create images with {hero.name}
                  </Link>
                </div>
              )}
              {hero.status === "FAILED" && (
                <div className="flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] p-4 text-sm">
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-rose-300" aria-hidden />
                  <div>
                    <p className="text-rose-100">Training failed</p>
                    <p className="text-xs text-slate-400">{hero.error ?? "Unknown error."} You can fix the photos and train again.</p>
                  </div>
                </div>
              )}

              {/* Photos */}
              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Training photos</h3>
                  <span className={cx("text-xs", enoughPhotos ? "text-emerald-300" : "text-slate-500")}>
                    {enoughPhotos ? "Enough to train" : `${SOUL_PHOTO_MIN - photos.length} more needed (min ${SOUL_PHOTO_MIN})`}
                  </span>
                </div>

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!training) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => (training ? e.preventDefault() : onDrop(e))}
                  className={cx(
                    "rounded-xl border border-dashed p-3 transition-colors",
                    dragging ? "border-indigo-400/70 bg-indigo-500/[0.06]" : "border-white/[0.1]",
                  )}
                >
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-6">
                    {photos.map((p) => (
                      <div key={p.id} className="group relative aspect-square overflow-hidden rounded-lg bg-black">
                        {p.url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.url} alt={p.fileName ?? "Training photo"} loading="lazy" className="size-full object-cover" />
                        )}
                        {!training && (
                          <button
                            type="button"
                            onClick={() => void removePhoto(p)}
                            title="Remove photo"
                            className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/70 text-slate-200 opacity-100 hover:border-rose-400/60 hover:text-rose-200 sm:opacity-0 sm:group-hover:opacity-100"
                          >
                            <X className="size-3.5" aria-hidden />
                            <span className="sr-only">Remove photo</span>
                          </button>
                        )}
                      </div>
                    ))}
                    {!training && photos.length < SOUL_PHOTO_MAX && (
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        disabled={uploading}
                        className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] text-xs text-slate-400 hover:border-indigo-400/50 hover:text-indigo-200 disabled:opacity-60"
                      >
                        {uploading ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <ImagePlus className="size-5" aria-hidden />}
                        {uploading ? "Uploading…" : "Add photos"}
                      </button>
                    )}
                  </div>
                  {photos.length === 0 && !uploading && (
                    <p className="mt-3 flex items-center justify-center gap-2 text-xs text-slate-500">
                      <UploadCloud className="size-4" aria-hidden />
                      Drop photos here or click “Add photos”. JPEG, PNG or WebP, up to 15 MB each.
                    </p>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    hidden
                    onChange={onPick}
                  />
                </div>

                {uploads.some((u) => u.state === "error" || u.state === "uploading" || u.state === "queued") && (
                  <ul className="mt-3 space-y-1 text-xs">
                    {uploads
                      .filter((u) => u.state !== "done")
                      .map((u) => (
                        <li key={u.key} className="flex items-center gap-2">
                          {u.state === "error" ? (
                            <AlertTriangle className="size-3.5 text-rose-300" aria-hidden />
                          ) : (
                            <Loader2 className={cx("size-3.5 text-slate-500", u.state === "uploading" && "animate-spin text-indigo-300")} aria-hidden />
                          )}
                          <span className="truncate text-slate-300">{u.name}</span>
                          {u.error && <span className="text-rose-300">— {u.error}</span>}
                        </li>
                      ))}
                  </ul>
                )}

                <details className="mt-3 text-xs text-slate-400">
                  <summary className="cursor-pointer text-slate-300">What makes good training photos?</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>Only this person in every photo — no group shots.</li>
                    <li>Face clearly visible: close-ups plus some half-body shots.</li>
                    <li>Different angles, expressions, outfits and lighting.</li>
                    <li>No sunglasses, heavy filters, masks or blurry photos.</li>
                    <li>{SOUL_PHOTO_RECOMMENDED} good photos beat 30 similar ones.</li>
                  </ul>
                </details>
              </div>

              {/* Train */}
              {!training && (
                <div className="space-y-3 rounded-xl border border-white/[0.06] bg-[#0B0F17]/60 p-4">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
                    {hero.status === "READY" ? "Retrain" : "Train"}
                  </h3>
                  <SegmentedControl<SoulTrainingPreset>
                    label="Quality"
                    options={SOUL_TRAINING_PRESETS}
                    value={preset}
                    onChange={setPreset}
                    disabled={starting}
                  />
                  <button
                    type="button"
                    onClick={startTraining}
                    disabled={!enoughPhotos || starting || uploading}
                    className={cx(
                      "flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold uppercase tracking-[0.18em] transition-all",
                      enoughPhotos && !uploading
                        ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 text-white shadow-[0_0_30px_-6px_rgba(129,140,248,0.75)]"
                        : "cursor-not-allowed border border-white/10 bg-white/[0.04] text-slate-500",
                    )}
                  >
                    {starting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        Preparing photos…
                      </>
                    ) : hero.status === "FAILED" ? (
                      <>
                        <RotateCcw className="size-4" aria-hidden />
                        Train again ({SOUL_TRAINING_PRESETS.find((p) => p.value === preset)?.priceLabel})
                      </>
                    ) : (
                      <>
                        <Fingerprint className="size-4" aria-hidden />
                        {hero.status === "READY" ? "Retrain" : "Start training"} (
                        {SOUL_TRAINING_PRESETS.find((p) => p.value === preset)?.priceLabel})
                      </>
                    )}
                  </button>
                  <p className="text-[11px] text-slate-500">
                    Training uses your Fal credit once per run. You’ll be asked to confirm first.
                  </p>
                </div>
              )}
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

/* -------------------------------------------------------------------------- */
/*                                 Components                                 */
/* -------------------------------------------------------------------------- */

function Cover({ url, name, className }: { url: string | null; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className={cx("flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-indigo-500/10", className)}>
      {url && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <span className="text-xs font-semibold text-indigo-200">{initials}</span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SoulHero["status"] }) {
  const map = {
    NONE: { label: "Not trained", cls: "border-white/10 text-slate-400" },
    TRAINING: { label: "Training", cls: "border-indigo-400/40 text-indigo-200" },
    READY: { label: "Ready", cls: "border-emerald-400/40 text-emerald-200" },
    FAILED: { label: "Failed", cls: "border-rose-400/40 text-rose-200" },
  } as const;
  const s = map[status];
  return (
    <span className={cx("shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]", s.cls)}>
      {s.label}
    </span>
  );
}
