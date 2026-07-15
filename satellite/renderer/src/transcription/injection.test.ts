import { describe, expect, it } from "vitest";
import { computeInjection } from "./TranscriptionController";

describe("computeInjection", () => {
  it("appends the suffix when text only grows", () => {
    const r = computeInjection("let's refactor", "let's refactor the auth");
    expect(r.backspaces).toBe(0);
    expect(r.suffix).toBe(" the auth");
    expect(r.injected).toBe("let's refactor the auth");
  });

  it("backspaces only the diverged tail on a revision", () => {
    const r = computeInjection("let's refactor the aurth", "let's refactor the auth");
    // Shared prefix "let's refactor the au"; undo "rth" → type "th".
    expect(r.backspaces).toBe(3);
    expect(r.suffix).toBe("th");
    expect(r.injected).toBe("let's refactor the auth");
  });

  it("NEVER erases typed text on an empty pass (the swallow bug)", () => {
    const r = computeInjection("let's refactor the auth module", "");
    expect(r.backspaces).toBe(0);
    expect(r.suffix).toBe("");
    expect(r.injected).toBe("let's refactor the auth module");
  });

  it("emits nothing when the pass is unchanged", () => {
    const r = computeInjection("same text", "same text");
    expect(r.backspaces).toBe(0);
    expect(r.suffix).toBe("");
  });

  it("collapses newlines so a pass can't submit the prompt", () => {
    const r = computeInjection("", "hello\nworld");
    expect(r.suffix).toBe("hello world");
    expect(r.injected).toBe("hello world");
  });

  it("types the first pass from an empty prompt", () => {
    const r = computeInjection("", "first words");
    expect(r.backspaces).toBe(0);
    expect(r.suffix).toBe("first words");
  });
});
