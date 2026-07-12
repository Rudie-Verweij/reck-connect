// The transcription-provider contract, shared by the Deepgram (streaming)
// and embedded-Whisper (batch) implementations. The TranscriptionEngine
// drives capture and calls these; providers turn audio into text and report
// back through the handlers.
//
// Lifecycle per utterance: begin() → feed()* → end(). A provider instance is
// reused across utterances (so the embedded model stays loaded); cancel()
// aborts the current utterance but keeps the provider usable, dispose()
// releases everything.

export interface TranscriptionHandlers {
  /** Interim text for the current utterance (replaces the prior interim). */
  onPartial?: (text: string) => void;
  /** A finalized segment to inject (appended to what's already there). */
  onFinal?: (text: string) => void;
  /** Progress/status for slow steps, e.g. "loading" the local model. */
  onStatus?: (status: TranscriberStatus) => void;
  /** Model-load progress, 0–100 (local model download). */
  onProgress?: (pct: number) => void;
  /** A user-facing error message. */
  onError?: (message: string) => void;
}

export type TranscriberStatus = "loading" | "transcribing";

export interface Transcriber {
  /**
   * Get ready BEFORE the mic starts — e.g. load + warm up the local model —
   * so recording only begins once transcription can actually happen. Emits
   * onStatus("loading"). No-op for streaming providers. Rejects if the
   * engine can't be made ready (surfaced before any audio is captured).
   */
  prepare(handlers: TranscriptionHandlers): Promise<void>;
  /** Prepare for one utterance. `sampleRate` is the capture rate. */
  begin(handlers: TranscriptionHandlers, sampleRate: number): Promise<void>;
  /** A live Float32 chunk at `sampleRate` (streaming providers forward it). */
  feed(chunk: Float32Array, sampleRate: number): void;
  /** Capture stopped; `full` is the whole utterance at `sampleRate`. */
  end(full: Float32Array, sampleRate: number): Promise<void>;
  /** Abort the current utterance but keep the provider reusable. */
  cancel(): void;
  /** Release all resources (worker/socket). */
  dispose(): void;
}
