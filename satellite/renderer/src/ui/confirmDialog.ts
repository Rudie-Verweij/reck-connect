// A small yes/no confirmation modal with a blurred, dimmed backdrop. Resolves
// true on confirm; false on cancel, backdrop click, or Escape. Shared so every
// "are you sure?" looks and behaves identically (see reuse-shared-components).

export interface ConfirmOpts {
  title: string;
  /** Optional secondary line under the title. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const card = document.createElement("div");
    card.className = "confirm-card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");

    const title = document.createElement("div");
    title.className = "confirm-title";
    title.textContent = opts.title;
    card.appendChild(title);

    if (opts.detail) {
      const detail = document.createElement("div");
      detail.className = "confirm-detail";
      detail.textContent = opts.detail;
      card.appendChild(detail);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "confirm-btn confirm-btn-ghost";
    cancelBtn.textContent = opts.cancelLabel ?? "No";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "confirm-btn confirm-btn-primary";
    confirmBtn.textContent = opts.confirmLabel ?? "Yes";

    actions.append(cancelBtn, confirmBtn);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    confirmBtn.focus();

    let done = false;
    const close = (result: boolean): void => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        close(true);
      }
    };

    // Backdrop click (outside the card) = No.
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close(false);
    });
    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    // Capture so it beats any host panel's own Escape/outside handlers.
    document.addEventListener("keydown", onKey, true);
  });
}

/** True while a confirm dialog is open — hosts use this to suppress their own
 *  outside-click / Escape dismissal so the dialog isn't fighting the panel. */
export function confirmDialogOpen(): boolean {
  return document.querySelector(".confirm-overlay") !== null;
}
