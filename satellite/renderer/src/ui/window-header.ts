// The one window title bar.
//
// Every window in the app is `titleBarStyle: "hiddenInset"` (main window,
// detached-pane popout, file-viewer popup), which means the macOS traffic
// lights float over the top-left of OUR markup rather than sitting in an OS
// title bar. Three surfaces therefore need identical treatment, and before this
// module each had invented its own — the two popups reserved 78px of left
// padding, the nav used an 80px margin on its brand element.
//
// Two invariants live here, and they are the reason this is shared rather than
// copied:
//
//   1. The traffic-light inset is one value (`--window-header-inset` in
//      styles.css), which must stay in step with `trafficLightPosition` in the
//      main process.
//
//   2. **A title bar must never scale with zoom.** The traffic lights are drawn
//      by the OS at a fixed size, so a bar that grows on ⌘+ slides out of
//      alignment with them — which is the bug that prompted this. Zoom is
//      content-only (`--content-zoom`); `.reck-window-header` deliberately does
//      not reference it, and nothing added to it should.
//
// What is NOT shared: height, colours, typography and contents. The nav is 50px
// with brand styling; the popups are 38px, mono and uppercase. Forcing those
// into one shape would make the base a liability rather than a contract.

/** Base class carrying the drag region, traffic-light inset and no-zoom rule. */
export const WINDOW_HEADER_CLASS = "reck-window-header";

/**
 * Create a window title bar element.
 *
 * `extraClass` is the caller's own class — kept alongside the base, never
 * instead of it, so per-window styling stays additive.
 */
export function createWindowHeader(extraClass?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = extraClass
    ? `${WINDOW_HEADER_CLASS} ${extraClass}`
    : WINDOW_HEADER_CLASS;
  return el;
}
