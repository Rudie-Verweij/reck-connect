import { findTailDivergence } from "./tailDivergence";

export interface RangeMapEntry {
  charStart: number;
  charEnd: number;
  line: number;
  col: number;
  len: number;
}

export interface SpokenChunk {
  text: string;
  rangeMap: ReadonlyArray<RangeMapEntry>;
}

export interface TtsBoundary {
  line: number;
  col: number;
  len: number;
  word: string;
  charIndex: number;
}

export interface TtsEngineOptions {
  synth?: SpeechSynthesis;
  UtteranceCtor?: typeof SpeechSynthesisUtterance;
  heartbeatIntervalMs?: number;
  /**
   * Debounce window for setRate() while speaking. The Web Speech API
   * can't change utterance rate after speak() is called, so live rate
   * changes must cancel + re-speak. A small debounce coalesces a fast
   * slider drag (which can fire dozens of step events per second) into
   * one cancel/restart cycle when the user finishes adjusting.
   *
   * Default 60ms — tight enough to feel instant, wide enough to absorb
   * a typical drag. Set to 0 in tests for synchronous semantics.
   */
  restartDebounceMs?: number;
  /** Override the per-utterance char cap (see MAX_UTTERANCE_CHARS). Tests
   *  set a small value to exercise multi-segment speech cheaply. */
  maxUtteranceChars?: number;
  /**
   * How reswap() applies a recomputed chunk to a live utterance:
   *  - 'scheduled' (default): let the current audio keep playing and swap at
   *    the word boundary where old/new first diverge — the ~50-100ms cancel
   *    gap lands at a natural word seam, and an unchanged tail never swaps.
   *  - 'immediate': cancel + re-speak the new chunk from the current word at
   *    once (simpler; a small gap every time the tail changes).
   */
  respliceMode?: "scheduled" | "immediate";
}

export interface StartOptions {
  voice?: SpeechSynthesisVoice | null;
  rate?: number;
}

interface EventMap {
  boundary: TtsBoundary;
  end: void;
  error: Error;
  /** The boundary stream is degenerate (charIndex stuck at 0);
   *  word highlighting is unreliable for the rest of this utterance. */
  degenerate: void;
}

type Listener<T> = (arg: T) => void;

const RATE_MIN = 0.5;
const RATE_MAX = 6.0;
const RATE_STEP = 0.05;

export function clampRate(rate: number): number {
  if (Number.isNaN(rate)) return 1.0;
  if (rate < RATE_MIN) return RATE_MIN;
  if (rate > RATE_MAX) return RATE_MAX;
  return rate;
}

export function snapRate(rate: number): number {
  const clamped = clampRate(rate);
  const steps = Math.round(clamped / RATE_STEP);
  return Math.round(steps * RATE_STEP * 100) / 100;
}

// Characters that poison macOS boundary reporting. When the
// utterance text contains any of these (anywhere, even once), the OS
// fires EVERY word-boundary event with charIndex=0 for the whole
// utterance, freezing the word highlight on word #1 while audio plays on.
// Probe-verified empirically: U+2260 "≠" is
// guilty; its NFD/U+0338 siblings (≢ ≮ ∉) and all of
// & — – → × ≤ ≥ ≈ • … ✅ ❌ 🚀 é ü ñ ° are innocent — so this is an
// empirical blocklist, not a Unicode class. Extend it by re-running the
// probe against any new suspect.
const UTTERANCE_POISON_CHARS = /[≠]/g;

/**
 * Replace verified-poison characters with a single space in the text
 * handed to SpeechSynthesisUtterance. LENGTH-PRESERVING by construction:
 * boundary charIndex values keep indexing the original chunk text, so the
 * rangeMap and every surface adapter's offset bookkeeping stay valid. The
 * displayed text is untouched — only the spoken audio loses the symbol.
 */
export function sanitizeUtteranceText(text: string): string {
  return text.replace(UTTERANCE_POISON_CHARS, " ");
}

// Degenerate-stream guard threshold. In a healthy stream
// charIndex grows monotonically, so this many CONSECUTIVE word boundaries
// at charIndex 0 cannot occur naturally (at most a couple of events fire
// for the first word). Crossing it means the OS positions are garbage for
// this utterance (an unknown poison char, see UTTERANCE_POISON_CHARS) —
// better to warn + clear the highlight than to let it lie.
export const DEGENERATE_ZERO_BOUNDARY_THRESHOLD = 12;

