// The sub-sentence chunk model (Phase 2). A "chunk" is the rolling phrase
// currently living in the pill overlay — up to ~commitWordCount words, or until
// a pause. Each word is a SEGMENT with its own identity and lifecycle:
//
//   blurred        → an onset was heard; no text yet (a ▓ placeholder)
//   crystallizing  → transcription assigned/changed its word (animate de-blur)
//   sharp          → its word is stable (assigned + unchanged) — stop animating
//
// When the chunk fills (word count) or the speaker pauses, its leading run of
// resolved words is committed into the terminal as plain text and dropped from
// the pill; the still-blurred tail (onsets the transcriber hasn't caught up to)
// carries into the next chunk.
//
// Pure + deterministic so it unit-tests without a DOM, audio, or timers.

export type SegmentState = "blurred" | "crystallizing" | "sharp";

export interface Segment {
  /** Stable identity: the onset id (positive), or a synthetic negative id for a
   *  transcribed word that had no detected onset. Lets the view diff by id. */
  id: number;
  state: SegmentState;
  /** The resolved word, or null while still a blurred placeholder. */
  text: string | null;
}

export interface ChunkState {
  segments: Segment[];
  /** Words already committed to the terminal this utterance (transcript slice offset). */
  committedWords: number;
}

/** A fresh, empty chunk (optionally carrying the running committed-word offset). */
export function makeChunk(committedWords = 0): ChunkState {
  return { segments: [], committedWords };
}

/** Append a blurred placeholder for a newly-heard word onset (idempotent per id). */
export function addOnset(chunk: ChunkState, id: number): ChunkState {
  if (chunk.segments.some((s) => s.id === id)) return chunk;
  return {
    ...chunk,
    segments: [...chunk.segments, { id, state: "blurred", text: null }],
  };
}

/**
 * Assign resolved words to segments IN ORDER (word i → segment i):
 * - equal counts: every segment gets its word;
 * - more words than segments (transcriber split a blob): extra words append as
 *   crystallizing segments with synthetic ids;
 * - fewer words (transcriber behind the onsets): the trailing segments stay
 *   blurred.
 * A segment whose word is unchanged becomes `sharp` (won't re-animate); a new or
 * revised word becomes `crystallizing`.
 */
export function alignWords(chunk: ChunkState, words: readonly string[]): ChunkState {
  const n = Math.max(chunk.segments.length, words.length);
  const segments: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const prev = chunk.segments[i];
    const word = i < words.length ? words[i] : null;
    if (word === null) {
      // No word for this segment yet — keep it exactly as it was (blurred tail).
      if (prev) segments.push(prev);
      continue;
    }
    const id = prev ? prev.id : -(i + 1);
    if (prev && prev.text === word) {
      segments.push({ id, state: "sharp", text: word });
    } else {
      segments.push({ id, state: "crystallizing", text: word });
    }
  }
  return { ...chunk, segments };
}

/** Segments that have a resolved word (blurred ones excluded). */
export function resolvedCount(chunk: ChunkState): number {
  return chunk.segments.reduce((n, s) => n + (s.text !== null ? 1 : 0), 0);
}

export interface FlushOpts {
  msSinceVoice: number;
  commitWordCount: number;
  commitPauseMs: number;
}

/**
 * Should the chunk commit now? Only ever true when there's at least one resolved
 * word to commit, and either the chunk reached `commitWordCount` resolved words
 * or the speaker has been silent for `commitPauseMs`.
 */
export function shouldFlush(chunk: ChunkState, opts: FlushOpts): boolean {
  const resolved = resolvedCount(chunk);
  if (resolved === 0) return false;
  if (resolved >= opts.commitWordCount) return true;
  return opts.msSinceVoice >= opts.commitPauseMs;
}

export interface FlushResult {
  /** The leading resolved words, space-joined — inject this into the terminal. */
  committedText: string;
  /** How many segments (words) were committed. */
  committedCount: number;
  /** The chunk after removing the committed leading run (blurred tail preserved). */
  rest: ChunkState;
}

/**
 * Commit the LEADING contiguous run of resolved words (stopping at the first
 * still-blurred segment, so committed terminal text is always in order and
 * gap-free). The remaining segments carry into the next chunk.
 */
export function takeFlush(chunk: ChunkState): FlushResult {
  let i = 0;
  while (i < chunk.segments.length && chunk.segments[i].text !== null) i++;
  const committed = chunk.segments.slice(0, i);
  const rest = chunk.segments.slice(i);
  return {
    committedText: committed.map((s) => s.text ?? "").join(" "),
    committedCount: committed.length,
    rest: { segments: rest, committedWords: chunk.committedWords + committed.length },
  };
}

export interface StepOpts extends FlushOpts {
  /** After this much silence with only-blurred segments, drop the phantom blobs. */
  ghostResetMs: number;
}

// A clear pause (~1s) means the speaker has stopped: everything already
// crystallized is committed, even any word stranded past a blurred gap, and the
// leftover blobs (onsets that never became words) are dropped. commitPauseMs
// handles the shorter mid-phrase flush; this is the end-of-utterance sweep.
export const SILENCE_FINALIZE_MS = 1000;

export interface StepResult {
  /** The chunk after aligning + any commits (or a fresh chunk if cleared). */
  chunk: ChunkState;
  /** Committed phrases to append to the terminal, in order. */
  commits: string[];
  /** True when the chunk was fully drained (final pass or phantom reset). */
  cleared: boolean;
}

/**
 * Advance the chunk one settle tick: align the uncommitted transcript tail, then
 * commit whatever's due. THE single place the align→flush policy lives, shared by
 * the live controller and the tuning lab so they never drift.
 *
 * @param tailWords transcript words past `chunk.committedWords` (the pill's share)
 * @param final     the transcriber's final pass — commit everything remaining
 */
export function stepChunk(
  chunk: ChunkState,
  tailWords: readonly string[],
  opts: StepOpts,
  final: boolean,
): StepResult {
  let c = alignWords(chunk, tailWords);
  const commits: string[] = [];

  if (final) {
    const remaining = tailWords.join(" ");
    if (remaining) commits.push(remaining);
    return { chunk: makeChunk(c.committedWords + tailWords.length), commits, cleared: true };
  }

  while (shouldFlush(c, opts)) {
    const { committedText, committedCount, rest } = takeFlush(c);
    if (committedCount === 0) break;
    commits.push(committedText);
    c = rest;
  }

  // End-of-utterance sweep: after a clear (~1s) silence, commit every remaining
  // crystallized word — even one stranded past a blurred gap that takeFlush
  // stops at — and clear the chunk (dropping unresolved blobs). Never earlier
  // than commitPauseMs so a higher pause setting is respected.
  const finalizeMs = Math.max(SILENCE_FINALIZE_MS, opts.commitPauseMs);
  if (opts.msSinceVoice > finalizeMs && c.segments.length > 0) {
    const resolvedTail = c.segments
      .filter((s) => s.text !== null)
      .map((s) => s.text as string);
    if (resolvedTail.length > 0) commits.push(resolvedTail.join(" "));
    return {
      chunk: makeChunk(c.committedWords + resolvedTail.length),
      commits,
      cleared: true,
    };
  }

  // Phantom-blob reset: onsets that never resolved after a longer silence.
  if (resolvedCount(c) === 0 && c.segments.length > 0 && opts.msSinceVoice > opts.ghostResetMs) {
    return { chunk: makeChunk(c.committedWords), commits, cleared: true };
  }
  return { chunk: c, commits, cleared: false };
}
