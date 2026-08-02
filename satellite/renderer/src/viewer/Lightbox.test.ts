// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { attachLightbox, LIGHTBOX_CLASS } from "./Lightbox";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "file-viewer-body";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const DOC =
  '<p>prose</p><img src="a.png" alt="an image"><a href="./x.md">link</a>';

function clickImg(container: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  container.querySelector("img")!.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("attachLightbox", () => {
  it("opens an overlay on a plain image click", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container);
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).not.toBeNull();
  });

  it("shows the clicked image's source and alt text", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container);
    const shown = container.querySelector<HTMLImageElement>(
      `.${LIGHTBOX_CLASS} img`,
    )!;
    expect(shown.getAttribute("src")).toBe("a.png");
    expect(shown.getAttribute("alt")).toBe("an image");
  });

  it("ignores Cmd+click so link activation keeps working", () => {
    // ⌘+click already means "open this" in the viewer; a linked image must
    // keep routing through onLinkActivate rather than opening the lightbox.
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container, { metaKey: true });
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("ignores Ctrl+click too", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container, { ctrlKey: true });
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("ignores clicks on non-images", () => {
    const container = mount(DOC);
    attachLightbox(container);
    container
      .querySelector("p")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("does not open for an image inside a link", () => {
    // That is a navigation affordance, not a picture to inspect.
    const container = mount('<a href="./x.md"><img src="a.png" alt="i"></a>');
    attachLightbox(container);
    clickImg(container);
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("closes on Escape", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("closes on a backdrop click", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container);
    container
      .querySelector(`.${LIGHTBOX_CLASS}`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("stays open when the enlarged image itself is clicked", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container);
    container
      .querySelector(`.${LIGHTBOX_CLASS} img`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).not.toBeNull();
  });

  it("never stacks two overlays", () => {
    const container = mount(DOC);
    attachLightbox(container);
    clickImg(container);
    clickImg(container);
    expect(container.querySelectorAll(`.${LIGHTBOX_CLASS}`)).toHaveLength(1);
  });

  it("dispose removes the listener and any open overlay", () => {
    const container = mount(DOC);
    const lb = attachLightbox(container);
    clickImg(container);
    lb.dispose();
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
    clickImg(container);
    expect(container.querySelector(`.${LIGHTBOX_CLASS}`)).toBeNull();
  });

  it("dispose is idempotent", () => {
    const container = mount(DOC);
    const lb = attachLightbox(container);
    lb.dispose();
    expect(() => lb.dispose()).not.toThrow();
  });

  it("drops the Escape handler on dispose", () => {
    // A stale document-level keydown listener after re-render is a real leak:
    // popups re-render on every external file change.
    const container = mount(DOC);
    attachLightbox(container).dispose();
    expect(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    ).not.toThrow();
  });
});
