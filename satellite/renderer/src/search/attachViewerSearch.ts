// `attachViewerSearch` — wires the search bar + overlay scrollbar into a
// file-viewer popup. Picks the CodeMirror or markdown adapter the same way
// the viewer picks its TTS adapter, mounts the auto-hiding scrollbar over
// the right scroll element, and routes match-tick fractions to it.
//
// Returns a single dispose() that tears down search, scrollbar and the
// adapter — called from the viewer's existing per-render teardown.

import { initSearch, type SearchHandle } from "./initSearch";
import { CodeMirrorSearchAdapter } from "./CodeMirrorSearchAdapter";
import { MarkdownSearchAdapter } from "./MarkdownSearchAdapter";
import { createOverlayScrollbar, type OverlayScrollbar } from "./OverlayScrollbar";
import { domScrollSurface } from "./scrollSurfaces";
import { ensurePaneControls } from "../ui/paneControls";
import type { SearchSurfaceAdapter } from "./SearchSurfaceAdapter";
import type { EditorView } from "@codemirror/view";

export interface ViewerSearchTarget {
  /** `.file-viewer-root` — positioned, non-scrolling; hosts the bar + bar. */
  root: HTMLElement;
  /** `.file-viewer-body` — the markdown scroll container. */
  body: HTMLElement;
  /** The CodeMirror view in source mode, or null for rendered markdown. */
  view: EditorView | null;
}

export interface ViewerSearchHandle {
  dispose(): void;
}

export function attachViewerSearch(t: ViewerSearchTarget): ViewerSearchHandle {
  // The search bar mounts into the shared top-right control stack (alongside
  // the TTS bar); the scrollbar still anchors to the root directly.
  const controls = ensurePaneControls(t.root);
  const adapter: SearchSurfaceAdapter = t.view
    ? new CodeMirrorSearchAdapter({ container: controls, view: t.view })
    : new MarkdownSearchAdapter({ container: controls, body: t.body });

  // CodeMirror scrolls inside its own scrollDOM; markdown scrolls the body.
  const scrollEl: HTMLElement = t.view ? t.view.scrollDOM : t.body;
  const scrollbar: OverlayScrollbar = createOverlayScrollbar({
    host: t.root,
    surface: domScrollSurface(scrollEl),
  });

  const search: SearchHandle = initSearch({
    getActiveSearchSurface: () => adapter,
    onMatchesChanged: (fractions) => scrollbar.setMatches(fractions),
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      search.dispose();
      scrollbar.dispose();
      adapter.dispose();
    },
  };
}
