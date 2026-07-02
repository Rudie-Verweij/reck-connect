// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CodeMirrorSearchAdapter } from "./CodeMirrorSearchAdapter";

let container: HTMLElement;
let view: EditorView;
let adapter: CodeMirrorSearchAdapter;

function mount(doc: string): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  view = new EditorView({ state: EditorState.create({ doc }), parent: container });
  adapter = new CodeMirrorSearchAdapter({ container, view });
}

afterEach(() => {
  adapter?.dispose();
  view?.destroy();
  document.body.innerHTML = "";
});

describe("CodeMirrorSearchAdapter", () => {
  beforeEach(() => mount("foo bar foo baz foo"));

  it("reports its kind and container", () => {
    expect(adapter.kind).toBe("codemirror");
    expect(adapter.getContainerEl()).toBe(container);
  });

  it("getText returns the full document", () => {
    expect(adapter.getText()).toBe("foo bar foo baz foo");
  });

  it("highlightMatches installs one decoration per match", () => {
    adapter.highlightMatches(
      [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
        { start: 16, end: 19 },
      ],
      1,
    );
    expect(adapter.__matchCount()).toBe(3);
  });

  it("clearHighlights removes all decorations", () => {
    adapter.highlightMatches([{ start: 0, end: 3 }], 0);
    adapter.clearHighlights();
    expect(adapter.__matchCount()).toBe(0);
  });

  it("scrollToMatch does not throw", () => {
    adapter.highlightMatches([{ start: 16, end: 19 }], 0);
    expect(() => adapter.scrollToMatch({ start: 16, end: 19 })).not.toThrow();
  });

  it("clamps ranges that exceed the document length", () => {
    expect(() => adapter.highlightMatches([{ start: 0, end: 9999 }], 0)).not.toThrow();
    expect(adapter.__matchCount()).toBeLessThanOrEqual(1);
  });

  it("is a no-op after dispose (and dispose is idempotent)", () => {
    adapter.dispose();
    expect(() => adapter.highlightMatches([{ start: 0, end: 3 }], 0)).not.toThrow();
    expect(() => adapter.scrollToMatch({ start: 0, end: 3 })).not.toThrow();
    expect(() => adapter.dispose()).not.toThrow();
  });
});
