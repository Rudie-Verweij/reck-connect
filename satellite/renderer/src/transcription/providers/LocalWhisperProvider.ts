// Embedded (on-device) Whisper provider via a persistent Web Worker (so the
// model stays loaded across utterances).
//
// Whisper isn't a streaming model, but to show live text we re-transcribe the
// audio-so-far every ~1.2s while recording and surface that as interim
// ("partial") text; on stop we do one final pass over the whole utterance and
// inject that ("final"). The model is loaded + warmed up in prepare() — before
// the mic starts — so recording only begins once transcription can run.

import { mergeFloat32, resampleLinear, WHISPER_SAMPLE_RATE } from "../pcm";
import type { Transcriber, TranscriptionHandlers } from "./types";

// How often to re-transcribe the growing buffer for the live preview.
const PARTIAL_INTERVAL_MS = 1200;

type WorkerOut =
  | { type: "status"; status: "loading" | "transcribing"; generation: number }
  | { type: "progress"; pct: number; generation: number }
  | { type: "ready"; generation: number }
  | { type: "result"; kind: "partial" | "final"; text: string; generation: number }
  | { type: "error"; message: string; generation: number };

export class LocalWhisperProvider implements Transcriber {
  private worker: Worker | null = null;
  private handlers: TranscriptionHandlers | null = null;
  // Bumped each utterance; a late reply from a cancelled one is dropped.
  private generation = 0;
  private resolveEnd: (() => void) | null = null;
  private resolvePrepare: (() => void) | null = null;
  private rejectPrepare: ((err: Error) => void) | null = null;

  // Live-preview state.
  private liveChunks: Float32Array[] = [];
  private liveSampleRate = WHISPER_SAMPLE_RATE;
  private partialTimer: number | null = null;
  private partialBusy = false;
  private lastPartialLen = 0;

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
          if (d.kind === "partial") {
            this.partialBusy = false;
            if (d.text) this.handlers?.onPartial?.(d.text);
          } else {
            this.handlers?.onFinal?.(d.text);
            this.settleEnd();
          }
          break;
        case "error":
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
    // Fresh utterance: reset the live buffer and start the preview loop.
    this.liveChunks = [];
    this.lastPartialLen = 0;
    this.partialBusy = false;
    this.stopPartialTimer();
    this.partialTimer = self.setInterval(() => this.runPartial(), PARTIAL_INTERVAL_MS);
  }

  feed(chunk: Float32Array, sampleRate: number): void {
    this.liveSampleRate = sampleRate;
    this.liveChunks.push(chunk);
  }

  private runPartial(): void {
    if (this.partialBusy || !this.worker) return;
    let total = 0;
    for (const c of this.liveChunks) total += c.length;
    // Skip if nothing new since the last partial (avoid redundant work).
    if (total === 0 || total === this.lastPartialLen) return;
    this.lastPartialLen = total;
    this.partialBusy = true;
    const audio = resampleLinear(
      mergeFloat32(this.liveChunks),
      this.liveSampleRate,
      WHISPER_SAMPLE_RATE,
    );
    this.worker.postMessage(
      { type: "transcribe", kind: "partial", audio, repo: this.repo, generation: this.generation },
      [audio.buffer],
    );
  }

  private stopPartialTimer(): void {
    if (this.partialTimer !== null) {
      self.clearInterval(this.partialTimer);
      this.partialTimer = null;
    }
  }

  /** Resolves once the worker has returned the final result (or errored). */
  end(full: Float32Array, sampleRate: number): Promise<void> {
    this.stopPartialTimer();
    this.liveChunks = [];
    if (full.length === 0) {
      this.handlers?.onFinal?.("");
      return Promise.resolve();
    }
    const audio = resampleLinear(full, sampleRate, WHISPER_SAMPLE_RATE);
    const worker = this.ensureWorker();
    return new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
      worker.postMessage(
        { type: "transcribe", kind: "final", audio, repo: this.repo, generation: this.generation },
        [audio.buffer],
      );
    });
  }

  cancel(): void {
    // Invalidate any in-flight reply and release waiters so nothing hangs.
    this.generation++;
    this.stopPartialTimer();
    this.liveChunks = [];
    this.partialBusy = false;
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
