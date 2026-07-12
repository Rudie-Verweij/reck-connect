// Embedded (on-device) Whisper provider. Batch style: it ignores live
// chunks and transcribes the whole utterance when capture stops, via a
// persistent Web Worker (so the model stays loaded across utterances).

import { resampleLinear, WHISPER_SAMPLE_RATE } from "../pcm";
import type { Transcriber, TranscriptionHandlers } from "./types";

type WorkerOut =
  | { type: "status"; status: "loading" | "transcribing"; generation: number }
  | { type: "result"; text: string; generation: number }
  | { type: "error"; message: string; generation: number };

export class LocalWhisperProvider implements Transcriber {
  private worker: Worker | null = null;
  private handlers: TranscriptionHandlers | null = null;
  // Bumped each utterance; a late result from a cancelled one is dropped.
  private generation = 0;

  constructor(private readonly repo: string) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("../whisper-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const d = e.data;
      // Drop any reply from a cancelled/superseded utterance.
      if (d.generation !== this.generation) return;
      if (d.type === "status") this.handlers?.onStatus?.(d.status);
      else if (d.type === "result") this.handlers?.onFinal?.(d.text);
      else if (d.type === "error") this.handlers?.onError?.(d.message);
    };
    this.worker.onerror = (e) => this.handlers?.onError?.(e.message || "Whisper worker failed");
    return this.worker;
  }

  async begin(handlers: TranscriptionHandlers): Promise<void> {
    this.handlers = handlers;
    this.generation++;
    this.ensureWorker(); // warm the worker; model loads on first transcribe.
  }

  feed(): void {
    // Batch provider: nothing to do with live chunks.
  }

  async end(full: Float32Array, sampleRate: number): Promise<void> {
    if (full.length === 0) {
      this.handlers?.onFinal?.("");
      return;
    }
    const audio = resampleLinear(full, sampleRate, WHISPER_SAMPLE_RATE);
    const worker = this.ensureWorker();
    // Result arrives asynchronously via onmessage → onFinal.
    worker.postMessage(
      { type: "transcribe", audio, repo: this.repo, generation: this.generation },
      [audio.buffer],
    );
  }

  cancel(): void {
    // Invalidate any in-flight transcription result.
    this.generation++;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.handlers = null;
  }
}