/**
 * Return the tail of `chunk` starting at `fromCharIndex`. Used when
 * restarting an in-flight utterance with a new rate — the new utterance
 * speaks the remaining text. The returned chunk's rangemap entries are
 * char-shifted into the new (sliced) coordinate space; line/col stay
 * absolute (they index the buffer, not the spoken text).
 */
export function sliceChunkFrom(
  chunk: SpokenChunk,
  fromCharIndex: number,
): SpokenChunk {
  if (fromCharIndex <= 0) return { text: chunk.text, rangeMap: chunk.rangeMap };
  if (fromCharIndex >= chunk.text.length) {
    return { text: "", rangeMap: [] };
  }
  return {
    text: chunk.text.slice(fromCharIndex),
    rangeMap: chunk.rangeMap
      .filter((e) => e.charEnd > fromCharIndex)
      .map((e) => ({
        ...e,
        charStart: Math.max(0, e.charStart - fromCharIndex),
        charEnd: e.charEnd - fromCharIndex,
      })),
  };
}

// Maximum characters per SpeechSynthesisUtterance. A single utterance far
// larger than this wedges the engine: Chromium silently drops / never
// finishes an over-long utterance, leaving `speaking` stuck true so every
// later speak() queues behind it forever (only an app restart clears it).
// The transcript surface can hand us a huge chunk when a tool_use /
// tool_result payload is EXPANDED (hundreds of KB of JSON as one string),
// so we segment the chunk into sub-utterances spoken back-to-back. 2000 is
// comfortably under the platform limit while keeping inter-segment gaps rare.
export const MAX_UTTERANCE_CHARS = 2000;

/**
 * Split `text` into [start, end) segments each at most `max` chars, breaking
 * on whitespace so a word is never cut across two utterances (a boundary
 * event's charIndex must stay resolvable within its segment). A single word
 * longer than `max` is hard-split as a last resort. Offsets index the
 * ORIGINAL text so each segment maps straight back into the chunk's rangeMap.
 */
export function segmentText(
  text: string,
  max: number,
): Array<{ start: number; end: number }> {
  const segs: Array<{ start: number; end: number }> = [];
  const n = text.length;
  if (n === 0) return segs;
  let i = 0;
  while (i < n) {
    let end = Math.min(i + max, n);
    if (end < n) {
      // Back up to the last whitespace within (i, end] so we split between
      // words. If there's no whitespace in the window it's one long token —
      // hard-split at `end` rather than loop forever.
      let b = end;
      while (b > i && !/\s/.test(text[b - 1])) b--;
      if (b > i) end = b;
    }
    segs.push({ start: i, end });
    i = end;
  }
  return segs;
}

export class TtsEngine {
  private readonly synth: SpeechSynthesis;
  private readonly UtteranceCtor: typeof SpeechSynthesisUtterance;
  private readonly heartbeatIntervalMs: number;
  private readonly restartDebounceMs: number;
  private readonly maxUtteranceChars: number;
  private readonly respliceMode: "scheduled" | "immediate";
  private rateRestartTimer: ReturnType<typeof setTimeout> | null = null;
  // A recomputed chunk awaiting a scheduled swap: playback continues on the
  // current chunk until lastBoundaryCharIndex reaches `divCharOld` (or the
  // chunk ends, for a pure append), then we cancel + re-speak `newChunk` from
  // `divCharNew`. Overwritten by a newer reswap; cleared on swap/stop/pause.
  private pendingSwap:
    | { newChunk: SpokenChunk; divCharOld: number; divCharNew: number }
    | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentUtt: SpeechSynthesisUtterance | null = null;
  private currentChunk: SpokenChunk | null = null;
  private currentVoice: SpeechSynthesisVoice | null = null;
  private rate = 1.0;
  private userPaused = false;
  // The current chunk split into [start, end) segments (each ≤
  // maxUtteranceChars), spoken back-to-back so no single utterance is large
  // enough to wedge the synthesizer. segIndex is the segment in flight;
  // segBase is its start offset into currentChunk.text, added to each
  // boundary's charIndex so highlighting resolves against the whole chunk.
  private segments: Array<{ start: number; end: number }> = [];
  private segIndex = 0;
  private segBase = 0;
  // Set when a user pause() raced a segment's end: the next segment is held
  // back (speaking into a paused queue wedges forever) until resume() runs it.
  private segmentPending = false;
  // Char-index of the most recent 'word' boundary, in the CURRENT chunk's
  // coordinate space. Reset to 0 on start() and on every rate-change
  // restart (where the chunk is re-sliced from this point onward).
  private lastBoundaryCharIndex = 0;
  // Degenerate-stream guard state, reset per utterance.
  // zeroBoundaryStreak counts CONSECUTIVE word boundaries at charIndex 0;
  // crossing DEGENERATE_ZERO_BOUNDARY_THRESHOLD flips boundaryDegenerate,
  // which suppresses further boundary emission for this utterance.
  private zeroBoundaryStreak = 0;
  private boundaryDegenerate = false;

