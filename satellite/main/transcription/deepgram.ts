// Deepgram live-streaming transcription session (main process). The API key
// lives here (read from encrypted config); the renderer streams linear16
// audio frames in and receives interim/final transcripts back — the key
// never reaches the renderer.
//
// Uses @deepgram/sdk v5's `listen.v1.connect()` websocket. Transcript
// results arrive as `{ type: "Results", is_final, channel.alternatives[0]
// .transcript }`.
//
// The SDK (and its `ws` dependency) is imported LAZILY inside open() — a
// type-only static import for the types, a dynamic import() for the value —
// so a missing/broken SDK never crashes app startup; it just makes the
// cloud engine fail gracefully (the router turns the throw into an error
// the renderer surfaces). The on-device engine is unaffected.

import type { DeepgramClient } from "@deepgram/sdk";

export interface DeepgramSessionHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}

type DeepgramSocket = Awaited<ReturnType<DeepgramClient["listen"]["v1"]["connect"]>>;

// Cap the pre-open audio buffer (~frames). At ~8 frames/s this is plenty of
// slack for the connection to open without growing unbounded.
const MAX_QUEUED_FRAMES = 250;

export class DeepgramSession {
  private socket: DeepgramSocket | null = null;
  private ready = false;
  private closed = false;
  private gotResult = false;
  // Frames captured before the socket finished opening — flushed on "open"
  // so the first words aren't lost (and one early frame can't kill the run).
  private queue: ArrayBuffer[] = [];

  async open(
    apiKey: string,
    sampleRate: number,
    handlers: DeepgramSessionHandlers,
  ): Promise<void> {
    const { DeepgramClient } = await import("@deepgram/sdk");
    const client = new DeepgramClient({ apiKey });
    const socket = await client.listen.v1.connect({
      model: "nova-2",
      encoding: "linear16",
      sample_rate: sampleRate,
      channels: 1,
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      Authorization: `Token ${apiKey}`,
    });
    this.socket = socket;

    socket.on("open", () => {
      console.log("[deepgram] connection open @", sampleRate, "Hz");
      this.markReady();
    });
    socket.on("message", (msg) => {
      if (msg.type !== "Results") return;
      const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (!text) return;
      this.gotResult = true;
      if (msg.is_final) handlers.onFinal(text);
      else handlers.onPartial(text);
    });
    socket.on("error", (err: Error) => {
      console.error("[deepgram] socket error:", err);
      handlers.onError(err?.message ?? String(err));
    });
    socket.on("close", (event: { code?: number; reason?: string }) => {
      const code = event?.code;
      const reason = event?.reason;
      console.log(
        `[deepgram] closed (code=${code ?? "?"}${reason ? `, reason=${reason}` : ""}, gotResult=${this.gotResult}, ready=${this.ready})`,
      );
      this.closed = true;
      // Closed abnormally before any transcript → almost always a bad/rejected
      // API key or a plan without streaming access. Surface it (silent
      // failure was the previous behaviour).
      if (!this.gotResult && code !== undefined && code !== 1000) {
        handlers.onError(
          `Deepgram closed the connection (code ${code}${reason ? `: ${reason}` : ""}). ` +
            `This is usually an invalid API key or a plan without streaming access.`,
        );
      }
      handlers.onClosed();
    });

    // If connect() already resolved after the socket opened, the "open" event
    // may have fired before our handler — detect that and flush.
    const rs = (socket as unknown as { socket?: { readyState?: number } })?.socket?.readyState;
    if (rs === 1) this.markReady();
  }

  private markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    const socket = this.socket;
    if (!socket) return;
    for (const buf of this.queue) {
      try {
        socket.sendMedia(buf);
      } catch {
        // Dropped a flushed frame; the stream keeps going.
      }
    }
    this.queue = [];
  }

  /** Feed a linear16 audio frame (little-endian Int16 bytes). */
  sendAudio(bytes: Uint8Array): void {
    if (this.closed) return;
    // Copy into a standalone ArrayBuffer so we never hand the socket a view
    // over a larger/pooled buffer.
    const buf = bytes.slice().buffer;
    if (!this.ready) {
      // Buffer until the socket opens rather than sending into a not-yet-open
      // socket (which throws). Do NOT kill the session on early frames.
      if (this.queue.length < MAX_QUEUED_FRAMES) this.queue.push(buf);
      return;
    }
    try {
      this.socket?.sendMedia(buf);
    } catch {
      // Transient (closing/network); drop this frame, let the next retry.
    }
  }

  /** Signal end-of-stream and close. Deepgram flushes any final results. */
  close(): void {
    this.closed = true;
    this.ready = false;
    this.queue = [];
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.sendCloseStream({ type: "CloseStream" });
    } catch {
      // Socket may already be closing.
    }
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
