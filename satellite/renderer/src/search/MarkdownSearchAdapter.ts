// `MarkdownSearchAdapter` — search over rendered markdown HTML. Mirrors
// the TTS `MarkdownSurfaceAdapter`'s text-walking: a TreeWalker joins the
// rendered text nodes into one flat string (block tags add a newline
// separator) while recording each text node's offset span, so a flat
// match offset can be mapped back to a DOM (node, offset) pair.
//
// Match highlighting uses the CSS Custom Highlight API
// (`CSS.highlights` + `Highlight` + the `::highlight()` pseudo-element):
// we register the match Ranges without mutating the DOM, so the prose,
// the existing internal-link anchors and the TTS overlay are all left
// intact. The API ships in Electron 30 (Chromium); where it's absent
// (jsdom) registration is skipped — the Ranges are still built so the
// adapter's behaviour stays testable.

import type { OffsetRange } from "./matcher";
import type { SearchSurfaceAdapter, SurfaceKind } from "./SearchSurfaceAdapter";

export interface MarkdownSearchAdapterOptions {
  /** Where the search bar mounts. Must be `position: relative`. */
  container: HTMLElement;
  /** The rendered-markdown scroll container (`.file-viewer-body`). */
  body: HTMLElement;
}

interface NodeOffset {
  node: Text;
  start: number;
  end: number;
}

const HIGHLIGHT_NAME = "reck-search";
const ACTIVE_HIGHLIGHT_NAME = "reck-search-active";

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "BR", "HR",
  "ARTICLE", "SECTION", "HEADER", "FOOTER", "TABLE", "TR",
]);

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

export class MarkdownSearchAdapter implements SearchSurfaceAdapter {
  readonly kind: SurfaceKind = "markdown";

  private readonly container: HTMLElement;
  private readonly body: HTMLElement;
  private disposed = false;

  private nodeOffsets: NodeOffset[] = [];
  private indexBuilt = false;
  private matchRanges: Range[] = [];
  private activeIdx = -1;

  constructor(opts: MarkdownSearchAdapterOptions) {
    this.container = opts.container;
    this.body = opts.body;
  }

  getContainerEl(): HTMLElement {
    return this.container;
  }

  getText(): string {
    if (this.disposed) return "";
    return this.buildIndex();
  }

  highlightMatches(ranges: readonly OffsetRange[], activeIndex: number): void {
    if (this.disposed) return;
    if (!this.indexBuilt) this.buildIndex();

    this.matchRanges = [];
    this.activeIdx = -1;
    for (let i = 0; i < ranges.length; i++) {
      const range = this.rangeFor(ranges[i]);
      if (!range) continue;
      if (i === activeIndex) this.activeIdx = this.matchRanges.length;
      this.matchRanges.push(range);
    }
    this.applyHighlights();
  }

