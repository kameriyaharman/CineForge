"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Aperture,
  Check,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  Download,
  Film,
  Fingerprint,
  Info,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  UserRound,
  Video,
  X,
} from "lucide-react";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

type CameraMovement =
  | "STATIC"
  | "PAN LEFT"
  | "PAN RIGHT"
  | "TILT UP"
  | "ZOOM IN FAST"
  | "CINEMATIC DOLLY ZOOM";

interface CameraOption {
  value: CameraMovement;
  hint: string;
}

type FaceIdStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

/** Shape returned by GET /api/characters and POST /api/characters. */
interface SoulCharacter {
  id: string;
  characterName: string;
  referenceImageUrl: string;
  faceIdStatus: FaceIdStatus;
  createdAt: string;
}

interface ListCharactersResponse {
  characters: SoulCharacter[];
}

interface RegisterCharacterRequest {
  userId: string;
  characterName: string;
  referenceImageUrl: string;
}

interface RegisterCharacterResponse {
  character: SoulCharacter;
}

interface GenerateVideoRequest {
  prompt: string;
  cameraMovement: CameraMovement;
  characterId: string;
}

/** 202 from POST /api/generate-video — the render is queued at Fal. */
interface GenerateVideoAccepted {
  clipId: string;
  requestId: string;
  status: "IN_QUEUE";
  statusUrl: string;
  finalPrompt: string;
}

type ClipPhase = "IN_QUEUE" | "RENDERING" | "UPSCALING" | "COMPLETED" | "FAILED";

/** GET /api/generate-video/{clipId} */
interface ClipStatusResponse {
  clipId: string;
  status: ClipPhase;
  queuePosition?: number;
  videoUrl?: string;
  seed?: number;
  finalPrompt: string;
  error?: string;
  note?: string;
}

interface ApiErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

interface RenderMeta {
  seed?: number;
  finalPrompt: string;
  elapsedMs: number;
  characterName: string;
  cameraMovement: CameraMovement;
}

type ToastTone = "info" | "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

type Notify = (tone: ToastTone, title: string, message?: string) => void;

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

/**
 * TEMPORARY until login exists: the signed-in user's id comes from an env var.
 * In production the server still verifies it against the signed `cf_session`
 * cookie, which the browser sends automatically on same-origin requests.
 */
const CURRENT_USER_ID = process.env.NEXT_PUBLIC_CINEFORGE_USER_ID ?? "";
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CAMERA_OPTIONS: readonly CameraOption[] = [
  { value: "STATIC", hint: "Locked-off tripod frame" },
  { value: "PAN LEFT", hint: "Smooth horizontal sweep left" },
  { value: "PAN RIGHT", hint: "Smooth horizontal sweep right" },
  { value: "TILT UP", hint: "Vertical reveal from ground to sky" },
  { value: "ZOOM IN FAST", hint: "Aggressive punch-in on subject" },
  { value: "CINEMATIC DOLLY ZOOM", hint: "Vertigo effect, background warps" },
] as const;

const PROMPT_MIN_LENGTH = 10;
const PROMPT_MAX_LENGTH = 2000;
const CHARACTER_NAME_MAX = 80;
const PLACEHOLDER_SLOTS = 4;
const TOAST_DURATION_MS = 4500;

const PROMPT_PLACEHOLDER =
  "A cyberpunk cybernetic hacker standing in neon rain on a Tokyo rooftop at midnight, holographic billboards reflecting in chrome implants, steam rising from the street below, anamorphic lens flares…";

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function isGenerateVideoAccepted(value: unknown): value is GenerateVideoAccepted {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { clipId?: unknown }).clipId === "string" &&
    typeof (value as { statusUrl?: unknown }).statusUrl === "string"
  );
}

function isClipStatus(value: unknown): value is ClipStatusResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { clipId?: unknown }).clipId === "string" &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

const STATUS_POLL_MS = 4000;
const MAX_POLL_FAILURES = 6;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

function phaseCaption(phase: ClipPhase | null, queuePosition: number | null): string {
  switch (phase) {
    case "IN_QUEUE":
      return queuePosition !== null && queuePosition > 0
        ? `Waiting in the render queue · position ${queuePosition + 1}`
        : "Waiting for a render slot…";
    case "RENDERING":
      return "Rendering frames…";
    case "UPSCALING":
      return "Upscaling to 2K…";
    default:
      return "Sending to the render engine…";
  }
}

