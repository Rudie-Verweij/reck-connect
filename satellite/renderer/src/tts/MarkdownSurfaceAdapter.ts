// `MarkdownSurfaceAdapter` — speaks rendered markdown via the unified
// TTS controller. The rendered body is a sanitized DOM tree (from
// MarkdownRenderer); we walk its text nodes to build the SpokenChunk
// + a per-word rangemap whose entries point back into the original DOM
// via (textNode, offset) pairs. When the engine fires a `boundary` event
// for a word, we look up the DOM Range, compute its bounding rect, and
// position an absolute-positioned `.tts-highlight-overlay` element over
// it. The rendered DOM is never mutated — the overlay floats above the
// content, so the prose typography stays intact.
//
// The overlay is appended INTO the scroll container
// (`body`, i.e. `.file-viewer-body`) so when the user scrolls the popup
// body the overlay translates with the markdown content automatically.
// Previously it was appended to `container` (#viewer-root) which is the
// popup's outer grid and does NOT scroll; the overlay stayed pinned to
// a viewport-fixed position while the text scrolled beneath it. A
// `scroll` listener on the body also re-paints from the last cached
// `RangeAnchor` so reflow mid-scroll (e.g. font load completing) doesn't
// strand the overlay.
//
// jsdom note: `Range.getBoundingClientRect()` returns zeroed coords in
// jsdom because layout isn't computed. The adapter still mounts the
// overlay (covered by tests) but the rect is degenerate; real positioning
// only works in a real browser context (Electron renderer). That's
// acceptable — the visual correctness is verified manually; jsdom tests
// only assert structural behaviour (overlay mounted, removed on clear).

import type { SpokenChunk, TtsBoundary, RangeMapEntry } from "./TtsEngine";
import type {
  SpeakSurfaceAdapter,
  SurfaceHighlightTheme,
  SurfaceKind,
  SurfacePoint,
} from "./SpeakSurfaceAdapter";

// Translucency applied to the (solid) configured highlight colour so the
// prose reads through the tint — matching the terminal overlay's opacity.
const OVERLAY_OPACITY = "0.5";

export interface MarkdownSurfaceAdapterOptions {
  /** Where to mount the SpeakControlBar (and the highlight overlay).
   *  Must be `position: relative`. */
  container: HTMLElement;
  /** The rendered-markdown root. Text content is extracted from this. */
  body: HTMLElement;
}

interface DomAnchor {
  node: Text;
  offset: number;
}

interface RangeAnchor {
  start: DomAnchor;
  end: DomAnchor;
}

const WORD_REGEX = /\S+/g;

export class MarkdownSurfaceAdapter implements SpeakSurfaceAdapter {
  readonly kind: SurfaceKind = "markdown";

  private readonly container: HTMLElement;
  private readonly body: HTMLElement;
  private overlayEl: HTMLElement | null = null;
  // Configured highlight colour (solid hex). Defaults to a neutral yellow
  // until the controller pushes the user's theme via setTheme().
  private highlightColor = "#ffeb3b";
  // charStart → DOM range anchor map, populated by resolveSpokenChunk.
  // Used by highlightBoundary to find where to paint.
  private charToRange = new Map<number, RangeAnchor>();
  private disposed = false;
  // Last anchor painted, used by the body scroll
  // listener to re-run the position math. Cleared in clearHighlight.
  private currentAnchor: RangeAnchor | null = null;
  // Lazy-installed scroll listener bound to `paintOverlay(currentAnchor)`.
  // null until the first highlightBoundary; reset to null on teardown.
  private onBodyScroll: (() => void) | null = null;

  constructor(opts: MarkdownSurfaceAdapterOptions) {
    this.container = opts.container;
    this.body = opts.body;
  }

  getContainerEl(): HTMLElement {
    return this.container;
  }

