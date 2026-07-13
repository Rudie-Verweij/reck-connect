import { describe, it, expect } from "vitest";
import {
  resolveDefaultVoice,
  isNoveltyVoice,
  type VoiceLike,
} from "./defaultVoice";

function mkVoice(
  name: string,
  lang = "en-US",
  extra: Partial<Pick<VoiceLike, "default" | "localService">> = {},
): VoiceLike {
  return {
    name,
    lang,
    default: extra.default ?? false,
    localService: extra.localService ?? true,
  };
}

describe("isNoveltyVoice", () => {
  it("matches macOS novelty voices with and without suffixes", () => {
    expect(isNoveltyVoice(mkVoice("Albert"))).toBe(true);
    expect(isNoveltyVoice(mkVoice("Albert (en-US)"))).toBe(true);
    expect(isNoveltyVoice(mkVoice("Bad News"))).toBe(true);
    expect(isNoveltyVoice(mkVoice("Zarvox"))).toBe(true);
  });

  it("does not match regular voices", () => {
    expect(isNoveltyVoice(mkVoice("Samantha"))).toBe(false);
    expect(isNoveltyVoice(mkVoice("Zoe (Premium)"))).toBe(false);
    expect(isNoveltyVoice(mkVoice("Nicky (Enhanced)"))).toBe(false);
  });
});

describe("resolveDefaultVoice", () => {
  it("returns null for an empty list", () => {
    expect(resolveDefaultVoice([], "en-US")).toBeNull();
  });

  // The real-world bug: Siri system voice → Chromium flags Albert (a
  // novelty voice) as default. Our resolver must never pick it.
  it("never picks a novelty voice, even when it carries the default flag", () => {
    const voices = [
      mkVoice("Albert", "en-US", { default: true }),
      mkVoice("Samantha", "en-US"),
    ];
    expect(resolveDefaultVoice(voices, "en-US")?.name).toBe("Samantha");
  });

  it("prefers premium over enhanced over plain voices", () => {
    const voices = [
      mkVoice("Samantha", "en-US"),
      mkVoice("Nicky (Enhanced)", "en-US"),
      mkVoice("Zoe (Premium)", "en-US"),
    ];
    expect(resolveDefaultVoice(voices, "en-US")?.name).toBe("Zoe (Premium)");
  });

  it("prefers a plain voice in the right language over premium in the wrong one", () => {
    const voices = [
      mkVoice("Zoe (Premium)", "en-US"),
      mkVoice("Ellen", "nl-BE"),
      mkVoice("Xander", "nl-NL"),
    ];
    expect(resolveDefaultVoice(voices, "nl-NL")?.name).toBe("Xander");
  });

  // Real-world regression: with an en-GB system locale the resolver used
  // to pick plain Daniel (en-GB, exact region) over Zoe (Premium, en-US).
  // Quality dominates within the same language; exact region only breaks ties.
  it("prefers a premium voice of the same language over an exact regional match", () => {
    const voices = [
      mkVoice("Daniel", "en-GB"),
      mkVoice("Zoe (Premium)", "en-US"),
    ];
    expect(resolveDefaultVoice(voices, "en-GB")?.name).toBe("Zoe (Premium)");
  });

  it("uses exact region as a tiebreak between equal-quality voices", () => {
    const voices = [
      mkVoice("Flo (English (United States))", "en-US"),
      mkVoice("Flo (English (United Kingdom))", "en-GB"),
    ];
    expect(resolveDefaultVoice(voices, "en-GB")?.name).toBe(
      "Flo (English (United Kingdom))",
    );
  });

  it("accepts a primary-subtag match when there is no exact regional match", () => {
    const voices = [
      mkVoice("Daniel", "en-GB"),
      mkVoice("Anna", "de-DE"),
    ];
    expect(resolveDefaultVoice(voices, "en-US")?.name).toBe("Daniel");
  });

  it("falls back to English when the preferred language has no voices", () => {
    const voices = [
      mkVoice("Samantha", "en-US"),
      mkVoice("Anna", "de-DE"),
    ];
    expect(resolveDefaultVoice(voices, "xx-XX")?.name).toBe("Samantha");
  });

  it("prefers the classic system voices over unknown plain voices", () => {
    const voices = [
      mkVoice("Eddy (English (United States))", "en-US"),
      mkVoice("Samantha", "en-US"),
    ];
    expect(resolveDefaultVoice(voices, "en-US")?.name).toBe("Samantha");
  });

  it("uses the default flag as a tiebreak between equals", () => {
    const voices = [
      mkVoice("Flo (English (United States))", "en-US"),
      mkVoice("Kathy", "en-US", { default: true }),
    ];
    expect(resolveDefaultVoice(voices, "en-US")?.name).toBe("Kathy");
  });

  it("picks a novelty voice only when nothing else exists", () => {
    const voices = [mkVoice("Albert", "en-US", { default: true })];
    expect(resolveDefaultVoice(voices, "en-US")?.name).toBe("Albert");
  });
});
