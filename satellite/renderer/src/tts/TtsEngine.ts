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

export class TtsEngine {
  private readonly synth: SpeechSynthesis;
  private readonly UtteranceCtor: typeof SpeechSynthesisUtterance;
  private readonly heartbeatIntervalMs: number;
  private readonly restartDebounceMs: number;
  private rateRestartTimer: ReturnType<typeof setTimeout> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentUtt: SpeechSynthesisUtterance | null = null;
  private currentChunk: SpokenChunk | null = null;
  private currentVoice: SpeechSynthesisVoice | null = null;
  private rate = 1.0;
  private userPaused = false;
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
    }
    this.stopHeartbeat();

    // Speak the sanitized text but keep the ORIGINAL in
    // currentChunk: boundary `word` extraction, sliceChunkFrom, and every
    // adapter's rangeMap continue to index the original string (same
    // length by construction, so charIndex values are interchangeable).
    const spokenText = sanitizeUtteranceText(chunk.text);
    const utt = new this.UtteranceCtor(spokenText);
    utt.text = spokenText;
    utt.rate = rate;
    if (voice) utt.voice = voice;

    this.currentChunk = chunk;
    this.currentUtt = utt;
    this.userPaused = false;
    this.zeroBoundaryStreak = 0;
    this.boundaryDegenerate = false;

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
    this.currentUtt = null;
    this.currentChunk = null;
    this.currentVoice = null;
    this.userPaused = false;
    this.lastBoundaryCharIndex = 0;
    this.stopHeartbeat();
  }

  pause(): void {
    this.userPaused = true;
    this.synth.pause();
  }

  resume(): void {
    this.userPaused = false;
    this.synth.resume();
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
    const idx = ev.charIndex;
    // Track most-recent boundary so live rate changes can restart from
    // here. Recorded even when no rangemap entry matches (e.g. punctuation).
    this.lastBoundaryCharIndex = idx;
    // Degenerate-stream guard. macOS reports charIndex=0 for
    // EVERY boundary when the utterance contains a poison char (see
    // UTTERANCE_POISON_CHARS); a healthy stream's charIndex grows, so a
    // long run of consecutive zeros means the positions are garbage.
    // Warn once, tell listeners (the controller clears the stuck
    // highlight), and stop emitting boundaries for this utterance.
    if (idx === 0) {
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
    this.currentUtt = null;
    this.currentChunk = null;
    for (const cb of this.endListeners) cb();
  }

  private handleError(ev: SpeechSynthesisErrorEvent): void {
    this.stopHeartbeat();
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