  resolveSpokenChunk(point?: SurfacePoint): SpokenChunk {
    if (this.disposed) return { text: "", rangeMap: [] };
    // Walk the rendered DOM, collecting text nodes + their character
    // offsets in the joined text buffer. Block-level elements add a
    // newline boundary so adjacent paragraphs/headings don't run their
    // words together in speech.
    const parts: string[] = [];
    const nodeOffsets: Array<{ node: Text; start: number; end: number }> = [];
    let cursor = 0;
    const walker = document.createTreeWalker(
      this.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null,
    );
    const blockTags = new Set([
      "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
      "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "BR", "HR",
      "ARTICLE", "SECTION", "HEADER", "FOOTER",
    ]);
    let needsSeparator = false;
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
        nodeOffsets.push({ node: t, start, end });
        cursor = end;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName;
        if (blockTags.has(tag)) needsSeparator = true;
      }
    }

    const joined = parts.join("");

    // Honour the SurfacePoint so the
    // popup supports "speak from here". `document.caretRangeFromPoint`
    // returns the Range under the mouse; map its (node, offset) to a
    // joined-text index, snap to a word start, then slice from there.
    let startOffset = 0;
    if (point) {
      const offset = caretOffsetFromPoint(
        point.pixelX,
        point.pixelY,
        nodeOffsets,
      );
      if (typeof offset === "number") {
        startOffset = snapToWordStart(joined, offset);
      }
    }

    const text = startOffset === 0 ? joined : joined.slice(startOffset);
    const rangeMap: RangeMapEntry[] = [];
    this.charToRange.clear();

    WORD_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_REGEX.exec(text)) !== null) {
      const word = m[0];
      const chunkCharStart = m.index;
      const chunkCharEnd = chunkCharStart + word.length;
      const absStart = startOffset + chunkCharStart;
      const absEnd = startOffset + chunkCharEnd;
      // Locate the text nodes covering the ABSOLUTE [absStart, absEnd).
      const startAnchor = locateAnchor(nodeOffsets, absStart);
      const endAnchor = locateAnchor(nodeOffsets, absEnd);
      if (!startAnchor || !endAnchor) continue;
      // line/col aren't used by the markdown surface — the highlight is
      // looked up by `col` via charToRange. `col` is the ABSOLUTE
      // joined-text offset so a sliced chunk's boundary events still
      // resolve to the same DOM range (independent of the slice base).
      rangeMap.push({
        charStart: chunkCharStart,
        charEnd: chunkCharEnd,
        line: 0,
        col: absStart,
        len: word.length,
      });
      this.charToRange.set(absStart, { start: startAnchor, end: endAnchor });
    }

    return { text, rangeMap };
  }

  highlightBoundary(b: TtsBoundary): void {
    if (this.disposed) return;
    // The engine emits boundary with line/col mirroring the rangeMap.
    // The col is the charStart we stashed when building the chunk;
    // look up the DOM range and position the overlay over it.
    const anchor = this.charToRange.get(b.col);
    if (!anchor) return;
    if (!this.overlayEl) {
      this.overlayEl = document.createElement("div");
      this.overlayEl.className = "tts-highlight-overlay";
      this.overlayEl.style.position = "absolute";
      this.overlayEl.style.pointerEvents = "none";
      this.overlayEl.style.background = this.highlightColor;
      this.overlayEl.style.opacity = OVERLAY_OPACITY;
      this.overlayEl.style.borderRadius = "2px";
      // Append into the scroll container (body) so
      // scrolling the body translates the overlay with the content.
      // Previously this was `this.container` (#viewer-root) which is the
      // popup's outer grid and does NOT scroll; the overlay stranded on
      // viewport-fixed coordinates while the text scrolled away.
      this.body.appendChild(this.overlayEl);
    }
    this.currentAnchor = anchor;
    // Install the scroll listener lazily so we
    // recompute the overlay's rect when the user scrolls. Without this,
    // even with the overlay parented to `body`, reflow mid-scroll (font
    // load, dynamic content) could leave the overlay slightly off — the
    // listener forces a re-paint from the cached anchor on every tick.
    if (!this.onBodyScroll) {
      this.onBodyScroll = () => {
        if (this.currentAnchor) this.paintOverlay(this.currentAnchor);
      };
      this.body.addEventListener("scroll", this.onBodyScroll, {
        passive: true,
      });
    }
    this.paintOverlay(anchor);
  }

  /**
   * Shared paint helper. Computes the overlay's
   * position from the anchor's DOM Range relative to the body's content
   * origin: (range viewport rect) − (body viewport rect) + (body scroll).
   * Because the overlay is `position: absolute` inside `position: relative`
   * `.file-viewer-body`, its `(0, 0)` is the body's padding-box top-left,
   * not shifted by scroll. So the math is straightforward viewport-delta
   * plus scroll offset.
   *
   * jsdom returns zeroed rects (no layout). Tests assert that `style.top`
   * CHANGES across scroll events, not specific pixel values.
   */
  private paintOverlay(anchor: RangeAnchor): void {
    if (!this.overlayEl) return;
    try {
      const range = document.createRange();
      range.setStart(anchor.start.node, anchor.start.offset);
      range.setEnd(anchor.end.node, anchor.end.offset);
      const getRect = (
        range as unknown as { getBoundingClientRect?: () => DOMRect }
      ).getBoundingClientRect;
      if (typeof getRect !== "function") return;
      const rect = getRect.call(range);
      const bodyRect = this.body.getBoundingClientRect();
      this.overlayEl.style.left = `${
        rect.left - bodyRect.left + this.body.scrollLeft
      }px`;
      this.overlayEl.style.top = `${
        rect.top - bodyRect.top + this.body.scrollTop
      }px`;
      this.overlayEl.style.width = `${rect.width}px`;
      this.overlayEl.style.height = `${rect.height}px`;
    } catch {
      // jsdom may throw on createRange/setStart in some configurations.
      // The overlay is still mounted (asserted by tests); positioning
      // simply doesn't take effect.
    }
  }

  clearHighlight(): void {
    if (this.disposed) return;
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    this.currentAnchor = null;
    if (this.onBodyScroll) {
      this.body.removeEventListener("scroll", this.onBodyScroll);
      this.onBodyScroll = null;
    }
  }

  setTheme(theme: SurfaceHighlightTheme): void {
    if (this.disposed) return;
    this.highlightColor = theme.backgroundColor;
    if (this.overlayEl) this.overlayEl.style.background = this.highlightColor;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    this.charToRange.clear();
    this.currentAnchor = null;
    if (this.onBodyScroll) {
      this.body.removeEventListener("scroll", this.onBodyScroll);
      this.onBodyScroll = null;
    }
  }
}