function isSoulCharacter(value: unknown): value is SoulCharacter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.characterName === "string" &&
    typeof v.referenceImageUrl === "string"
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    const message =
      res.status === 502 || res.status === 503 || res.status === 504
        ? "The server is unreachable or restarting. Try again in a minute."
        : `Unexpected response (${res.status}).`;
    return { error: message, code: "BAD_RESPONSE" };
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function CineForgeStudioPage() {
  /* ---------------------------- Generation state --------------------------- */
  const [prompt, setPrompt] = useState<string>("");
  const [cameraMovement, setCameraMovement] = useState<CameraMovement>("STATIC");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<RenderMeta | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [phase, setPhase] = useState<ClipPhase | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const renderAbortRef = useRef<AbortController | null>(null);
  const activeClipIdRef = useRef<string | null>(null);

  /* ----------------------------- Soul ID state ----------------------------- */
  const [characters, setCharacters] = useState<SoulCharacter[]>([]);
  const [charactersLoading, setCharactersLoading] = useState<boolean>(true);
  const [charactersError, setCharactersError] = useState<string | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [soulIdHighlight, setSoulIdHighlight] = useState<boolean>(false);

  /* -------------------------------- Toasts -------------------------------- */
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef<number>(0);

  const userIdValid = USER_ID_PATTERN.test(CURRENT_USER_ID);
  const activeCharacter = characters.find((c) => c.id === activeCharacterId) ?? null;

  const trimmedLength = prompt.trim().length;
  const promptValid = trimmedLength >= PROMPT_MIN_LENGTH && trimmedLength <= PROMPT_MAX_LENGTH;

  /* -------------------------------- Effects -------------------------------- */

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (tone, title, message) => {
      const id = ++toastIdRef.current;
      setToasts((list) => [...list.slice(-3), { id, tone, title, message }]);
      window.setTimeout(() => dismissToast(id), TOAST_DURATION_MS);
    },
    [dismissToast],
  );

  // Load the user's saved characters.
  useEffect(() => {
    if (!userIdValid) {
      setCharactersLoading(false);
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/characters?userId=${encodeURIComponent(CURRENT_USER_ID)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await readJson(res);
        if (!res.ok || isApiError(data)) {
          throw new Error(isApiError(data) ? data.error : `Request failed (${res.status}).`);
        }
        const list = (data as ListCharactersResponse).characters;
        setCharacters(Array.isArray(list) ? list.filter(isSoulCharacter) : []);
        setCharactersError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setCharactersError(err instanceof Error ? err.message : "Could not load characters.");
      } finally {
        if (!controller.signal.aborted) setCharactersLoading(false);
      }
    })();
    return () => controller.abort();
  }, [userIdValid]);

  // Elapsed-time ticker while rendering.
  useEffect(() => {
    if (!loading) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  // Abort any in-flight render on unmount.
  useEffect(() => () => renderAbortRef.current?.abort(), []);

  // Clear the "pick a character" pulse after a moment.
  useEffect(() => {
    if (!soulIdHighlight) return;
    const id = window.setTimeout(() => setSoulIdHighlight(false), 2400);
    return () => window.clearTimeout(id);
  }, [soulIdHighlight]);

  /* ------------------------------- Handlers ------------------------------- */

  const handleCharacterCreated = useCallback(
    (character: SoulCharacter) => {
      setCharacters((list) => [character, ...list.filter((c) => c.id !== character.id)]);
      setActiveCharacterId(character.id);
      notify("success", "Soul ID registered", `${character.characterName} is locked in for production.`);
    },
    [notify],
  );

  const handleSelectCharacter = useCallback((id: string) => {
    setActiveCharacterId((current) => (current === id ? null : id));
  }, []);

  const generateVideo = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (loading) return;

      if (!promptValid) {
        notify(
          "info",
          "Prompt too short",
          `Describe the shot in at least ${PROMPT_MIN_LENGTH} characters.`,
        );
        return;
      }

      if (!activeCharacter) {
        setSoulIdHighlight(true);
        notify(
          "error",
          "No Soul ID locked",
          characters.length === 0
            ? "Register a character in Soul ID Archetypes before rendering."
            : "Select a character slot to lock identity for this sequence.",
        );
        return;
      }

      renderAbortRef.current?.abort();
      const controller = new AbortController();
      renderAbortRef.current = controller;

      const began = Date.now();
      const lockedCharacter = activeCharacter;
      const lockedCamera = cameraMovement;
      setStartedAt(began);
      setNow(began);
      setLoading(true);
      setError(null);
      setVideoUrl(null);
      setMeta(null);

      const payload: GenerateVideoRequest = {
        prompt: prompt.trim(),
        cameraMovement: lockedCamera,
        characterId: lockedCharacter.id,
      };

      setPhase(null);
      setQueuePosition(null);
      activeClipIdRef.current = null;

      try {
        // 1. Submit — returns in about a second with a clip id.
        const response = await fetch("/api/generate-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const accepted = await readJson(response);
        if (!response.ok || isApiError(accepted)) {
          throw new Error(
            isApiError(accepted) ? accepted.error : `Render failed (${response.status}).`,
          );
        }
        if (!isGenerateVideoAccepted(accepted)) {
          throw new Error("The server returned an unexpected response.");
        }
        activeClipIdRef.current = accepted.clipId;
        setPhase("IN_QUEUE");

        // 2. Poll until the video is ready or the render fails.
        let failures = 0;
        for (;;) {
          await sleep(STATUS_POLL_MS, controller.signal);

          let status: unknown;
          let ok = false;
          try {
            const res = await fetch(accepted.statusUrl, {
              cache: "no-store",
              signal: controller.signal,
            });
            ok = res.ok;
            status = await readJson(res);
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            status = null;
          }

          if (!ok || !isClipStatus(status)) {
            failures += 1;
            if (failures >= MAX_POLL_FAILURES) {
              throw new Error(
                isApiError(status) ? status.error : "Lost contact with the render server.",
              );
            }
            continue;
          }
          failures = 0;
          setPhase(status.status);
          setQueuePosition(status.queuePosition ?? null);

          if (status.status === "FAILED") {
            throw new Error(status.error ?? "The render failed.");
          }

          if ((status.status === "COMPLETED" || status.status === "UPSCALING") && status.videoUrl) {
            setVideoUrl(status.videoUrl);
            setMeta({
              seed: status.seed,
              finalPrompt: status.finalPrompt,
              elapsedMs: Date.now() - began,
              characterName: lockedCharacter.characterName,
              cameraMovement: lockedCamera,
            });
            notify(
              "success",
              "Sequence rendered",
              status.status === "UPSCALING"
                ? "Showing the raw render; the 2K master is upscaling in the background."
                : `${lockedCharacter.characterName} · ${lockedCamera}`,
            );
            break;
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setError("Render cancelled.");
        } else if (err instanceof TypeError) {
          setError("Network error. Check your connection and try again.");
        } else {
          setError(err instanceof Error ? err.message : "Unexpected error during render.");
        }
      } finally {
        if (renderAbortRef.current === controller) renderAbortRef.current = null;
        activeClipIdRef.current = null;
        setPhase(null);
        setQueuePosition(null);
        setLoading(false);
      }
    },
    [activeCharacter, cameraMovement, characters.length, loading, notify, prompt, promptValid],
  );

  const handleCancel = useCallback(() => {
    const clipId = activeClipIdRef.current;
    renderAbortRef.current?.abort();
    if (clipId) {
      // Stop the Fal job too, so an abandoned render isn't billed.
      void fetch(`/api/generate-video/${clipId}`, { method: "DELETE" }).catch(() => undefined);
    }
  }, []);

  const handleReset = useCallback(() => {
    setError(null);
    setVideoUrl(null);
    setMeta(null);
  }, []);

  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void generateVideo();
    }
  };

  const elapsedLabel = startedAt !== null ? formatElapsed(now - startedAt) : "0:00";
  const renderReady = promptValid && activeCharacter !== null;

  /* -------------------------------- Render -------------------------------- */

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#0B0F17] font-sans text-slate-100 antialiased">
      <style>{`
        @keyframes cf-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        @keyframes cf-scan { 0% { top: 0%; } 100% { top: 100%; } }
        @keyframes cf-fade-in { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: scale(1); } }
        @keyframes cf-drop { from { transform: translateY(-4px); } to { transform: translateY(0); } }
        @keyframes cf-toast { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes cf-attention { 0%, 100% { box-shadow: 0 0 0 0 rgba(244,63,94,0); } 50% { box-shadow: 0 0 0 4px rgba(244,63,94,0.35); } }
        .cf-shimmer { animation: cf-shimmer 2.2s linear infinite; }
        .cf-scan { animation: cf-scan 3.2s ease-in-out infinite alternate; }
        .cf-fade-in { animation: cf-fade-in 0.6s ease-out both; }
        .cf-drop { animation: cf-drop 0.15s ease-out both; }
        .cf-toast { animation: cf-toast 0.25s ease-out both; }
        .cf-attention { animation: cf-attention 0.8s ease-in-out 3; }
        @media (prefers-reduced-motion: reduce) {
          .cf-shimmer, .cf-scan, .cf-fade-in, .cf-drop, .cf-toast, .cf-attention { animation: none; }
        }
      `}</style>

      {/* Ambient lighting */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.18),transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-[420px] w-[620px] rounded-full bg-[radial-gradient(closest-side,rgba(139,92,246,0.10),transparent)]"
      />

      {/* Header */}
      <header className="relative z-10 border-b border-white/[0.06] bg-[#0B0F17]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border border-indigo-400/40 bg-indigo-500/10 shadow-[0_0_20px_-4px_rgba(129,140,248,0.6)]">
              <Aperture className="size-5 text-indigo-300" aria-hidden />
            </div>
            <span className="text-lg font-semibold tracking-tight">
              Cine<span className="text-indigo-300">Forge</span>
            </span>
            <span className="ml-2 hidden rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200 sm:inline">
              Studio
            </span>
          </div>
          <div className="hidden items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-slate-500 md:flex">
            <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
            Hunyuan Video · 16:9 · 580p
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid max-w-[1440px] items-start gap-6 px-4 py-6 sm:px-8 sm:py-10 lg:grid-cols-[420px_minmax(0,1fr)] xl:grid-cols-[460px_minmax(0,1fr)]">
        {/* ============================ Production Panel ============================ */}
        <aside className="space-y-5">
          <SoulIdArchetypes
            userId={CURRENT_USER_ID}
            userIdValid={userIdValid}
            characters={characters}
            loading={charactersLoading}
            loadError={charactersError}
            activeCharacterId={activeCharacterId}
            onSelect={handleSelectCharacter}
            onCreated={handleCharacterCreated}
            disabled={loading}
            highlight={soulIdHighlight}
            notify={notify}
          />

          <section className="rounded-2xl border border-indigo-500/20 bg-[#0F1420]/90 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_30px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur sm:p-6">
            <div className="mb-6 flex items-center gap-2.5">
              <Clapperboard className="size-4 text-violet-300" aria-hidden />
              <h1 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">
                Production Panel
              </h1>
            </div>

            <form onSubmit={generateVideo} noValidate className="space-y-6">
              {/* Master prompt */}
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <label
                    htmlFor="master-prompt"
                    className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400"
                  >
                    Master Prompt
                  </label>
                  <span
                    className={cx(
                      "font-mono text-[11px] tabular-nums",
                      trimmedLength > PROMPT_MAX_LENGTH ? "text-rose-400" : "text-slate-500",
                    )}
                  >
                    {trimmedLength}/{PROMPT_MAX_LENGTH}
                  </span>
                </div>
                <div className="group relative rounded-xl p-px transition-all duration-300 focus-within:bg-gradient-to-br focus-within:from-indigo-500/70 focus-within:via-violet-500/50 focus-within:to-fuchsia-500/40 focus-within:shadow-[0_0_30px_-8px_rgba(129,140,248,0.7)]">
                  <textarea
                    id="master-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    disabled={loading}
                    rows={8}
                    maxLength={PROMPT_MAX_LENGTH + 200}
                    placeholder={PROMPT_PLACEHOLDER}
                    className="block min-h-48 w-full resize-none rounded-[11px] border border-white/[0.08] bg-[#0B0F17] p-4 text-[15px] leading-relaxed text-slate-100 placeholder:text-slate-600 outline-none transition-colors group-focus-within:border-transparent disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Subject, setting, lighting, lens and mood. Press{" "}
                  <kbd className="whitespace-nowrap rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                    ⌘/Ctrl + Enter
                  </kbd>{" "}
                  to render.
                </p>
              </div>

              {/* Camera control */}
              <div className="space-y-2">
                <span
                  id="camera-label"
                  className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400"
                >
                  Camera Control
                </span>
                <CameraDropdown
                  labelledBy="camera-label"
                  value={cameraMovement}
                  onChange={setCameraMovement}
                  disabled={loading}
                />
              </div>

              {/* Locked identity summary */}
              <div
                className={cx(
                  "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-xs transition-colors",
                  activeCharacter
                    ? "border-indigo-400/40 bg-indigo-500/[0.08]"
                    : "border-dashed border-white/10 bg-transparent",
                )}
              >
                {activeCharacter ? (
                  <>
                    <Avatar
                      name={activeCharacter.characterName}
                      src={activeCharacter.referenceImageUrl}
                      className="size-8 rounded-lg"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
                        Identity locked
                      </p>
                      <p className="truncate font-medium text-slate-100">
                        {activeCharacter.characterName}
                      </p>
                    </div>
                    <Fingerprint className="size-4 shrink-0 text-indigo-300" aria-hidden />
                  </>
                ) : (
                  <>
                    <div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-white/15">
                      <UserRound className="size-4 text-slate-600" aria-hidden />
                    </div>
                    <p className="text-slate-500">
                      No Soul ID selected. Pick a character above to lock identity.
                    </p>
                  </>
                )}
              </div>

              {/* Render button */}
              {loading ? (
                <div className="space-y-3">
                  <button
                    type="button"
                    disabled
                    aria-busy="true"
                    className="relative flex h-14 w-full items-center justify-center gap-2.5 overflow-hidden rounded-xl border border-indigo-400/40 bg-gradient-to-r from-indigo-600/60 via-violet-600/60 to-indigo-600/60 text-sm font-semibold uppercase tracking-[0.2em] text-white/90"
                  >
                    <span
                      aria-hidden
                      className="cf-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                    />
                    <Loader2 className="relative size-4 animate-spin" aria-hidden />
                    <span className="relative">Rendering · {elapsedLabel}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 transition-colors hover:border-rose-400/40 hover:text-rose-300"
                  >
                    <Square className="size-3.5" aria-hidden />
                    Cancel Render
                  </button>
                </div>
              ) : (
                <button
                  type="submit"
                  aria-disabled={!renderReady}
                  className={cx(
                    "group relative flex h-14 w-full items-center justify-center gap-2.5 overflow-hidden rounded-xl text-sm font-semibold uppercase tracking-[0.22em] transition-all duration-300",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F1420]",
                    renderReady
                      ? [
                          "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 bg-[length:200%_100%] bg-left text-white",
                          "shadow-[0_0_30px_-6px_rgba(129,140,248,0.75),inset_0_1px_0_rgba(255,255,255,0.18)]",
                          "hover:-translate-y-0.5 hover:bg-right hover:shadow-[0_0_55px_-4px_rgba(139,92,246,0.95),inset_0_1px_0_rgba(255,255,255,0.25)] active:translate-y-0",
                        ].join(" ")
                      : "border border-white/10 bg-white/[0.04] text-slate-500 hover:border-white/20",
                  )}
                >
                  <Sparkles
                    className={cx(
                      "size-4 transition-transform duration-300",
                      renderReady && "group-hover:rotate-12 group-hover:scale-125",
                    )}
                    aria-hidden
                  />
                  Render Sequence
                </button>
              )}
            </form>
          </section>
        </aside>

        {/* ============================ Preview Monitor ============================ */}
        <section className="rounded-2xl border border-white/[0.06] bg-[#0F1420]/70 p-4 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur sm:p-6 lg:sticky lg:top-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Film className="size-4 text-indigo-300" aria-hidden />
              <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">
                Preview Monitor
              </h2>
            </div>
            <StatusPill loading={loading} error={error} hasVideo={videoUrl !== null} />
          </div>

          <div
            className={cx(
              "relative aspect-video w-full overflow-hidden rounded-2xl bg-black transition-shadow duration-500",
              videoUrl
                ? "border border-indigo-400/40 shadow-[0_0_60px_-15px_rgba(129,140,248,0.55)]"
                : "border border-white/[0.07]",
            )}
          >
            {loading ? (
              <RenderingPlaceholder
                elapsed={elapsedLabel}
                camera={cameraMovement}
                characterName={activeCharacter?.characterName ?? null}
                caption={phaseCaption(phase, queuePosition)}
              />
            ) : error ? (
              <ErrorState message={error} onReset={handleReset} />
            ) : videoUrl ? (
              <video
                key={videoUrl}
                src={videoUrl}
                controls
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                className="cf-fade-in size-full rounded-2xl object-contain"
              >
                Your browser does not support HTML5 video.
              </video>
            ) : (
              <EmptyCanvas />
            )}
          </div>

          {videoUrl && meta && !loading && (
            <div className="mt-4 flex flex-col gap-4 rounded-xl border border-white/[0.06] bg-[#0B0F17]/80 p-4 sm:flex-row sm:items-center sm:justify-between">
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <div className="flex gap-1.5">
                  <dt className="text-slate-500">Soul ID</dt>
                  <dd className="text-slate-200">{meta.characterName}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-slate-500">Camera</dt>
                  <dd className="font-mono text-violet-300">{meta.cameraMovement}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-slate-500">Render</dt>
                  <dd className="font-mono tabular-nums text-slate-200">
                    {formatElapsed(meta.elapsedMs)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-slate-500">Seed</dt>
                  <dd className="font-mono tabular-nums text-slate-200">{meta.seed ?? "—"}</dd>
                </div>
              </dl>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-white/5"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Clear
                </button>
                <a
                  href={videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  download
                  className="flex h-9 items-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-500/15 px-3 text-xs font-medium text-indigo-100 transition-all hover:bg-indigo-500/25 hover:shadow-[0_0_20px_-4px_rgba(129,140,248,0.7)]"
                >
                  <Download className="size-3.5" aria-hidden />
                  Download MP4
                </a>
              </div>
            </div>
          )}
        </section>
      </main>

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Soul ID Archetypes                              */
/* -------------------------------------------------------------------------- */

interface SoulIdArchetypesProps {
  userId: string;
  userIdValid: boolean;
  characters: SoulCharacter[];
  loading: boolean;
  loadError: string | null;
  activeCharacterId: string | null;
  onSelect: (id: string) => void;
  onCreated: (character: SoulCharacter) => void;
  disabled: boolean;
  highlight: boolean;
  notify: Notify;
}

function SoulIdArchetypes({
  userId,
  userIdValid,
  characters,
  loading,
  loadError,
  activeCharacterId,
  onSelect,
  onCreated,
  disabled,
  highlight,
  notify,
}: SoulIdArchetypesProps) {
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const placeholderCount = loading ? 0 : Math.max(0, PLACEHOLDER_SLOTS - characters.length);

  return (
    <section
      aria-labelledby="soul-id-heading"
      className={cx(
        "rounded-2xl border bg-[#0F1420]/90 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_30px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur transition-colors sm:p-6",
        highlight ? "cf-attention border-rose-400/60" : "border-indigo-500/20",
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Fingerprint className="size-4 text-violet-300" aria-hidden />
          <h2
            id="soul-id-heading"
            className="whitespace-nowrap text-xs font-semibold uppercase tracking-[0.2em] text-slate-300 sm:text-sm sm:tracking-[0.22em]"
          >
            Soul ID Archetypes
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          disabled={!userIdValid || disabled}
          aria-expanded={formOpen}
          aria-controls="soul-id-form"
          className={cx(
            "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-all",
            formOpen
              ? "border-white/15 text-slate-300 hover:bg-white/5"
              : "border-indigo-400/50 bg-indigo-500/15 text-indigo-100 hover:bg-indigo-500/25 hover:shadow-[0_0_18px_-4px_rgba(129,140,248,0.7)]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {formOpen ? (
            <>
              <X className="size-3.5" aria-hidden /> Close
            </>
          ) : (
            <>
              <Plus className="size-3.5" aria-hidden /> New
              <span className="hidden sm:inline">Soul ID</span>
            </>
          )}
        </button>
      </div>

      {!userIdValid && (
        <div className="mb-4 flex gap-2.5 rounded-lg border border-amber-400/30 bg-amber-500/[0.07] p-3 text-xs text-amber-100/90">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
          <p>
            No user configured. Set <code className="font-mono">NEXT_PUBLIC_CINEFORGE_USER_ID</code>{" "}
            to a user id from the database, then restart the dev server.
          </p>
        </div>
      )}

      {formOpen && userIdValid && (
        <CharacterForm
          userId={userId}
          onCreated={(character) => {
            onCreated(character);
            setFormOpen(false);
          }}
          notify={notify}
        />
      )}

      {loadError && (
        <p className="mb-3 flex items-center gap-2 text-xs text-rose-300">
          <AlertTriangle className="size-3.5" aria-hidden />
          {loadError}
        </p>
      )}

      <div
        role="listbox"
        aria-label="Soul ID characters"
        aria-activedescendant={activeCharacterId ? `soul-${activeCharacterId}` : undefined}
        className="grid grid-cols-4 gap-3"
      >
        {loading &&
          Array.from({ length: PLACEHOLDER_SLOTS }, (_, i) => (
            <div key={`skeleton-${i}`} className="space-y-2">
              <div className="aspect-square animate-pulse rounded-xl bg-white/[0.05]" />
              <div className="mx-auto h-2 w-3/4 animate-pulse rounded-full bg-white/[0.05]" />
            </div>
          ))}

        {!loading &&
          characters.map((character) => (
            <CharacterSlot
              key={character.id}
              character={character}
              selected={character.id === activeCharacterId}
              disabled={disabled}
              onSelect={onSelect}
            />
          ))}

        {placeholderCount > 0 &&
          Array.from({ length: placeholderCount }, (_, i) => (
            <button
              key={`placeholder-${i}`}
              type="button"
              onClick={() => userIdValid && setFormOpen(true)}
              disabled={!userIdValid || disabled}
              className="group flex flex-col items-center gap-2 disabled:cursor-not-allowed"
            >
              <span className="flex aspect-square w-full items-center justify-center rounded-xl border border-dashed border-white/[0.12] bg-white/[0.02] transition-colors group-hover:border-indigo-400/40 group-hover:bg-indigo-500/[0.05] group-disabled:group-hover:border-white/[0.12] group-disabled:group-hover:bg-white/[0.02]">
                <UserRound
                  className="size-6 text-slate-700 transition-colors group-hover:text-indigo-300/70"
                  aria-hidden
                />
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-slate-600">
                Hero {characters.length + i + 1}
              </span>
            </button>
          ))}
      </div>

      {!loading && characters.length > 0 && (
        <p className="mt-3 text-[11px] text-slate-500">
          {activeCharacterId
            ? "Click the selected slot again to release it."
            : "Select a slot to lock that identity for the next render."}
        </p>
      )}
    </section>
  );
}

function CharacterSlot({
  character,
  selected,
  disabled,
  onSelect,
}: {
  character: SoulCharacter;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const statusStyle: Record<FaceIdStatus, string> = {
    PENDING: "bg-amber-400",
    PROCESSING: "bg-sky-400 animate-pulse",
    READY: "bg-emerald-400",
    FAILED: "bg-rose-500",
  };

  return (
    <button
      id={`soul-${character.id}`}
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={() => onSelect(character.id)}
      title={`${character.characterName} · Face ID ${character.faceIdStatus.toLowerCase()}`}
      className="group flex min-w-0 flex-col items-center gap-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={cx(
          "relative block aspect-square w-full overflow-hidden rounded-xl transition-all duration-200",
          selected
            ? "ring-2 ring-indigo-300 ring-offset-2 ring-offset-[#0F1420] shadow-[0_0_28px_-4px_rgba(129,140,248,0.95)]"
            : "ring-1 ring-white/10 group-hover:ring-indigo-400/50 group-focus-visible:ring-2 group-focus-visible:ring-violet-400",
        )}
      >
        <Avatar
          name={character.characterName}
          src={character.referenceImageUrl}
          className={cx(
            "size-full transition-all duration-300",
            selected ? "scale-105" : "grayscale-[35%] group-hover:grayscale-0",
          )}
        />
        <span
          aria-hidden
          className={cx(
            "absolute left-1.5 top-1.5 size-2 rounded-full ring-2 ring-black/60",
            statusStyle[character.faceIdStatus],
          )}
        />
        {selected && (
          <span className="absolute bottom-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-indigo-400 text-[#0B0F17] shadow-[0_0_10px_rgba(129,140,248,0.9)]">
            <Check className="size-3.5" strokeWidth={3} aria-hidden />
          </span>
        )}
      </span>
      <span
        className={cx(
          "w-full truncate text-center text-[11px] font-medium",
          selected ? "text-indigo-100" : "text-slate-400",
        )}
      >
        {character.characterName}
      </span>
    </button>
  );
}

function Avatar({ name, src, className }: { name: string; src: string; className?: string }) {
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return (
      <span
        className={cx(
          "flex items-center justify-center bg-gradient-to-br from-indigo-500/30 to-violet-600/30 text-sm font-semibold text-indigo-100",
          className,
        )}
      >
        {initials(name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- user-supplied hosts; next/image would need every domain allow-listed
    <img
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cx("object-cover", className)}
    />
  );
}

/* -------------------------- Character registration ------------------------ */

function CharacterForm({
  userId,
  onCreated,
  notify,
}: {
  userId: string;
  onCreated: (character: SoulCharacter) => void;
  notify: Notify;
}) {
  const [name, setName] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const urlId = useId();

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const trimmedName = name.trim();
  const trimmedUrl = imageUrl.trim();
  const urlLooksValid = /^https:\/\/\S+$/i.test(trimmedUrl);
  const canSubmit =
    trimmedName.length > 0 && trimmedName.length <= CHARACTER_NAME_MAX && urlLooksValid && !submitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      setFormError(
        !trimmedName
          ? "Give the character a name."
          : "Reference image must be an https:// link to a JPEG, PNG or WebP.",
      );
      return;
    }

    setSubmitting(true);
    setFormError(null);

    const payload: RegisterCharacterRequest = {
      userId,
      characterName: trimmedName,
      referenceImageUrl: trimmedUrl,
    };

    try {
      const res = await fetch("/api/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await readJson(res);

      if (res.status === 201 && !isApiError(data)) {
        const character = (data as RegisterCharacterResponse).character;
        if (!isSoulCharacter(character)) {
          throw new Error("Server returned an unexpected character payload.");
        }
        onCreated(character);
        return;
      }

      const message = isApiError(data) ? data.error : `Request failed (${res.status}).`;
      if (res.status === 401 || res.status === 403) {
        notify("error", "Session problem", message);
      }
      setFormError(message);
    } catch (err) {
      setFormError(
        err instanceof TypeError
          ? "Network error. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Could not register the character.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    "h-11 w-full rounded-lg border border-white/[0.08] bg-[#0B0F17] px-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition-all focus:border-indigo-400/70 focus:shadow-[0_0_20px_-6px_rgba(129,140,248,0.7)] disabled:opacity-60";

  return (
    <form
      id="soul-id-form"
      onSubmit={handleSubmit}
      noValidate
      className="cf-drop mb-5 space-y-3 rounded-xl border border-indigo-500/25 bg-[#0B0F17]/70 p-4"
    >
      <div className="space-y-1.5">
        <label
          htmlFor={nameId}
          className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400"
        >
          Character Name
        </label>
        <input
          ref={nameInputRef}
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={CHARACTER_NAME_MAX}
          disabled={submitting}
          placeholder="Kaira Vance"
          autoComplete="off"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor={urlId}
          className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400"
        >
          Reference Image URL
        </label>
        <div className="relative">
          <Link2
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-600"
            aria-hidden
          />
          <input
            id={urlId}
            type="url"
            inputMode="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            disabled={submitting}
            placeholder="https://…/hero-front.jpg"
            autoComplete="off"
            spellCheck={false}
            className={cx(inputClass, "pl-9")}
          />
        </div>
        <p className="text-[11px] text-slate-500">
          Clear, front-facing face shot. JPEG, PNG or WebP, up to 15 MB.
        </p>
      </div>

      {formError && (
        <p role="alert" className="flex items-start gap-2 text-xs text-rose-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className={cx(
          "flex h-11 w-full items-center justify-center gap-2 rounded-lg border text-xs font-semibold uppercase tracking-[0.2em] transition-all",
          canSubmit
            ? "border-indigo-400/60 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-[0_0_24px_-6px_rgba(129,140,248,0.8)] hover:shadow-[0_0_36px_-4px_rgba(139,92,246,0.95)]"
            : "border-white/10 bg-white/[0.04] text-slate-500",
          "disabled:cursor-wait",
        )}
      >
        {submitting ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Verifying Reference…
          </>
        ) : (
          <>
            <Fingerprint className="size-4" aria-hidden />
            Register Soul ID
          </>
        )}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Camera Dropdown                               */
/* -------------------------------------------------------------------------- */

interface CameraDropdownProps {
  value: CameraMovement;
  onChange: (value: CameraMovement) => void;
  disabled?: boolean;
  labelledBy: string;
}

function CameraDropdown({ value, onChange, disabled = false, labelledBy }: CameraDropdownProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selectedIndex = Math.max(
    0,
    CAMERA_OPTIONS.findIndex((o) => o.value === value),
  );
  const selected = CAMERA_OPTIONS[selectedIndex] ?? CAMERA_OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setActiveIndex(selectedIndex);
      listRef.current?.focus({ preventScroll: true });
    }
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const commit = (index: number) => {
    const option = CAMERA_OPTIONS[index];
    if (option) onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const last = CAMERA_OPTIONS.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? last : i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={`${labelledBy} camera-value`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKeyDown}
        className={cx(
          "flex h-14 w-full items-center justify-between gap-3 rounded-xl border bg-[#0B0F17] px-4 text-left transition-all duration-200",
          open
            ? "border-indigo-400/70 shadow-[0_0_24px_-6px_rgba(129,140,248,0.7)]"
            : "border-white/[0.08] hover:border-indigo-400/40",
          "focus-visible:border-indigo-400/70 focus-visible:outline-none focus-visible:shadow-[0_0_24px_-6px_rgba(129,140,248,0.7)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-violet-400/30 bg-violet-500/10">
            <Video className="size-4 text-violet-300" aria-hidden />
          </span>
          <span className="min-w-0">
            <span
              id="camera-value"
              className="block truncate font-mono text-sm tracking-wider text-slate-100"
            >
              {selected.value}
            </span>
            <span className="block truncate text-[11px] text-slate-500">{selected.hint}</span>
          </span>
        </span>
        <ChevronDown
          className={cx(
            "size-4 shrink-0 text-slate-400 transition-transform duration-200",
            open && "rotate-180 text-indigo-300",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={`${listboxId}-opt-${activeIndex}`}
          onKeyDown={onListKeyDown}
          className="cf-drop absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-80 overflow-auto rounded-xl border border-indigo-500/30 bg-[#0F1420] p-1.5 shadow-[0_20px_60px_-10px_rgba(0,0,0,0.95),0_0_30px_-10px_rgba(129,140,248,0.5)] outline-none"
        >
          {CAMERA_OPTIONS.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={option.value}
                id={`${listboxId}-opt-${index}`}
                role="option"
                aria-selected={isSelected}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={cx(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-lg border-l-2 px-3 py-2.5 transition-colors",
                  isActive
                    ? "border-indigo-400 bg-indigo-500/20 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.25)]"
                    : "border-transparent bg-transparent",
                )}
              >
                <span className="min-w-0">
                  <span
                    className={cx(
                      "block font-mono text-[13px] tracking-wider",
                      isSelected ? "text-indigo-200" : "text-slate-200",
                    )}
                  >
                    {option.value}
                  </span>
                  <span className="block text-[11px] text-slate-500">{option.hint}</span>
                </span>
                {isSelected && <Check className="size-4 shrink-0 text-indigo-300" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Monitor States                                */
/* -------------------------------------------------------------------------- */

function StatusPill({
  loading,
  error,
  hasVideo,
}: {
  loading: boolean;
  error: string | null;
  hasVideo: boolean;
}) {
  const { label, dot } = loading
    ? {
        label: "Rendering",
        dot: "bg-violet-400 animate-pulse shadow-[0_0_8px_rgba(167,139,250,0.9)]",
      }
    : error
      ? { label: "Failed", dot: "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]" }
      : hasVideo
        ? { label: "Ready", dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" }
        : { label: "Standby", dot: "bg-slate-500" };

  return (
    <div className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-[#0B0F17] px-3 py-1.5">
      <span className={cx("size-1.5 rounded-full", dot)} />
      <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-300">
        {label}
      </span>
    </div>
  );
}

function ViewfinderFrame() {
  const corner = "absolute size-6 border-indigo-400/60";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-4 sm:inset-6">
      <span className={cx(corner, "left-0 top-0 border-l-2 border-t-2")} />
      <span className={cx(corner, "right-0 top-0 border-r-2 border-t-2")} />
      <span className={cx(corner, "bottom-0 left-0 border-b-2 border-l-2")} />
      <span className={cx(corner, "bottom-0 right-0 border-b-2 border-r-2")} />
    </div>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.06),transparent_70%)] p-6 text-center">
      <ViewfinderFrame />
      <Aperture className="size-10 text-slate-700" aria-hidden />
      <p className="text-sm text-slate-500">Your rendered sequence will appear here</p>
    </div>
  );
}

function RenderingPlaceholder({
  elapsed,
  camera,
  characterName,
  caption,
}: {
  elapsed: string;
  camera: CameraMovement;
  characterName: string | null;
  caption: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative size-full overflow-hidden bg-gradient-to-br from-[#0E1322] via-[#0B0F17] to-[#120E22]"
    >
      <div
        aria-hidden
        className="cf-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-indigo-400/[0.07] to-transparent"
      />
      <div
        aria-hidden
        className="cf-scan absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-violet-400/70 to-transparent shadow-[0_0_12px_rgba(167,139,250,0.8)]"
      />
      <ViewfinderFrame />

      <div aria-hidden className="absolute inset-x-10 top-10 hidden items-center justify-between sm:flex">
        <div className="h-2.5 w-24 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="flex items-center gap-2">
          <span className="size-2 animate-pulse rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9)]" />
          <span className="font-mono text-[11px] tracking-widest text-slate-400">REC {elapsed}</span>
        </div>
      </div>
      <div aria-hidden className="absolute inset-x-10 bottom-10 hidden space-y-2.5 sm:block">
        <div className="h-2 w-2/3 animate-pulse rounded-full bg-white/[0.06]" />
        <div className="h-2 w-1/3 animate-pulse rounded-full bg-white/[0.05]" />
      </div>

      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-indigo-400/25 bg-[#0B0F17]/80 p-5 text-center shadow-[0_0_40px_-10px_rgba(129,140,248,0.5)] backdrop-blur-md sm:p-6">
          <Loader2 className="mx-auto mb-3 size-7 animate-spin text-indigo-300" aria-hidden />
          <p className="animate-pulse text-sm font-medium text-slate-100 sm:text-base">
            🎬 CineForge AI Engine Rendering Clip (Approx 60s)...
          </p>
          <p className="mt-2 text-xs text-indigo-200/90">{caption}</p>
          <p className="mt-2 font-mono text-[11px] tracking-widest text-slate-500">
            {characterName ? `${characterName.toUpperCase()} · ` : ""}
            {camera} · ELAPSED {elapsed}
          </p>
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="cf-shimmer h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-violet-400 to-transparent" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_center,rgba(244,63,94,0.08),transparent_70%)] p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-rose-400/40 bg-rose-500/10">
        <AlertTriangle className="size-5 text-rose-300" aria-hidden />
      </div>
      <p className="max-w-sm text-sm text-slate-300">{message}</p>
      <button
        type="button"
        onClick={onReset}
        className="flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-white/5"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Dismiss
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Toasts                                   */
/* -------------------------------------------------------------------------- */

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  const toneStyles: Record<ToastTone, { border: string; icon: ReactNode }> = {
    info: {
      border: "border-indigo-400/40",
      icon: <Info className="size-4 text-indigo-300" aria-hidden />,
    },
    success: {
      border: "border-emerald-400/40",
      icon: <CheckCircle2 className="size-4 text-emerald-300" aria-hidden />,
    },
    error: {
      border: "border-rose-400/50",
      icon: <AlertTriangle className="size-4 text-rose-300" aria-hidden />,
    },
  };

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      {toasts.map((toast) => {
        const style = toneStyles[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={cx(
              "cf-toast pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-[#0F1420]/95 p-3.5 shadow-[0_20px_50px_-10px_rgba(0,0,0,0.9)] backdrop-blur-xl sm:w-96",
              style.border,
            )}
          >
            <span className="mt-0.5 shrink-0">{style.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-100">{toast.title}</p>
              {toast.message && <p className="mt-0.5 text-xs text-slate-400">{toast.message}</p>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
