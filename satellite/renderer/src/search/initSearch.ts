// `initSearch` — the single entry point for the search subsystem, the
// same call for every surface (main-window terminal panes, detached
// popouts, and file-viewer popups), mirroring `initTts`.
//
// It owns the Cmd/Ctrl+F binding and a `SearchController`; per-surface
// behaviour lives entirely in the adapter returned by
// `getActiveSearchSurface`.

import { SearchController } from "./SearchController";
import { createSearchBar } from "./SearchBar";
import { installSearchShortcuts } from "./searchShortcuts";
import type { SearchSurfaceAdapter } from "./SearchSurfaceAdapter";

export interface InitSearchOptions {
  /** Resolves the currently-focused searchable surface, or null. */
  getActiveSearchSurface(): SearchSurfaceAdapter | null;
  /** Forwarded to the controller for the overlay scrollbar's match ticks
   *  (Phase 6). Optional. */
  onMatchesChanged?: (fractions: number[]) => void;
}

export interface SearchHandle {
  /** Programmatically open the search bar on the active surface. */
  open(): void;
  dispose(): void;
}

export function initSearch(opts: InitSearchOptions): SearchHandle {
  const controller = new SearchController({
    barFactory: (o) =>
      createSearchBar({
        parent: o.parent,
        callbacks: o.callbacks,
        initialOptions: o.initialOptions,
      }),
    getActiveSurface: () => opts.getActiveSearchSurface(),
    onMatchesChanged: opts.onMatchesChanged,
  });

  const offShortcuts = installSearchShortcuts({
    onFind: () => controller.open(),
  });

  let disposed = false;
  return {
    open: () => controller.open(),
    dispose() {
      if (disposed) return;
      disposed = true;
      offShortcuts();
      controller.dispose();
    },
  };
}
