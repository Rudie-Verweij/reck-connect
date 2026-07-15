// Word-onset detection from the live audio energy stream (Phase 2). The
// engine already computes per-chunk RMS; feeding it here lets us know a word
// is being spoken the INSTANT it starts — long before the transcriber returns
// text — so the overlay can show a heavily-blurred placeholder immediately
// and crystallize it into the real word once transcription catches up.
//
// Pure + deterministic (no timers, no audio APIs) so it unit-tests against
// synthetic RMS sequences. Hysteresis (separate open/close thresholds), a
// minimum word duration (reject blips), and a minimum silence gap (don't split
// a word on brief dips) keep it stable in a noisy room.

export interface OnsetConfig {
  /** RMS at/above which a word STARTS. */
  openThreshold: number;
  /** RMS below which we start counting a gap (hysteresis: < openThreshold). */
  closeThreshold: number;
  /** Silence this long ends the current word. */
  minGapMs: number;
  /** Ignore words shorter than this (coughs, clicks) — no onset emitted. */
  minWordMs: number;
}

export const DEFAULT_ONSET_CONFIG: OnsetConfig = {
  openThreshold: 0.02,
  closeThreshold: 0.012,
  minGapMs: 140,
  minWordMs: 70,
};

export interface OnsetEvents {
  /** A word onset was confirmed (sustained past minWordMs). `id` increments. */
  onOnset?: (id: number) => void;
  /** The word ended; `durationMs` is its voiced span. */
  onEnd?: (id: number, durationMs: number) => void;
}

export class OnsetDetector {
  private inWord = false;
  private confirmed = false;
  private wordMs = 0;
  private gapMs = 0;
  private id = 0;

  constructor(
    private cfg: OnsetConfig,
    private readonly ev: OnsetEvents,
  ) {}

  setConfig(cfg: OnsetConfig): void {
    this.cfg = cfg;
  }

  /** Feed one energy sample covering `dtMs` of audio. */
  feed(rms: number, dtMs: number): void {
    if (!this.inWord) {
      if (rms >= this.cfg.openThreshold) {
        this.inWord = true;
        this.confirmed = false;
        this.wordMs = dtMs;
        this.gapMs = 0;
      }
      return;
    }
    this.wordMs += dtMs;
    // Track the TRAILING gap first, so a silent chunk counts as gap (not as
    // voiced word length) before we decide to confirm.
    if (rms < this.cfg.closeThreshold) {
      this.gapMs += dtMs;
    } else {
      this.gapMs = 0;
    }
    const voicedMs = this.wordMs - this.gapMs;
    // Confirm (and emit the onset) once the VOICED span has sustained — so a
    // click doesn't spawn a phantom placeholder. The tiny delay is imperceptible.
    if (!this.confirmed && voicedMs >= this.cfg.minWordMs) {
      this.confirmed = true;
      this.id += 1;
      this.ev.onOnset?.(this.id);
    }
    if (this.gapMs >= this.cfg.minGapMs) {
      this.inWord = false;
      if (this.confirmed) this.ev.onEnd?.(this.id, voicedMs);
    }
  }

  /** Reset between utterances. Does not reset the id counter's monotonicity. */
  reset(): void {
    this.inWord = false;
    this.confirmed = false;
    this.wordMs = 0;
    this.gapMs = 0;
  }
}
