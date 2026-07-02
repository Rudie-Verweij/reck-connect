// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { MarkdownSurfaceAdapter } from "./MarkdownSurfaceAdapter";
import type { TtsBoundary } from "./TtsEngine";

function makeContainer(): HTMLElement {
  const c = document.createElement("div");
  c.style.position = "relative";
  document.body.appendChild(c);
  return c;
}

function makeBodyWithHTML(html: string): { container: HTMLElement; body: HTMLElement } {
  const container = makeContainer();
  const body = document.createElement("div");
  body.className = "file-viewer-body";
  body.innerHTML = html;
  container.appendChild(body);
  return { container, body };
}

describe("MarkdownSurfaceAdapter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports kind 'markdown'", () => {
    const { container, body } = makeBodyWithHTML("<p>hello world</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    expect(adapter.kind).toBe("markdown");
  });

  it("getContainerEl returns the host container", () => {
    const { container, body } = makeBodyWithHTML("<p>hello world</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    expect(adapter.getContainerEl()).toBe(container);
  });

  it("resolveSpokenChunk extracts text from the rendered body", () => {
    const { container, body } = makeBodyWithHTML(
      "<h1>Title</h1><p>Hello <strong>bold</strong> world.</p>",
    );
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    const chunk = adapter.resolveSpokenChunk();
    expect(chunk.text).toContain("Title");
    expect(chunk.text).toContain("Hello");
    expect(chunk.text).toContain("bold");
    expect(chunk.text).toContain("world");
  });

  it("resolveSpokenChunk builds a per-word rangeMap", () => {
    const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    const chunk = adapter.resolveSpokenChunk();
    expect(chunk.rangeMap.length).toBeGreaterThan(0);
    // Each rangemap entry has a charStart/charEnd and identifies a word.
    for (const entry of chunk.rangeMap) {
      expect(entry.charEnd).toBeGreaterThan(entry.charStart);
      const slice = chunk.text.slice(entry.charStart, entry.charEnd);
      expect(slice.trim().length).toBeGreaterThan(0);
    }
  });

  it("resolveSpokenChunk returns empty chunk when body is empty", () => {
    const { container, body } = makeBodyWithHTML("");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    const chunk = adapter.resolveSpokenChunk();
    expect(chunk.text.trim()).toBe("");
    expect(chunk.rangeMap).toEqual([]);
  });

  it("highlightBoundary mounts an overlay element inside the container", () => {
    const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    // Build a rangeMap entry via resolveSpokenChunk, then fire a matching
    // boundary so highlightBoundary has something to look up.
    adapter.resolveSpokenChunk();
    const boundary: TtsBoundary = {
      line: 0, col: 0, len: 5, word: "Hello", charIndex: 0,
    };
    adapter.highlightBoundary(boundary);
    expect(container.querySelector(".tts-highlight-overlay")).toBeTruthy();
  });

  it("setTheme colours the overlay (applied even when set before the overlay exists)", () => {
    const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    adapter.setTheme({ backgroundColor: "rgb(10, 20, 30)" });
    adapter.resolveSpokenChunk();
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "Hello", charIndex: 0 });
    const overlay = container.querySelector<HTMLDivElement>(".tts-highlight-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.style.background).toBe("rgb(10, 20, 30)");
    // And a later setTheme recolours the live overlay.
    adapter.setTheme({ backgroundColor: "rgb(40, 50, 60)" });
    expect(overlay!.style.background).toBe("rgb(40, 50, 60)");
  });

  it("clearHighlight removes the overlay", () => {
    const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    adapter.resolveSpokenChunk();
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "Hello", charIndex: 0 });
    adapter.clearHighlight();
    expect(container.querySelector(".tts-highlight-overlay")).toBeNull();
  });

  it("dispose removes the overlay and is idempotent", () => {
    const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    adapter.resolveSpokenChunk();
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "Hello", charIndex: 0 });
    expect(() => adapter.dispose()).not.toThrow();
    expect(() => adapter.dispose()).not.toThrow();
    expect(container.querySelector(".tts-highlight-overlay")).toBeNull();
  });

  it("highlightBoundary after dispose is a no-op", () => {
    const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
    const adapter = new MarkdownSurfaceAdapter({ container, body });
    adapter.resolveSpokenChunk();
    adapter.dispose();
    adapter.highlightBoundary({ line: 0, col: 0, len: 5, word: "Hello", charIndex: 0 });
    expect(container.querySelector(".tts-highlight-overlay")).toBeNull();
  });

  // Bug observed: the popup always started reading from
  // the top, ignoring where the mouse was. Fix: caretRangeFromPoint
  // (jsdom returns null, so a test fake injects a known offset) drives
  // the chunk slice.
  describe("speak-from-here (SurfacePoint honoured)", () => {
    it("trims the chunk to text after the hovered char when a point is provided", () => {
      const { container, body } = makeBodyWithHTML("<p>alpha beta gamma</p>");
      const adapter = new MarkdownSurfaceAdapter({ container, body });
      // jsdom doesn't compute layout / caret coordinates. Stub
      // `document.caretRangeFromPoint` so the adapter sees a deterministic
      // hit. The hit is "at the start of 'gamma'" within the first text node.
      const textNode = body.querySelector("p")!.firstChild as Text;
      const docAny = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      docAny.caretRangeFromPoint = (_x: number, _y: number) => {
        const r = document.createRange();
        r.setStart(textNode, 11); // "alpha beta " ends at index 11
        r.setEnd(textNode, 11);
        return r;
      };
      const chunk = adapter.resolveSpokenChunk({ pixelX: 50, pixelY: 8 });
      expect(chunk.text.startsWith("gamma")).toBe(true);
    });

    it("falls back to the full document when no point is provided", () => {
      const { container, body } = makeBodyWithHTML("<p>alpha beta</p>");
      const adapter = new MarkdownSurfaceAdapter({ container, body });
      const chunk = adapter.resolveSpokenChunk();
      expect(chunk.text).toContain("alpha");
      expect(chunk.text).toContain("beta");
    });
  });

  // Overlay must live INSIDE the scroll container
  // (`.file-viewer-body`) and reposition on body scroll. Previously the
  // overlay was appended to `container` (#viewer-root) which is NOT the
  // scroll container; scrolling the body left the overlay anchored to
  // the wrong place. See plan robust-stargazing-scroll.md.
  describe("scroll tracking", () => {
    function mountWithBoundary(): {
      container: HTMLElement;
      body: HTMLElement;
      adapter: MarkdownSurfaceAdapter;
    } {
      const { container, body } = makeBodyWithHTML("<p>Hello world!</p>");
      const adapter = new MarkdownSurfaceAdapter({ container, body });
      adapter.resolveSpokenChunk();
      adapter.highlightBoundary({
        line: 0,
        col: 0,
        len: 5,
        word: "Hello",
        charIndex: 0,
      });
      return { container, body, adapter };
    }

    it("appends the overlay into the scroll container body, not the popup root", () => {
      const { container, body } = mountWithBoundary();
      const overlay = body.querySelector(
        ".tts-highlight-overlay",
      ) as HTMLElement | null;
      expect(overlay).not.toBeNull();
      // The overlay's parent must be the body, not the container. Both
      // queries-from-container resolve transitively (because body lives
      // inside container), but only the body should own the overlay so
      // its painted position scrolls with the body's content.
      expect(overlay!.parentElement).toBe(body);
      expect(overlay!.parentElement).not.toBe(container);
    });

    it("repositions the overlay when the body scrolls", () => {
      // Stub Range.prototype.getBoundingClientRect to return a
      // programmable rect tied to a closure variable — simulates "the
      // text moved 100px up because the body scrolled".
      let rectTop = 200;
      const originalGetRect = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = function () {
        return {
          x: 10,
          y: rectTop,
          top: rectTop,
          left: 10,
          right: 90,
          bottom: rectTop + 20,
          width: 80,
          height: 20,
          toJSON() {
            return this;
          },
        } as DOMRect;
      };
      try {
        const { body } = mountWithBoundary();
        const overlay = body.querySelector(
          ".tts-highlight-overlay",
        ) as HTMLElement;
        const topBefore = overlay.style.top;
        rectTop = 100; // text scrolled up
        body.dispatchEvent(new Event("scroll"));
        const topAfter = overlay.style.top;
        expect(topAfter).not.toBe(topBefore);
      } finally {
        Range.prototype.getBoundingClientRect = originalGetRect;
      }
    });

    it("clearHighlight detaches the scroll listener", () => {
      const { container, body, adapter } = mountWithBoundary();
      // Mark the body so the listener has something deterministic to do.
      // Test the contract via removeEventListener spy.
      const removed: Array<{ type: string }> = [];
      const original = body.removeEventListener;
      body.removeEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ): void {
        removed.push({ type });
        return original.call(this, type, listener, options);
      };
      try {
        adapter.clearHighlight();
        const scrollRemoved = removed.some((r) => r.type === "scroll");
        expect(scrollRemoved).toBe(true);
      } finally {
        body.removeEventListener = original;
        void container; // appease unused-var lint
      }
    });

    it("dispose detaches the scroll listener", () => {
      const { body, adapter } = mountWithBoundary();
      const removed: Array<{ type: string }> = [];
      const original = body.removeEventListener;
      body.removeEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ): void {
        removed.push({ type });
        return original.call(this, type, listener, options);
      };
      try {
        adapter.dispose();
        const scrollRemoved = removed.some((r) => r.type === "scroll");
        expect(scrollRemoved).toBe(true);
      } finally {
        body.removeEventListener = original;
      }
    });
  });
});
