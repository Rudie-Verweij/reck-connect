import { describe, it, expect } from "vitest";
import {
  isMarkdownPath,
  isRenderablePath,
  pickViewerMode,
} from "./pickViewerMode";

describe("isMarkdownPath", () => {
  it("matches .md and .markdown case-insensitively", () => {
    expect(isMarkdownPath("/a/b.md")).toBe(true);
    expect(isMarkdownPath("/a/b.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/a/b.ts")).toBe(false);
  });
});

describe("isRenderablePath", () => {
  it("is true for markdown (Phase 0 scope)", () => {
    expect(isRenderablePath("/a/b.md")).toBe(true);
    expect(isRenderablePath("/a/b.ts")).toBe(false);
  });
});

describe("pickViewerMode", () => {
  it("renders markdown by default", () => {
    expect(pickViewerMode("/a/b.md", undefined)).toBe("markdown-rendered");
  });
  it("honours a persisted 'source' choice for markdown", () => {
    expect(pickViewerMode("/a/b.md", "source")).toBe("source");
  });
  it("uses source for non-renderable files regardless of persisted value", () => {
    expect(pickViewerMode("/a/b.ts", "rendered")).toBe("source");
    expect(pickViewerMode("/a/b.ts", undefined)).toBe("source");
  });
});
