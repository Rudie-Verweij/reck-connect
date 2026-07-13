// Voice-dictation preferences (issue #67), mirroring the TTS settings
// module. The non-secret prefs live under the "transcription" config key;
// the Deepgram API key is stored separately under a secret key so
// safeStorage's refusal path only blocks the secret half.
//
// See docs/plans/voice-dictation-satellite.md.

import { isDictationLanguage } from "./languages";

export const TRANSCRIPTION_CONFIG_KEY = "transcription";
export const DEEPGRAM_KEY_CONFIG_KEY = "transcription.deepgramKey";

export type TranscriptionProvider = "local" | "deepgram";

/**
 * Curated embedded (transformers.js) Whisper models the user can pick in
 * settings. Each maps to its Hugging Face ONNX repo. `whisper-base` is the
 * default because it loads reliably on CPU/WASM; `whisper-large-v3-turbo`
 * is best-quality but realistically needs a working WebGPU GPU (its quantized
 * WASM build is unreliable).
 */
export const EMBEDDED_MODELS = [
  { id: "whisper-base", repo: "Xenova/whisper-base", label: "Base — recommended (runs on CPU)" },
  { id: "whisper-small", repo: "Xenova/whisper-small", label: "Small — more accurate, slower" },
  { id: "whisper-tiny", repo: "Xenova/whisper-tiny", label: "Tiny — fastest, least accurate" },
  {
    id: "whisper-large-v3-turbo",
    repo: "onnx-community/whisper-large-v3-turbo",
    label: "Large v3 Turbo — best, needs a fast GPU",
  },
] as const;

export type EmbeddedModelId = (typeof EMBEDDED_MODELS)[number]["id"];

const EMBEDDED_MODEL_IDS: ReadonlySet<string> = new Set(EMBEDDED_MODELS.map((m) => m.id));

/** The HF ONNX repo for a model id (falls back to the default's repo). */
export function embeddedModelRepo(id: EmbeddedModelId): string {
  return (EMBEDDED_MODELS.find((m) => m.id === id) ?? EMBEDDED_MODELS[0]).repo;
}

export interface TranscriptionSettings {
  /** Master on/off. When off, no mic button or hotkey is installed. */
  enabled: boolean;
  /** Which engine transcribes: on-device Whisper, or Deepgram cloud. */
  provider: TranscriptionProvider;
  /** Embedded (transformers.js) model id when provider is "local". */
  localModel: EmbeddedModelId;
  /** Toggle-dictation chord (normalized string; picker is Phase 3). */
  hotkeyToggle: string;
  /** Push-to-talk chord (hold to record; wired in Phase 3). */
  hotkeyPushToTalk: string;
  /** When true, inject a trailing newline so the prompt sends immediately. */
  autoSubmit: boolean;
  /** Spoken language: "auto" (detect) or an ISO code from DICTATION_LANGUAGES. */
  language: string;
  /** Show the floating mic button on Claude panes (hotkey works regardless). */
  showMicButton: boolean;
  /**
   * The floating mic's position, as an offset in px from the pane's
   * BOTTOM-LEFT corner (where the status line starts). Shared by every pane,
   * so the button sits in the same spot on all of them.
   */
  micOffset: { dx: number; dy: number };
  /**
   * When true, ghost-tail words crystallize (blur→sharp, left-anchored) as
   * they firm up, instead of hard-popping. Purely cosmetic; off = snappy.
   */
  fluidMotion: boolean;
  /** Live-tunable dictation-overlay appearance (the "Advanced" panel). */
  appearance: DictationAppearance;
}

/**
 * View-only knobs for the dictation overlay. All are tweakable live from the
 * right-click "Advanced" panel and persisted, so the look can be tuned by
 * feel rather than by editing code.
 */
