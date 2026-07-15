// @vitest-environment jsdom
// Unit spec for the renderer-side DeepgramProvider — a thin shim over the
// main-process router reached through window.reckAPI.transcription. That IPC
// surface is stubbed: deepgramStart/Frame/Stop are spies and onEvent captures
// the event callback so the test can push router events by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepgramProvider } from "./DeepgramProvider";
import type { TranscriptionHandlers } from "./types";

interface DGEvent {
  sessionId: number;
  kind: "partial" | "final" | "error" | "closed" | "debug";
  text: string;
}

interface MockTranscription {
  deepgramStart: ReturnType<typeof vi.fn>;
  deepgramFrame: ReturnType<typeof vi.fn>;
  deepgramStop: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
}

interface Harness {
  api: MockTranscription;
  unsub: ReturnType<typeof vi.fn>;
  callOrder: string[];
  emit: (ev: DGEvent) => void;
}

function installMockReckAPI(
  startResult: { ok: boolean; sessionId?: number; error?: string } = {
    ok: true,
    sessionId: 1,
  },
): Harness {
  const callOrder: string[] = [];
  const unsub = vi.fn();
  let cb: ((ev: DGEvent) => void) | null = null;

  const api: MockTranscription = {
    deepgramStart: vi.fn(),
    deepgramFrame: vi.fn(),
    deepgramStop: vi.fn(),
    onEvent: vi.fn(),
  };
  api.deepgramStart.mockImplementation(async () => {
    callOrder.push("start");
    return startResult;
  });
  api.deepgramFrame.mockImplementation(() => {
    callOrder.push("frame");
  });
  api.deepgramStop.mockImplementation(async () => {
    callOrder.push("stop");
    return true;
  });
  api.onEvent.mockImplementation((fn: (ev: DGEvent) => void) => {
    callOrder.push("onEvent");
    cb = fn;
    return unsub;
  });

  (window as unknown as { reckAPI: { transcription: MockTranscription } }).reckAPI = {
    transcription: api,
  };

  return {
    api,
    unsub,
    callOrder,
    emit: (ev: DGEvent) => cb?.(ev),
  };
}

function makeHandlers(): TranscriptionHandlers & {
  onPartial: ReturnType<typeof vi.fn>;
  onTail: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  return {
    onPartial: vi.fn(),
    onTail: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
  };
}

afterEach(() => {
  delete (window as unknown as { reckAPI?: unknown }).reckAPI;
  vi.restoreAllMocks();
});

describe("DeepgramProvider.begin", () => {
  it("subscribes to events BEFORE starting the session", async () => {
    const h = installMockReckAPI();
    const provider = new DeepgramProvider();

    await provider.begin(makeHandlers(), 16000);

    expect(h.callOrder[0]).toBe("onEvent");
    expect(h.callOrder[1]).toBe("start");
  });

  it("rejects and unsubscribes when the session fails to start", async () => {
    const h = installMockReckAPI({ ok: false, error: "no key" });
    const provider = new DeepgramProvider();

    await expect(provider.begin(makeHandlers(), 16000)).rejects.toThrow("no key");
    expect(h.unsub).toHaveBeenCalledTimes(1);
  });
});

describe("DeepgramProvider — running transcript", () => {
  it("routes interim text to the ghost tail, finals to the stable text", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);

    // Interim = unstable → tail only, never the stable/injected channel.
    h.emit({ sessionId: 1, kind: "partial", text: "worl" });
    expect(handlers.onTail).toHaveBeenLastCalledWith("worl");
    expect(handlers.onPartial).not.toHaveBeenCalled();

    // Finalized segment → stable text; tail clears.
    h.emit({ sessionId: 1, kind: "final", text: "hello" });
    expect(handlers.onPartial).toHaveBeenLastCalledWith("hello");
    expect(handlers.onTail).toHaveBeenLastCalledWith("");
  });

  it("accumulates successive finals", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);

    h.emit({ sessionId: 1, kind: "final", text: "hello" });
    h.emit({ sessionId: 1, kind: "final", text: "world" });

    expect(handlers.onPartial).toHaveBeenLastCalledWith("hello world");
  });

  it("ignores events for a different sessionId", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);

    h.emit({ sessionId: 999, kind: "partial", text: "ghost" });

    expect(handlers.onPartial).not.toHaveBeenCalled();
  });

  it("logs debug events and changes no transcript state", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);
    handlers.onPartial.mockClear();

    h.emit({ sessionId: 1, kind: "debug", text: "connection open" });

    expect(spy).toHaveBeenCalledWith("[deepgram]", "connection open");
    expect(handlers.onPartial).not.toHaveBeenCalled();
    expect(handlers.onFinal).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});

describe("DeepgramProvider — error handling", () => {
  it("reports an error event and stops forwarding frames", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);

    h.emit({ sessionId: 1, kind: "error", text: "socket died" });
    expect(handlers.onError).toHaveBeenCalledWith("socket died");

    h.api.deepgramFrame.mockClear();
    provider.feed(new Float32Array([0.5, -0.5]));
    expect(h.api.deepgramFrame).not.toHaveBeenCalled();
  });
});

describe("DeepgramProvider.feed", () => {
  it("converts Float32 to little-endian Int16 bytes and passes the session id", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 42 });
    const provider = new DeepgramProvider();
    await provider.begin(makeHandlers(), 16000);

    provider.feed(new Float32Array([1.0]));

    expect(h.api.deepgramFrame).toHaveBeenCalledTimes(1);
    const [sessionId, bytes] = h.api.deepgramFrame.mock.calls[0] as [number, Uint8Array];
    expect(sessionId).toBe(42);
    // +1.0 → Int16 32767 → 0x7FFF → little-endian [0xFF, 0x7F].
    expect(Array.from(bytes)).toEqual([0xff, 0x7f]);
  });

  it("does not forward empty chunks", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const provider = new DeepgramProvider();
    await provider.begin(makeHandlers(), 16000);

    provider.feed(new Float32Array(0));
    expect(h.api.deepgramFrame).not.toHaveBeenCalled();
  });
});

describe("DeepgramProvider.end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves on the 'closed' event and emits onFinal with the accumulated text", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);
    h.emit({ sessionId: 1, kind: "final", text: "hello world" });

    const p = provider.end();
    h.emit({ sessionId: 1, kind: "closed", text: "" });
    await p;

    expect(handlers.onFinal).toHaveBeenCalledWith("hello world");
  });

  it("resolves after the flush timeout when no close event arrives", async () => {
    const h = installMockReckAPI({ ok: true, sessionId: 1 });
    const provider = new DeepgramProvider();
    const handlers = makeHandlers();
    await provider.begin(handlers, 16000);

    let resolved = false;
    const p = provider.end().then(() => {
      resolved = true;
    });

    // CLOSE_FLUSH_TIMEOUT_MS is 4000ms in the source.
    await vi.advanceTimersByTimeAsync(3900);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(resolved).toBe(true);
    expect(handlers.onFinal).not.toHaveBeenCalled();
  });
});
