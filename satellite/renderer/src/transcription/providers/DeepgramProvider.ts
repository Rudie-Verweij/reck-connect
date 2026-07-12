// Cloud (Deepgram) provider — a thin renderer shim over the main-process
// router (which holds the API key and the websocket). Streaming: live
// Float32 chunks are converted to linear16 and forwarded; interim/final
// transcripts arrive via the "transcription:event" IPC channel.

import { floatToInt16 } from "../pcm";
import type { Transcriber, TranscriptionHandlers } from "./types";

// After CloseStream, Deepgram emits any trailing final results before it
// closes the socket. Wait up to this long for the "closed" event so the
// last words aren't dropped.
const CLOSE_FLUSH_TIMEOUT_MS = 1500;

export class DeepgramProvider implements Transcriber {
  private sessionId: number | null = null;
  private unsub: (() => void) | null = null;
  private handlers: TranscriptionHandlers | null = null;
  private onClosed: (() => void) | null = null;

  async begin(handlers: TranscriptionHandlers, sampleRate: number): Promise<void> {
    this.handlers = handlers;
    // Subscribe before starting so no early transcript is missed.
    this.unsub = window.reckAPI.transcription.onEvent((ev) => {
      if (ev.sessionId !== this.sessionId) return;
      if (ev.kind === "partial") this.handlers?.onPartial?.(ev.text);
      else if (ev.kind === "final") this.handlers?.onFinal?.(ev.text);
      else if (ev.kind === "error") this.handlers?.onError?.(ev.text);
      else if (ev.kind === "closed") this.onClosed?.();
    });
    const res = await window.reckAPI.transcription.deepgramStart(sampleRate || 16000);
    if (!res.ok || res.sessionId === undefined) {
      this.unsub?.();
      this.unsub = null;
      throw new Error(res.error ?? "Failed to start Deepgram session");
    }
    this.sessionId = res.sessionId;
  }

  feed(chunk: Float32Array): void {
    if (this.sessionId === null || chunk.length === 0) return;
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