  scrollToMatch(range: OffsetRange): void {
    if (this.disposed) return;
    if (!this.indexBuilt) this.buildIndex();
    const domRange = this.rangeFor(range);
    const target =
      domRange?.startContainer.parentElement ??
      (domRange?.startContainer as Element | null);
    // Reveal matches hidden inside collapsed <details> (transcript tool/
    // thinking blocks): a closed details gives the match no box, so
    // scrollIntoView would silently do nothing. Open every closed
    // ancestor before scrolling.
    let ancestor: Element | null = target;
    while (ancestor && ancestor !== this.body) {
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
        ancestor.open = true;
      }
      ancestor = ancestor.parentElement;
    }
    try {
      target?.scrollIntoView?.({ block: "center", inline: "nearest" });
    } catch {
      // jsdom has no layout; scrollIntoView is a harmless no-op there.
    }
  }

  clearHighlights(): void {
    if (this.disposed) return;
    this.matchRanges = [];
    this.activeIdx = -1;
    const reg = highlightRegistry();
    if (reg) {
      reg.delete(HIGHLIGHT_NAME);
      reg.delete(ACTIVE_HIGHLIGHT_NAME);
    }
  }

  fractionForOffset(offset: number): number | null {
    if (this.disposed) return null;
    if (!this.indexBuilt) this.buildIndex();
    const range = this.rangeFor({ start: offset, end: offset });
    if (!range) return null;
    try {
      let rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        // No box — the match is hidden inside a collapsed <details>
        // (transcript tool/thinking blocks). Anchor the tick to the
        // nearest ancestor that has a box (the details element itself)
        // so it lands where the match actually lives in the document,
        // instead of collapsing to a garbage position.
        let el: Element | null = range.startContainer.parentElement;
        while (el && el !== this.body) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            rect = r;
            break;
          }
          el = el.parentElement;
        }
      }
      const bodyRect = this.body.getBoundingClientRect();
      const scrollHeight = this.body.scrollHeight;
      if (scrollHeight <= 0) return null;
      const contentTop = rect.top - bodyRect.top + this.body.scrollTop;
      return Math.max(0, Math.min(1, contentTop / scrollHeight));
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    const reg = highlightRegistry();
    if (reg) {
      reg.delete(HIGHLIGHT_NAME);
      reg.delete(ACTIVE_HIGHLIGHT_NAME);
    }
    this.disposed = true;
    this.matchRanges = [];
    this.activeIdx = -1;
    this.nodeOffsets = [];
    this.indexBuilt = false;
  }

  /** Test introspection: number of DOM ranges built for the last match set. */
  __matchCount(): number {
    return this.matchRanges.length;
  }

  /** Test introspection: text of the active match range (or null). */
  __activeRangeText(): string | null {
    if (this.activeIdx < 0 || this.activeIdx >= this.matchRanges.length) return null;
    return this.matchRanges[this.activeIdx].toString();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private buildIndex(): string {
    const parts: string[] = [];
    this.nodeOffsets = [];
    let cursor = 0;
    let needsSeparator = false;
    const walker = document.createTreeWalker(
      this.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null,
    );
    let node: Node | null = walker.currentNode;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node as Text;
        const text = t.data;
        if (!text) continue;
        if (needsSeparator && cursor > 0) {
          parts.push("\n");
          cursor += 1;
          needsSeparator = false;
        }
        const start = cursor;
        parts.push(text);
        const end = start + text.length;
        this.nodeOffsets.push({ node: t, start, end });
        cursor = end;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (BLOCK_TAGS.has((node as Element).tagName)) needsSeparator = true;
      }
    }
    this.indexBuilt = true;
    return parts.join("");
  }

  private rangeFor(r: OffsetRange): Range | null {
    const start = this.locateAnchor(r.start);
    const end = this.locateAnchor(r.end);
    if (!start || !end) return null;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    } catch {
      return null;
    }
  }

  private locateAnchor(charIndex: number): { node: Text; offset: number } | null {
    for (const n of this.nodeOffsets) {
      if (charIndex >= n.start && charIndex <= n.end) {
        return { node: n.node, offset: charIndex - n.start };
      }
    }
    return null;
  }

  private applyHighlights(): void {
    const reg = highlightRegistry();
    const HighlightCtor = highlightConstructor();
    if (!reg || !HighlightCtor) return; // unsupported (jsdom) — ranges still built
    reg.delete(HIGHLIGHT_NAME);
    reg.delete(ACTIVE_HIGHLIGHT_NAME);
    const inactive = this.matchRanges.filter((_, i) => i !== this.activeIdx);
    if (inactive.length > 0) reg.set(HIGHLIGHT_NAME, new HighlightCtor(...inactive));
    if (this.activeIdx >= 0) {
      reg.set(ACTIVE_HIGHLIGHT_NAME, new HighlightCtor(this.matchRanges[this.activeIdx]));
    }
  }
}

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

function highlightConstructor(): (new (...ranges: Range[]) => unknown) | null {
  const ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  return typeof ctor === "function" ? ctor : null;
}
