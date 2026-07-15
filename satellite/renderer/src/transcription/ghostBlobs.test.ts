import { describe, expect, it } from "vitest";
import { computeGhostBlobs } from "./TranscriptionController";

const base = { heardWords: 0, transcribedWords: 0, msSinceVoice: 0, max: 8 };

describe("computeGhostBlobs", () => {
  it("shows the leading-edge floor while voicing, even with zero backlog", () => {
    // Deepgram case: transcription keeps pace (no lag), but you're speaking →
    // blobs must still show so the effect doesn't vanish.
    expect(computeGhostBlobs({ ...base, heardWords: 5, transcribedWords: 5, msSinceVoice: 50 })).toBe(2);
  });

  it("shows nothing when not speaking and fully caught up", () => {
    expect(
      computeGhostBlobs({ ...base, heardWords: 5, transcribedWords: 5, msSinceVoice: 5000 }),
    ).toBe(0);
  });

  it("decays the floor after voice stops instead of cutting hard", () => {
    // 300ms active window + 500ms decay. Halfway through decay → ~1 blob.
    const mid = computeGhostBlobs({ ...base, heardWords: 3, transcribedWords: 3, msSinceVoice: 550 });
    expect(mid).toBe(1);
    // Past the decay window → 0.
    expect(
      computeGhostBlobs({ ...base, heardWords: 3, transcribedWords: 3, msSinceVoice: 900 }),
    ).toBe(0);
  });

  it("grows blobs with a real backlog (laggy Whisper)", () => {
    // Heard 7 words, only 2 transcribed → lag 5 dominates the floor.
    expect(
      computeGhostBlobs({ ...base, heardWords: 7, transcribedWords: 2, msSinceVoice: 50 }),
    ).toBe(5);
  });

  it("clamps to max", () => {
    expect(
      computeGhostBlobs({ ...base, heardWords: 100, transcribedWords: 0, msSinceVoice: 50, max: 8 }),
    ).toBe(8);
  });

  it("never goes negative when the transcript overshoots the estimate", () => {
    expect(
      computeGhostBlobs({ ...base, heardWords: 2, transcribedWords: 6, msSinceVoice: 5000 }),
    ).toBe(0);
  });
});
