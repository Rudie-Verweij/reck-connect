// Table of contents for the rendered-markdown popup.
//
// Built from the heading `id`s `markdown-it-anchor` already adds
// (MarkdownRenderer.ts) — no second slugifier, so a TOC link and a `#anchor`
// link in the document resolve identically.
//
// Must be built AFTER `MarkdownRenderer.whenEnhanced()` resolves: mermaid and
// KaTeX change document height, which moves every scroll-spy threshold.

export interface TocOptions {
  /** Rendered markdown container to read headings from. */
  content: HTMLElement;
  /** The `<aside>` the list is rendered into. Cleared first. */
  sidebar: HTMLElement;
  /**
   * Scroll container the headings live in — `.file-viewer-body`. Used as the
   * IntersectionObserver root so scroll-spy tracks the popup's own scrolling
   * rather than the viewport.
   */
  scroller?: HTMLElement;
}

export interface TocHandle {
  /** Number of headings picked up. Zero means the caller should hide the chip. */
  readonly count: number;
  /** Disconnect the observer and drop listeners. Idempotent. */
  dispose(): void;
}

/** Heading levels that earn a TOC entry. h5/h6 are too fine for a popup. */
export const TOC_HEADING_SELECTOR = "h1, h2, h3, h4";

/** Class on the entry whose heading is currently in view. */
export const TOC_ACTIVE_CLASS = "active";

export function buildToc(opts: TocOptions): TocHandle {
  const { content, sidebar, scroller } = opts;

  const headings = Array.from(
    content.querySelectorAll<HTMLHeadingElement>(TOC_HEADING_SELECTOR),
  ).filter((h) => h.id.length > 0);

  sidebar.innerHTML = "";

  const list = sidebar.ownerDocument.createElement("ul");
  list.className = "reck-toc";
  const links = new Map<Element, HTMLAnchorElement>();

  for (const heading of headings) {
    const level = Number(heading.tagName[1]);
    const item = sidebar.ownerDocument.createElement("li");
    item.setAttribute("data-level", String(level));

    const link = sidebar.ownerDocument.createElement("a");
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent ?? "";
    link.addEventListener("click", (ev) => {
      // A real anchor navigation inside the popup would be a page load — the
      // popup has no history UI to get back from it.
      ev.preventDefault();
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    item.appendChild(link);
    list.appendChild(item);
    links.set(heading, link);
  }
  sidebar.appendChild(list);

  // Scroll-spy. Absent in jsdom (and conceivably disabled elsewhere) — the
  // list still renders, we just lose the active highlight.
  let observer: IntersectionObserver | null = null;
  if (headings.length > 0 && typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          links
            .get(entry.target)
            ?.classList.toggle(TOC_ACTIVE_CLASS, entry.isIntersecting);
        }
      },
      {
        // Only the top slice of the scroller counts as "current", otherwise
        // every heading on a tall screen lights up at once.
        root: scroller ?? null,
        rootMargin: "0px 0px -70% 0px",
      },
    );
    for (const heading of headings) observer.observe(heading);
  }

  let disposed = false;
  return {
    count: headings.length,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      observer = null;
      links.clear();
    },
  };
}