  private boundaryListeners = new Set<Listener<TtsBoundary>>();
  private endListeners = new Set<Listener<void>>();
  private errorListeners = new Set<Listener<Error>>();
  private degenerateListeners = new Set<Listener<void>>();

  constructor(opts: TtsEngineOptions = {}) {
    const synth = opts.synth ?? globalThis.speechSynthesis;
    const UtteranceCtor = opts.UtteranceCtor ?? globalThis.SpeechSynthesisUtterance;
    if (!synth || !UtteranceCtor) {
      throw new Error(
        "TtsEngine: speechSynthesis is unavailable in this environment",
      );
    }
    this.synth = synth;
    this.UtteranceCtor = UtteranceCtor;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 9000;
    this.restartDebounceMs = opts.restartDebounceMs ?? 60;
    this.maxUtteranceChars = opts.maxUtteranceChars ?? MAX_UTTERANCE_CHARS;
    this.respliceMode = opts.respliceMode ?? "scheduled";
  }

  on<K extends keyof EventMap>(event: K, cb: Listener<EventMap[K]>): () => void {
    if (event === "boundary") {
      this.boundaryListeners.add(cb as Listener<TtsBoundary>);
      return () => this.boundaryListeners.delete(cb as Listener<TtsBoundary>);
    }
    if (event === "end") {
      this.endListeners.add(cb as Listener<void>);
      return () => this.endListeners.delete(cb as Listener<void>);
    }
    if (event === "degenerate") {
      this.degenerateListeners.add(cb as Listener<void>);
      return () => this.degenerateListeners.delete(cb as Listener<void>);
    }
    this.errorListeners.add(cb as Listener<Error>);
    return () => this.errorListeners.delete(cb as Listener<Error>);
  }

  start(chunk: SpokenChunk, opts: StartOptions = {}): void {
    const rate = snapRate(opts.rate ?? this.rate);
    this.rate = rate;
    this.lastBoundaryCharIndex = 0;
    this.currentVoice = opts.voice ?? null;
    this.speakInternal(chunk, this.currentVoice, rate);
  }

  private speakInternal(
    chunk: SpokenChunk,
    voice: SpeechSynthesisVoice | null,
    rate: number,
  ): void {
    if (this.currentUtt) {
      this.detachUtterance(this.currentUtt);
      this.synth.cancel();
      // pause() pauses the GLOBAL SpeechSynthesis queue, and cancel() does
      // NOT unpause it — speaking into a still-paused queue leaves the new
      // utterance silently queued forever (no events, speaking=false, so
      // even the heartbeat can't rescue it; only an app restart could).
      // resume() is a spec no-op when the queue isn't paused, so call it
      // unconditionally rather than trusting synth.paused to be accurate
      // across a cancel.
      this.synth.resume();
    } else if (this.synth.paused) {
      // No utterance of ours in flight but the queue is paused (e.g. the
      // utterance ended/errored while paused) — clear it before speak().
      this.synth.resume();
    }
    this.stopHeartbeat();

    // Keep the ORIGINAL chunk: boundary `word` extraction, sliceChunkFrom,
    // and every adapter's rangeMap index the original string. Split it into
    // ≤ maxUtteranceChars segments so no single utterance is big enough to
    // wedge the synthesizer, then speak the first — handleEnd chains the rest.
    this.currentChunk = chunk;
    this.currentVoice = voice;
    this.rate = rate;
    this.segments = segmentText(chunk.text, this.maxUtteranceChars);
    this.segIndex = 0;
    this.segmentPending = false;
    this.userPaused = false;
    if (this.segments.length === 0) {
      // Empty text: nothing to speak. Reset and signal completion so callers
      // that await an 'end' after start() don't hang.
      this.currentChunk = null;
      this.currentUtt = null;
      for (const cb of this.endListeners) cb();
      return;
    }
    this.speakSegment();
  }

