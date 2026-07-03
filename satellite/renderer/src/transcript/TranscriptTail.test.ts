import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTranscriptTail } from "./TranscriptTail";
import type { TranscriptChunk } from "@client-core/api/client";

// Poll-loop lifecycle mirrors daemon/connection.ts: self-rescheduling
// timer, guarded start/stop, results after stop are dropped.

describe("TranscriptTail", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function chunk(c: string, next: number, more = false): TranscriptChunk {
    return { chunk: c, nextOffset: next, hasMore: more };
  }

  it("fetches immediately on start, forwards chunks, advances offset, re-polls on interval", async () => {
    const fetchChunk = vi
      .fn<[number], Promise<TranscriptChunk>>()
      .mockResolvedValueOnce(chunk("a", 5))
      .mockResolvedValueOnce(chunk("", 5))
      .mockResolvedValue(chunk("b", 9));
    const onChunk = vi.fn();
    const tail = createTranscriptTail({ fetchChunk, onChunk, intervalMs: 1000 });

    tail.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChunk).toHaveBeenNthCalledWith(1, 0);
    expect(onChunk).toHaveBeenCalledWith("a");

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchChunk).toHaveBeenNthCalledWith(2, 5);
    // Empty chunk → no onChunk call.
    expect(onChunk).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchChunk).toHaveBeenNthCalledWith(3, 5);
    expect(onChunk).toHaveBeenLastCalledWith("b");
    tail.stop();
  });

  it("drains hasMore chunks back-to-back without waiting the interval", async () => {
    const fetchChunk = vi
      .fn<[number], Promise<TranscriptChunk>>()
      .mockResolvedValueOnce(chunk("part1", 100, true))
      .mockResolvedValueOnce(chunk("part2", 200, true))
      .mockResolvedValue(chunk("tail", 250));
    const onChunk = vi.fn();
    const tail = createTranscriptTail({ fetchChunk, onChunk, intervalMs: 60_000 });

    tail.start();
    await vi.advanceTimersByTimeAsync(0);
    // All three slices arrive despite the long interval: catch-up drains.
    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(fetchChunk).toHaveBeenNthCalledWith(2, 100);
    expect(fetchChunk).toHaveBeenNthCalledWith(3, 200);
    expect(onChunk.mock.calls.map((c) => c[0])).toEqual(["part1", "part2", "tail"]);
    tail.stop();
  });

  it("stop() prevents further polls and drops late results", async () => {
    let release!: (v: TranscriptChunk) => void;
    const gate = new Promise<TranscriptChunk>((res) => {
      release = res;
    });
    const fetchChunk = vi.fn(() => gate);
    const onChunk = vi.fn();
    const tail = createTranscriptTail({ fetchChunk, onChunk, intervalMs: 1000 });

    tail.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChunk).toHaveBeenCalledTimes(1);

    tail.stop();
    release(chunk("late", 4));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChunk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchChunk).toHaveBeenCalledTimes(1);
  });

  it("reports fetch errors and keeps polling", async () => {
    const fetchChunk = vi
      .fn<[number], Promise<TranscriptChunk>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(chunk("recovered", 3));
    const onChunk = vi.fn();
    const onError = vi.fn();
    const tail = createTranscriptTail({ fetchChunk, onChunk, onError, intervalMs: 1000 });

    tail.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChunk).toHaveBeenCalledWith("recovered");
    tail.stop();
  });

  it("start() is idempotent while running", async () => {
    const fetchChunk = vi
      .fn<[number], Promise<TranscriptChunk>>()
      .mockResolvedValue(chunk("", 0));
    const tail = createTranscriptTail({ fetchChunk, onChunk: vi.fn(), intervalMs: 1000 });
    tail.start();
    tail.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChunk).toHaveBeenCalledTimes(1);
    tail.stop();
  });
});
