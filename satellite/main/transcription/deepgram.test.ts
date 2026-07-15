// Unit spec for DeepgramSession (main process). The @deepgram/sdk value is
// mocked so no real websocket / network is touched: DeepgramClient.listen.v1
// .connect() resolves to a controllable FakeV1Socket whose open/close/message
// /error lifecycle the test drives by hand. Fake timers run for every test so
// the KeepAlive interval and the close-flush fallback are deterministic and
// never leak past a test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DeepgramSessionHandlers } from "./deepgram";

// A fake of the SDK's V1 websocket. `on()` records handlers; `emit()` fires
// them. `waitForOpen()` returns a promise the test resolves/rejects. All the
// send*/close methods are spies so ordering and payloads can be asserted.
class FakeV1Socket {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  sendMedia = vi.fn();
  sendCloseStream = vi.fn();
  sendKeepAlive = vi.fn();
  close = vi.fn();
  // The SDK builds the socket startClosed — nothing dials until connect() is
  // called. The session MUST call this (its omission was the original
  // silent-Deepgram bug), so it's a spy the connect-args test asserts on.
  connect = vi.fn();
  private openResolve!: () => void;
  private openReject!: (err: unknown) => void;
  private openPromise: Promise<void>;

  constructor() {
    this.openPromise = new Promise<void>((res, rej) => {
      this.openResolve = res;
      this.openReject = rej;
    });
    // Never surface as an unhandled rejection if a test rejects it.
    this.openPromise.catch(() => undefined);
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const arr = this.handlers.get(event) ?? [];
    arr.push(cb);
    this.handlers.set(event, arr);
  }

  waitForOpen(): Promise<void> {
    return this.openPromise;
  }

  // --- test drivers ---
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  /** Fire the "open" lifecycle event (does NOT resolve waitForOpen). */
  fireOpenEvent(): void {
    this.emit("open");
  }
  /** Resolve waitForOpen() (does NOT fire the "open" event). */
  resolveWaitForOpen(): void {
    this.openResolve();
  }
  rejectWaitForOpen(err: unknown): void {
    this.openReject(err);
  }
}

const dg = vi.hoisted(() => ({
  sockets: [] as FakeV1Socket[],
  connectArgs: [] as unknown[],
  apiKeys: [] as unknown[],
}));

vi.mock("@deepgram/sdk", () => {
  class DeepgramClient {
    listen = {
      v1: {
        connect: async (args: unknown): Promise<FakeV1Socket> => {
          dg.connectArgs.push(args);
          const s = new FakeV1Socket();
          dg.sockets.push(s);
          return s;
        },
      },
    };
    constructor(opts: { apiKey: string }) {
      dg.apiKeys.push(opts.apiKey);
    }
  }
  return { DeepgramClient };
});

// Import after the mock is registered.
const { DeepgramSession } = await import("./deepgram");

type SpyHandlers = { [K in keyof DeepgramSessionHandlers]: ReturnType<typeof vi.fn> };

function makeHandlers(): DeepgramSessionHandlers & SpyHandlers {
  return {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
    onDebug: vi.fn(),
  };
}

function frame(first: number, len = 4): Uint8Array {
  const a = new Uint8Array(len);
  a[0] = first;
  return a;
}

function firstByte(buf: unknown): number {
  return new Uint8Array(buf as ArrayBuffer)[0];
}

