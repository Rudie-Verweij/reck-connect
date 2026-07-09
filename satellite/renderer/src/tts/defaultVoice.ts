/**
 * Explicit default-voice resolution.
 *
 * When no voice is configured we must NOT leave `utterance.voice` unset:
 * Chromium then resolves a "default" on its own, and on macOS that pick is
 * unreliable — when the system voice is a Siri voice (never exposed to the
 * Web Speech API) Chromium falls back to the first alphabetical match,
 * which is "Albert", a novelty voice. Verified live on a machine where
 * `getVoices()` flagged Zoe (Premium) as default yet unset-voice utterances
 * still spoke with the wrong voice. So the app always picks a concrete
 * voice itself.
 */

/** The fields we score on — a structural subset of SpeechSynthesisVoice
 *  so tests can pass plain objects. */
export interface VoiceLike {
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
}

// macOS novelty/character voices (Albert, Bells, Zarvox, ...). Chromium can
// land on these as its implicit default; never pick one as OUR default.
// Matched on the base name so localised suffixes ("Albert (en-US)") and
// quality suffixes don't dodge the filter.
const NOVELTY_VOICE_NAMES = new Set([
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Deranged",
  "Good News",
  "Jester",
  "Organ",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
]);

// Classic per-region macOS system voices — decent quality, present on every
// install. Preferred over the flood of low-quality "personal" voices
// (Eddy, Flo, Grandma, ...) when no premium/enhanced voice is available.
const KNOWN_GOOD_NAMES = new Set([
  "Alex",
  "Samantha",
  "Daniel",
  "Karen",
  "Moira",
  "Tessa",
  "Fiona",
]);

/** "Nicky (Enhanced)" → "Nicky"; "Eddy (English (United States))" → "Eddy". */
export function voiceBaseName(name: string): string {
  const i = name.indexOf(" (");
  return i === -1 ? name : name.slice(0, i);
}

/** Compact label for the speak bar: "EN (Zoe)", "NL (Ellen)".
 *  Falls back to "Voice" when nothing has resolved yet. */
export function formatVoiceLabel(
  v: Pick<VoiceLike, "name" | "lang"> | null | undefined,
): string {
  if (!v) return "Voice";
  const sub = v.lang.toLowerCase().replace(/_/g, "-").split("-")[0];
  return `${sub.toUpperCase()} (${voiceBaseName(v.name)})`;
}

export function isNoveltyVoice(v: Pick<VoiceLike, "name">): boolean {
  return NOVELTY_VOICE_NAMES.has(voiceBaseName(v.name));
}

/** 2 = exact BCP-47 match, 1 = same primary subtag, 0 = no match. */
function langScore(voiceLang: string, preferred: string): number {
  const v = voiceLang.toLowerCase().replace(/_/g, "-");
  const p = preferred.toLowerCase().replace(/_/g, "-");
  if (v === p) return 2;
  if (v.split("-")[0] === p.split("-")[0]) return 1;
  return 0;
}

function qualityScore(name: string): number {
  if (/\((?:premium|siri)\)/i.test(name)) return 3;
  if (/\(enhanced\)/i.test(name)) return 2;
  return 0;
}

/**
 * Pick the voice to use when the user hasn't chosen one. Preference order:
 * language match (preferred, falling back to English when the preferred
 * language has no voices), then premium/enhanced quality, then the classic
 * system voices, then the platform default flag, then local-service.
 * Novelty voices are excluded unless literally nothing else exists.
 */
export function resolveDefaultVoice<T extends VoiceLike>(
  voices: readonly T[],
  preferredLang?: string,
): T | null {
  if (voices.length === 0) return null;
  const preferred =
    preferredLang ??
    (typeof navigator !== "undefined" ? navigator.language : "") ??
    "";

  const usable = voices.filter((v) => !isNoveltyVoice(v));
  const pool = usable.length > 0 ? usable : voices;

  // A premium voice in the wrong language is worse than a plain voice in
  // the right one — and reading text in a language with zero installed
  // voices, score against English instead of picking by quality alone.
  const lang =
    preferred && pool.some((v) => langScore(v.lang, preferred) > 0)
      ? preferred
      : "en-US";

  let best: T | null = null;
  let bestScore = -1;
  for (const v of pool) {
    const score =
      langScore(v.lang, lang) * 100 +
      qualityScore(v.name) * 10 +
      (KNOWN_GOOD_NAMES.has(voiceBaseName(v.name)) ? 5 : 0) +
      (v.default ? 2 : 0) +
      (v.localService ? 1 : 0);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}
