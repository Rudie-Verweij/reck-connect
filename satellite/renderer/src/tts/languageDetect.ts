/**
 * Lightweight language detection for spoken chunks.
 *
 * The Web Speech API has no language detection (macOS "Detect languages"
 * in Read & Speak applies only to Apple's own Spoken Content, never to
 * apps), so with the voice on Automatic we detect the chunk's language
 * ourselves and let the default-voice resolver pick a voice for it.
 *
 * Method: count function-word (stopword) hits per language. Function words
 * are extremely frequent and language-distinctive, so a handful of them
 * separate the supported languages reliably after just a sentence or two.
 * Returns null when the signal is too weak (short/ambiguous/code-heavy
 * text) — callers should fall back to the UI locale.
 */

const STOPWORDS: Record<string, readonly string[]> = {
  en: [
    "the", "a", "an", "and", "of", "to", "in", "is", "was", "are", "have",
    "has", "not", "that", "this", "it", "you", "for", "but", "with", "they",
    "what", "which", "there", "from", "your", "will", "would", "should",
  ],
  nl: [
    "de", "het", "een", "en", "van", "naar", "ik", "je", "jij", "niet",
    "dat", "dit", "die", "is", "was", "zijn", "heb", "hebben", "wat", "voor",
    "maar", "ook", "als", "dan", "nog", "wel", "geen", "bij", "uit", "om",
    "te", "er", "we", "ze", "hij", "zij", "op", "aan", "met", "deze",
  ],
  de: [
    "der", "die", "das", "und", "ich", "nicht", "ist", "ein", "eine", "zu",
    "mit", "auf", "für", "den", "dem", "sie", "er", "wir", "ihr", "aber",
    "auch", "wenn", "dann", "noch", "kein", "nach", "bei", "aus", "um", "es",
  ],
  fr: [
    "le", "la", "les", "et", "de", "je", "tu", "ne", "pas", "que", "est",
    "sont", "pour", "mais", "aussi", "si", "alors", "vers", "chez", "ce",
    "cette", "nous", "ils", "il", "elle", "son", "sa", "des", "du", "une",
  ],
  es: [
    "el", "la", "los", "las", "y", "de", "que", "es", "no", "un", "una",
    "por", "para", "pero", "también", "si", "entonces", "este", "esta",
    "nosotros", "ellos", "él", "ella", "su", "con", "del", "se", "lo", "en",
  ],
};

// Minimum stopword hits before we trust a verdict, and how decisively the
// winner must beat the runner-up. Terminal content is full of code and
// English-ish identifiers; when in doubt say "don't know".
const MIN_HITS = 3;
const MIN_LEAD_RATIO = 1.5;

/**
 * Detect the dominant language of `text`. Returns a primary subtag
 * ("en", "nl", ...) or null when the text is too short or ambiguous.
 */
export function detectLanguage(text: string): string | null {
  const words = text
    .toLowerCase()
    .split(/[^a-zà-ÿ']+/)
    .filter((w) => w.length > 0);
  if (words.length < 4) return null;

  const scores = new Map<string, number>();
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const set = new Set(stops);
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    scores.set(lang, hits);
  }

  let bestLang: string | null = null;
  let best = 0;
  let second = 0;
  for (const [lang, hits] of scores) {
    if (hits > best) {
      second = best;
      best = hits;
      bestLang = lang;
    } else if (hits > second) {
      second = hits;
    }
  }

  if (best < MIN_HITS) return null;
  if (second > 0 && best / second < MIN_LEAD_RATIO) return null;
  return bestLang;
}