function locateAnchor(
  nodeOffsets: ReadonlyArray<{ node: Text; start: number; end: number }>,
  charIndex: number,
): DomAnchor | null {
  // Find the text node whose [start, end] contains charIndex (inclusive
  // on the end side so we can anchor a range's `setEnd` at the boundary).
  for (const n of nodeOffsets) {
    if (charIndex >= n.start && charIndex <= n.end) {
      return { node: n.node, offset: charIndex - n.start };
    }
  }
  return null;
}

/**
 * Map viewport pixel coordinates to a joined-text offset using the
 * browser's caret API. Prefers `document.caretRangeFromPoint` (Webkit,
 * Chromium) and falls back to `caretPositionFromPoint` (Gecko). Returns
 * null when no Text node is hit (or when running under jsdom without
 * the polyfill the test installs).
 */
function caretOffsetFromPoint(
  pixelX: number,
  pixelY: number,
  nodeOffsets: ReadonlyArray<{ node: Text; start: number; end: number }>,
): number | null {
  const doc = document as unknown as {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  let hitNode: Node | null = null;
  let hitOffset = 0;
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(pixelX, pixelY);
    if (range) {
      hitNode = range.startContainer;
      hitOffset = range.startOffset;
    }
  } else if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(pixelX, pixelY);
    if (pos) {
      hitNode = pos.offsetNode;
      hitOffset = pos.offset;
    }
  }
  if (!hitNode) return null;
  if (hitNode.nodeType !== Node.TEXT_NODE) return null;
  for (const n of nodeOffsets) {
    if (n.node === hitNode) {
      return n.start + Math.min(hitOffset, n.end - n.start);
    }
  }
  return null;
}

/**
 * Snap an offset BACKWARD to the start of the current word so playback
 * always begins at a word boundary. Mirrors PaneTextResolver's snap
 * semantics so all three surface adapters behave consistently.
 */
function snapToWordStart(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  if (/\s/.test(text[offset])) {
    let i = offset;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  }
  let i = offset;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}
