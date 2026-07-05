// @vitest-environment jsdom
// satellite/renderer/src/viewer/renderedDom.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRenderedDom } from "./renderedDom";

describe("createRenderedDom.mount", () => {
  it("sets innerHTML and wraps free-text paths as internal links", () => {
    const dom = createRenderedDom();
    const el = document.createElement("div");
    dom.mount(el, "<p>see services/foo.ts here</p>");
    const a = el.querySelector("a.reck-internal-link");
    expect(a?.getAttribute("href")).toBe("services/foo.ts");
  });

  it("blocks plain clicks and routes Cmd+click on internal links", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md">x</a>');
    const a = el.querySelector("a")!;

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(onLinkActivate).not.toHaveBeenCalled();

    const meta = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    a.dispatchEvent(meta);
    expect(onLinkActivate).toHaveBeenCalledWith("./x.md", expect.any(MouseEvent));
  });

  it("routes Cmd+click on external links to onExternalActivate", () => {
    const onExternalActivate = vi.fn();
    const dom = createRenderedDom({ onExternalActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="https://example.com">e</a>');
    el.querySelector("a")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onExternalActivate).toHaveBeenCalledWith(
      "https://example.com",
      expect.any(MouseEvent),
    );
  });

  it("dispose() detaches the click handler", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md">x</a>');
    const a = el.querySelector("a")!;
    dom.dispose();
    a.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onLinkActivate).not.toHaveBeenCalled();
  });
});
