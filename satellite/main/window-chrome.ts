// Window chrome geometry: where macOS draws the traffic lights.
//
// `titleBarStyle: "hiddenInset"` floats the lights over our own title bar, so
// their position is ours to get right — and getting it wrong is visible as the
// dots sitting off the title's centre line, which reads as a bug in the header
// rather than a window setting.
//
// The lights are a 12px-tall cluster whose `y` is its TOP, so centring them in a
// bar of height H means `y = H/2 - 6`. Because our bars are not all the same
// height, one shared position cannot centre in all of them: a single `y: 16`
// (centre 22) sat 3px LOW in the 38px popup bars and 3px HIGH in the 50px nav.
//
// These heights must track the CSS. `--nav-height` and the `38px` grid rows for
// `.popout-shell` / `.file-viewer-root` in renderer/src/styles.css are the
// source; if you change one, change it here.

/** Diameter of the traffic-light cluster, as macOS draws it. */
const TRAFFIC_LIGHT_SIZE = 12;

/** Left inset. Mirrors `--window-header-inset` reserving room after them. */
const TRAFFIC_LIGHT_X = 14;

/** Main window title bar — `--nav-height` in styles.css. */
export const NAV_HEIGHT = 50;

/** Popout + file-viewer title bars — the `38px` grid row in styles.css. */
export const POPUP_HEADER_HEIGHT = 38;

/** Traffic-light position that centres the cluster in a bar of `height`. */
export function trafficLightPositionFor(height: number): { x: number; y: number } {
  return {
    x: TRAFFIC_LIGHT_X,
    y: Math.round(height / 2 - TRAFFIC_LIGHT_SIZE / 2),
  };
}
