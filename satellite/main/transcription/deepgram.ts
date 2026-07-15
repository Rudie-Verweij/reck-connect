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
  // Diagnostics forwarded to the renderer console — main-process logs are
  // invisible in a Finder-launched app, so lifecycle facts travel this way.
  onDebug: (message: string) => void;
}

type DeepgramSocket = Awaited<ReturnType<DeepgramClient["listen"]["v1"]["connect"]>>;

// Cap the pre-open audio buffer (~frames). At ~8 frames/s this is plenty of
// slack for the connection to open without growing unbounded.
const MAX_QUEUED_FRAMES = 250;

// Deepgram closes a stream that goes ~10s without audio (NET-0001). A
// periodic KeepAlive covers gaps (permission prompts, long pauses).
const KEEPALIVE_INTERVAL_MS = 4000;

// After CloseStream, wait this long for Deepgram to flush trailing finals
// and close from its side before force-closing the socket. Must exceed the
// renderer's own flush wait so the finals beat the provider teardown.
const CLOSE_FLUSH_TIMEOUT_MS = 3000;

export class DeepgramSession {
  private socket: DeepgramSocket | null = null;
  private ready = false;
  private closed = false;
  // We asked for the close (user stopped) — a close without this flag set is
  // Deepgram hanging up on us and must be surfaced, not swallowed.
  private closeRequested = false;
  private gotResult = false;
  private framesSent = 0;
  private bytesSent = 0;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  // Frames captured before the socket finished opening — flushed on "open"
  // so the first words aren't lost (and one early frame can't kill the run).
  private queue: ArrayBuffer[] = [];

  async open(
    apiKey: string,
    sampleRate: number,
    language: string | undefined,
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
      // Undefined = Deepgram's default (English); set from the dictation
      // language menu otherwise.
      ...(language ? { language } : {}),
      Authorization: `Token ${apiKey}`,
      // The SDK's ReconnectingWebSocket retries 30× by default; a rejected
      // key would silently loop connect/close. Fail once, loudly.
      reconnectAttempts: 0,
    });
    this.socket = socket;

    socket.on("open", () => {
      handlers.onDebug(`connection open @ ${sampleRate} Hz`);
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
      if (this.closed) return; // forced-close fallback after a real close
      const code = event?.code;
      const reason = event?.reason;
      this.stopKeepAlive();
      handlers.onDebug(
        `closed (code=${code ?? "?"}${reason ? `, reason=${reason}` : ""}) after ` +
          `${this.framesSent} frames / ${this.bytesSent} bytes sent; ` +
          `gotResult=${this.gotResult}, ready=${this.ready}, requested=${this.closeRequested}`,
      );
      this.closed = true;
      // Deepgram hung up before we asked and before any transcript arrived.
      // Surface it whatever the code — an undefined/1000 code here still
      // means the stream produced nothing and the user deserves to know why.
      if (!this.gotResult && !this.closeRequested) {
        handlers.onError(
          `Deepgram closed the connection (code ${code ?? "unknown"}${reason ? `: ${reason}` : ""}) ` +
            `after ${this.framesSent} audio frames. ` +
            (this.framesSent === 0
              ? "No audio reached Deepgram — the socket never became ready."
              : "This is usually an invalid API key or a plan without streaming access."),
        );
      }
      handlers.onClosed();
    });

    // The SDK builds the socket with startClosed:true — it does NOT dial
    // until connect() is called ("the returned socket is not connected until
    // you call socket.connect()"). Missing this call was the original
    // everything-is-silent bug: no open, no error, every frame queued.
    socket.connect();

    // waitForOpen() resolves whether the socket opens now or already did —
    // no race with the "open" event having fired before our handler attached.
    void socket
      .waitForOpen()
      .then(() => {
        this.markReady();
      })
      .catch((err: unknown) => {
        if (this.closed || this.closeRequested) return;
        const message = err instanceof Error ? err.message : String(err);
        handlers.onError(`Deepgram connection failed to open: ${message}`);
      });

    // Keep the stream alive across quiet gaps.
    this.keepAlive = setInterval(() => {
      if (!this.ready || this.closed) return;
      try {
        this.socket?.sendKeepAlive({ type: "KeepAlive" });
      } catch {
        // Socket closing; the close handler reports the real story.
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    const socket = this.socket;
    if (!socket) return;
    for (const buf of this.queue) {
      try {
        socket.sendMedia(buf);
        this.framesSent++;
        this.bytesSent += buf.byteLength;
      } catch {
        // Dropped a flushed frame; the stream keeps going.
      }
    }
    this.queue = [];
  }

  /** Feed a linear16 audio frame (little-endian Int16 bytes). */
  sendAudio(bytes: Uint8Array): void {
    if (this.closed || this.closeRequested) return;
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
      this.framesSent++;
      this.bytesSent += buf.byteLength;
    } catch {
      // Transient (closing/network); drop this frame, let the next retry.
    }
  }

  /**
   * Signal end-of-stream. Deepgram transcribes any buffered audio AFTER
   * CloseStream and sends the trailing finals before closing the socket from
   * its side — so do NOT hard-close here (the SDK's close() also detaches
   * the message listeners, which would drop exactly those finals). A
   * fallback timer force-closes if the server never does.
   */
  close(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.ready = false;
    this.queue = [];
    this.stopKeepAlive();
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      this.closed = true;
      return;
    }
    try {
      socket.sendCloseStream({ type: "CloseStream" });
    } catch {
      // Not open (never connected) — nothing to flush, close immediately.
      this.forceClose(socket);
      return;
    }
    setTimeout(() => {
      if (!this.closed) this.forceClose(socket);
    }, CLOSE_FLUSH_TIMEOUT_MS);
  }

  private forceClose(socket: DeepgramSocket): void {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}
