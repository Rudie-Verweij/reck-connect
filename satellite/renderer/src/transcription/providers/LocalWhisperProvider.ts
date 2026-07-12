// Embedded (on-device) Whisper provider via a persistent Web Worker (so the
// model stays loaded across utterances).
//
// Whisper isn't a streaming model, but to show live text we re-transcribe the
// audio-so-far every ~1.2s while recording and surface that as interim
// ("partial") text; on stop we do one final pass over the whole utterance and
// inject that ("final"). The models are loaded + warmed up in prepare() —
// before the mic starts — so recording only begins once transcription can run.
//
// Two models per session: PARTIAL passes run on a fast small model (tiny by
// default) so live text keeps up with speech; the FINAL pass runs on the
// user-selected model for quality. Without this split, live preview on
// base/small lagged so far behind that dictation felt like transcribe-on-stop.

import { mergeFloat32, resampleLinear, rms, WHISPER_SAMPLE_RATE } from "../pcm";
import type { Transcriber, TranscriptionHandlers } from "./types";

// How often to re-transcribe the growing buffer for the live preview.
const PARTIAL_INTERVAL_MS = 1200;
// RMS above this counts as speech. Below it we don't transcribe at all, so
// Whisper can't hallucinate words out of silence.
const VOICE_THRESHOLD = 0.01;
// Partial passes re-transcribe the whole live buffer, whose cost grows with
// utterance length. Once the un-frozen span exceeds this, freeze the words
// committed so far and restart the live pass on audio from that point on, so
// each partial stays O(window). The final pass still covers the full
// utterance and corrects anything the cut mangled.
const MAX_PARTIAL_WINDOW_S = 12;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

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
  private hasVoice = false;
  // Stable-prefix (LocalAgreement) state: words confirmed across two passes
  // are committed and never rewritten; `prevHyp` is the last full hypothesis.
  private committed: string[] = [];
  private prevHyp: string[] = [];
  // Sliding-window state: words permanently frozen when the window advanced,
  // and the sample offset (at capture rate) where the current window starts.
  private frozen: string[] = [];
  private windowStart = 0;

  private readonly partialRepo: string;
  private readonly language: string;

  constructor(
    private readonly repo: string,
    opts: { partialRepo?: string; language?: string } = {},
  ) {
    this.partialRepo = opts.partialRepo ?? repo;
    this.language = opts.language ?? "auto";
  }

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
            this.integratePartial(d.text);
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
      const repos = this.partialRepo === this.repo ? [this.repo] : [this.partialRepo, this.repo];
      worker.postMessage({ type: "prepare", repos, generation: this.generation });
    });
  }

  async begin(): Promise<void> {
    // Fresh utterance: reset the live buffer/preview + stable-prefix state.
    this.liveChunks = [];
    this.lastPartialLen = 0;
    this.partialBusy = false;
    this.hasVoice = false;
    this.committed = [];
    this.prevHyp = [];
    this.frozen = [];
    this.windowStart = 0;
    this.stopPartialTimer();
    this.partialTimer = self.setInterval(() => this.runPartial(), PARTIAL_INTERVAL_MS);
  }

  feed(chunk: Float32Array, sampleRate: number): void {
    this.liveSampleRate = sampleRate;
    this.liveChunks.push(chunk);
    if (!this.hasVoice && rms(chunk) > VOICE_THRESHOLD) this.hasVoice = true;
  }

  /**
   * Commit words that agree between the last two full hypotheses (streaming
   * "LocalAgreement"): committed words are stable and never rewritten, so the
   * live text only grows; only the unsettled tail waits. Emits the committed
   * text as the running transcript.
   */
  private integratePartial(text: string): void {
    const cur = words(text);
    let agree = 0;
    const max = Math.min(cur.length, this.prevHyp.length);
    while (agree < max && normWord(cur[agree]) === normWord(this.prevHyp[agree])) agree++;
    this.prevHyp = cur;
    if (agree > this.committed.length) {
      this.committed = cur.slice(0, agree);
      this.handlers?.onPartial?.(this.frozen.concat(this.committed).join(" "));
    }
    // Everything beyond the committed prefix is still settling — surface it
    // as the ghost tail so the user sees words the instant Whisper hears
    // them, without the prompt flickering through corrections.
    this.handlers?.onTail?.(cur.slice(this.committed.length).join(" "));
  }

  private runPartial(): void {
    // No transcription until we've actually heard speech — stops silence
    // hallucinations from appearing/changing on their own.
    if (this.partialBusy || !this.worker || !this.hasVoice) return;
    let total = 0;
    for (const c of this.liveChunks) total += c.length;
    // Skip if nothing new since the last partial (avoid redundant work).
    if (total === 0 || total === this.lastPartialLen) return;
    this.lastPartialLen = total;
    // Window overflow: freeze what's committed and restart the live pass on
    // audio from here on. Uncommitted tail words go dark until the final
    // full-buffer pass restores them — bounded partial cost is worth it.
    if (total - this.windowStart > MAX_PARTIAL_WINDOW_S * this.liveSampleRate) {
      this.frozen = this.frozen.concat(this.committed);
      this.committed = [];
      this.prevHyp = [];
      this.windowStart = total;
      return;
    }
    this.partialBusy = true;
    const audio = resampleLinear(
      mergeFloat32(this.liveChunks).subarray(this.windowStart),
      this.liveSampleRate,
      WHISPER_SAMPLE_RATE,
    );
    this.worker.postMessage(
      {
        type: "transcribe",
        kind: "partial",
        audio,
        repo: this.partialRepo,
        language: this.language,
        generation: this.generation,
      },
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
    // Nothing captured, or never any speech → don't transcribe silence.
    if (full.length === 0 || !this.hasVoice) {
      this.handlers?.onFinal?.("");
      return Promise.resolve();
    }
    const audio = resampleLinear(full, sampleRate, WHISPER_SAMPLE_RATE);
    const worker = this.ensureWorker();
    return new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
      worker.postMessage(
        {
          type: "transcribe",
          kind: "final",
          audio,
          repo: this.repo,
          language: this.language,
          generation: this.generation,
        },
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
