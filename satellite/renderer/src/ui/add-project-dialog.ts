import { ApiClient } from "@client-core/api/client";
import type { Project } from "@proto/proto";

type DialogResult =
  | { kind: "new"; name: string; preamble: string }
  | { kind: "existing"; cwd: string; name: string; preamble: string }
  | null;

// Vite inlines `import.meta.env.VITE_RECK_STATION_ROOT` at build time.
// Required — see `project-push.ts` for the full rationale.
const REMOTE_PROJECTS_ROOT: string = (() => {
  const v = (import.meta.env as Record<string, string | undefined>).VITE_RECK_STATION_ROOT;
  if (!v) throw new Error("VITE_RECK_STATION_ROOT is required at build time (Vite env)");
  return v;
})();

/** Slugify a project name the same way the daemon does:
 *  lowercase → non-[a-z0-9] runs become '-' → trim leading/trailing '-'. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || ""
  );
}

/** Runs the add-project flow. Defaults to name-first (daemon picks cwd);
 *  user can opt into folder-picker via the secondary button. An
 *  existing-folder pick is rsync'd to the station before the daemon
 *  registers it — the Satellite sends the station-side path, not the
 *  laptop one. */
export async function addProjectFlow(client: ApiClient): Promise<Project | null> {
  const picked = await promptAddProject();
  if (picked === null) return null;

  try {
    if (picked.kind === "existing") {
      return await copyAndRegisterExisting(client, picked);
    }
    const body: { name: string; preamble?: string } = { name: picked.name };
    if (picked.preamble) body.preamble = picked.preamble;
    const resp = await client.createProject(body);
    return resp.project;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await alertError(`Failed to add project: ${msg}`);
    return null;
  }
}

async function copyAndRegisterExisting(
  client: ApiClient,
  picked: { cwd: string; name: string; preamble: string },
): Promise<Project | null> {
  const slug = slugify(picked.name);
  if (!slug) {
    await alertError("Project name must contain at least one letter or digit.");
    return null;
  }

  const cancelFlag = { canceled: false };
  const overlay = showCopyProgress(picked.cwd, slug, async () => {
    cancelFlag.canceled = true;
    await window.reckAPI.rsync.cancel();
  });

  // an audit finding — collision detection lives inside `toStation` now
  // (atomic `mkdir` reservation on the station). A colliding slug surfaces
  // here as `result.code === "slug-in-use"` and is reported with the same
  // user-visible wording the old preflight used.
  const result = await window.reckAPI.rsync.toStation(picked.cwd, slug);
  overlay.remove();

  if (!result.ok) {
    if (result.code === "slug-in-use") {
      await alertError(
        `A folder already exists on the station at ${REMOTE_PROJECTS_ROOT}/${slug}.\n\nChoose a different name.`,
      );
      return null;
    }
    // For non-collision failures the main process has already rolled back
    // (if a reservation existed) before resolving — calling rollback again
    // here is harmless (it's `rm -rf` of a now-missing dir) and keeps the
    // cancel/error UX exactly as it was for users on older builds.
    await window.reckAPI.rsync.rollback(slug);
    if (!cancelFlag.canceled) {
      await alertError(`Copy failed: ${result.error}`);
    }
    return null;
  }

  try {
    const remoteCwd = `${REMOTE_PROJECTS_ROOT}/${slug}`;
    const body: { name: string; cwd: string; id: string; preamble?: string } = {
      name: picked.name,
      cwd: remoteCwd,
      id: slug,
    };
    if (picked.preamble) body.preamble = picked.preamble;
    const resp = await client.createProject(body);
    return resp.project;
  } catch (e: unknown) {
    await window.reckAPI.rsync.rollback(slug);
    const msg = e instanceof Error ? e.message : String(e);
    await alertError(`Copied files, but registration failed: ${msg}`);
    return null;
  }
}

