// Cloud (Deepgram) provider — a thin renderer shim over the main-process
// router (which holds the API key and the websocket). Streaming: live
// Float32 chunks are converted to linear16 and forwarded; interim/final
// transcripts arrive via the "transcription:event" IPC channel.

import { floatToInt16 } from "../pcm";
import { sanitizeTranscript } from "../transcriptClean";
import type { Transcriber, TranscriptionHandlers } from "./types";

// After CloseStream, Deepgram emits any trailing final results before it
// closes the socket. Wait up to this long for the "closed" event so the
// last words aren't dropped. Slightly longer than the main process's own
// 3s flush window, so the socket always wins or loses before we stop
// listening. In the normal case Deepgram closes within ~0.5s and this
// timeout never bites.
const CLOSE_FLUSH_TIMEOUT_MS = 4000;

export class DeepgramProvider implements Transcriber {
  // "auto" = let the server default; anything else is passed as Deepgram's
  // `language` query param (e.g. "nl").
  private readonly language: string;
  private sessionId: number | null = null;

  constructor(opts: { language?: string } = {}) {
    this.language = opts.language ?? "auto";
  }
  private unsub: (() => void) | null = null;
  private handlers: TranscriptionHandlers | null = null;
  private onClosed: (() => void) | null = null;
  // Set once the socket errors or closes — stop feeding a dead session.
  private dead = false;
  // Deepgram streams finalized SEGMENTS plus a rolling interim; the consumer
  // wants the full running transcript, so accumulate finals and append the
  // current interim.
  private finalized = "";

  async prepare(): Promise<void> {
    // Streaming provider: the socket opens per-utterance in begin() (it needs
    // the capture sample rate), so there's nothing to warm up ahead of time.
  }

  private join(a: string, b: string): string {
    const t = sanitizeTranscript(b);
    if (!t) return a;
    return a ? `${a} ${t}` : t;
  }

  async begin(handlers: TranscriptionHandlers, sampleRate: number): Promise<void> {
    this.handlers = handlers;
    this.finalized = "";
    this.dead = false;
    // Subscribe before starting so no early transcript is missed. Every event
    // yields the full text-so-far so the controller can type it live.
    this.unsub = window.reckAPI.transcription.onEvent((ev) => {
      if (ev.sessionId !== this.sessionId) return;
      if (ev.kind === "partial") {
        // Interim text is unstable — Deepgram rewrites it until the segment
        // finalizes. It goes to the ghost tail, never into the prompt.
        this.handlers?.onTail?.(ev.text);
      } else if (ev.kind === "final") {
        this.finalized = this.join(this.finalized, ev.text);
        this.handlers?.onPartial?.(this.finalized);
        this.handlers?.onTail?.("");
      } else if (ev.kind === "debug") {
        // Main-process lifecycle facts (open/close codes, frames sent) —
        // surfaced here because main's stdout is invisible in a packaged app.
        console.log("[deepgram]", ev.text);
      } else if (ev.kind === "error") {
        console.error("[deepgram] error event:", ev.text);
        this.dead = true;
        this.handlers?.onError?.(ev.text);
      } else if (ev.kind === "closed") {
        console.log("[deepgram] closed event; transcript so far:", JSON.stringify(this.finalized));
        this.dead = true;
        this.handlers?.onFinal?.(this.finalized);
        this.onClosed?.();
      }
    });
    const res = await window.reckAPI.transcription.deepgramStart(
      sampleRate || 16000,
      this.language,
    );
    console.log("[deepgram] start →", res, "@", sampleRate, "Hz");
    if (!res.ok || res.sessionId === undefined) {
      this.unsub?.();
      this.unsub = null;
      throw new Error(res.error ?? "Failed to start Deepgram session");
    }
    this.sessionId = res.sessionId;
  }

  feed(chunk: Float32Array): void {
    if (this.dead || this.sessionId === null || chunk.length === 0) return;
    const pcm = floatToInt16(chunk);
    window.reckAPI.transcription.deepgramFrame(this.sessionId, new Uint8Array(pcm.buffer));
  }

  async end(): Promise<void> {
    const id = this.sessionId;
    if (id === null) {
      this.teardown();
      return;
    }
    // Keep listening until the socket closes (trailing finals) or we time out.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      this.onClosed = finish;
      void window.reckAPI.transcription.deepgramStop(id);
      setTimeout(finish, CLOSE_FLUSH_TIMEOUT_MS);
    });
    this.teardown();
  }

  cancel(): void {
    if (this.sessionId !== null) void window.reckAPI.transcription.deepgramStop(this.sessionId);
    this.teardown();
  }

  dispose(): void {
    this.cancel();
  }

  private teardown(): void {
    this.unsub?.();
    this.unsub = null;
    this.onClosed = null;
    this.sessionId = null;
    this.handlers = null;
  }
}