  /** Speak segments[segIndex] as its own utterance. Called by speakInternal
   *  for the first segment and by handleEnd to chain each subsequent one. */
  private speakSegment(): void {
    if (!this.currentChunk) return;
    const seg = this.segments[this.segIndex];
    if (!seg) return;
    // Never speak into a still-paused global queue — the utterance would sit
    // queued forever with no boundary/end events (the same wedge speakInternal
    // guards against). resume() is a no-op when the queue isn't paused.
    if (this.synth.paused) this.synth.resume();
    this.segBase = seg.start;
    // Reflect the reached position immediately: until this segment's first
    // boundary fires, a rate change must restart from the segment START, not
    // from the previous segment's last boundary (which would re-speak text).
    this.lastBoundaryCharIndex = seg.start;
    this.zeroBoundaryStreak = 0;
    this.boundaryDegenerate = false;

    // Speak the sanitized text but map boundaries back through segBase into
    // the original chunk (sanitize is length-preserving, so charIndex values
    // are interchangeable with the original slice).
    const spokenText = sanitizeUtteranceText(
      this.currentChunk.text.slice(seg.start, seg.end),
    );
    const utt = new this.UtteranceCtor(spokenText);
    utt.text = spokenText;
    utt.rate = this.rate;
    if (this.currentVoice) utt.voice = this.currentVoice;

    this.currentUtt = utt;

    utt.onboundary = (ev: SpeechSynthesisEvent) => this.handleBoundary(ev);
    utt.onend = () => this.handleEnd();
    utt.onerror = (ev: SpeechSynthesisErrorEvent) => this.handleError(ev);

    this.synth.speak(utt);
    this.startHeartbeat();
  }

  stop(): void {
    if (this.rateRestartTimer) {
      clearTimeout(this.rateRestartTimer);
      this.rateRestartTimer = null;
    }
    if (this.currentUtt) this.detachUtterance(this.currentUtt);
    this.synth.cancel();
    // Clear any global paused state left by pause(): cancel() alone keeps
    // the queue paused, which would wedge every future speak() app-wide
    // (see speakInternal). No-op when not paused.
    this.synth.resume();
    this.currentUtt = null;
    this.currentChunk = null;
    this.currentVoice = null;
    this.userPaused = false;
    this.lastBoundaryCharIndex = 0;
    this.segments = [];
    this.segIndex = 0;
    this.segBase = 0;
    this.segmentPending = false;
    this.pendingSwap = null;
    this.stopHeartbeat();
  }

  pause(): void {
    this.userPaused = true;
    // Drop any scheduled swap — its divergence point indexes the pre-pause
    // chunk; the next render after resume recomputes a fresh one.
    this.pendingSwap = null;
    this.synth.pause();
  }

  resume(): void {
    this.userPaused = false;
    this.synth.resume();
    // If a pause raced a segment's end, handleEnd deferred the next segment
    // rather than speak into the paused queue. Start it now.
    if (this.segmentPending) {
      this.segmentPending = false;
      this.speakSegment();
    }
  }

  setRate(rate: number): void {
    const next = snapRate(rate);
    if (next === this.rate) return;
    this.rate = next;

    // Web Speech API: SpeechSynthesisUtterance.rate is read-only after
    // the utterance starts speaking — assigning to it has no effect on
    // the in-flight speech. To make rate changes audible mid-utterance,
    // we cancel the current utterance and re-speak the remaining text
    // starting at the most recent word boundary, with the new rate.
    if (!this.currentUtt || !this.currentChunk || !this.synth.speaking) {
      return;
    }

    if (this.restartDebounceMs <= 0) {
      this.applyRateRestart();
      return;
    }
    if (this.rateRestartTimer) clearTimeout(this.rateRestartTimer);
    this.rateRestartTimer = setTimeout(() => {
      this.rateRestartTimer = null;
      this.applyRateRestart();
    }, this.restartDebounceMs);
  }

  private applyRateRestart(): void {
    if (!this.currentUtt || !this.currentChunk || !this.synth.speaking) {
      return;
    }
    const remaining = sliceChunkFrom(
      this.currentChunk,
      this.lastBoundaryCharIndex,
    );
    if (!remaining.text) {
      // Past the end of the chunk — nothing to re-speak.
      return;
    }
    this.lastBoundaryCharIndex = 0;
    this.speakInternal(remaining, this.currentVoice, this.rate);
  }

