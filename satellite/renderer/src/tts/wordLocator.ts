// Live word location for the TTS highlight.
//
// Claude's TUI repaints terminal cells in place (mouse-tracking mode), so a
// highlight anchored to a fixed buffer line ends up pointing at whatever the
// TUI later redrew there. Instead of trusting the snapshot position captured
// when speech started, we RE-FIND the spoken word in the current visible
// buffer on every render and move the highlight to it — the same idea as a
// live search. Reading advances in order, so we disambiguate repeated words
// (several "the"s) by continuity: prefer the occurrence nearest to, and
// forward from, where the previous word was found.

export interface BufferTextLine {
  /** Absolute buffer line index. */
  line: number;
  /** The line's text (already translated to a string). */
  text: string;
}

export interface WordHit {
  line: number;
  col: number;
}

/**
 * Whitespace-bounded occurrences of `word` in `text`, returned as start
 * columns. Bounded matching avoids "the" matching inside "theme"/"other";
 * TTS words are whitespace-delimited tokens, so they appear that way in the
 * buffer too.
 */
export function findWordOccurrences(text: string, word: string): number[] {
  if (!word) return [];
  const out: number[] = [];
  let i = text.indexOf(word);
  while (i !== -1) {
    const beforeOk = i === 0 || /\s/.test(text[i - 1]);
    const after = i + word.length;
    const afterOk = after === text.length || /\s/.test(text[after]);
    if (beforeOk && afterOk) out.push(i);
    i = text.indexOf(word, i + 1);
  }
  return out;
}

/**
 * Find the best current position of `word` across the visible lines, or null
 * if it isn't visible. Disambiguates duplicates by reading-order continuity:
 * occurrences at/after the hint (forward) win over ones before it, and within
 * each group the one closest to the hint wins.
 */
export function relocateWord(
  lines: ReadonlyArray<BufferTextLine>,
  word: string,
  hintLine: number,
  hintCol: number,
): WordHit | null {
  const hits: WordHit[] = [];
  for (const ln of lines) {
    for (const col of findWordOccurrences(ln.text, word)) {
      hits.push({ line: ln.line, col });
    }
  }
  if (hits.length === 0) return null;

  const FORWARD_PENALTY = 1_000_000;
  const LINE_WEIGHT = 1000; // a line apart costs more than any column delta
  const score = (h: WordHit): number => {
    const forward =
      h.line > hintLine || (h.line === hintLine && h.col >= hintCol);
    const dist =
      Math.abs(h.line - hintLine) * LINE_WEIGHT + Math.abs(h.col - hintCol);
    return (forward ? 0 : FORWARD_PENALTY) + dist;
  };

  let best = hits[0];
  let bestScore = score(best);
  for (let k = 1; k < hits.length; k++) {
    const s = score(hits[k]);
    if (s < bestScore) {
      best = hits[k];
      bestScore = s;
    }
  }
  return best;
}
