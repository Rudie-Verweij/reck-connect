// Round 8.5 — minimal auto-dismissing toast for file-viewer popups.
// Use case: a recursive Cmd+click on a link that resolves to the
// popup's own file. Main returns `{ok: true, code: "same-popup"}`;
// the renderer can't bring "no visible action" to the user without
// some hint, so we paint a small toast and fade it out.
//
// Intentionally minimal: a plain DOM helper, no framework, no
// dependency injection. Mounts into the passed parent, schedules
// auto-removal, returns a dispose handle so callers can dismiss
// early if they need to (none currently do).

/**
 * Round 8.6 follow-up (2026-05-21) — visual kind.
 *  - "info" (default): high-contrast Reck-orange branded toast for
 *    friendly hints ("Already viewing this file."). Top-right anchor,
 *    drop shadow, body font, larger than the prior cream-on-cream style.
 *  - "error": Wes-rose variant for failures ("Could not open: ...");
 *    also switches the live region to assertive so screen readers
 *    interrupt the user.
 */
export type ToastKind = "info" | "error";

export interface ToastOptions {
  durationMs?: number;
  fadeMs?: number;
  kind?: ToastKind;
}

export interface ToastHandle {
  dispose(): void;
  readonly element: HTMLElement;
}

const DEFAULT_DURATION_MS = 2000;
const DEFAULT_FADE_MS = 240;

// Accepts a number (the previous inline-helper shape: durationMs only) or
// a structured options object. Pre-existing callers in FileViewerHost.ts
// pass a number; the new same-popup-toast caller passes options.
export function showToast(
  parent: HTMLElement,
  message: string,
  optsOrDuration: ToastOptions | number = {},
): ToastHandle {
  const opts: ToastOptions =
    typeof optsOrDuration === "number"
      ? { durationMs: optsOrDuration }
      : optsOrDuration;
  const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
  const fade = opts.fadeMs ?? DEFAULT_FADE_MS;

  const toast = document.createElement("div");
  toast.className =
    opts.kind === "error"
      ? "file-viewer-toast file-viewer-toast--error"
      : "file-viewer-toast";
  toast.setAttribute("role", opts.kind === "error" ? "alert" : "status");
  toast.setAttribute(
    "aria-live",
    opts.kind === "error" ? "assertive" : "polite",
  );
  toast.textContent = message;
  parent.appendChild(toast);

  let disposed = false;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    if (removeTimer !== null) clearTimeout(removeTimer);
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  };

  fadeTimer = setTimeout(() => {
    if (disposed) return;
    toast.classList.add("file-viewer-toast--fade-out");
    removeTimer = setTimeout(() => {
      if (disposed) return;
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      disposed = true;
    }, fade);
  }, duration);

  return { dispose, element: toast };
}
