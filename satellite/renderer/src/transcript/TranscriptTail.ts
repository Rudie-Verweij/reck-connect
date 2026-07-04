// Poll-loop that tails a Claude session transcript through
// `ApiClient.getTranscript`. Lifecycle mirrors daemon/connection.ts:
// a self-rescheduling timer, guarded start/stop, and results that
// arrive after stop() are dropped on the floor.
//
// Catch-up behaviour: the daemon caps each response (multi-MB
// transcripts arrive in slices flagged `hasMore`), so the loop drains
// back-to-back until a slice is final, then falls back to the poll
// interval for live tailing.

import type { TranscriptChunk } from "@client-core/api/client";

export interface TranscriptTailOptions {
  /** Fetch one slice starting at the given BYTE offset. */
  fetchChunk(offset: number): Promise<TranscriptChunk>;
  /** Called with each non-empty raw slice, in order. */
  onChunk(chunk: string): void;
  onError?(err: unknown): void;
  /** Poll interval once caught up. Default 1500ms. */
  intervalMs?: number;
}

export interface TranscriptTail {
  start(): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 1500;

export function createTranscriptTail(opts: TranscriptTailOptions): TranscriptTail {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function poll(): Promise<void> {
    while (running) {
      let more = false;
      try {
        const res = await opts.fetchChunk(offset);
        if (!running) return; // stopped mid-flight — drop the result
        offset = res.nextOffset;
        if (res.chunk !== "") opts.onChunk(res.chunk);
        more = res.hasMore;
      } catch (err) {
        if (!running) return;
        opts.onError?.(err);
      }
      if (!more) break; // caught up — wait for the interval
    }
    if (running) schedule(intervalMs);
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delayMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      // First poll runs immediately (no 0ms timer bounce) so a caller
      // that starts a tail inside an async chain doesn't need an extra
      // timer flush before the first fetch happens.
      void poll();
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
