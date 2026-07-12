// @vitest-environment jsdom
// Unit spec for the embedded-Whisper provider. The Web Worker is stubbed with
// a FakeWorker that captures postMessage and lets the test push worker
// messages back through onmessage/onerror. Timers are faked for the whole file
// so the 1.2s partial cadence and the 12s sliding window are deterministic and
// the partial interval never leaks a real timer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalWhisperProvider } from "./LocalWhisperProvider";
import type { TranscriptionHandlers } from "./types";

interface WorkerMsg {
  type: string;
  kind?: string;
  [key: string]: unknown;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(
    public url: unknown,
    public opts: unknown,
  ) {
    FakeWorker.instances.push(this);
  }
  emit(data: WorkerMsg): void {
    this.onmessage?.({ data });
  }
  emitError(message: string): void {
    this.onerror?.({ message });
  }
}

function makeHandlers(): TranscriptionHandlers & {
  onPartial: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  return {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
  };
}

function transcribeCalls(w: FakeWorker): unknown[] {
  return w.postMessage.mock.calls.filter((c) => (c[0] as WorkerMsg)?.type === "transcribe");
}

/** prepare() → ready → begin(), returning the provider, worker and handlers. */
async function ready(
  repo = "Xenova/whisper-base",
): Promise<{ provider: LocalWhisperProvider; w: FakeWorker; handlers: ReturnType<typeof makeHandlers> }> {
  const provider = new LocalWhisperProvider(repo);
  const handlers = makeHandlers();
  const p = provider.prepare(handlers);
  const w = FakeWorker.instances[FakeWorker.instances.length - 1];
  w.emit({ type: "ready", generation: 1 });
  await p;
  await provider.begin();
  return { provider, w, handlers };
}

