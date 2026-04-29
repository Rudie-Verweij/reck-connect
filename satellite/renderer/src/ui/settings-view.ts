import {
  loadHoverToFocus,
  loadSettings,
  saveHoverToFocus,
  saveSettings,
} from "../config";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const DEFAULT_LOCAL_PORT = 7315;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Returns the offending "host:port" string when `stationUrl` resolves to
 * the same loopback host:port the local daemon would bind on
 * (`localPort`); returns null otherwise. an earlier release — both daemons would
 * race for the same socket and one fails to bind. Used by the save-time
 * validator + exported for tests.
 */
export function sameHostPortAsLocal(
  stationUrl: string,
  localPort: number,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(stationUrl);
  } catch {
    // Malformed URL is the daemon's problem at probe time; not a save-
    // time collision. Return null so the existing wiring still saves.
    return null;
  }
  // URL.hostname lowercases ASCII; bracketed IPv6 surfaces with the
  // brackets in some runtimes (jsdom/Chromium) and without in others
  // (Node native). Strip them so the loopback check is uniform.
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) return null;
  // URL.port is "" when the URL omits the port. http:// → 80, https:// → 443.
  let port: number;
  if (parsed.port !== "") {
    port = parseInt(parsed.port, 10);
  } else if (parsed.protocol === "https:") {
    port = 443;
  } else if (parsed.protocol === "http:") {
    port = 80;
  } else {
    return null;
  }
  if (port !== localPort) return null;
  return `${host}:${port}`;
}

/**
 * Preferences view — Phase 12 of the hybrid-mode work (plan rev 3.1,
 * an earlier release). an earlier release dropped the "local-only" mode: local is now
 * always available, station is the only host you choose to enable.
 * Hybrid is the only configuration shape; "no station" is just the
 * natural fallback.
 *
 * Invariants enforced at save time:
 *   - If station is enabled: URL + token are both required.
 *   - Local port must be a valid integer in 1..65535 (the local daemon
 *     binds to it on next start, regardless of whether autoStart is on).
 *
 * A single page serves the fresh-install path (no `Settings` exists
 * yet — station inputs render empty / unchecked) and the returning-
 * user path (inputs seed from the saved blob). The caller distinguishes
 * via `onSaved`; the view itself doesn't know or care which flow it's in.
 */
