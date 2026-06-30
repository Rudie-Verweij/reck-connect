// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CodeMirrorSurfaceAdapter } from "./CodeMirrorSurfaceAdapter";
import type { TtsBoundary } from "./TtsEngine";

function mountCm(content: string): {
  container: HTMLElement;
  view: EditorView;
} {
  const container = document.createElement("div");
  container.style.position = "relative";
  document.body.appendChild(container);
  const state = EditorState.create({ doc: content });
  const view = new EditorView({ state, parent: container });
  return { container, view };
}

describe("CodeMirrorSurfaceAdapter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports kind 'codemirror'", () => {
    const { container, view } = mountCm("hello world");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    expect(adapter.kind).toBe("codemirror");
  });

  it("getContainerEl returns the host container", () => {
    const { container, view } = mountCm("hello world");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    expect(adapter.getContainerEl()).toBe(container);
  });

  it("setTheme sets the --cm-tts-highlight-bg variable on the editor root", () => {
    const { container, view } = mountCm("hello world");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    adapter.setTheme({ backgroundColor: "#abcdef" });
    expect(view.dom.style.getPropertyValue("--cm-tts-highlight-bg")).toBe(
      "#abcdef",
    );
    adapter.dispose();
  });

  it("resolveSpokenChunk extracts the editor's document text", () => {
    const { container, view } = mountCm("alpha beta\ngamma delta");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    const chunk = adapter.resolveSpokenChunk();
    expect(chunk.text).toBe("alpha beta\ngamma delta");
  });

  it("resolveSpokenChunk emits one rangemap entry per word", () => {
    const { container, view } = mountCm("alpha beta gamma");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    const chunk = adapter.resolveSpokenChunk();
    // Three words: alpha, beta, gamma.
    expect(chunk.rangeMap).toHaveLength(3);
    expect(chunk.rangeMap[0]).toMatchObject({ charStart: 0, charEnd: 5 });
    expect(chunk.rangeMap[1]).toMatchObject({ charStart: 6, charEnd: 10 });
    expect(chunk.rangeMap[2]).toMatchObject({ charStart: 11, charEnd: 16 });
  });

  it("resolveSpokenChunk returns empty chunk for an empty document", () => {
    const { container, view } = mountCm("");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    const chunk = adapter.resolveSpokenChunk();
    expect(chunk.text).toBe("");
    expect(chunk.rangeMap).toEqual([]);
  });

  it("highlightBoundary dispatches a decoration via the state effect", () => {
    const { container, view } = mountCm("alpha beta");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    adapter.resolveSpokenChunk();
    const boundary: TtsBoundary = {
      line: 0, col: 0, len: 5, word: "alpha", charIndex: 0,
    };
    // Should not throw. The decoration is applied via a transaction.
    expect(() => adapter.highlightBoundary(boundary)).not.toThrow();
  });

  it("clearHighlight is idempotent and safe before any highlight", () => {
    const { container, view } = mountCm("alpha beta");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    expect(() => adapter.clearHighlight()).not.toThrow();
    adapter.resolveSpokenChunk();
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    expect(() => adapter.clearHighlight()).not.toThrow();
    expect(() => adapter.clearHighlight()).not.toThrow();
  });

  it("dispose removes the highlight decoration", () => {
    const { container, view } = mountCm("alpha beta");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    adapter.resolveSpokenChunk();
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    expect(() => adapter.dispose()).not.toThrow();
    // Idempotent.
    expect(() => adapter.dispose()).not.toThrow();
  });

  it("highlightBoundary after dispose is a no-op", () => {
    const { container, view } = mountCm("alpha beta");
    const adapter = new CodeMirrorSurfaceAdapter({ container, view });
    adapter.resolveSpokenChunk();
    adapter.dispose();
    // Should not throw, must not dispatch into a destroyed view.
    expect(() => adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 }))
      .not.toThrow();
  });

  // Bug observed: the file viewer popup always speaks from
  // the start of the doc — the SurfacePoint hint was ignored. Fix: use
  // view.posAtCoords(point) to get a char offset and slice the chunk so
  // playback starts at the hovered word.
  describe("speak-from-here (SurfacePoint honoured)", () => {
    it("returns a chunk whose first rangemap entry starts at-or-after the hovered offset", () => {
      const { container, view } = mountCm("alpha beta gamma delta");
      const adapter = new CodeMirrorSurfaceAdapter({ container, view });
      // Stub posAtCoords so jsdom (no layout) returns a known doc offset.
      // The real view uses layout coords; the test pins the conversion
      // result deterministically.
      const STUB_OFFSET = 11; // start of "gamma"
      const stubbedView = view as unknown as {
        posAtCoords?: typeof view.posAtCoords;
      };
      stubbedView.posAtCoords = () => STUB_OFFSET;
      const chunk = adapter.resolveSpokenChunk({ pixelX: 100, pixelY: 20 });
      // Chunk should start at "gamma" — no rangemap entries pointing to
      // chars before STUB_OFFSET in the joined text.
      expect(chunk.text.startsWith("gamma")).toBe(true);
      expect(chunk.rangeMap[0].charStart).toBe(0);
    });

    it("falls back to full-doc chunk when no point is provided", () => {
      const { container, view } = mountCm("alpha beta gamma");
      const adapter = new CodeMirrorSurfaceAdapter({ container, view });
      const chunk = adapter.resolveSpokenChunk();
      expect(chunk.text).toBe("alpha beta gamma");
    });
  });
});
