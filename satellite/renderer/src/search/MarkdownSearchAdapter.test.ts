// @vitest-environment jsdom
//
// CSS.highlights / the Highlight constructor don't exist in jsdom, so the
// real ::highlight() registration no-ops here. These tests assert the
// structural behaviour instead: the flat text index and the DOM Ranges
// the adapter builds for each match (verified via test-introspection
// hooks). Real highlight rendering is verified manually in the Electron
// renderer (Electron 30 / Chromium ships the Highlight API).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MarkdownSearchAdapter } from "./MarkdownSearchAdapter";

let container: HTMLElement;
let body: HTMLElement;
let adapter: MarkdownSearchAdapter;

function mount(html: string): void {
  container = document.createElement("div");
  container.style.position = "relative";
  body = document.createElement("div");
  body.className = "file-viewer-body";
  body.innerHTML = html;
  container.appendChild(body);
  document.body.appendChild(container);
  adapter = new MarkdownSearchAdapter({ container, body });
}

afterEach(() => {
  adapter?.dispose();
  document.body.innerHTML = "";
});

describe("MarkdownSearchAdapter", () => {
  beforeEach(() => mount("<p>foo bar foo</p><p>baz foo</p>"));

  it("reports its kind and container", () => {
    expect(adapter.kind).toBe("markdown");
    expect(adapter.getContainerEl()).toBe(container);
  });

  it("getText joins block text with newline separators", () => {
    const text = adapter.getText();
    expect(text).toContain("foo bar foo");
    expect(text).toContain("baz foo");
    expect(text).toContain("\n"); // block boundary
  });

  it("builds one DOM range per match, mapping offsets back to the DOM", () => {
    const text = adapter.getText();
    // indices of "foo" in "foo bar foo\nbaz foo"
    expect(text.indexOf("foo")).toBe(0);
    adapter.highlightMatches(
      [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
        { start: 16, end: 19 },
      ],
      1,
    );
    expect(adapter.__matchCount()).toBe(3);
    expect(adapter.__activeRangeText()).toBe("foo");
  });

  it("clearHighlights drops the ranges", () => {
    adapter.getText();
    adapter.highlightMatches([{ start: 0, end: 3 }], 0);
    adapter.clearHighlights();
    expect(adapter.__matchCount()).toBe(0);
  });

  it("scrollToMatch does not throw", () => {
    adapter.getText();
    adapter.highlightMatches([{ start: 16, end: 19 }], 0);
    expect(() => adapter.scrollToMatch({ start: 16, end: 19 })).not.toThrow();
  });

  it("rebuilds the index when getText is called after a re-render", () => {
    adapter.getText();
    body.innerHTML = "<p>different content here</p>";
    const text = adapter.getText();
    expect(text).toContain("different content here");
    expect(() => adapter.highlightMatches([{ start: 0, end: 9 }], 0)).not.toThrow();
  });

  it("is a no-op after dispose (idempotent)", () => {
    adapter.dispose();
    expect(() => adapter.highlightMatches([{ start: 0, end: 3 }], 0)).not.toThrow();
    expect(adapter.__matchCount()).toBe(0);
    expect(() => adapter.dispose()).not.toThrow();
  });
});
