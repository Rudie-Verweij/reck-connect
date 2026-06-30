// `ScrollSurface` — the minimal scroll abstraction the OverlayScrollbar
// drives. It deliberately does NOT assume a DOM scroll element: the
// markdown body and CodeMirror scroller are real DOM scrollers, but the
// xterm terminal scrolls through its buffer API (line-based, no scrollable
// DOM node). Both are expressed as the same three operations.

export interface ScrollMetrics {
  /** Current scroll offset from the top (px for DOM, lines for xterm). */
  scrollTop: number;
  /** Total scrollable extent. */
  scrollHeight: number;
  /** Visible extent. */
  clientHeight: number;
}

export interface ScrollSurface {
  getMetrics(): ScrollMetrics;
  /** Scroll so the top sits at `fraction` (0..1) of the scrollable range. */
  scrollToFraction(fraction: number): void;
  /** Subscribe to scroll changes; returns an unsubscribe thunk. */
  onScroll(cb: () => void): () => void;
  /** Optional: fires when the surface re-renders without a scroll (new
   *  output, in-place TUI redraw, font/size change). The scrollbar uses this
   *  to recompute geometry — e.g. clear its disabled state once scrollback
   *  grows — WITHOUT flashing into view. Returns an unsubscribe thunk. */
  onRender?(cb: () => void): () => void;
}

/** A DOM scroll container (markdown `.file-viewer-body`, CodeMirror
 *  `.cm-scroller`). */
export function domScrollSurface(el: HTMLElement): ScrollSurface {
  return {
    getMetrics: () => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }),
    scrollToFraction: (fraction: number) => {
      const range = el.scrollHeight - el.clientHeight;
      el.scrollTop = clamp01(fraction) * Math.max(0, range);
    },
    onScroll: (cb) => {
      el.addEventListener("scroll", cb, { passive: true });
      return () => el.removeEventListener("scroll", cb);
    },
  };
}

interface ScrollableTerminal {
  readonly rows: number;
  buffer: { active: { length: number; baseY: number; viewportY: number } };
  scrollToLine(line: number): void;
  onScroll(cb: () => void): { dispose(): void };
  onRender?(cb: () => void): { dispose(): void };
}

/** An xterm terminal. Scroll position is line-based: `viewportY` is the
 *  top visible absolute line, `baseY` the max scroll-top (scrollback
 *  size), `length` the total buffer height, `rows` the viewport height. */
export function terminalScrollSurface(term: ScrollableTerminal): ScrollSurface {
  return {
    getMetrics: () => ({
      scrollTop: term.buffer.active.viewportY,
      scrollHeight: term.buffer.active.length,
      clientHeight: term.rows,
    }),
    scrollToFraction: (fraction: number) => {
      const line = Math.round(clamp01(fraction) * term.buffer.active.baseY);
      term.scrollToLine(line);
    },
    onScroll: (cb) => {
      const sub = term.onScroll(cb);
      return () => sub.dispose();
    },
    onRender: term.onRender
      ? (cb) => {
          const sub = term.onRender!(cb);
          return () => sub.dispose();
        }
      : undefined,
  };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
