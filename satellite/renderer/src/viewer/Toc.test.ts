// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildToc, TOC_ACTIVE_CLASS } from "./Toc";

// jsdom has no IntersectionObserver, so these tests install a controllable stub
// and drive it directly. That is enough to pin the wiring (observe every
// heading, toggle the active class, disconnect on dispose); whether the
// rootMargin actually feels right while scrolling is a browser question and is
// covered in e2e/markdown-viewer.spec.ts.

interface StubObserver {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
  options?: IntersectionObserverInit;
}

let observers: StubObserver[] = [];

beforeEach(() => {
  observers = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    class {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        const rec: StubObserver = {
          callback,
          observed: [],
          disconnected: false,
          options,
        };
        observers.push(rec);
        this.rec = rec;
      }
      private rec: StubObserver;
      observe(el: Element) {
        this.rec.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.rec.disconnected = true;
      }
      takeRecords() {
        return [];
      }
    };
});

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(markupHtml: string): { content: HTMLElement; sidebar: HTMLElement } {
  const content = document.createElement("div");
  content.className = "file-viewer-body";
  content.innerHTML = markupHtml;
  const sidebar = document.createElement("aside");
  document.body.append(content, sidebar);
  return { content, sidebar };
}

const DOC =
  '<h1 id="intro">Intro</h1><p>a</p>' +
  '<h2 id="goals">Goals</h2><p>b</p>' +
  '<h3 id="detail">Detail</h3><p>c</p>' +
  '<h4 id="deep">Deep</h4><p>d</p>' +
  '<h5 id="too-deep">Too deep</h5>';

describe("buildToc", () => {
  it("creates one entry per h1–h4, skipping deeper levels", () => {
    const { content, sidebar } = mount(DOC);
    const toc = buildToc({ content, sidebar });
    const links = sidebar.querySelectorAll("a");
    expect(links).toHaveLength(4);
    expect(Array.from(links).map((a) => a.textContent)).toEqual([
      "Intro",
      "Goals",
      "Detail",
      "Deep",
    ]);
    expect(toc.count).toBe(4);
  });

  it("links to the ids markdown-it-anchor already emitted", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar });
    expect(
      Array.from(sidebar.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toEqual(["#intro", "#goals", "#detail", "#deep"]);
  });

  it("indents by heading depth", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar });
    const levels = Array.from(sidebar.querySelectorAll("li")).map((li) =>
      li.getAttribute("data-level"),
    );
    expect(levels).toEqual(["1", "2", "3", "4"]);
  });

  it("replaces any previous content in the sidebar", () => {
    const { content, sidebar } = mount(DOC);
    sidebar.innerHTML = "<p>stale</p>";
    buildToc({ content, sidebar });
    expect(sidebar.textContent).not.toContain("stale");
  });

  it("reports zero for a document with no headings", () => {
    const { content, sidebar } = mount("<p>just prose</p>");
    expect(buildToc({ content, sidebar }).count).toBe(0);
  });

  it("skips headings that somehow lack an id", () => {
    const { content, sidebar } = mount('<h2>no id</h2><h2 id="ok">ok</h2>');
    buildToc({ content, sidebar });
    expect(sidebar.querySelectorAll("a")).toHaveLength(1);
  });

  it("scrolls the heading into view on click, without navigating", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar });
    const heading = content.querySelector<HTMLElement>("#goals")!;
    heading.scrollIntoView = vi.fn();

    const link = sidebar.querySelectorAll("a")[1];
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);

    // A real anchor navigation inside the popup would be a page load.
    expect(ev.defaultPrevented).toBe(true);
    expect(heading.scrollIntoView).toHaveBeenCalled();
  });
});

describe("buildToc — scroll spy", () => {
  it("observes every heading it listed", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar });
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toHaveLength(4);
  });

  it("uses the scroll container as the observer root when given one", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar, scroller: content });
    expect(observers[0].options?.root).toBe(content);
  });

  it("marks the entry active when its heading enters view", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar });
    const heading = content.querySelector("#goals")!;

    observers[0].callback(
      [{ target: heading, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    const links = sidebar.querySelectorAll("a");
    expect(links[1].classList.contains(TOC_ACTIVE_CLASS)).toBe(true);
    expect(links[0].classList.contains(TOC_ACTIVE_CLASS)).toBe(false);
  });

  it("clears the active class when the heading leaves view", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar });
    const heading = content.querySelector("#goals")!;
    const link = sidebar.querySelectorAll("a")[1];

    observers[0].callback(
      [{ target: heading, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    observers[0].callback(
      [{ target: heading, isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    expect(link.classList.contains(TOC_ACTIVE_CLASS)).toBe(false);
  });
});

describe("buildToc — dispose", () => {
  it("disconnects the observer", () => {
    const { content, sidebar } = mount(DOC);
    buildToc({ content, sidebar }).dispose();
    expect(observers[0].disconnected).toBe(true);
  });

  it("is idempotent", () => {
    const { content, sidebar } = mount(DOC);
    const toc = buildToc({ content, sidebar });
    toc.dispose();
    expect(() => toc.dispose()).not.toThrow();
  });

  it("does not throw when IntersectionObserver is unavailable", () => {
    // Belt-and-braces: the popup must still render its list even if the
    // observer is missing; only the scroll-spy highlight is lost.
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
    const { content, sidebar } = mount(DOC);
    let toc!: ReturnType<typeof buildToc>;
    expect(() => (toc = buildToc({ content, sidebar }))).not.toThrow();
    expect(sidebar.querySelectorAll("a")).toHaveLength(4);
    expect(() => toc.dispose()).not.toThrow();
  });
});