/** Let queued microtasks (import/connect/waitForOpen chains) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  dg.sockets.length = 0;
  dg.connectArgs.length = 0;
  dg.apiKeys.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DeepgramSession.open — connect args", () => {
  it("connects with nova-2 / linear16 / the given rate / interim + reconnectAttempts 0", async () => {
    const session = new DeepgramSession();
    await session.open("secret-key", 24000, undefined, makeHandlers());

    expect(dg.connectArgs).toHaveLength(1);
    const args = dg.connectArgs[0] as Record<string, unknown>;
    expect(args.model).toBe("nova-2");
    expect(args.encoding).toBe("linear16");
    expect(args.sample_rate).toBe(24000);
    expect(args.interim_results).toBe("true");
    expect(args.reconnectAttempts).toBe(0);
    expect(dg.apiKeys[0]).toBe("secret-key");
    // No language arg unless one was chosen.
    expect(args.language).toBeUndefined();
    // startClosed socket: without this call nothing ever dials.
    expect(dg.sockets[0].connect).toHaveBeenCalledTimes(1);
  });

  it("passes a chosen language through to the connect args", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, "nl", makeHandlers());
    const args = dg.connectArgs[0] as Record<string, unknown>;
    expect(args.language).toBe("nl");
  });
});

describe("DeepgramSession — pre-open queueing / flushing", () => {
  it("queues frames sent before open and flushes them in order on the 'open' event", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];

    session.sendAudio(frame(1));
    session.sendAudio(frame(2));
    session.sendAudio(frame(3));
    expect(socket.sendMedia).not.toHaveBeenCalled();

    socket.fireOpenEvent();

    expect(socket.sendMedia).toHaveBeenCalledTimes(3);
    expect(firstByte(socket.sendMedia.mock.calls[0][0])).toBe(1);
    expect(firstByte(socket.sendMedia.mock.calls[1][0])).toBe(2);
    expect(firstByte(socket.sendMedia.mock.calls[2][0])).toBe(3);

    // Frames after ready go straight through.
    session.sendAudio(frame(9));
    expect(socket.sendMedia).toHaveBeenCalledTimes(4);
    expect(firstByte(socket.sendMedia.mock.calls[3][0])).toBe(9);
  });

  it("flushes the queue when waitForOpen() resolves (no 'open' event needed)", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];

    session.sendAudio(frame(7));
    expect(socket.sendMedia).not.toHaveBeenCalled();

    socket.resolveWaitForOpen();
    await flush();

    expect(socket.sendMedia).toHaveBeenCalledTimes(1);
    expect(firstByte(socket.sendMedia.mock.calls[0][0])).toBe(7);
  });

  it("caps the pre-open queue at 250 frames", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];

    for (let i = 0; i < 300; i++) session.sendAudio(frame(i % 250));
    socket.fireOpenEvent();

    expect(socket.sendMedia).toHaveBeenCalledTimes(250);
  });
});

describe("DeepgramSession — KeepAlive", () => {
  it("sends KeepAlive periodically once ready and never after close()", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];
    socket.fireOpenEvent(); // ready

    vi.advanceTimersByTime(4000);
    expect(socket.sendKeepAlive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(socket.sendKeepAlive).toHaveBeenCalledTimes(2);

    session.close();
    const afterClose = socket.sendKeepAlive.mock.calls.length;
    vi.advanceTimersByTime(20000);
    expect(socket.sendKeepAlive.mock.calls.length).toBe(afterClose);
  });

  it("does not send KeepAlive before the socket is ready", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];

    vi.advanceTimersByTime(12000);
    expect(socket.sendKeepAlive).not.toHaveBeenCalled();
  });
});

describe("DeepgramSession.close", () => {
  it("sends CloseStream synchronously and turns later sendAudio() into a no-op", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];
    socket.fireOpenEvent();

    session.close();

    expect(socket.sendCloseStream).toHaveBeenCalledWith({ type: "CloseStream" });
    // It deliberately does NOT hard-close synchronously — Deepgram flushes any
    // trailing finals AFTER CloseStream, and socket.close() would detach the
    // message listeners. The socket is force-closed only via the fallback timer.
    expect(socket.close).not.toHaveBeenCalled();

    const before = socket.sendMedia.mock.calls.length;
    session.sendAudio(frame(5));
    expect(socket.sendMedia.mock.calls.length).toBe(before);
  });

  it("force-closes the socket after the flush timeout when the server never closes", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];
    socket.fireOpenEvent();

    session.close();
    expect(socket.close).not.toHaveBeenCalled();

    // CLOSE_FLUSH_TIMEOUT_MS is 3000ms in the source.
    vi.advanceTimersByTime(3000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    // Ordering: CloseStream was sent before the socket was closed.
    expect(socket.sendCloseStream.mock.invocationCallOrder[0]).toBeLessThan(
      socket.close.mock.invocationCallOrder[0],
    );
  });

  it("does not force-close when the server already closed the socket", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];
    socket.fireOpenEvent();

    session.close();
    socket.emit("close", { code: 1000 }); // server closes first
    vi.advanceTimersByTime(3000);

    expect(socket.close).not.toHaveBeenCalled();
  });

  it("is idempotent — a second close() does nothing", async () => {
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, makeHandlers());
    const socket = dg.sockets[0];
    socket.fireOpenEvent();

    session.close();
    socket.sendCloseStream.mockClear();
    session.close();
    expect(socket.sendCloseStream).not.toHaveBeenCalled();
  });
});

describe("DeepgramSession — close events", () => {
  it("an UNREQUESTED close with no results reports onError (with code + frames) and onClosed", async () => {
    const handlers = makeHandlers();
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, handlers);
    const socket = dg.sockets[0];

    socket.emit("close", { code: 1011, reason: "server error" });

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    const msg = handlers.onError.mock.calls[0][0] as string;
    expect(msg).toMatch(/1011/);
    expect(msg).toMatch(/frames/);
    expect(handlers.onClosed).toHaveBeenCalledTimes(1);
  });

  it("a REQUESTED close reports onClosed but NOT onError", async () => {
    const handlers = makeHandlers();
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, handlers);
    const socket = dg.sockets[0];
    socket.fireOpenEvent();

    session.close();
    socket.emit("close", { code: 1000 });

    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onClosed).toHaveBeenCalledTimes(1);
  });

  it("emits open/close lifecycle strings to onDebug", async () => {
    const handlers = makeHandlers();
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, handlers);
    const socket = dg.sockets[0];

    socket.fireOpenEvent();
    socket.emit("close", { code: 1000 });

    const debugMsgs = handlers.onDebug.mock.calls.map((c) => c[0] as string);
    expect(debugMsgs.some((m) => /open/i.test(m))).toBe(true);
    expect(debugMsgs.some((m) => /closed/i.test(m))).toBe(true);
  });
});

describe("DeepgramSession — message events", () => {
  it("interim Results → onPartial, final Results → onFinal, empty transcript → neither", async () => {
    const handlers = makeHandlers();
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, handlers);
    const socket = dg.sockets[0];

    socket.emit("message", {
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "hi" }] },
    });
    expect(handlers.onPartial).toHaveBeenCalledWith("hi");
    expect(handlers.onFinal).not.toHaveBeenCalled();

    socket.emit("message", {
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "hello there" }] },
    });
    expect(handlers.onFinal).toHaveBeenCalledWith("hello there");

    handlers.onPartial.mockClear();
    handlers.onFinal.mockClear();
    socket.emit("message", {
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "" }] },
    });
    expect(handlers.onPartial).not.toHaveBeenCalled();
    expect(handlers.onFinal).not.toHaveBeenCalled();
  });

  it("ignores non-Results messages", async () => {
    const handlers = makeHandlers();
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, handlers);
    const socket = dg.sockets[0];

    socket.emit("message", { type: "Metadata" });
    expect(handlers.onPartial).not.toHaveBeenCalled();
    expect(handlers.onFinal).not.toHaveBeenCalled();
  });
});

describe("DeepgramSession — socket error", () => {
  it("forwards a socket 'error' event to onError", async () => {
    const handlers = makeHandlers();
    const session = new DeepgramSession();
    await session.open("k", 16000, undefined, handlers);
    const socket = dg.sockets[0];

    socket.emit("error", new Error("boom"));
    expect(handlers.onError).toHaveBeenCalledWith("boom");
  });
});
