import type { HostRef } from "../host";

interface HostCopy {
  /** Dialog title and aria-label. */
  title: string;
  /** Body paragraph above the input. Accepts inline <code> markup. */
  body: string;
}

/**
 * Per-host copy for the token-update dialog. Hybrid mode (an earlier release,
 * plan rev 3.1, Phase 3) introduces independent station + local
 * tokens; the prompt has to tell the user *which* token they're
 * pasting so they can grab the right one.
 *
 * Station: the daemon's bearer comes from `/etc/reck-stationd/token`
 * on the station host.
 *
 * Local: Phase 5 generates a fresh 32-byte random token in the
 * Electron main process every time the local daemon spawns and passes
 * it to the daemon via `DAEMON_TOKEN=`. The token only lives in
 * Electron main-process memory — the user shouldn't normally need to
 * paste anything. The dialog still exists so a 1008 close on the
 * local client surfaces *something* visible to the user; the help
 * text explains the rotate-on-restart behaviour and the Cancel path
 * waits for the next spawn.
 */
const HOST_COPY: Record<HostRef, HostCopy> = {
  station: {
    title: "Update station token",
    body: 'Paste the current daemon token from the station. On the station, read it with <code>sudo cat /etc/reck-stationd/token</code>.',
  },
  local: {
    title: "Update local-daemon token",
    body: "The local daemon rotates its bearer on every spawn. Cancel and let the daemon restart, or paste the current token if you know it.",
  },
};

/**
 * Prompt for an updated daemon token. Resolves to the new token
 * string, or null if the user cancelled. The empty-string is treated
 * as cancel — the token is required for whichever host the prompt was
 * raised against.
 *
 * `host` controls the copy (station vs local-daemon). The caller is
 * responsible for routing the resulting token to the right place
 * (`saveStationToken` / `setApiTokenForHost`).
 */
export function promptForToken(
  host: HostRef,
  currentToken: string,
  reason?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const copy = HOST_COPY[host];
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";
    const reasonHtml = reason
      ? `<p style="margin-top:4px; font-size:12px; color:var(--sl-red);"></p>`
      : "";
    overlay.innerHTML = `
      <div class="options" role="dialog" aria-label="${copy.title}" style="max-width:460px;">
        <div class="dialog-title">${copy.title}</div>
        <div class="dialog-body" style="margin-top:12px;">
          ${reasonHtml}
          <p style="font-size:13px;">${copy.body}</p>
          <input id="tok-input" type="password" autocomplete="off" spellcheck="false" style="width:100%; margin-top:10px;" />
        </div>
        <div class="dialog-buttons" style="margin-top:16px;">
          <button id="tok-cancel" type="button">Cancel</button>
          <button id="tok-save" class="primary" type="button">Save</button>
        </div>
      </div>
    `;
    if (reason) {
      (overlay.querySelector(".dialog-body p") as HTMLElement).textContent = reason;
    }
    const input = overlay.querySelector("#tok-input") as HTMLInputElement;
    input.value = currentToken;
    document.body.appendChild(overlay);

    const finish = (value: string | null) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const commit = () => {
      const v = input.value.trim();
      if (!v) return finish(null);
      finish(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
      if (e.key === "Enter") commit();
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    (overlay.querySelector("#tok-cancel") as HTMLElement).addEventListener("click", () =>
      finish(null),
    );
    (overlay.querySelector("#tok-save") as HTMLElement).addEventListener("click", commit);
    input.focus();
    input.select();
  });
}
