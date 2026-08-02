// Wires the TOC sidebar into a file-viewer shell: builds the list, mounts the
// header chip, and drives the open/close animation.
//
// The collapse behaviour is the rail's, not a new one. `createWidthAnimator`
// (spring easing, reduced-motion aware, rAF) is reused verbatim from
// ui/rail-collapse.ts, and the thresholds come from the shared collapse model
// via viewer/tocCollapse.ts — so opening the TOC feels exactly like expanding
// the rail. See ui/collapse-model.ts for why that generalization exists.

import { buildToc, type TocHandle } from "./Toc";
import { createWidthAnimator } from "../ui/rail-collapse";
import { TOC_MINI } from "./tocCollapse";
import {
  loadFileViewerTocMode,
  loadFileViewerTocWidth,
  saveFileViewerTocMode,
  type TocMode,
} from "../config";

/** Matches the rail's snap duration so the two panels move alike. */
const TOC_SNAP_MS = 200;

export interface AttachTocOptions {
  /** Rendered markdown container — also the scroll container. */
  body: HTMLElement;
  /** `<aside>` from the shell. */
  tocSlot: HTMLElement;
  /** Header slot for the chip. */
  tocToggleSlot: HTMLElement;
  /** The two-column row whose template columns we animate. */
  content: HTMLElement;
}

export interface TocController {
  dispose(): void;
}

function applyColumns(content: HTMLElement, width: number): void {
  content.style.gridTemplateColumns = `${width}px 1fr`;
}

/**
 * Build the TOC for the currently-mounted document and wire its chip.
 *
 * Call AFTER `MarkdownRenderer.whenEnhanced()` resolves — mermaid and KaTeX
 * change document height, which moves every scroll-spy threshold.
 *
 * A document with no headings gets no chip and no aside: the popup is small,
 * and a control that opens an empty panel is worse than no control.
 */
export async function attachToc(
  opts: AttachTocOptions,
): Promise<TocController> {
  const { body, tocSlot, tocToggleSlot, content } = opts;

  let toc: TocHandle | null = buildToc({
    content: body,
    sidebar: tocSlot,
    scroller: body,
  });

  if (toc.count === 0) {
    toc.dispose();
    toc = null;
    tocSlot.hidden = true;
    tocToggleSlot.innerHTML = "";
    applyColumns(content, TOC_MINI);
    return { dispose() {} };
  }

  const expandedWidth = await loadFileViewerTocWidth();
  let mode: TocMode = await loadFileViewerTocMode();
  let width = mode === "expanded" ? expandedWidth : TOC_MINI;

  tocSlot.hidden = mode !== "expanded";
  applyColumns(content, width);

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const animator = createWidthAnimator({
    getWidth: () => width,
    onFrame: (w) => {
      width = w;
      applyColumns(content, w);
    },
    reducedMotion: () => reducedMotion?.matches === true,
  });

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "reck-collapse-chip file-viewer-toc-toggle";
  chip.textContent = "☰";

  function paintChip(): void {
    const open = mode === "expanded";
    chip.setAttribute("aria-expanded", String(open));
    chip.title = open ? "Hide contents" : "Show contents";
    chip.setAttribute("aria-label", chip.title);
  }

  function setMode(next: TocMode): void {
    if (next === mode) return;
    mode = next;
    void saveFileViewerTocMode(next);
    paintChip();
    // Reveal before animating open so the content is there to slide in;
    // hide only once the collapse has finished, or it vanishes mid-flight.
    if (next === "expanded") tocSlot.hidden = false;
    animator.animateTo(next === "expanded" ? expandedWidth : TOC_MINI, {
      durationMs: TOC_SNAP_MS,
      easing: "spring",
      onDone: () => {
        if (mode !== "expanded") tocSlot.hidden = true;
      },
    });
  }

  const onChipClick = (): void =>
    setMode(mode === "expanded" ? "mini" : "expanded");
  chip.addEventListener("click", onChipClick);
  paintChip();

  tocToggleSlot.innerHTML = "";
  tocToggleSlot.appendChild(chip);

  return {
    dispose(): void {
      animator.cancel();
      chip.removeEventListener("click", onChipClick);
      toc?.dispose();
      toc = null;
      tocToggleSlot.innerHTML = "";
      tocSlot.innerHTML = "";
      tocSlot.hidden = true;
    },
  };
}
