// Drives one dictation session: owns the mic capture and the active
// provider, and exposes a small state machine (idle → listening →
// transcribing → idle). Framework-free; the controller wires its callbacks
// to the UI and to the pane the text is injected into.

import { AudioCapture } from "./AudioCapture";
import type {
  Transcriber,
  TranscriptionHandlers,
  TranscriberStatus,
} from "./providers/types";

export type DictationState = "idle" | "preparing" | "listening" | "transcribing";

export interface EngineHandlers {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onStatus?: (status: TranscriberStatus) => void;
  onProgress?: (pct: number) => void;
  onError?: (message: string) => void;
  onStateChange?: (state: DictationState) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TranscriptionEngine {
  private capture: AudioCapture | null = null;
  private state: DictationState = "idle";
  // Chunks captured before the provider finished starting, replayed on ready.
  private pending: Array<{ chunk: Float32Array; rate: number }> = [];
  private ready = false;

  constructor(
    private provider: Transcriber,
    private readonly handlers: EngineHandlers,
  ) {}

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
    this.capture = new AudioCapture({
      onChunk: (chunk, rate) => {
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
