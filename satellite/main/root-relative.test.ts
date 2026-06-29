import { describe, it, expect } from "vitest";
import { rootRelativeCandidate } from "./root-relative";

// defect 3 — the popup double-join. The raw click text is
// joined onto the project cwd as a deterministic second candidate
// before the streaming suffix-search kicks in.

describe("rootRelativeCandidate", () => {
  it("joins a bare relative reference onto the project cwd", () => {
    expect(rootRelativeCandidate("docs/notes.md", "/proj")).toBe(
      "/proj/docs/notes.md",
    );
  });

  it("normalizes a ./ prefix", () => {
    expect(rootRelativeCandidate("./docs/notes.md", "/proj")).toBe(
      "/proj/docs/notes.md",
    );
  });

  it("keeps leading dot-folder references intact (.claude/…)", () => {
    expect(rootRelativeCandidate(".claude/settings.json", "/proj")).toBe(
      "/proj/.claude/settings.json",
    );
  });

  it("rescues the double-join case: subfolder-relative text + project cwd", () => {
    // Popup shows /proj/subfolder/notes.md; the markdown references
    // subfolder/other.md (root-relative). resolveAgainst produced
    // /proj/subfolder/subfolder/other.md (the miss); this candidate is
    // the correct /proj/subfolder/other.md.
    expect(rootRelativeCandidate("subfolder/other.md", "/proj")).toBe(
      "/proj/subfolder/other.md",
    );
  });

  it("returns null for absolute originalText (already anchored)", () => {
    expect(rootRelativeCandidate("/abs/x.md", "/proj")).toBeNull();
  });

  it("returns null for home-anchored originalText", () => {
    expect(rootRelativeCandidate("~/x.md", "/proj")).toBeNull();
    expect(rootRelativeCandidate("~", "/proj")).toBeNull();
  });

  it("returns null when projectCwd is missing or empty", () => {
    expect(rootRelativeCandidate("x.md", null)).toBeNull();
    expect(rootRelativeCandidate("x.md", undefined)).toBeNull();
    expect(rootRelativeCandidate("x.md", "")).toBeNull();
  });

  it("returns null for empty or whitespace-only originalText", () => {
    expect(rootRelativeCandidate("", "/proj")).toBeNull();
    expect(rootRelativeCandidate("   ", "/proj")).toBeNull();
    expect(rootRelativeCandidate(undefined, "/proj")).toBeNull();
  });

  it("returns null when ../ escapes the project cwd", () => {
    expect(rootRelativeCandidate("../outside.md", "/proj")).toBeNull();
    expect(rootRelativeCandidate("a/../../outside.md", "/proj")).toBeNull();
  });

  it("allows ../ segments that stay inside the cwd", () => {
    expect(rootRelativeCandidate("a/../b.md", "/proj")).toBe("/proj/b.md");
  });

  it("returns null for a relative projectCwd (must be absolute)", () => {
    expect(rootRelativeCandidate("x.md", "proj")).toBeNull();
  });

  it("tolerates a trailing slash on the cwd", () => {
    expect(rootRelativeCandidate("x.md", "/proj/")).toBe("/proj/x.md");
  });
});
