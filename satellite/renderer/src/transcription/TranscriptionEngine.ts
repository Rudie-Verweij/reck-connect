// Drives one dictation session: owns the mic capture and the active
// provider, and exposes a small state machine (idle → listening →
// transcribing → idle). Framework-free; the controller wires its callbacks
// to the UI and to the pane the text is injected into.

import { AudioCapture } from "./AudioCapture";
import { rms } from "./pcm";
import { DEFAULT_ONSET_CONFIG, OnsetDetector, type OnsetConfig } from "./onsetDetector";
import type {
  Transcriber,
  TranscriptionHandlers,
  TranscriberStatus,
} from "./providers/types";

export type DictationState = "idle" | "preparing" | "listening" | "transcribing";

export interface EngineHandlers {
  onPartial?: (text: string) => void;
  onTail?: (text: string) => void;
  onFinal?: (text: string) => void;
  onStatus?: (status: TranscriberStatus) => void;
  onProgress?: (pct: number) => void;
  /** Live mic amplitude (RMS, ~0–1) for the volume meter. */
  onLevel?: (level: number) => void;
  /**
   * Cumulative VOICED milliseconds this utterance — grows the moment you
   * speak, long before any transcription returns. The UI turns it into
   * ghost word-placeholders that crystallize as real text arrives.
   */
  onSpeechMs?: (ms: number) => void;
  /** A word ONSET was detected from the audio (Phase 2) — fires the instant a
   *  word is spoken, before transcription. `count` is onsets this utterance.
   *  (Kept for the "estimate" ghost-mode fallback.) */
  onWordCount?: (count: number) => void;
  /** A word onset with its stable `id` — the chunk model appends one blurred
   *  segment per onset the instant a word starts. */
  onWordOnset?: (id: number) => void;
  /** The matching word ended (`durationMs` = its voiced span). */
  onWordEnd?: (id: number, durationMs: number) => void;
  onError?: (message: string) => void;
  onStateChange?: (state: DictationState) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Sub-chunk RMS above this counts as voiced audio (same floor the local
// provider uses to gate transcription).
const VOICED_RMS = 0.01;
// Analyze voiced-ness in ~32ms windows so brief inter-word gaps don't
// inflate the speech-time estimate.
const VOICED_WINDOW_SAMPLES = 512;

/** Milliseconds of voiced audio within a capture chunk. */
function voicedMs(chunk: Float32Array, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  let voicedSamples = 0;
  for (let start = 0; start < chunk.length; start += VOICED_WINDOW_SAMPLES) {
    const end = Math.min(start + VOICED_WINDOW_SAMPLES, chunk.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += chunk[i] * chunk[i];
    if (Math.sqrt(sum / (end - start)) > VOICED_RMS) voicedSamples += end - start;
  }
  return (voicedSamples / sampleRate) * 1000;
}

export class TranscriptionEngine {
  private capture: AudioCapture | null = null;
  private state: DictationState = "idle";
  // Chunks captured before the provider finished starting, replayed on ready.
  private pending: Array<{ chunk: Float32Array; rate: number }> = [];
  private ready = false;
  private speechMs = 0;
  private onsetCount = 0;
  private onsetConfig: OnsetConfig = DEFAULT_ONSET_CONFIG;
  private readonly onset = new OnsetDetector(this.onsetConfig, {
    onOnset: (id) => {
      this.onsetCount = id;
      this.handlers.onWordCount?.(id);
      this.handlers.onWordOnset?.(id);
    },
    onEnd: (id, durationMs) => {
      this.handlers.onWordEnd?.(id, durationMs);
    },
  });

  constructor(
    private provider: Transcriber,
    private readonly handlers: EngineHandlers,
  ) {}

  /** Update onset-detection thresholds (from the appearance settings). */
  setOnsetConfig(cfg: OnsetConfig): void {
    this.onsetConfig = cfg;
    this.onset.setConfig(cfg);
  }

  getState(): DictationState {
    return this.state;
  }

  isActive(): boolean {
    return this.state !== "idle";
  }

  /** Swap the transcription provider (e.g. after a settings change). */
  setProvider(provider: Transcriber): void {
    if (provider === this.provider) return;
    this.provider.dispose();
    this.provider = provider;
  }

  private setState(state: DictationState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private providerHandlers(): TranscriptionHandlers {
    return {
      onPartial: (t) => this.handlers.onPartial?.(t),
      onTail: (t) => this.handlers.onTail?.(t),
      onFinal: (t) => this.handlers.onFinal?.(t),
      onStatus: (s) => this.handlers.onStatus?.(s),
      onProgress: (p) => this.handlers.onProgress?.(p),
      onError: (m) => this.handlers.onError?.(m),
    };
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    // Get the provider ready (load + warm up the local model) BEFORE opening
    // the mic, so recording only begins once transcription can actually run.
    this.setState("preparing");
    try {
      await this.provider.prepare(this.providerHandlers());
    } catch (err) {
      this.handlers.onError?.(errMsg(err));
      this.setState("idle");
      return;
    }
    // A cancel() during preparation already reset us to idle — don't proceed
    // to open the mic. (Read via the getter so TS doesn't keep the stale
    // narrowing from the "idle" guard above.)
    if (this.getState() !== "preparing") return;

    this.pending = [];
    this.ready = false;
    this.speechMs = 0;
    this.onsetCount = 0;
    this.onset.reset();
    this.capture = new AudioCapture({
      onChunk: (chunk, rate) => {
        // Instant volume feedback — independent of the (laggy) transcription.
        const level = rms(chunk);
        this.handlers.onLevel?.(level);
        // Word-onset detection (Phase 2): fires the instant a word starts.
        this.onset.feed(level, rate > 0 ? (chunk.length / rate) * 1000 : 0);
        const voiced = voicedMs(chunk, rate);
        if (voiced > 0) {
          this.speechMs += voiced;
          this.handlers.onSpeechMs?.(this.speechMs);
        }
        if (this.ready) this.provider.feed(chunk, rate);
        else this.pending.push({ chunk, rate });
      },
      onError: (err) => this.handlers.onError?.(errMsg(err)),
    });
    try {
      await this.capture.start();
      await this.provider.begin(this.providerHandlers(), this.capture.getSampleRate());
      this.ready = true;
      for (const { chunk, rate } of this.pending) this.provider.feed(chunk, rate);
      this.pending = [];
      this.setState("listening");
    } catch (err) {
      this.handlers.onError?.(errMsg(err));
      await this.cancel();
    }
  }

  /** Stop capture and finalize; resolves once transcription completes. */
  async stop(): Promise<void> {
    if (this.state !== "listening" || !this.capture) return;
    this.setState("transcribing");
    const { samples, sampleRate } = await this.capture.stop();
    this.capture = null;
    try {
      await this.provider.end(samples, sampleRate);
    } catch (err) {
      this.handlers.onError?.(errMsg(err));
    }
    this.setState("idle");
  }

  /** Abort the current session without finalizing. */
  async cancel(): Promise<void> {
    this.provider.cancel();
    if (this.capture) {
      try {
        await this.capture.stop();
      } catch {
        // Best-effort teardown.
      }
      this.capture = null;
    }
    this.pending = [];
    this.ready = false;
    this.setState("idle");
  }

  dispose(): void {
    void this.cancel();
    this.provider.dispose();
  }
}