  /**
   * The word currently being spoken, in the CURRENT chunk's coordinate space,
   * or null if nothing is playing / the cursor sits between rangemap words.
   * Exposed for callers that want to align a recomputed chunk themselves.
   */
  getPlaybackAnchor():
    | { charIndex: number; word: string; line: number; col: number }
    | null {
    if (!this.currentChunk) return null;
    const idx = this.lastBoundaryCharIndex;
    const entry = this.currentChunk.rangeMap.find(
      (e) => idx >= e.charStart && idx < e.charEnd,
    );
    if (!entry) return null;
    return {
      charIndex: idx,
      word: this.currentChunk.text.slice(entry.charStart, entry.charEnd),
      line: entry.line,
      col: entry.col,
    };
  }

  /**
   * Apply a freshly-resolved chunk to the in-flight utterance so the UPCOMING
   * (not-yet-spoken) words track what's on screen — used when a TUI repaints or
   * the user scrolls during playback. Does nothing when the upcoming tail is
   * unchanged (the common case → no cancel, no audible gap). See
   * `respliceMode` for scheduled vs immediate swap timing.
   */
  reswap(newChunk: SpokenChunk): void {
    // Only meaningful while our own utterance is actively speaking. A paused
    // or degenerate stream has no reliable cursor to align against.
    if (!this.currentChunk || !this.currentUtt) return;
    if (this.userPaused || this.boundaryDegenerate) return;
    if (!this.synth.speaking) return;

    const d = findTailDivergence(
      this.currentChunk,
      newChunk,
      this.lastBoundaryCharIndex,
    );
    if (!d.changed) {
      // Upcoming words are identical (or we couldn't align) — cancel any stale
      // pending swap and leave the audio untouched.
      this.pendingSwap = null;
      return;
    }

    if (this.respliceMode === "immediate") {
      // Cancel + re-speak the new chunk from the current word, now.
      this.pendingSwap = null;
      this.executeSwap(newChunk, d.resumeCharNew);
      return;
    }

    if (d.divCharOld <= this.lastBoundaryCharIndex) {
      // Divergence is already at the current word — swap now (rare; alignment
      // normally puts the first mismatch strictly ahead of the cursor).
      this.pendingSwap = null;
      this.executeSwap(newChunk, d.divCharNew);
      return;
    }

    // Scheduled: let the current audio keep playing and swap when the cursor
    // reaches the divergence (handled in handleBoundary / handleEnd).
    this.pendingSwap = {
      newChunk,
      divCharOld: d.divCharOld,
      divCharNew: d.divCharNew,
    };
  }

  /** Cancel the in-flight utterance and re-speak `chunk` from `fromCharIndex`.
   *  Shares the rate-restart machinery: speakInternal detaches + cancels the
   *  old utterance (so no stale onend chains) and re-segments the remainder. */
  private executeSwap(chunk: SpokenChunk, fromCharIndex: number): void {
    const remaining = sliceChunkFrom(chunk, fromCharIndex);
    if (!remaining.text) {
      // Nothing left to speak (e.g. content truncated to before the cursor) —
      // end cleanly rather than leaving a wedged utterance.
      this.stop();
      for (const cb of this.endListeners) cb();
      return;
    }
    this.lastBoundaryCharIndex = 0;
    this.speakInternal(remaining, this.currentVoice, this.rate);
  }

  getRate(): number {
    return this.rate;
  }

  isSpeaking(): boolean {
    return this.synth.speaking;
  }

  isPaused(): boolean {
    return this.synth.paused;
  }

  async getVoices(): Promise<SpeechSynthesisVoice[]> {
    const initial = this.synth.getVoices();
    if (initial.length > 0) return initial;
    return new Promise((resolve) => {
      const target = this.synth as unknown as EventTarget;
      const handler = () => {
        target.removeEventListener("voiceschanged", handler);
        resolve(this.synth.getVoices());
      };
      target.addEventListener("voiceschanged", handler);
    });
  }

  dispose(): void {
    this.stop();
    this.boundaryListeners.clear();
    this.endListeners.clear();
    this.errorListeners.clear();
    this.degenerateListeners.clear();
  }