export interface DictationAppearance {
  /** De-blur duration per character (ms). Lower = snappier crystallize. */
  crystallizeMs: number;
  /** Delay between successive characters (ms) — the left→right sweep speed. */
  charStaggerMs: number;
  /** Starting blur of a fresh ghost char (px) — how illegible it begins. */
  blurStartPx: number;
  /** Resting blur once crystallized (px) — the "still a ghost" softness. */
  blurRestPx: number;
  /** How often buffered updates flush to the UI (ms). */
  settleMs: number;
  /** Clear stale ghost text after this much silence with nothing pending (ms). */
  ghostResetMs: number;
  /** Ghost-tail font size (px). */
  tailFontPx: number;
  /** Show the leading "words heard" blobs (the orange cluster). */
  showBlobs: boolean;
  /** Pill background theme. "auto" follows the app theme. */
  pillTheme: "auto" | "dark" | "light";
  /** Draw a contrast outline behind ghost text (legibility over any content). */
  textOutline: boolean;
  /**
   * How the leading "words heard but not transcribed" placeholders are sized:
   * "onset" = one per detected word onset from the audio (instant, accurate);
   * "estimate" = the older voiced-time word-count guess.
   */
  ghostMode: "onset" | "estimate";
  /** Heavy blur (px) of an unknown-word placeholder — the diffusion-noise look
   *  it starts from before crystallizing into the real word. */
  placeholderBlurPx: number;
  /** Onset detection: RMS to START a word (higher = needs louder speech). */
  onsetOpen: number;
  /** Onset detection: RMS to end a word (hysteresis; below onsetOpen). */
  onsetClose: number;
  /**
   * Sub-sentence chunking: commit the pill's crystallized phrase into the
   * terminal once it reaches this many words (a rolling ~sentence fragment).
   */
  commitWordCount: number;
  /** …or after this much silence, whichever comes first (ms). */
  commitPauseMs: number;
}

export const DEFAULT_APPEARANCE: DictationAppearance = {
  crystallizeMs: 260,
  charStaggerMs: 36,
  blurStartPx: 4.5,
  blurRestPx: 0.5,
  settleMs: 500,
  ghostResetMs: 1200,
  tailFontPx: 14,
  showBlobs: true,
  pillTheme: "auto",
  textOutline: true,
  ghostMode: "onset",
  placeholderBlurPx: 4.5,
  onsetOpen: 0.02,
  onsetClose: 0.012,
  commitWordCount: 7,
  commitPauseMs: 550,
};

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  enabled: true,
  provider: "local",
  localModel: "whisper-base",
  hotkeyToggle: "Mod+Shift+V",
  hotkeyPushToTalk: "Alt+Space",
  autoSubmit: false,
  language: "auto",
  showMicButton: true,
  micOffset: { dx: 14, dy: 14 },
  fluidMotion: true,
  appearance: { ...DEFAULT_APPEARANCE },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceProvider(v: unknown): TranscriptionProvider {
  return v === "deepgram" ? "deepgram" : "local";
}

function coerceModel(v: unknown): EmbeddedModelId {
  return typeof v === "string" && EMBEDDED_MODEL_IDS.has(v)
    ? (v as EmbeddedModelId)
    : DEFAULT_TRANSCRIPTION_SETTINGS.localModel;
}

