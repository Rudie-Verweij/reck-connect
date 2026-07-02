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
  /** Optional: true when the SURFACE owns scrolling and xterm's viewportY
   *  won't track it — i.e. a mouse-tracking TUI (Claude Code, less, vim) that
   *  grabs the wheel and redraws in place. The scrollbar then can't read a
   *  real position from metrics and falls back to a simulated (cumulative
   *  wheel-delta) thumb. Absent/false → the metrics are truthful. */
  ownsScroll?(): boolean;
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
  /** xterm's DEC mode set. `mouseTrackingMode !== 'none'` means a full-screen
   *  TUI (Claude Code, less, vim) has grabbed the mouse — see `ownsScroll`.
   *  Optional so fakes/older shims that don't model it default to truthful. */
  modes?: { mouseTrackingMode: string };
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
    // A mouse-tracking TUI repaints in place and never moves `viewportY`, so
    // the metrics above are frozen and a truthful thumb is impossible. Report
    // that so the scrollbar switches to its simulated (wheel-delta) thumb.
    // Default to "none" (truthful) when the terminal doesn't model modes.
    ownsScroll: () => (term.modes?.mouseTrackingMode ?? "none") !== "none",
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
