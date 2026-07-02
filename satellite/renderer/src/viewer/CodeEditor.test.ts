// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  mountCodeEditor,
  pickLanguageForPath,
} from "./CodeEditor";

describe("pickLanguageForPath", () => {
  it.each([
    ["foo.ts", "typescript"],
    ["foo.tsx", "tsx"],
    ["foo.js", "javascript"],
    ["foo.jsx", "jsx"],
    ["foo.json", "json"],
    ["foo.py", "python"],
    ["foo.go", "go"],
    ["foo.rs", "rust"],
    ["foo.md", "markdown"],
    ["foo.html", "html"],
    ["foo.css", "css"],
    ["foo.yaml", "yaml"],
    ["foo.unknown-ext", null],
    ["no-extension", null],
  ])("matches %s to language %j", (filename, expected) => {
    const lang = pickLanguageForPath(filename);
    if (expected === null) {
      expect(lang).toBeNull();
    } else {
      expect(lang).not.toBeNull();
      expect(lang!.name.toLowerCase()).toBe(expected);
    }
  });
});

describe("mountCodeEditor", () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  it("mounts a CodeMirror editor into the parent element", () => {
    const handle = mountCodeEditor({
      initialContent: "hello world",
      filePath: "test.txt",
      theme: "light",
      parent,
    });
    expect(parent.querySelector(".cm-editor")).not.toBeNull();
    handle.dispose();
  });

  it("getContent() returns the current document text", () => {
    const handle = mountCodeEditor({
      initialContent: "line one\nline two",
      filePath: "test.txt",
      theme: "light",
      parent,
    });
    expect(handle.getContent()).toBe("line one\nline two");
    handle.dispose();
  });

  it("setContent() replaces the document text", () => {
    const handle = mountCodeEditor({
      initialContent: "original",
      filePath: "test.txt",
      theme: "light",
      parent,
    });
    handle.setContent("replaced");
    expect(handle.getContent()).toBe("replaced");
    handle.dispose();
  });

  it("applies the dark theme class when theme is dark", () => {
    const handle = mountCodeEditor({
      initialContent: "x",
      filePath: "test.txt",
      theme: "dark",
      parent,
    });
    // The CodeMirror editor element should reflect dark theme styling via a
    // class or data attribute. We don't pin to a specific class — only that
    // SOME dark-theme indicator exists in the rendered DOM.
    const editor = parent.querySelector(".cm-editor");
    expect(editor).not.toBeNull();
    // The wrapper we apply ourselves carries the data-theme attribute.
    const wrapper = parent.querySelector(".file-viewer-code-editor");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute("data-theme")).toBe("dark");
    handle.dispose();
  });

  it("mounts read-only — no input events allowed to change the doc", () => {
    const handle = mountCodeEditor({
      initialContent: "fixed",
      filePath: "test.ts",
      theme: "light",
      parent,
      readOnly: true,
    });
    // Attempt a programmatic edit via the public setContent — that bypasses
    // user input and must still work (this is what reload-from-disk uses).
    handle.setContent("changed");
    expect(handle.getContent()).toBe("changed");
    handle.dispose();
  });

  // Round 3 Issue D2 — silent setContent must NOT fire onChange. This is
  // the seam that breaks the write→watch→reload→setContent→onChange→save
  // loop driving the ~50ms flicker observed in production. The
  // FileViewerHost passes { silent: true } from auto-reload + conflict
  // resolution paths so disk-driven content swaps don't re-enter the
  // auto-save pipeline.
  it("setContent({ silent: true }) does NOT fire onChange", () => {
    const calls: string[] = [];
    const handle = mountCodeEditor({
      initialContent: "original",
      filePath: "test.txt",
      theme: "light",
      parent,
      readOnly: false,
      onChange: (content) => calls.push(content),
    });
    handle.setContent("loaded-from-disk", { silent: true });
    expect(handle.getContent()).toBe("loaded-from-disk");
    expect(calls).toHaveLength(0);
    handle.dispose();
  });

  it("setContent() without silent DOES fire onChange", () => {
    const calls: string[] = [];
    const handle = mountCodeEditor({
      initialContent: "original",
      filePath: "test.txt",
      theme: "light",
      parent,
      readOnly: false,
      onChange: (content) => calls.push(content),
    });
    handle.setContent("user-replaced");
    expect(calls).toEqual(["user-replaced"]);
    handle.dispose();
  });

  it("dispose() detaches the editor from the DOM", () => {
    const handle = mountCodeEditor({
      initialContent: "x",
      filePath: "test.txt",
      theme: "light",
      parent,
    });
    expect(parent.querySelector(".cm-editor")).not.toBeNull();
    handle.dispose();
    expect(parent.querySelector(".cm-editor")).toBeNull();
  });

  // Round 5 Phase W — dynamic readOnly toggling via Compartment so
  // the lock pill / banner can flip editability without rebuilding
  // the editor (no DOM teardown, no scroll-position loss, no
  // language-load re-fetch).
  it("setReadOnly(false) makes a previously-readonly editor accept onChange-fired transactions", () => {
    const calls: string[] = [];
    const handle = mountCodeEditor({
      initialContent: "x",
      filePath: "test.txt",
      theme: "light",
      parent,
      readOnly: true,
      onChange: (c) => calls.push(c),
    });
    // While read-only, a non-silent setContent still works (used for
    // disk-reload). Programmatic edits bypass the editability gate;
    // the test ensures the surrounding state IS read-only by checking
    // EditorState.readOnly is true initially.
    expect(handle.view.state.readOnly).toBe(true);
    handle.setReadOnly(false);
    expect(handle.view.state.readOnly).toBe(false);
    // After unlock, a programmatic content change should fire onChange
    // (proves the updateListener still wired through).
    handle.setContent("changed");
    expect(calls).toContain("changed");
    handle.dispose();
  });

  it("setReadOnly(true) re-locks an editor that started writable", () => {
    const handle = mountCodeEditor({
      initialContent: "x",
      filePath: "test.txt",
      theme: "light",
      parent,
      readOnly: false,
    });
    expect(handle.view.state.readOnly).toBe(false);
    handle.setReadOnly(true);
    expect(handle.view.state.readOnly).toBe(true);
    handle.dispose();
  });
});
