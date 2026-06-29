// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutoSave } from "./AutoSave";

/**
 * Drain the microtask queue. Each `.then`/`.catch`/`.finally` requires
 * one microtask checkpoint, so we await several `Promise.resolve()` to
 * flush a typical save() → catch → finally chain.
 */
async function drainMicrotasks(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe("createAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces save() to fire 400ms after the last markDirty()", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const auto = createAutoSave({ save });
    auto.markDirty("v1");
    vi.advanceTimersByTime(300);
    auto.markDirty("v2");
    vi.advanceTimersByTime(300);
    auto.markDirty("v3");
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    await drainMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("v3");
  });

  it("respects a custom debounce window", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const auto = createAutoSave({ save, debounceMs: 100 });
    auto.markDirty("x");
    vi.advanceTimersByTime(99);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    await drainMicrotasks();
    expect(save).toHaveBeenCalled();
  });

  it("queues the newest content when a save is in flight", async () => {
    let resolveSave: () => void = () => {};
    const save = vi.fn((_: string) => new Promise<void>((r) => { resolveSave = r; }));
    const auto = createAutoSave({ save });
    auto.markDirty("first");
    vi.advanceTimersByTime(400);
    await drainMicrotasks();
    expect(save).toHaveBeenCalledWith("first");

    // A new edit while the first save is still pending.
    auto.markDirty("second");
    auto.markDirty("third"); // overrides "second"

    // Complete the first save.
    resolveSave();
    await drainMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe("third");
  });

  it("transitions through idle → scheduled → saving → idle", async () => {
    const states: string[] = [];
    const save = vi.fn().mockResolvedValue(undefined);
    const auto = createAutoSave({
      save,
      onStateChange: (s) => states.push(s),
    });
    expect(auto.getState()).toBe("idle");
    auto.markDirty("x");
    expect(auto.getState()).toBe("scheduled");
    vi.advanceTimersByTime(400);
    expect(auto.getState()).toBe("saving");
    await drainMicrotasks();
    expect(auto.getState()).toBe("idle");
    expect(states).toEqual(["scheduled", "saving", "idle"]);
  });

  it("flush() pushes any pending save through immediately", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const auto = createAutoSave({ save });
    auto.markDirty("pending");
    // Don't advance timers — flush() should bypass the debounce.
    const flushPromise = auto.flush();
    // Allow the synchronous fire() to run and queue runSave.
    await Promise.resolve();
    await flushPromise;
    expect(save).toHaveBeenCalledWith("pending");
  });

  it("cancel() drops pending content without saving", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const auto = createAutoSave({ save });
    auto.markDirty("draft");
    auto.cancel();
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
    expect(auto.getState()).toBe("idle");
  });

  it("calls onError when save rejects", async () => {
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const auto = createAutoSave({ save, onError });
    auto.markDirty("x");
    vi.advanceTimersByTime(400);
    await drainMicrotasks();
    expect(onError).toHaveBeenCalled();
    expect(auto.getState()).toBe("idle");
  });

  // Round 4 Phase P — structured diagnostic logging so the user can
  // grep `[autosave]` in devtools to trace markDirty → fire → save
  // transitions while reproducing the phantom-banner or flicker bugs.
  describe("Phase P diagnostic logging", () => {
    it("emits [autosave] markDirty + state-transition logs", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const save = vi.fn().mockResolvedValue(undefined);
        const auto = createAutoSave({ save });
        auto.markDirty("v1");
        vi.advanceTimersByTime(400);
        await drainMicrotasks();
        const lines = logSpy.mock.calls
          .map((c) => (typeof c[0] === "string" ? c[0] : ""))
          .filter((s) => s.startsWith("[autosave]"));
        expect(lines.some((l) => l.includes("markDirty"))).toBe(true);
        expect(lines.some((l) => l.includes("transition") && l.includes("idle"))).toBe(true);
        expect(lines.some((l) => l.includes("transition") && l.includes("saving"))).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
