import { describe, expect, it } from "vitest";
import { sanitizeTranscript } from "./transcriptClean";

describe("sanitizeTranscript", () => {
  it("passes clean speech through unchanged", () => {
    expect(sanitizeTranscript("let's refactor the auth module")).toBe(
      "let's refactor the auth module",
    );
  });

  it("strips bracketed / parenthesized annotations", () => {
    expect(sanitizeTranscript("so what are we (audience chattering) talking about")).toBe(
      "so what are we talking about",
    );
    expect(sanitizeTranscript("run the [BLANK_AUDIO] tests")).toBe("run the tests");
    expect(sanitizeTranscript("(applause)")).toBe("");
  });

  it("strips musical-note runs", () => {
    expect(sanitizeTranscript("♪ humming ♪ deploy now")).toBe("humming deploy now");
    expect(sanitizeTranscript("🎵🎶")).toBe("");
  });

  it("drops standalone silence hallucinations", () => {
    expect(sanitizeTranscript("Thanks for watching!")).toBe("");
    expect(sanitizeTranscript("Subtitles by the Amara.org community")).toBe("");
    expect(sanitizeTranscript("you")).toBe("");
    expect(sanitizeTranscript("...")).toBe("");
  });

  it("keeps a hallucination phrase when it's part of real speech", () => {
    // "thank you" alone is dropped, but inside a sentence it's kept.
    expect(sanitizeTranscript("thank you for reviewing the pull request")).toBe(
      "thank you for reviewing the pull request",
    );
  });

  it("collapses whitespace left by removals", () => {
    expect(sanitizeTranscript("hello   (noise)   world")).toBe("hello world");
  });
});
