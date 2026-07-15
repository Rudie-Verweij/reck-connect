// @vitest-environment jsdom
// Unit spec for the TranscriptionEngine state machine. AudioCapture is mocked
// with a controllable fake (start/stop resolution, sample rate, and a driver
// to emit captured chunks); the provider is a plain object of spies whose
// begin/prepare promises the test resolves by hand. `rms` stays real so the
// level-meter assertion checks the true value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionEngine } from "./TranscriptionEngine";
import type { Transcriber } from "./providers/types";
import { rms } from "./pcm";

interface FakeCapture {
  cb: { onChunk?: (chunk: Float32Array, rate: number) => void; onError?: (err: unknown) => void };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getSampleRate: () => number;
  emitChunk: (chunk: Float32Array, rate: number) => void;
  emitError: (err: unknown) => void;
}

const cap = vi.hoisted(() => ({
  instances: [] as FakeCapture[],
  sampleRate: 16000,
  stopResult: { samples: new Float32Array(0), sampleRate: 16000 } as {
    samples: Float32Array;
    sampleRate: number;
  },
}));

vi.mock("./AudioCapture", () => {
  class AudioCapture {
    cb: FakeCapture["cb"];
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => cap.stopResult);
    getSampleRate = (): number => cap.sampleRate;
    constructor(cb: FakeCapture["cb"]) {
      this.cb = cb;
      cap.instances.push(this as unknown as FakeCapture);
    }
    emitChunk(chunk: Float32Array, rate: number): void {
      this.cb.onChunk?.(chunk, rate);
    }
    emitError(err: unknown): void {
      this.cb.onError?.(err);
    }
  }
  return { AudioCapture };
});

function makeProvider(overrides: Partial<Record<keyof Transcriber, unknown>> = {}): {
  prepare: ReturnType<typeof vi.fn>;
  begin: ReturnType<typeof vi.fn>;
  feed: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn(async () => undefined),
    begin: vi.fn(async () => undefined),
    feed: vi.fn(),
    end: vi.fn(async () => undefined),
    cancel: vi.fn(),
    dispose: vi.fn(),
    ...(overrides as object),
  } as never;
}

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  cap.instances.length = 0;
  cap.sampleRate = 16000;
  cap.stopResult = { samples: new Float32Array(0), sampleRate: 16000 };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TranscriptionEngine.start", () => {
  it("is a no-op while not idle (no second prepare)", async () => {
    const provider = makeProvider({ prepare: vi.fn(() => new Promise<void>(() => undefined)) });
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, {});

    void engine.start();
    void engine.start();
    await flush();

    expect(provider.prepare).toHaveBeenCalledTimes(1);
  });

  it("reports onError, returns to idle, and never opens the mic when prepare fails", async () => {
    const provider = makeProvider({
      prepare: vi.fn(async () => {
        throw new Error("no model");
      }),
    });
    const onError = vi.fn();
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, { onError });

    await engine.start();

    expect(onError).toHaveBeenCalledWith("no model");
    expect(engine.getState()).toBe("idle");
    expect(cap.instances).toHaveLength(0);
  });

  it("replays chunks captured before begin() resolves, in order, then feeds live", async () => {
    let resolveBegin!: () => void;
    const provider = makeProvider({
      begin: vi.fn(() => new Promise<void>((r) => (resolveBegin = r))),
    });
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, {});

    const startP = engine.start();
    await flush(); // settle prepare + capture.start(), suspend at begin()
    const capture = cap.instances[0];
    expect(capture).toBeDefined();

    const c1 = new Float32Array([0.1]);
    const c2 = new Float32Array([0.2]);
    const c3 = new Float32Array([0.3]);
    capture.emitChunk(c1, 16000);
    capture.emitChunk(c2, 16000);
    expect(provider.feed).not.toHaveBeenCalled();

    resolveBegin();
    await startP;

    capture.emitChunk(c3, 16000);
    expect(provider.feed.mock.calls.map((c) => c[0])).toEqual([c1, c2, c3]);
    expect(engine.getState()).toBe("listening");
  });

  it("reports the rms level of each captured chunk", async () => {
    const provider = makeProvider();
    const onLevel = vi.fn();
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, { onLevel });

    await engine.start();
    const chunk = new Float32Array([0.5, -0.5]);
    cap.instances[0].emitChunk(chunk, 16000);

    expect(onLevel).toHaveBeenLastCalledWith(rms(chunk));
  });
});

describe("TranscriptionEngine.stop", () => {
  it("routes the captured audio to end() and transitions listening→transcribing→idle", async () => {
    cap.stopResult = { samples: new Float32Array([0.1, 0.2]), sampleRate: 16000 };
    const provider = makeProvider();
    const states: string[] = [];
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, {
      onStateChange: (s) => states.push(s),
    });

    await engine.start();
    await engine.stop();

    expect(provider.end).toHaveBeenCalledWith(cap.stopResult.samples, 16000);
    expect(states).toEqual(["preparing", "listening", "transcribing", "idle"]);
  });

  it("is a no-op when not listening", async () => {
    const provider = makeProvider();
    const states: string[] = [];
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, {
      onStateChange: (s) => states.push(s),
    });

    await engine.stop();

    expect(provider.end).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(engine.getState()).toBe("idle");
  });
});

describe("TranscriptionEngine.cancel", () => {
  it("during preparing, keeps the mic closed after prepare resolves", async () => {
    let resolvePrepare!: () => void;
    const provider = makeProvider({
      prepare: vi.fn(() => new Promise<void>((r) => (resolvePrepare = r))),
    });
    const engine = new TranscriptionEngine(provider as unknown as Transcriber, {});

    const startP = engine.start();
    await flush();
    await engine.cancel(); // resets state to idle mid-preparation

    resolvePrepare();
    await startP;

    expect(cap.instances).toHaveLength(0);
    expect(engine.getState()).toBe("idle");
    expect(provider.cancel).toHaveBeenCalled();
  });
});
