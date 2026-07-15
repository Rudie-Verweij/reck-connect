import type { RangeMapEntry, SpokenChunk } from "./TtsEngine";

// Compare the UPCOMING (not-yet-spoken) words of the currently-playing chunk
// against a freshly-resolved chunk, to decide whether a live TTS session needs
// to swap its remaining audio (e.g. because a TUI repainted / the user
// scrolled). The comparison is by WORD TEXT in reading order, NOT by absolute
// char/line index: a repaint changes what a given buffer line holds, so
// positions are unreliable, but the sequence of words is the stable signal —
// the same idea `wordLocator.relocateWord` uses for the highlight.

export interface TailDivergence {
  /** The upcoming words differ — a swap is warranted. */
  changed: boolean;
  /** The current word was located in the new chunk (a swap can be aligned).
   *  When false the caller should NOT swap: we can't tell where to resume. */
  aligned: boolean;
  /** New-chunk char index of the CURRENT word (immediate-mode resume point). */
  resumeCharNew: number;
  /** Old-chunk char index where the upcoming words first differ. For a pure
   *  append this is `oldChunk.text.length` (reached only when the old chunk
   *  finishes — see the engine's handleEnd path). */
  divCharOld: number;
  /** New-chunk char index to resume speaking from at the divergence. */
  divCharNew: number;
}

function wordAt(chunk: SpokenChunk, e: RangeMapEntry): string {
  return chunk.text.slice(e.charStart, e.charEnd);
}

// Reading-order continuity scoring (mirrors wordLocator.relocateWord): prefer
// an occurrence at/after the hint position, and among those the nearest.
const FORWARD_PENALTY = 1_000_000;
const LINE_WEIGHT = 1000;

/**
 * Find where the upcoming words of `oldChunk` (from `curCharIndexOld` onward)
 * diverge from `newChunk`. Returns `{ changed: false }` when the upcoming
 * words are identical — the caller then does nothing (no cancel, no gap).
 */
export function findTailDivergence(
  oldChunk: SpokenChunk,
  newChunk: SpokenChunk,
  curCharIndexOld: number,
): TailDivergence {
  const none: TailDivergence = {
    changed: false,
    aligned: false,
    resumeCharNew: 0,
    divCharOld: oldChunk.text.length,
    divCharNew: newChunk.text.length,
  };

  const oldWords = oldChunk.rangeMap;
  const newWords = newChunk.rangeMap;
  if (oldWords.length === 0) return none;

  // The current word = first word whose end is past the playback cursor.
  const oldStart = oldWords.findIndex((e) => e.charEnd > curCharIndexOld);
  if (oldStart === -1) return none; // cursor past the last word — nothing ahead

  const curWord = wordAt(oldChunk, oldWords[oldStart]);
  const hintLine = oldWords[oldStart].line;
  const hintCol = oldWords[oldStart].col;

  // Align the current word into the new chunk (nearest forward occurrence).
  let newStart = -1;
  let bestScore = Infinity;
  for (let j = 0; j < newWords.length; j++) {
    if (wordAt(newChunk, newWords[j]) !== curWord) continue;
    const e = newWords[j];
    const forward =
      e.line > hintLine || (e.line === hintLine && e.col >= hintCol);
    const dist =
      Math.abs(e.line - hintLine) * LINE_WEIGHT + Math.abs(e.col - hintCol);
    const score = (forward ? 0 : FORWARD_PENALTY) + dist;
    if (score < bestScore) {
      bestScore = score;
      newStart = j;
    }
  }
  if (newStart === -1) {
    // The current word is not on the new screen — scrolled off or fully
    // replaced. We can't align a resume point safely, so signal "don't swap".
    return { ...none, aligned: false };
  }

  const resumeCharNew = newWords[newStart].charStart;

  // Walk both word sequences forward from the aligned position.
  let oi = oldStart;
  let nj = newStart;
  while (oi < oldWords.length && nj < newWords.length) {
    if (wordAt(oldChunk, oldWords[oi]) !== wordAt(newChunk, newWords[nj])) {
      return {
        changed: true,
        aligned: true,
        resumeCharNew,
        divCharOld: oldWords[oi].charStart,
        divCharNew: newWords[nj].charStart,
      };
    }
    oi += 1;
    nj += 1;
  }

  if (oi < oldWords.length) {
    // Old has words the new chunk lacks (content shrank/truncated). Resume at
    // the new chunk's end → speech stops when it reaches the vanished text.
    return {
      changed: true,
      aligned: true,
      resumeCharNew,
      divCharOld: oldWords[oi].charStart,
      divCharNew: newChunk.text.length,
    };
  }
  if (nj < newWords.length) {
    // Pure append: new content continues past where the old chunk ends.
    return {
      changed: true,
      aligned: true,
      resumeCharNew,
      divCharOld: oldChunk.text.length,
      divCharNew: newWords[nj].charStart,
    };
  }

  // Identical upcoming tail — nothing to do.
  return { changed: false, aligned: true, resumeCharNew, divCharOld: oldChunk.text.length, divCharNew: newChunk.text.length };
}
