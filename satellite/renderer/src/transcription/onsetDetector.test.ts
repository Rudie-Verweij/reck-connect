import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ONSET_CONFIG, OnsetDetector, type OnsetConfig } from "./onsetDetector";

const CFG: OnsetConfig = { ...DEFAULT_ONSET_CONFIG, minGapMs: 100, minWordMs: 60 };

function feed(det: OnsetDetector, seq: Array<[rms: number, dtMs: number]>): void {
  for (const [rms, dt] of seq) det.feed(rms, dt);
}

describe("OnsetDetector", () => {
  it("emits one onset per sustained word", () => {
    const onset = vi.fn();
    const det = new OnsetDetector(CFG, { onOnset: onset });
    // loud (word) → quiet gap → loud (word)
    feed(det, [
      [0.05, 50],
      [0.05, 50], // word 1 sustained → onset
      [0.0, 60],
      [0.0, 60], // gap > 100ms → end
      [0.05, 50],
      [0.05, 50], // word 2 → onset
    ]);
    expect(onset).toHaveBeenCalledTimes(2);
  });

  it("ignores blips shorter than minWordMs", () => {
    const onset = vi.fn();
    const det = new OnsetDetector(CFG, { onOnset: onset });
    // a single 40ms loud sample then silence — under the 60ms floor
    feed(det, [
      [0.05, 40],
      [0.0, 120],
    ]);
    expect(onset).not.toHaveBeenCalled();
  });

  it("does not split a word on a brief dip (< minGapMs)", () => {
    const onset = vi.fn();
    const end = vi.fn();
    const det = new OnsetDetector(CFG, { onOnset: onset, onEnd: end });
    feed(det, [
      [0.05, 50],
      [0.05, 50], // onset
      [0.0, 50], // dip 50ms < 100ms gap — not an end
      [0.05, 50], // back to voice
      [0.0, 120], // now a real gap → end
    ]);
    expect(onset).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("uses hysteresis: mid-level between close and open does not re-trigger", () => {
    const onset = vi.fn();
    const det = new OnsetDetector(CFG, { onOnset: onset });
    // 0.015 is above closeThreshold (0.012) but below openThreshold (0.02):
    // once quiet, it must NOT start a new word.
    feed(det, [
      [0.015, 60],
      [0.015, 60],
    ]);
    expect(onset).not.toHaveBeenCalled();
  });

  it("reports the voiced duration on end", () => {
    const end = vi.fn();
    const det = new OnsetDetector(CFG, { onOnset: vi.fn(), onEnd: end });
    feed(det, [
      [0.05, 100],
      [0.05, 100], // 200ms voiced
      [0.0, 100], // gap ends it
    ]);
    expect(end).toHaveBeenCalledTimes(1);
    const [, dur] = end.mock.calls[0] as [number, number];
    expect(dur).toBeGreaterThanOrEqual(180);
  });
});
