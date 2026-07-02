// Minimal loading-circle component for the file viewer's top-right
// header slot. Visible during file reads, saves, conflict-detection
// re-stats, and external-change reload round-trips.
//
// Pure DOM, no animation lib — a 16px circle with a CSS spin keyframe
// defined in styles.css. Use `mount(slot)` to attach into the
// .file-viewer-spinner-slot reserved earlier.

export interface SpinnerHandle {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  dispose(): void;
}

export function mountSpinner(slot: HTMLElement): SpinnerHandle {
  const el = document.createElement("span");
  el.className = "file-viewer-spinner";
  el.setAttribute("aria-label", "loading");
  el.setAttribute("role", "status");
  // Start hidden — the host explicitly calls `show()` on each in-flight
  // operation. CSS `display: none` keeps the spinner-slot's reserved 24x24
  // space intact so the surrounding chrome doesn't reflow.
  el.style.display = "none";
  slot.appendChild(el);

  // Track an in-flight count so concurrent operations (e.g., save +
  // watch reload) don't toggle the spinner off prematurely.
  let inflight = 0;
  return {
    show() {
      inflight++;
      el.style.display = "";
    },
    hide() {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) el.style.display = "none";
    },
    isVisible: () => el.style.display !== "none",
    dispose() {
      el.remove();
    },
  };
}
