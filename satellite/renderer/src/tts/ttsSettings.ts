import { snapRate } from "./TtsEngine";
import { TTS_HIGHLIGHT_BG_LIGHT, TTS_HIGHLIGHT_BG_DARK } from "./ttsTheme";

export const TTS_CONFIG_KEY = "tts";

export interface TtsSettings {
  voice: string | null;
  rate: number;
  /** Reading-highlight colour in light mode (solid hex). */
  highlightColorLight: string;
  /** Reading-highlight colour in dark mode (solid hex). */
  highlightColorDark: string;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  voice: null,
  rate: 1.0,
  highlightColorLight: TTS_HIGHLIGHT_BG_LIGHT,
  highlightColorDark: TTS_HIGHLIGHT_BG_DARK,
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True for `#rgb` / `#rrggbb` (what `<input type="color">` emits). */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_COLOR_RE.test(v);
}

function coerceColor(v: unknown, fallback: string): string {
  return isHexColor(v) ? v : fallback;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerce(raw: unknown): TtsSettings {
  if (!isPlainObject(raw)) return { ...DEFAULT_TTS_SETTINGS };
  const voice =
    typeof raw.voice === "string" && raw.voice.length > 0 ? raw.voice : null;
  const rateRaw =
    typeof raw.rate === "number" && Number.isFinite(raw.rate)
      ? raw.rate
      : DEFAULT_TTS_SETTINGS.rate;
  return {
    voice,
    rate: snapRate(rateRaw),
    highlightColorLight: coerceColor(
      raw.highlightColorLight,
      DEFAULT_TTS_SETTINGS.highlightColorLight,
    ),
    highlightColorDark: coerceColor(
      raw.highlightColorDark,
      DEFAULT_TTS_SETTINGS.highlightColorDark,
    ),
  };
}

export async function loadTtsSettings(): Promise<TtsSettings> {
  const raw = await window.reckAPI.config.get<unknown>(TTS_CONFIG_KEY);
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_TTS_SETTINGS };
  }
  return coerce(raw);
}

export async function saveTtsSettings(s: TtsSettings): Promise<void> {
  const normalised: TtsSettings = {
    voice: s.voice ?? null,
    rate: snapRate(s.rate),
    highlightColorLight: coerceColor(
      s.highlightColorLight,
      DEFAULT_TTS_SETTINGS.highlightColorLight,
    ),
    highlightColorDark: coerceColor(
      s.highlightColorDark,
      DEFAULT_TTS_SETTINGS.highlightColorDark,
    ),
  };
  await window.reckAPI.config.set(TTS_CONFIG_KEY, normalised);
}
