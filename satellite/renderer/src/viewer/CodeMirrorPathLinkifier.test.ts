// @vitest-environment jsdom
//
// Round 6 Phase BB1 — installCodeMirrorPathLinkifier.
//
// The popup CodeMirror surface needs the same path-detection-and-Cmd-click
// behaviour that xterm has from Round 2. The linkifier scans visible doc
// ranges, decorates matched path tokens with `.reck-path-link`, and routes
// Cmd-clicks on those ranges through a `deps.onActivate(text, ev)` callback.
//
// Pattern reference:
//   - CodeMirrorSurfaceAdapter.ts:36-57 (StateField + Decoration.mark + ViewPlugin)
//   - PathLinkProvider.ts:89 (xterm-side linkifier contract — onActivate API)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { installCodeMirrorPathLinkifier } from "./CodeMirrorPathLinkifier";

function mountView(doc: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({ doc });
  const view = new EditorView({ state, parent });
  return { view, parent };
}

describe("installCodeMirrorPathLinkifier", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("decorates path tokens in the visible doc with .reck-path-link", () => {
    const { view, parent } = mountView(
      "open services/foo.ts to read",
    );
    const handle = installCodeMirrorPathLinkifier(view, {
      onActivate: vi.fn(),
    });
    // The decoration must show up in the DOM after install.
    const link = parent.querySelector(".reck-path-link");
    expect(link).not.toBeNull();
    expect((link as HTMLElement).textContent).toBe("services/foo.ts");
    handle.dispose();
    view.destroy();
  });

  it("decorates absolute paths /etc/hosts and home-relative ~/x.md", () => {
    const { view, parent } = mountView(
      "see /etc/passwd and ~/notes.md please",
    );
    const handle = installCodeMirrorPathLinkifier(view, {
      onActivate: vi.fn(),
    });
    const links = parent.querySelectorAll(".reck-path-link");
    const texts = Array.from(links).map((n) => (n as HTMLElement).textContent);
    expect(texts).toContain("/etc/passwd");
    expect(texts).toContain("~/notes.md");
    handle.dispose();
    view.destroy();
  });

  it("does NOT decorate plain words that aren't paths", () => {
    const { view, parent } = mountView("hello world this is plain text");
    installCodeMirrorPathLinkifier(view, { onActivate: vi.fn() });
    expect(parent.querySelector(".reck-path-link")).toBeNull();
    view.destroy();
  });

  it("fires onActivate(text, ev) on Cmd-click of a decorated span", () => {
    const onActivate = vi.fn();
    const { view, parent } = mountView("open services/foo.ts now");
    installCodeMirrorPathLinkifier(view, { onActivate });
    const link = parent.querySelector(".reck-path-link") as HTMLElement;
    expect(link).not.toBeNull();
    link.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
        button: 0,
      }),
    );
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toBe("services/foo.ts");
    view.destroy();
  });

  it("plain click (no metaKey) does NOT fire onActivate", () => {
    const onActivate = vi.fn();
    const { view, parent } = mountView("open services/foo.ts now");
    installCodeMirrorPathLinkifier(view, { onActivate });
    const link = parent.querySelector(".reck-path-link") as HTMLElement;
    link.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    expect(onActivate).not.toHaveBeenCalled();
    view.destroy();
  });

  it("dispose() removes the decorations", () => {
    const { view, parent } = mountView("see services/foo.ts now");
    const handle = installCodeMirrorPathLinkifier(view, { onActivate: vi.fn() });
    expect(parent.querySelector(".reck-path-link")).not.toBeNull();
    handle.dispose();
    expect(parent.querySelector(".reck-path-link")).toBeNull();
    view.destroy();
  });

  it("re-scans after doc changes (new path appearing after edit gets decorated)", async () => {
    const onActivate = vi.fn();
    const { view, parent } = mountView("starting empty doc");
    installCodeMirrorPathLinkifier(view, { onActivate });
    expect(parent.querySelector(".reck-path-link")).toBeNull();
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "now see services/bar.ts",
      },
    });
    // Decorations are applied synchronously by the StateField; the next
    // measure may still be needed to paint. Yielding once ensures the
    // view's update cycle ran.
    await Promise.resolve();
    const link = parent.querySelector(".reck-path-link");
    expect(link).not.toBeNull();
    expect((link as HTMLElement).textContent).toBe("services/bar.ts");
    view.destroy();
  });

  // Round 7 Phase FF — native title tooltip on decorated path spans so
  // hovering surfaces the "⌘+click to open" hint after ~1s. Matches the
  // markdown-side tooltip on `<a class="reck-internal-link">`.
  it("decorated span carries title='⌘+click to open' for native hover tooltip", () => {
    const { view, parent } = mountView("open services/foo.ts now");
    installCodeMirrorPathLinkifier(view, { onActivate: vi.fn() });
    const link = parent.querySelector(".reck-path-link") as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("title")).toBe("⌘+click to open");
    view.destroy();
  });
});
