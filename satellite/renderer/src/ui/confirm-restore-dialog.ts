// Confirm dialog shown before restoring (unarchiving) a project. Waking a
// project respawns its panes — potentially several heavy agent processes —
// so the user opts in first. Mirrors the delete-project dialog's structure.
export function confirmRestoreProject(name: string, paneCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    const paneLabel =
      paneCount === 1 ? "1 pane" : paneCount > 1 ? `${paneCount} panes` : "its panes";
    overlay.innerHTML = `
      <div class="options" role="alertdialog" aria-label="Restore project" style="max-width:460px;">
        <div class="dialog-title">Restore this project?</div>
        <div class="dialog-body" style="margin-top:12px;">
          <p>This wakes <strong></strong> and reopens <span class="restore-pane-count"></span> on the station.</p>
          <p style="margin-top:8px; font-size:12px; opacity:0.7;">Archived projects use no memory until restored.</p>
        </div>
        <div class="dialog-buttons" style="margin-top:16px;">
          <button id="restore-cancel" type="button">Cancel</button>
          <button id="restore-ok" class="primary" type="button">Restore</button>
        </div>
      </div>
    `;
    (overlay.querySelector(".dialog-body strong") as HTMLElement).textContent = name;
    (overlay.querySelector(".restore-pane-count") as HTMLElement).textContent = paneLabel;
    document.body.appendChild(overlay);

    const finish = (ok: boolean) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    (overlay.querySelector("#restore-cancel") as HTMLElement).addEventListener("click", () =>
      finish(false),
    );
    (overlay.querySelector("#restore-ok") as HTMLElement).addEventListener("click", () =>
      finish(true),
    );
    (overlay.querySelector("#restore-ok") as HTMLElement).focus();
  });
}
