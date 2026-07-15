// Clean up ASR output for injection into a terminal prompt. Whisper (and to a
// lesser extent Deepgram) emit non-speech ANNOTATIONS when the audio is quiet
// or noisy — "(applause)", "[BLANK_AUDIO]", "(audience chattering)", musical
// notes — and stock "Subtitles by…" / "Thanks for watching" hallucinations
// from its subtitle-heavy training data. None of that belongs in a command
// prompt. This strip is deterministic (safer than trying to steer the model
// via an initial prompt, which transformers.js doesn't cleanly expose).

// Bracketed/parenthesized annotations: "(applause)", "[music]", "{noise}".
const ANNOTATION = /[([{][^)\]}]*[)\]}]/g;
// Musical-note runs Whisper uses for music: "♪ ... ♪" or bare notes.
const MUSIC = /[♪♫🎵🎶]/g;
// Whole-output hallucinations Whisper produces on near-silence, matched only
// when they are the ENTIRE cleaned result (never mid-sentence, to avoid
// eating real speech that happens to contain the phrase).
const STANDALONE_HALLUCINATIONS = [
  /^thanks? for watching$/i,
  /^thank you$/i,
  /^please subscribe$/i,
  /^subtitles? by .*$/i,
  /^subs? by .*$/i,
  /^you$/i,
];

/**
 * Strip non-speech annotations and standalone hallucinations. Returns clean
 * speech text, or "" when nothing but annotation/hallucination was present
 * (the caller treats "" as "heard nothing usable" — it must NOT erase text
 * already typed).
 */
export function sanitizeTranscript(text: string): string {
  let out = text.replace(ANNOTATION, " ").replace(MUSIC, " ");
  out = out.replace(/\s+/g, " ").trim();
  // Match hallucinations regardless of trailing/leading punctuation, and
  // treat an all-punctuation result (". . .") as empty.
  const bare = out.replace(/^[\s.!?,…]+|[\s.!?,…]+$/g, "");
  if (bare === "") return "";
  if (STANDALONE_HALLUCINATIONS.some((re) => re.test(bare))) return "";
  return out;
}