function coerceHotkey(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function coerceNum(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function coercePillTheme(v: unknown): DictationAppearance["pillTheme"] {
  return v === "dark" || v === "light" ? v : "auto";
}

export function coerceAppearance(raw: unknown): DictationAppearance {
  const d = DEFAULT_APPEARANCE;
  if (!isPlainObject(raw)) return { ...d };
  return {
    crystallizeMs: coerceNum(raw.crystallizeMs, d.crystallizeMs, 0, 2000),
    charStaggerMs: coerceNum(raw.charStaggerMs, d.charStaggerMs, 0, 200),
    blurStartPx: coerceNum(raw.blurStartPx, d.blurStartPx, 0, 20),
    blurRestPx: coerceNum(raw.blurRestPx, d.blurRestPx, 0, 8),
    settleMs: coerceNum(raw.settleMs, d.settleMs, 80, 2000),
    ghostResetMs: coerceNum(raw.ghostResetMs, d.ghostResetMs, 300, 10000),
    tailFontPx: coerceNum(raw.tailFontPx, d.tailFontPx, 9, 28),
    showBlobs: coerceBool(raw.showBlobs, d.showBlobs),
    pillTheme: coercePillTheme(raw.pillTheme),
    textOutline: coerceBool(raw.textOutline, d.textOutline),
    ghostMode: raw.ghostMode === "estimate" ? "estimate" : "onset",
    placeholderBlurPx: coerceNum(raw.placeholderBlurPx, d.placeholderBlurPx, 0, 20),
    onsetOpen: coerceNum(raw.onsetOpen, d.onsetOpen, 0.001, 0.2),
    onsetClose: coerceNum(raw.onsetClose, d.onsetClose, 0.001, 0.2),
    commitWordCount: Math.round(coerceNum(raw.commitWordCount, d.commitWordCount, 1, 20)),
    commitPauseMs: coerceNum(raw.commitPauseMs, d.commitPauseMs, 150, 3000),
  };
}

export function coerce(raw: unknown): TranscriptionSettings {
  if (!isPlainObject(raw)) return { ...DEFAULT_TRANSCRIPTION_SETTINGS };
  return {
    enabled: coerceBool(raw.enabled, DEFAULT_TRANSCRIPTION_SETTINGS.enabled),
    provider: coerceProvider(raw.provider),
    localModel: coerceModel(raw.localModel),
    hotkeyToggle: coerceHotkey(raw.hotkeyToggle, DEFAULT_TRANSCRIPTION_SETTINGS.hotkeyToggle),
    hotkeyPushToTalk: coerceHotkey(
      raw.hotkeyPushToTalk,
      DEFAULT_TRANSCRIPTION_SETTINGS.hotkeyPushToTalk,
    ),
    autoSubmit: coerceBool(raw.autoSubmit, DEFAULT_TRANSCRIPTION_SETTINGS.autoSubmit),
    language: isDictationLanguage(raw.language)
      ? raw.language
      : DEFAULT_TRANSCRIPTION_SETTINGS.language,
    showMicButton: coerceBool(raw.showMicButton, DEFAULT_TRANSCRIPTION_SETTINGS.showMicButton),
    micOffset: coerceOffset(raw.micOffset),
    fluidMotion: coerceBool(raw.fluidMotion, DEFAULT_TRANSCRIPTION_SETTINGS.fluidMotion),
    appearance: coerceAppearance(raw.appearance),
  };
}

function coerceOffset(v: unknown): { dx: number; dy: number } {
  const d = DEFAULT_TRANSCRIPTION_SETTINGS.micOffset;
  if (!isPlainObject(v)) return { ...d };
  const num = (x: unknown, fallback: number): number =>
    typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.round(x)) : fallback;
  return { dx: num(v.dx, d.dx), dy: num(v.dy, d.dy) };
}

export async function loadTranscriptionSettings(): Promise<TranscriptionSettings> {
  const raw = await window.reckAPI.config.get<unknown>(TRANSCRIPTION_CONFIG_KEY);
  if (raw === null || raw === undefined) return { ...DEFAULT_TRANSCRIPTION_SETTINGS };
  return coerce(raw);
}

export async function saveTranscriptionSettings(s: TranscriptionSettings): Promise<void> {
  await window.reckAPI.config.set(TRANSCRIPTION_CONFIG_KEY, coerce(s));
}

/** Load the Deepgram API key (secret). Empty string when unset/unavailable. */
export async function loadDeepgramKey(): Promise<string> {
  const raw = await window.reckAPI.config.get<unknown>(DEEPGRAM_KEY_CONFIG_KEY);
  return typeof raw === "string" ? raw : "";
}

/** Persist (or clear, when empty) the Deepgram API key. */
export async function saveDeepgramKey(key: string): Promise<void> {
  await window.reckAPI.config.set(DEEPGRAM_KEY_CONFIG_KEY, key.trim());
}
