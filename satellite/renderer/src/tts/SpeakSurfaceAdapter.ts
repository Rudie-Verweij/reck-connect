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

/** The user-configurable highlight colour pushed to a surface. Only the
 *  background is configurable; `foregroundColor` is reserved/optional. */
export interface SurfaceHighlightTheme {
  backgroundColor: string;
  foregroundColor?: string;
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

  /** Apply the user-chosen highlight colour. The controller pushes this on
   *  `start()` and whenever the theme changes, so every surface honours the
   *  same configured colour. Optional for forward-compatibility. */
  setTheme?(theme: SurfaceHighlightTheme): void;

  /** Subscribe to "the visible content may have changed" (scroll / repaint),
   *  debounced. The controller uses this to re-resolve the upcoming words
   *  mid-playback. Returns an unsubscribe fn. Surfaces with a fixed document
   *  (markdown, CodeMirror) leave this undefined → the controller never
   *  re-resolves them. Optional. */
  onContentChange?(cb: () => void): () => void;

  /** Re-resolve "what is on screen now, minus the pinned status line" for a
   *  live re-swap. Returns null when re-resolution should not happen (e.g. a
   *  selection-based read, or a non-alt-screen terminal). Optional; only the
   *  terminal implements it. */
  resolveUpcomingChunk?(): SpokenChunk | null;

  /** Tear down resources (overlays, decorations, listeners). */
  dispose(): void;
}