function showCopyProgress(
  localPath: string,
  slug: string,
  onCancel: () => void,
): { remove: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "new-pane-dialog";
  overlay.innerHTML = `
    <div class="options" role="dialog" aria-label="Copying to station" style="max-width:480px;">
      <div class="dialog-title">Copying to station</div>
      <div class="dialog-body" style="margin-top:12px;">
        <div style="font-size:12px; opacity:0.8; margin-bottom:8px;">
          ${escapeHtml(localPath)} → ${REMOTE_PROJECTS_ROOT}/${escapeHtml(slug)}
        </div>
        <div style="height:6px; background:rgba(0,0,0,0.1); border-radius:3px; overflow:hidden;">
          <div id="ap-progress-fill" style="height:100%; width:0%; background:var(--accent, #5b8def); transition:width 0.15s ease;"></div>
        </div>
        <div id="ap-progress-text" style="margin-top:10px; font-size:11px; opacity:0.75; font-variant-numeric:tabular-nums;">
          Preparing…
        </div>
      </div>
      <div class="dialog-buttons" style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end;">
        <button id="ap-cancel-copy" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fill = overlay.querySelector("#ap-progress-fill") as HTMLElement;
  const text = overlay.querySelector("#ap-progress-text") as HTMLElement;
  window.reckAPI.rsync.onProgress((p) => {
    fill.style.width = `${p.percent}%`;
    const mb = (p.bytes / 1024 / 1024).toFixed(1);
    text.textContent = `${p.percent}% • ${mb} MB • ${p.speed} • ETA ${p.eta}`;
  });

  (overlay.querySelector("#ap-cancel-copy") as HTMLElement).addEventListener("click", onCancel);
  return { remove: () => overlay.remove() };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function promptAddProject(): Promise<DialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options" role="dialog" aria-label="Add a project" style="max-width:480px;">
        <div class="dialog-title">Add a project</div>
        <div class="dialog-body" style="margin-top:12px;">
          <label for="ap-name" style="display:block; font-size:12px; opacity:0.8;">Name</label>
          <input id="ap-name" type="text" class="text-input" placeholder="demo" />
          <label for="ap-preamble" style="display:block; margin-top:12px; font-size:12px; opacity:0.8;">Preamble (optional) — appended to Claude's system prompt on every session</label>
          <textarea id="ap-preamble" class="text-input" rows="4" style="margin-top:6px; resize:vertical; font-family:inherit;"></textarea>
          <div style="margin-top:14px; font-size:11px; opacity:0.65; line-height:1.4;">
            A new folder will be created at <code>~/reck/projects/&lt;slug&gt;</code> on the station. To copy an existing laptop folder to the station instead, use the secondary button below.
          </div>
        </div>
        <div class="dialog-buttons" style="margin-top:16px; display:flex; gap:8px; justify-content:flex-end; align-items:center;">
          <button id="ap-existing" type="button">From existing folder…</button>
          <div style="flex:1;"></div>
          <button id="ap-cancel" type="button">Cancel</button>
          <button id="ap-ok" class="primary" type="button">Create</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector("#ap-name") as HTMLInputElement;
    const preambleInput = overlay.querySelector("#ap-preamble") as HTMLTextAreaElement;
    requestAnimationFrame(() => nameInput.focus());

    const finish = (result: DialogResult) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const submitNew = () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      finish({ kind: "new", name, preamble: preambleInput.value.trim() });
    };
    const submitExisting = async () => {
      const cwd = await window.reckAPI.dialog.pickFolder();
      if (!cwd) return; // user canceled picker — stay in dialog
      const basename = cwd.split("/").filter(Boolean).pop() ?? "project";
      const name = nameInput.value.trim() || basename;
      finish({
        kind: "existing",
        cwd,
        name,
        preamble: preambleInput.value.trim(),
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.target === nameInput) {
        e.preventDefault();
        e.stopPropagation();
        submitNew();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    (overlay.querySelector("#ap-ok") as HTMLElement).addEventListener("click", submitNew);
    (overlay.querySelector("#ap-existing") as HTMLElement).addEventListener(
      "click",
      () => void submitExisting(),
    );
    (overlay.querySelector("#ap-cancel") as HTMLElement).addEventListener("click", () =>
      finish(null),
    );
  });
}

function alertError(message: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    overlay.innerHTML = `
      <div class="options" role="alertdialog" aria-label="Error" style="max-width:440px;">
        <div class="dialog-title">Could not add project</div>
        <div class="dialog-body"></div>
        <div class="dialog-buttons">
          <button id="ap-err-ok" class="primary" type="button">OK</button>
        </div>
      </div>
    `;
    (overlay.querySelector(".dialog-body") as HTMLElement).textContent = message;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    (overlay.querySelector("#ap-err-ok") as HTMLElement).addEventListener("click", close);
    (overlay.querySelector("#ap-err-ok") as HTMLElement).focus();
  });
}
