// Voice-dictation preferences (issue #67), mirroring the TTS settings
// module. The non-secret prefs live under the "transcription" config key;
// the Deepgram API key is stored separately under a secret key so
// safeStorage's refusal path only blocks the secret half.
//
// See docs/plans/voice-dictation-satellite.md.

export const TRANSCRIPTION_CONFIG_KEY = "transcription";
export const DEEPGRAM_KEY_CONFIG_KEY = "transcription.deepgramKey";

export type TranscriptionProvider = "local" | "deepgram";

/**
 * Curated embedded (transformers.js) Whisper models the user can pick in
 * settings. Each maps to its Hugging Face ONNX repo. Ordered best-quality
 * first; `whisper-large-v3-turbo` is the default.
 */
export const EMBEDDED_MODELS = [
  {
    id: "whisper-large-v3-turbo",
    repo: "onnx-community/whisper-large-v3-turbo",
    label: "Large v3 Turbo — best quality (larger first download)",
  },
  { id: "whisper-small", repo: "Xenova/whisper-small", label: "Small" },
  { id: "whisper-base", repo: "Xenova/whisper-base", label: "Base" },
  { id: "whisper-tiny", repo: "Xenova/whisper-tiny", label: "Tiny — fastest, smallest" },
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
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  enabled: true,
  provider: "local",
  localModel: "whisper-large-v3-turbo",
  hotkeyToggle: "Mod+Shift+V",
  hotkeyPushToTalk: "Alt+Space",
  autoSubmit: false,
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
  };
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
