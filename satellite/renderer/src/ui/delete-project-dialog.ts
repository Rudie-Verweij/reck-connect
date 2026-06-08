export function confirmDeleteProject(name: string, slug: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options" role="alertdialog" aria-label="Delete project" style="max-width:460px;">
        <div class="dialog-title">Delete this project?</div>
        <div class="dialog-body" style="margin-top:12px;">
          <p>This permanently deletes <strong></strong> and all its files on the station.</p>
          <p style="margin-top:8px; font-size:12px; opacity:0.7;">Slug: <code></code></p>
          <p style="margin-top:8px; font-size:12px; opacity:0.7;">This cannot be undone.</p>
        </div>
        <div class="dialog-buttons" style="margin-top:16px;">
          <button id="del-cancel" type="button">Cancel</button>
          <button id="del-ok" class="primary danger" type="button">Delete</button>
        </div>
      </div>
    `;
    (overlay.querySelector(".dialog-body strong") as HTMLElement).textContent = name;
    (overlay.querySelector(".dialog-body code") as HTMLElement).textContent = slug;
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
    (overlay.querySelector("#del-cancel") as HTMLElement).addEventListener("click", () =>
      finish(false),
    );
    (overlay.querySelector("#del-ok") as HTMLElement).addEventListener("click", () =>
      finish(true),
    );
    (overlay.querySelector("#del-cancel") as HTMLElement).focus();
  });
}
