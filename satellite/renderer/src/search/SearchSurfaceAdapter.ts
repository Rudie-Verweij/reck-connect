// `SearchSurfaceAdapter` — the single abstraction every searchable surface
// implements, mirroring the TTS subsystem's `SpeakSurfaceAdapter`.
//
// The `SearchController` consumes adapters rather than xterm / CodeMirror /
// the markdown DOM directly, so the search bar, the matcher, and all
// navigation logic are written once and reused across:
//
//   - TerminalSearchAdapter   — xterm panes (main window + detached popout)
//   - MarkdownSearchAdapter    — file-viewer markdown body (CSS Custom Highlight)
//   - CodeMirrorSearchAdapter  — file-viewer CodeMirror surface (decorations)
//
// Matching is performed by `matcher.ts` over the adapter's flat `getText()`.
// The resulting `OffsetRange`s are in flat-text character offsets; each
// adapter knows how to map an offset range back to its own coordinate
// system (xterm buffer cell, CodeMirror doc position, or DOM Range) for
// highlighting and scrolling.

import type { OffsetRange } from "./matcher";

export type SurfaceKind = "terminal" | "markdown" | "codemirror";

export interface SearchSurfaceAdapter {
  readonly kind: SurfaceKind;

  /** Element the floating search bar mounts inside. Must be
   *  `position: relative` (or otherwise an offset parent) so the bar's
   *  absolute top/right anchoring resolves correctly. */
  getContainerEl(): HTMLElement;

  /** The full searchable content as one flat string. Offsets returned by
   *  the matcher index into exactly this string. Terminals join their
   *  whole scrollback; CodeMirror returns the document; markdown joins its
   *  rendered text nodes. */
  getText(): string;

  /** Paint every match. `activeIndex` is the index into `ranges` that
   *  should get the stronger "active match" styling (or -1 for none).
   *  Called on every query/option change and on next/prev navigation. */
  highlightMatches(ranges: readonly OffsetRange[], activeIndex: number): void;

  /** Bring the given match range into view (centred where practical). */
  scrollToMatch(range: OffsetRange): void;

  /** Drop all match highlighting. Called when the bar closes or the query
   *  is cleared. */
  clearHighlights(): void;

  /** Fractional vertical position (0..1) of a flat-text offset within the
   *  full content, used to place the overlay scrollbar's match ticks.
   *  Optional — returns null when the position can't be determined (e.g.
   *  no layout yet). */
  fractionForOffset?(offset: number): number | null;

  /** Tear down decorations / overlays / listeners. */
  dispose(): void;
}