  private handleBoundary(ev: SpeechSynthesisEvent): void {
    if (ev.name !== "word") return;
    if (!this.currentChunk) return;
    if (this.boundaryDegenerate) return;
    // The OS reports charIndex relative to the current SEGMENT's utterance;
    // shift by segBase to index the whole chunk (rangeMap / word / rate
    // restart all work in chunk coordinates).
    const rel = ev.charIndex;
    const idx = this.segBase + rel;
    // Track most-recent boundary so live rate changes can restart from
    // here. Recorded even when no rangemap entry matches (e.g. punctuation).
    this.lastBoundaryCharIndex = idx;
    // Scheduled reswap: once the cursor reaches the divergence word, swap to
    // the recomputed chunk. We do this BEFORE emitting the boundary so the
    // highlight never flashes the about-to-be-replaced (stale) word.
    if (this.pendingSwap && idx >= this.pendingSwap.divCharOld) {
      const ps = this.pendingSwap;
      this.pendingSwap = null;
      this.executeSwap(ps.newChunk, ps.divCharNew);
      return;
    }
    // Degenerate-stream guard. macOS reports charIndex=0 for
    // EVERY boundary when the utterance contains a poison char (see
    // UTTERANCE_POISON_CHARS); a healthy stream's charIndex grows, so a
    // long run of consecutive zeros means the positions are garbage.
    // Warn once, tell listeners (the controller clears the stuck
    // highlight), and stop emitting boundaries for this utterance. Keyed on
    // the segment-relative index so a segment that starts at a nonzero
    // segBase isn't mistaken for a healthy stream.
    if (rel === 0) {
      this.zeroBoundaryStreak += 1;
      if (this.zeroBoundaryStreak >= DEGENERATE_ZERO_BOUNDARY_THRESHOLD) {
        this.boundaryDegenerate = true;
        console.warn(
          `[tts] boundary charIndex degenerate (${this.zeroBoundaryStreak} ` +
            "consecutive zeros) — word highlight disabled for this " +
            "utterance; the text may contain a speech-poison character.",
        );
        for (const cb of this.degenerateListeners) cb();
        return;
      }
    } else {
      this.zeroBoundaryStreak = 0;
    }
    const entry = this.currentChunk.rangeMap.find(
      (e) => idx >= e.charStart && idx < e.charEnd,
    );
    if (!entry) return;
    const word = this.currentChunk.text.slice(entry.charStart, entry.charEnd);
    const boundary: TtsBoundary = {
      line: entry.line,
      col: entry.col,
      len: entry.len,
      word,
      charIndex: idx,
    };
    for (const cb of this.boundaryListeners) cb(boundary);
  }

  private handleEnd(): void {
    this.stopHeartbeat();
    // A segment finished. If more remain, chain straight into the next one
    // (still the same logical playback — no 'end' fires to listeners). Only
    // when the LAST segment ends is the chunk truly done.
    this.segIndex += 1;
    if (this.currentChunk && this.segIndex < this.segments.length) {
      if (this.userPaused) {
        // A user pause() raced this segment's end. Do NOT speak the next
        // segment into the paused queue (it would wedge forever); hold it
        // until resume() runs it.
        this.currentUtt = null;
        this.segmentPending = true;
        return;
      }
      this.speakSegment();
      return;
    }
    // The chunk finished. A pending APPEND swap (divCharOld == old chunk end)
    // never fires a boundary at text.length, so honour it here: continue
    // straight into the recomputed content instead of ending. This is the
    // seam-less continuation of "play what's on screen" as content streams in.
    if (this.pendingSwap) {
      const ps = this.pendingSwap;
      this.pendingSwap = null;
      this.currentUtt = null;
      this.executeSwap(ps.newChunk, ps.divCharNew);
      return;
    }
    this.currentUtt = null;
    this.currentChunk = null;
    this.segments = [];
    this.segIndex = 0;
    this.segBase = 0;
    this.segmentPending = false;
    for (const cb of this.endListeners) cb();
  }

  private handleError(ev: SpeechSynthesisErrorEvent): void {
    this.stopHeartbeat();
    // Reset all in-flight state so an error partway through a multi-segment
    // chunk doesn't leave the engine stuck "mid-chunk" (segments that would
    // never be spoken, no end ever reaching the controller). A subsequent
    // start() is clean; the controller keys off the 'error' below.
    if (this.currentUtt) this.detachUtterance(this.currentUtt);
    this.currentUtt = null;
    this.currentChunk = null;
    this.segments = [];
    this.segIndex = 0;
    this.segBase = 0;
    this.segmentPending = false;
    this.pendingSwap = null;
    const err = new Error(ev.error || "speech-synthesis-error");
    for (const cb of this.errorListeners) cb(err);
  }

  private detachUtterance(u: SpeechSynthesisUtterance): void {
    u.onboundary = null;
    u.onend = null;
    u.onerror = null;
    u.onstart = null;
    u.onpause = null;
    u.onresume = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.userPaused) return;
      if (!this.synth.speaking) return;
      this.synth.pause();
      this.synth.resume();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
