// The TOC sidebar's collapse configuration.
//
// Mirrors `ui/rail-collapse.ts`: that file holds the rail's constants and a
// preconfigured instance of the shared model; this one does the same for the
// file viewer's table of contents. Both panels therefore behave identically —
// same sticky zone, same elastic stretch, same spring — differing only in
// their dimensions.
//
// The numbers are smaller than the rail's because the popup is smaller: a
// 240px rail inside a file-viewer popup would eat most of the reading column.
// TOC_MINI is 0 rather than the rail's 48: a mini rail still shows project
// avatars and stays useful, but a 48px sliver of a TOC shows nothing legible,
// so collapsed means gone and the header chip is what brings it back.

import { createCollapseModel } from "../ui/collapse-model";

export const TOC_MAX = 220;
export const TOC_MINI = 0;
export const TOC_COLLAPSE_AT = 120;
export const TOC_STICKY_PX = 24;
export const TOC_STRETCH_FACTOR = 0.35;
export const TOC_EXPAND_COMMIT_PX = 20;

/** Width the sidebar opens at before the user has resized it. */
export const TOC_DEFAULT_WIDTH = TOC_MAX;

export const tocCollapseModel = createCollapseModel({
  max: TOC_MAX,
  mini: TOC_MINI,
  collapseAt: TOC_COLLAPSE_AT,
  stickyPx: TOC_STICKY_PX,
  stretchFactor: TOC_STRETCH_FACTOR,
  expandCommitPx: TOC_EXPAND_COMMIT_PX,
});