function silent(len = 2048): Float32Array {
  return new Float32Array(len).fill(0.005); // rms 0.005 < 0.01 threshold
}
function loud(len = 2048): Float32Array {
  return new Float32Array(len).fill(0.5); // rms 0.5 > 0.01 threshold
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances.length = 0;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("LocalWhisperProvider.prepare", () => {
  it("posts a prepare message and resolves on ready for the matching generation", async () => {
    const provider = new LocalWhisperProvider("repo");
    const p = provider.prepare(makeHandlers());
    const w = FakeWorker.instances[0];

    expect(w.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "prepare", generation: 1 }),
    );

    w.emit({ type: "ready", generation: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects when the worker reports an error during prepare", async () => {
    const provider = new LocalWhisperProvider("repo");
    const p = provider.prepare(makeHandlers());
    const w = FakeWorker.instances[0];

    w.emit({ type: "error", message: "model load failed", generation: 1 });
    await expect(p).rejects.toThrow("model load failed");
  });

  it("ignores stale-generation messages while preparing", async () => {
    const provider = new LocalWhisperProvider("repo");
    const p = provider.prepare(makeHandlers());
    const w = FakeWorker.instances[0];

    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    w.emit({ type: "ready", generation: 99 }); // stale — different utterance
    await Promise.resolve();
    expect(settled).toBe(false);

    w.emit({ type: "ready", generation: 1 });
    await expect(p).resolves.toBeUndefined();
  });
});

describe("LocalWhisperProvider — voice gating", () => {
  it("does not run a partial pass while only silent audio is buffered", async () => {
    const { provider, w } = await ready();
    provider.feed(silent(), 16000);
    provider.feed(silent(), 16000);
    w.postMessage.mockClear();

    vi.advanceTimersByTime(1200 * 3);

    expect(transcribeCalls(w)).toHaveLength(0);
  });

  it("runs a partial pass once voiced audio has been heard", async () => {
    const { provider, w } = await ready();
    provider.feed(loud(), 16000);
    w.postMessage.mockClear();

    vi.advanceTimersByTime(1200);

    const calls = transcribeCalls(w);
    expect(calls).toHaveLength(1);
    expect((calls[0] as WorkerMsg[])[0].kind).toBe("partial");
  });
});

describe("LocalWhisperProvider — LocalAgreement stable prefix", () => {
  it("commits only words that agree across consecutive hypotheses and never rewrites them", async () => {
    const { w, handlers } = await ready();
    handlers.onPartial.mockClear();

    w.emit({ type: "result", kind: "partial", text: "let's refactor", generation: 1 });
    w.emit({ type: "result", kind: "partial", text: "let's refactor the auth", generation: 1 });
    expect(handlers.onPartial).toHaveBeenLastCalledWith("let's refactor");

    const callsBefore = handlers.onPartial.mock.calls.length;
    // A divergent hypothesis must not rewrite already-committed words.
    w.emit({ type: "result", kind: "partial", text: "let's rework the auth", generation: 1 });
    expect(handlers.onPartial.mock.calls.length).toBe(callsBefore);
    expect(handlers.onPartial).toHaveBeenLastCalledWith("let's refactor");
  });
});

describe("LocalWhisperProvider — sliding window", () => {
  it("freezes committed words when the partial window overflows and keeps the frozen prefix", async () => {
    const { provider, w, handlers } = await ready();

    // Commit "hello world" via two agreeing hypotheses.
    w.emit({ type: "result", kind: "partial", text: "hello world", generation: 1 });
    w.emit({ type: "result", kind: "partial", text: "hello world foo", generation: 1 });

    // Push the buffer past the 12s @ 16 kHz window (192000 samples).
    provider.feed(loud(2048), 16000);
    provider.feed(loud(200000), 16000);
    handlers.onPartial.mockClear();
    w.postMessage.mockClear();

    vi.advanceTimersByTime(1200); // runPartial → overflow → freeze, no transcribe
    expect(transcribeCalls(w)).toHaveLength(0);

    // Fresh hypotheses after the freeze still carry the frozen prefix.
    w.emit({ type: "result", kind: "partial", text: "the auth layer", generation: 1 });
    w.emit({ type: "result", kind: "partial", text: "the auth layer works", generation: 1 });

    const last = handlers.onPartial.mock.calls.at(-1)?.[0] as string;
    expect(last.startsWith("hello world")).toBe(true);
    expect(last).toBe("hello world the auth layer");
  });
});

describe("LocalWhisperProvider.end", () => {
  it("emits an empty final and posts no transcribe when the utterance was silent", async () => {
    const { provider, w, handlers } = await ready();
    provider.feed(silent(), 16000);
    w.postMessage.mockClear();

    await provider.end(silent(4096), 16000);

    expect(handlers.onFinal).toHaveBeenCalledWith("");
    expect(transcribeCalls(w)).toHaveLength(0);
  });

  it("posts a final pass for voiced audio and resolves on the result", async () => {
    const { provider, w, handlers } = await ready();
    provider.feed(loud(), 16000);
    w.postMessage.mockClear();

    const p = provider.end(loud(4096), 16000);
    const finalCall = transcribeCalls(w).find(
      (c) => (c as WorkerMsg[])[0].kind === "final",
    );
    expect(finalCall).toBeDefined();

    w.emit({ type: "result", kind: "final", text: "the answer", generation: 1 });
    await p;
    expect(handlers.onFinal).toHaveBeenCalledWith("the answer");
  });
});

describe("LocalWhisperProvider.cancel", () => {
  it("releases a pending end() and drops the in-flight result from the cancelled generation", async () => {
    const { provider, w, handlers } = await ready();
    provider.feed(loud(), 16000);

    let resolved = false;
    const p = provider.end(loud(4096), 16000).then(() => {
      resolved = true;
    });

    provider.cancel();
    await Promise.resolve();
    expect(resolved).toBe(true);

    handlers.onFinal.mockClear();
    // A late result tagged with the pre-cancel generation must be ignored.
    w.emit({ type: "result", kind: "final", text: "stale", generation: 1 });
    await p;
    expect(handlers.onFinal).not.toHaveBeenCalled();
  });
});