export async function renderSettings(
  root: HTMLElement,
  onSaved: () => void,
) {
  const existing = await loadSettings();
  const savedStationEnabled = !!existing?.station?.enabled;
  const savedUrl = existing?.station?.url ?? "";
  const savedTok = existing?.station?.token ?? "";
  const savedLocalPort = existing?.local?.port ?? DEFAULT_LOCAL_PORT;
  // Default autoStart=true on fresh installs so the local daemon comes
  // up without the user having to find the toggle. Existing configs
  // preserve whatever they had.
  const savedLocalAutoStart = existing?.local?.autoStart ?? true;
  const savedHoverToFocus = await loadHoverToFocus();
  root.innerHTML = `
    <div class="settings-shell">
      <div class="settings-card">
        <h2 class="brand-wordmark">Reck Connect <em>Satellite</em></h2>
        <div class="subtitle">by Reckon Labs</div>
        <div class="divider"></div>
        <h3>Hosts</h3>
        <p style="margin-top:0.4rem;color:var(--text-secondary);font-size:0.9rem;">
          Local is always available. Add a station to keep sessions running when this Mac is offline; new panes pick a host at creation.
        </p>
        <div class="divider" style="margin-top:1.25rem;"></div>
        <label style="display:flex;align-items:center;gap:0.5rem;margin-top:1rem;font-family:var(--font-body);text-transform:none;letter-spacing:0;font-size:0.95rem;color:var(--app-text);font-weight:500;">
          <input id="s-station-enabled" type="checkbox" ${savedStationEnabled ? "checked" : ""} style="width:auto;" />
          Station (optional remote daemon)
        </label>
        <p style="margin-top:0.25rem;margin-left:1.5rem;color:var(--text-secondary);font-size:0.85rem;">
          Sessions survive laptop reboots. Reachable over Tailscale.
        </p>
        <label for="s-url">Station URL</label>
        <input id="s-url" autocomplete="off" placeholder="http://&lt;tailnet-ip&gt;:7315" value="${escapeAttr(savedUrl)}" />
        <p style="margin-top:0.25rem;color:var(--text-secondary);font-size:0.8rem;">
          Reachable on the tailnet host:port. Same port as Local is fine — they only collide when the station URL points at this Mac (127.0.0.1 / localhost).
        </p>
        <label for="s-tok">Daemon token</label>
        <input id="s-tok" type="password" autocomplete="off" spellcheck="false" placeholder="printed by install-station.sh" value="${escapeAttr(savedTok)}" />
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h4 style="margin-top:1rem;font-family:var(--font-body);text-transform:none;letter-spacing:0;font-size:0.95rem;color:var(--app-text);font-weight:500;">
          Local daemon (always available)
        </h4>
        <p style="margin-top:0.25rem;color:var(--text-secondary);font-size:0.85rem;">
          A <code>reck-stationd</code> instance runs on this Mac. New panes land here when the station is disabled or unreachable.
        </p>
        <label for="s-local-port">Local port</label>
        <input id="s-local-port" type="number" min="${MIN_PORT}" max="${MAX_PORT}" value="${savedLocalPort}" placeholder="${DEFAULT_LOCAL_PORT}" />
        <p style="margin-top:0.25rem;color:var(--text-secondary);font-size:0.8rem;">
          Binds <code>127.0.0.1</code> only — separate from the tailnet-bound station port.
        </p>
        <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.6rem;font-family:var(--font-body);text-transform:none;letter-spacing:0;font-size:0.9rem;color:var(--app-text);">
          <input id="s-local-autostart" type="checkbox" ${savedLocalAutoStart ? "checked" : ""} style="width:auto;" />
          Auto-start on Satellite launch
        </label>
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h3>Behavior</h3>
        <label style="display:flex;align-items:center;gap:0.5rem;margin-top:1rem;font-family:var(--font-body);text-transform:none;letter-spacing:0;font-size:0.95rem;color:var(--app-text);font-weight:500;">
          <input id="s-hover-to-focus" type="checkbox" ${savedHoverToFocus ? "checked" : ""} style="width:auto;" />
          Hover to focus pane
        </label>
        <p style="margin-top:0.25rem;margin-left:1.5rem;color:var(--text-secondary);font-size:0.85rem;">
          Move the cursor over a pane to focus it, no click needed. Suppresses during text selection, drags, and right after typing.
        </p>
        <div id="s-err" style="color:var(--sl-red);margin-top:0.75rem;font-size:0.85rem;display:none;"></div>
        <div class="actions">
          <button id="s-save" class="primary">Save</button>
        </div>
      </div>
    </div>
  `;
  const btn = root.querySelector("#s-save") as HTMLButtonElement;
  const err = root.querySelector("#s-err") as HTMLDivElement;
  btn.onclick = async () => {
    const stationEnabled = (root.querySelector("#s-station-enabled") as HTMLInputElement).checked;
    const url = (root.querySelector("#s-url") as HTMLInputElement).value.trim();
    const tok = (root.querySelector("#s-tok") as HTMLInputElement).value.trim();
    const localPortRaw = (root.querySelector("#s-local-port") as HTMLInputElement).value;
    const localAutoStart = (root.querySelector("#s-local-autostart") as HTMLInputElement).checked;
    const hoverToFocus = (root.querySelector("#s-hover-to-focus") as HTMLInputElement).checked;
    err.style.display = "none";

    if (stationEnabled) {
      if (!url) {
        err.textContent = "Station URL is required when station is enabled.";
        err.style.display = "block";
        return;
      }
      if (!tok) {
        err.textContent = "Daemon token is required when station is enabled.";
        err.style.display = "block";
        return;
      }
    }
    const localPort = parseInt(localPortRaw, 10);
    if (!Number.isFinite(localPort) || localPort < MIN_PORT || localPort > MAX_PORT) {
      err.textContent = `Local port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`;
      err.style.display = "block";
      return;
    }
    // an earlier release: catch the host:port collision footgun. If the user
    // points the station URL at this Mac (127.0.0.1 / localhost) on the
    // same port the local daemon binds, both would race for the same
    // socket and one fails silently. Other tailnet hosts on :7315 are
    // fine — only same-host:same-port is the problem.
    if (stationEnabled) {
      const collision = sameHostPortAsLocal(url, localPort);
      if (collision) {
        err.textContent = `Station URL ${collision} collides with the local port. Pick a different local port, or point the station URL at the remote machine's tailnet address.`;
        err.style.display = "block";
        return;
      }
    }
    await saveSettings({
      station: stationEnabled
        ? { enabled: true, url, token: tok }
        : { enabled: false, url: url || savedUrl, token: tok || savedTok },
      // an earlier release — local is always enabled; saveSettings forces this
      // independently so the field stays compatible with the type.
      local: {
        enabled: true,
        port: localPort,
        autoStart: localAutoStart,
      },
    });
    await saveHoverToFocus(hoverToFocus);
    // Bounce the local daemon so a port change (or a fresh-install
    // first-save) picks up immediately rather than waiting for the
    // next Satellite restart. The spawn registry keys by host so
    // station is never touched here.
    await window.reckAPI.daemon.stop("local");
    const result = await window.reckAPI.daemon.start("local");
    if (!result.ok) {
      const code = result.code ? ` [${result.code}]` : "";
      err.textContent = `Local daemon failed to start${code}: ${result.reason}`;
      err.style.display = "block";
      return;
    }
    onSaved();
  };
}
