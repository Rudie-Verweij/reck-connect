// `SpeakSurfaceAdapter` — the interface every speakable surface implements.
//
// Unify TTS across the three surfaces (xterm pane, markdown viewer,
// CodeMirror viewer) behind
// one contract. The TtsController consumes adapters rather than xterm
// directly, so it no longer needs to know whether the active speaker is
// a terminal buffer or a rendered DOM. Concrete adapters:
//
//   - TerminalPaneAdapter   — xterm panes (main window + detached popout)
//   - MarkdownSurfaceAdapter — file-viewer markdown body
//   - CodeMirrorSurfaceAdapter — file-viewer CodeMirror surface
//
// All three speak via the same TtsEngine, render the same SpeakControlBar,
// and respond to the same shortcuts (⌘⇧S / ⌘⇧X / ⌘⇧+ / ⌘⇧-).

import type { SpokenChunk, TtsBoundary } from "./TtsEngine";

export type SurfaceKind = "terminal" | "markdown" | "codemirror";

/** Pixel coordinates in the surface's local DOM, used for "speak from
 *  here" entry. Terminals translate this to xterm cell coords; markdown
 *  and CodeMirror surfaces in v1 always speak the full document and
 *  ignore the point. */
export interface SurfacePoint {
  pixelX: number;
  pixelY: number;
}

export interface SpeakSurfaceAdapter {
  readonly kind: SurfaceKind;

  /** Element that the floating SpeakControlBar mounts inside.
   *  Must be `position: relative` (or otherwise an offset parent) so the
   *  bar's `position: absolute; bottom; right` anchoring resolves
   *  correctly. */
  getContainerEl(): HTMLElement;

  /** Resolve the chunk of text to speak right now. Selection-aware
   *  surfaces (terminal) honour an active selection first; surfaces
   *  without a selection notion return the document body.
   *
   *  `point` is the most-recent mouse position in viewport pixels —
   *  surfaces that support "from here" reads (terminal) use it as a
   *  start anchor; the rest ignore it. Selection wins over point. */
  resolveSpokenChunk(point?: SurfacePoint): SpokenChunk;

  /** Render the highlight for `b`. The semantics of `b.line` / `b.col`
   *  are surface-defined — each adapter builds the rangeMap that drove
   *  the boundary and so knows how to map it back to a visual range. */
  highlightBoundary(b: TtsBoundary): void;

  /** Drop any active highlight. Called on stop / end / error. */
  clearHighlight(): void;

  /** Tear down resources (overlays, decorations, listeners). */
  dispose(): void;
}
