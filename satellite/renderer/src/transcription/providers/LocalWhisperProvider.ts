// Embedded (on-device) Whisper provider. Batch style: it ignores live
// chunks and transcribes the whole utterance when capture stops, via a
// persistent Web Worker (so the model stays loaded across utterances).
//
// The model is loaded + warmed up in prepare() — before the mic starts — so
// recording only begins once transcription can actually run, and a WebGPU
// failure surfaces up front instead of after the user has spoken.

import { resampleLinear, WHISPER_SAMPLE_RATE } from "../pcm";
import type { Transcriber, TranscriptionHandlers } from "./types";

type WorkerOut =
  | { type: "status"; status: "loading" | "transcribing"; generation: number }
  | { type: "progress"; pct: number; generation: number }
  | { type: "ready"; generation: number }
  | { type: "result"; text: string; generation: number }
  | { type: "error"; message: string; generation: number };

export class LocalWhisperProvider implements Transcriber {
  private worker: Worker | null = null;
  private handlers: TranscriptionHandlers | null = null;
  // Bumped each utterance; a late reply from a cancelled one is dropped.
  private generation = 0;
  // Resolves the in-flight transcribe (end) promise.
  private resolveEnd: (() => void) | null = null;
  // Settles the in-flight prepare promise.
  private resolvePrepare: (() => void) | null = null;
  private rejectPrepare: ((err: Error) => void) | null = null;

  constructor(private readonly repo: string) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("../whisper-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const d = e.data;
      if (d.generation !== this.generation) return; // stale / cancelled
      switch (d.type) {
        case "status":
          this.handlers?.onStatus?.(d.status);
          break;
        case "progress":
          this.handlers?.onProgress?.(d.pct);
          break;
        case "ready":
          this.settlePrepare();
          break;
        case "result":
          this.handlers?.onFinal?.(d.text);
          this.settleEnd();
          break;
        case "error":
          // A failure during prepare rejects prepare (before recording);
          // otherwise it's a transcription error for the current utterance.
          if (this.rejectPrepare) this.settlePrepare(new Error(d.message));
          else {
            this.handlers?.onError?.(d.message);
            this.settleEnd();
          }
          break;
      }
    };
    this.worker.onerror = (e) => {
      const message = e.message || "Whisper worker failed";
      if (this.rejectPrepare) this.settlePrepare(new Error(message));
      else {
        this.handlers?.onError?.(message);
        this.settleEnd();
      }
    };
    return this.worker;
  }

  private settleEnd(): void {
    const resolve = this.resolveEnd;
    this.resolveEnd = null;
    resolve?.();
  }

  private settlePrepare(err?: Error): void {
    const resolve = this.resolvePrepare;
    const reject = this.rejectPrepare;
    this.resolvePrepare = null;
    this.rejectPrepare = null;
    if (err) reject?.(err);
    else resolve?.();
  }

  /** Load + warm up the model. Resolves only once it's ready to transcribe. */
  prepare(handlers: TranscriptionHandlers): Promise<void> {
    this.handlers = handlers;
    this.generation++;
    const worker = this.ensureWorker();
    return new Promise<void>((resolve, reject) => {
      this.resolvePrepare = resolve;
      this.rejectPrepare = reject;
      worker.postMessage({ type: "prepare", repo: this.repo, generation: this.generation });
    });
  }

  async begin(): Promise<void> {
    // Model was loaded in prepare(); nothing to do per-utterance.
  }

  feed(): void {
    // Batch provider: nothing to do with live chunks.
  }

  /** Resolves once the worker has returned a result (or errored/cancelled). */
  end(full: Float32Array, sampleRate: number): Promise<void> {
    if (full.length === 0) {
      this.handlers?.onFinal?.("");
      return Promise.resolve();
    }
    const audio = resampleLinear(full, sampleRate, WHISPER_SAMPLE_RATE);
    const worker = this.ensureWorker();
    return new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
      worker.postMessage(
        { type: "transcribe", audio, repo: this.repo, generation: this.generation },
        [audio.buffer],
      );
    });
  }

  cancel(): void {
    // Invalidate any in-flight reply and release waiters so nothing hangs.
    this.generation++;
    this.settleEnd();
    this.settlePrepare(new Error("cancelled"));
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.handlers = null;
  }
}
