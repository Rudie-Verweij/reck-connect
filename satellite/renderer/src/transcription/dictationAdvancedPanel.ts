// Developer/testing panel opened by right-clicking the floating mic button.
// Lets the user live-tune the dictation overlay's look (blur, timing, font,
// blobs, theme, chunking) with immediate apply + persist. The actual controls
// are the SHARED `renderAppearanceControls` component — the exact same rows the
// tuning lab uses — so tuning transfers 1:1. This file only owns the panel
// chrome: header, footer, positioning, and outside-click/Escape dismissal
// (mirrors languageMenu.ts so it feels like the mic context menu).

import {
  coerceAppearance,
  DEFAULT_APPEARANCE,
  type DictationAppearance,
} from "./transcriptionSettings";
import { renderAppearanceControls } from "./appearanceControls";
import { confirmDialog, confirmDialogOpen } from "../ui/confirmDialog";

export interface AdvancedPanelOpts {
  current: DictationAppearance;
  /** Called on EVERY control change with the full next appearance — used for LIVE apply + persist. */
  onChange: (next: DictationAppearance) => void;
  /** Optional: called when the panel closes. */
  onClose?: () => void;
}

/**
 * Open the panel with its BOTTOM edge at `y` and horizontally CENTERED on `x`
 * (the mouse position where "Advanced…" was clicked), so it grows upward from
 * the cursor and never covers the mic or the live pill below it.
 */
export function showDictationAdvancedPanel(x: number, y: number, opts: AdvancedPanelOpts): void {
  // One panel at a time.
  document.querySelector(".dictation-adv-panel")?.remove();

  const panel = document.createElement("div");
  panel.className = "dictation-adv-panel";
  // Off-screen first so measuring doesn't flash at (0,0).
  panel.style.left = "-9999px";
  panel.style.top = "-9999px";

  // --- Header (title + close button) ---
  const header = document.createElement("div");
  header.className = "dictation-adv-header";
  const title = document.createElement("span");
  title.className = "dictation-adv-title";
  title.textContent = "Dictation appearance";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dictation-adv-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => cleanup());
  header.append(title, closeBtn);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.className = "dictation-adv-body";
  panel.appendChild(body);

  // The shared controls — identical to the lab's. Coerce + emit on every change.
  const controls = renderAppearanceControls(body, {
    current: coerceAppearance(opts.current),
    onChange: (next) => opts.onChange(next),
  });

  // Link to the full tuning lab (replayable timelines + every knob).
  const labRow = document.createElement("div");
  labRow.className = "dictation-adv-row";
  const labLink = document.createElement("button");
  labLink.type = "button";
  labLink.className = "dictation-adv-lablink";
  labLink.textContent = "Open tuning lab ↗";
  labLink.title = "Replay sample dictations and tune every setting in a full page";
  labLink.addEventListener("click", () => {
    window.open("dictation-lab.html", "_blank", "noopener");
  });
  labRow.appendChild(labLink);
  body.appendChild(labRow);

  // --- Footer (Reset + Done) ---
  const footer = document.createElement("div");
  footer.className = "dictation-adv-footer";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "dictation-adv-btn dictation-adv-btn-ghost";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Reset appearance to defaults?",
      detail: "This discards your current tuning and restores the shipped values.",
      confirmLabel: "Yes, reset",
      cancelLabel: "No",
    });
    if (!ok) return;
    const next = { ...DEFAULT_APPEARANCE };
    controls.setAll(next);
    opts.onChange(next);
  });

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "dictation-adv-btn dictation-adv-btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => cleanup());

  footer.append(resetBtn, doneBtn);
  panel.appendChild(footer);

  document.body.appendChild(panel);

  // Position: bottom edge at `y`, centered on `x`, clamped fully on screen.
  // Use offsetWidth/offsetHeight (the untransformed LAYOUT size) — the panel's
  // scale-in entrance animation makes getBoundingClientRect() read short
  // mid-animation, which pushed the bottom well past the click point.
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, x - w / 2),
    Math.max(margin, window.innerWidth - margin - w),
  );
  const top = Math.min(
    Math.max(margin, y - h),
    Math.max(margin, window.innerHeight - margin - h),
  );
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    panel.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const onOutside = (e: PointerEvent): void => {
    // The confirm dialog sits above the panel; clicking it must not close us.
    if (confirmDialogOpen()) return;
    if (!panel.contains(e.target as Node)) cleanup();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (confirmDialogOpen()) return; // the dialog handles its own Escape
    if (e.key === "Escape") cleanup();
  };
  // Defer so the opening right-click doesn't immediately dismiss it.
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}
