import {
  DEFAULT_RAIL_WIGGLE,
  DEFAULT_RECK_CONNECT_PROMPT,
  DEFAULT_DRAGDROP_EXTENSIONS,
  DEFAULT_DROP_PROMPT_TEMPLATE,
  loadFileViewerExtraRoots,
  loadHoverToFocus,
  loadLinkifierAllowlist,
  loadRailWiggle,
  loadReckConnectPrompt,
  loadSettings,
  loadDragDropAllowlist,
  loadDropPromptTemplate,
  saveFileViewerExtraRoots,
  saveHoverToFocus,
  saveLinkifierAllowlist,
  saveRailWiggle,
  saveReckConnectPrompt,
  saveSettings,
  saveDragDropAllowlist,
  saveDropPromptTemplate,
} from "../config";
import {
  SEEDED_EXTENSIONLESS_FILENAMES,
  setExtensionlessAllowlist,
} from "../viewer/LinkDetector";
import { loadTtsSettings, saveTtsSettings } from "../tts/ttsSettings";
import { confirmDialog } from "./new-pane-dialog";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const DEFAULT_LOCAL_PORT = 7315;
const MIN_PORT = 1;
const MAX_PORT = 65535;

// Separator-wiggle tuning bounds. Generous — the point is to reject
// nonsense (0, negative, NaN), not to police taste.
const MIN_WIGGLE_PX = 1;
const MAX_WIGGLE_PX = 64;
const MIN_WIGGLE_MS = 16;
const MAX_WIGGLE_MS = 1000;

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
  const savedRailWiggle = await loadRailWiggle();
  const savedReckPrompt =
    (await loadReckConnectPrompt()) ?? DEFAULT_RECK_CONNECT_PROMPT;
  const ttsSettings = await loadTtsSettings();
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
        <label style="display:flex;align-items:center;gap:0.5rem;margin-top:1rem;font-family:var(--font-body);text-transform:none;letter-spacing:0;font-size:0.95rem;color:var(--app-text);font-weight:500;">
          <input id="s-rail-wiggle" type="checkbox" ${savedRailWiggle.enabled ? "checked" : ""} style="width:auto;" />
          Wiggle the divider on project switch
        </label>
        <p style="margin-top:0.25rem;margin-left:1.5rem;color:var(--text-secondary);font-size:0.85rem;">
          After switching projects the sidebar divider nudges out and back so terminals re-fit without a manual jiggle.
        </p>
        <label for="s-rail-wiggle-px">Wiggle distance (px)</label>
        <input id="s-rail-wiggle-px" type="number" min="${MIN_WIGGLE_PX}" max="${MAX_WIGGLE_PX}" value="${savedRailWiggle.pixels}" placeholder="${DEFAULT_RAIL_WIGGLE.pixels}" />
        <label for="s-rail-wiggle-ms">Wiggle leg duration (ms)</label>
        <input id="s-rail-wiggle-ms" type="number" min="${MIN_WIGGLE_MS}" max="${MAX_WIGGLE_MS}" value="${savedRailWiggle.legMs}" placeholder="${DEFAULT_RAIL_WIGGLE.legMs}" />
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h3>Text to speech</h3>
        <p style="margin-top:0.4rem;color:var(--text-secondary);font-size:0.85rem;">
          Colour of the highlight that tracks the word being read aloud. Set one per appearance mode; the matching colour is used automatically when you switch between light and dark.
        </p>
        <div class="tts-color-row">
          <label for="s-tts-color-light">Light mode</label>
          <input id="s-tts-color-light" type="color" value="${escapeAttr(ttsSettings.highlightColorLight)}" />
        </div>
        <div class="tts-color-row">
          <label for="s-tts-color-dark">Dark mode</label>
          <input id="s-tts-color-dark" type="color" value="${escapeAttr(ttsSettings.highlightColorDark)}" />
        </div>
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h3>Reck Connect prompt</h3>
        <p style="margin-top:0.4rem;color:var(--text-secondary);font-size:0.85rem;">
          Auto-appended to every Claude Code session spawned by Reck, regardless of project. Use it for global hints — path conventions, rendering capabilities, anything you want Claude to know on Day 1 of any project. Clear the field to opt out entirely.
        </p>
        <textarea id="s-reck-prompt" class="form-input" rows="14" spellcheck="false" style="margin-top:0.5rem;resize:vertical;font-family:var(--font-mono);line-height:1.5;">${escapeAttr(savedReckPrompt)}</textarea>
        <div class="actions" style="margin-top:0.5rem;">
          <button id="s-reck-prompt-reset" class="secondary" type="button">Reset to defaults</button>
        </div>
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h3>File viewer allowed paths</h3>
        <p style="margin-top:0.4rem;color:var(--text-secondary);font-size:0.85rem;">
          Cmd+click on a file path in a pane opens a popup viewer. Paths are only
          clickable when they live inside one of the allowed roots below. Built-in
          roots cover most workflows; add custom roots for code that lives elsewhere
          (e.g. external drives). Changes take effect immediately, no restart needed.
        </p>
        <div class="settings-roots-builtin" id="s-roots-builtin"></div>
        <div class="settings-roots-custom" id="s-roots-custom"></div>
        <div class="actions" style="margin-top:0.5rem;">
          <button id="s-roots-add" class="secondary" type="button">Add path…</button>
        </div>
        <div id="s-roots-err" style="color:var(--sl-red);margin-top:0.5rem;font-size:0.85rem;display:none;"></div>
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h3>File-link allowlist</h3>
        <p style="margin-top:0.4rem;color:var(--text-secondary);font-size:0.85rem;">
          Files without an extension (Makefile, .env, etc.) are only Cmd-clickable when their basename appears in this list. Add a name and press Save or Enter; hover a chip and click <code>×</code> to remove.
        </p>
        <div class="linkifier-allowlist-input-row">
          <input
            id="s-linkifier-input"
            class="linkifier-allowlist-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. Procfile"
          />
          <button id="s-linkifier-save" class="secondary" type="button">Save</button>
        </div>
        <div id="s-linkifier-chips" class="linkifier-allowlist-chips"></div>
        <div class="divider" style="margin-top:1.5rem;"></div>
        <h3>Drag &amp; drop files</h3>
        <p style="margin-top:0.4rem;color:var(--text-secondary);font-size:0.85rem;">
          Drag a file onto a pane to hand it to the session. Only the extensions
          below are accepted (up to 10&nbsp;MB each); anything else shows a toast.
          Add an extension and press Save or Enter; hover a chip and click
          <code>×</code> to remove.
        </p>
        <div class="linkifier-allowlist-input-row">
          <input
            id="s-dragdrop-input"
            class="linkifier-allowlist-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. pdf"
          />
          <button id="s-dragdrop-save" class="secondary" type="button">Save</button>
        </div>
        <div id="s-dragdrop-chips" class="linkifier-allowlist-chips"></div>
        <label for="s-dragdrop-prompt" style="display:block;margin-top:1rem;font-size:0.85rem;color:var(--text-secondary);">
          Prompt inserted when a file is dropped. <code>{path}</code> becomes the
          uploaded file's location and <code>{filename}</code> its original name.
          It's pasted as one block (Claude Code collapses it only if it's long).
        </label>
        <textarea
          id="s-dragdrop-prompt"
          rows="4"
          spellcheck="false"
          style="width:100%;margin-top:0.4rem;font-family:var(--font-mono,monospace);font-size:0.82rem;line-height:1.4;resize:vertical;"
        ></textarea>
        <div class="actions" style="margin-top:0.4rem;">
          <button id="s-dragdrop-prompt-reset" class="secondary" type="button">Reset to default</button>
        </div>
        <div id="s-err" style="color:var(--sl-red);margin-top:0.75rem;font-size:0.85rem;display:none;"></div>
        <div class="actions">
          <button id="s-save" class="primary">Save</button>
        </div>
      </div>
    </div>
  `;
  await renderFileViewerRootsSection(root);
  await renderLinkifierAllowlistSection(root);
  await renderDragDropSection(root);
  const reckPromptEl = root.querySelector("#s-reck-prompt") as HTMLTextAreaElement;
  const dropPromptEl = root.querySelector("#s-dragdrop-prompt") as HTMLTextAreaElement;
  const reckResetBtn = root.querySelector("#s-reck-prompt-reset") as HTMLButtonElement;
  reckResetBtn.onclick = () => {
    reckPromptEl.value = DEFAULT_RECK_CONNECT_PROMPT;
  };
  const btn = root.querySelector("#s-save") as HTMLButtonElement;
  const err = root.querySelector("#s-err") as HTMLDivElement;
  btn.onclick = async () => {
    const stationEnabled = (root.querySelector("#s-station-enabled") as HTMLInputElement).checked;
    const url = (root.querySelector("#s-url") as HTMLInputElement).value.trim();
    const tok = (root.querySelector("#s-tok") as HTMLInputElement).value.trim();
    const localPortRaw = (root.querySelector("#s-local-port") as HTMLInputElement).value;
    const localAutoStart = (root.querySelector("#s-local-autostart") as HTMLInputElement).checked;
    const hoverToFocus = (root.querySelector("#s-hover-to-focus") as HTMLInputElement).checked;
    const railWiggleEnabled = (root.querySelector("#s-rail-wiggle") as HTMLInputElement).checked;
    const railWigglePxRaw = (root.querySelector("#s-rail-wiggle-px") as HTMLInputElement).value;
    const railWiggleMsRaw = (root.querySelector("#s-rail-wiggle-ms") as HTMLInputElement).value;
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
    const railWigglePx = parseInt(railWigglePxRaw, 10);
    if (!Number.isFinite(railWigglePx) || railWigglePx < MIN_WIGGLE_PX || railWigglePx > MAX_WIGGLE_PX) {
      err.textContent = `Wiggle distance must be an integer between ${MIN_WIGGLE_PX} and ${MAX_WIGGLE_PX} px.`;
      err.style.display = "block";
      return;
    }
    const railWiggleMs = parseInt(railWiggleMsRaw, 10);
    if (!Number.isFinite(railWiggleMs) || railWiggleMs < MIN_WIGGLE_MS || railWiggleMs > MAX_WIGGLE_MS) {
      err.textContent = `Wiggle leg duration must be an integer between ${MIN_WIGGLE_MS} and ${MAX_WIGGLE_MS} ms.`;
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
    await saveRailWiggle({
      enabled: railWiggleEnabled,
      pixels: railWigglePx,
      legMs: railWiggleMs,
    });
    // No .trim() — whitespace is user intent; "" is the explicit opt-out.
    await saveReckConnectPrompt(reckPromptEl.value);
    // Drop prompt template — blank resets to the default on next load.
    await saveDropPromptTemplate(dropPromptEl.value);

    // Persist the TTS highlight colours. Reload first so a voice/rate the
    // control bar may have changed since this panel opened isn't clobbered
    // by the render-time snapshot.
    const ttsLight = (root.querySelector("#s-tts-color-light") as HTMLInputElement).value;
    const ttsDark = (root.querySelector("#s-tts-color-dark") as HTMLInputElement).value;
    const liveTts = await loadTtsSettings();
    await saveTtsSettings({
      ...liveTts,
      highlightColorLight: ttsLight,
      highlightColorDark: ttsDark,
    });

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

/**
 * Built-in file-viewer roots, shown read-only in Preferences. $HOME is
 * shown as the literal "$HOME" rather than the resolved path because the
 * renderer never sees the user's home-dir literal (same privacy the rest
 * of the renderer enforces).
 */
const BUILT_IN_ROOT_LABELS: ReadonlyArray<{ label: string; hint: string }> = [
  { label: "$HOME", hint: "your local files (~/Desktop, ~/dev, etc.)" },
  { label: "$HOME/reck/projects", hint: "station files via the sshfs mount" },
  { label: "/tmp", hint: "scratch space (where dev tools dump generated paths)" },
];

/**
 * Render the file-viewer allowed-roots section. Idempotent: re-rendering
 * replaces the previous list DOM and rebinds handlers, so add/remove
 * operations can re-call this to refresh.
 */
async function renderFileViewerRootsSection(root: HTMLElement): Promise<void> {
  const builtInHost = root.querySelector("#s-roots-builtin") as HTMLElement | null;
  const customHost = root.querySelector("#s-roots-custom") as HTMLElement | null;
  const addBtn = root.querySelector("#s-roots-add") as HTMLButtonElement | null;
  const errEl = root.querySelector("#s-roots-err") as HTMLElement | null;
  if (!builtInHost || !customHost || !addBtn || !errEl) return;

  // Built-ins: read-only display.
  builtInHost.innerHTML = "";
  const builtInTitle = document.createElement("div");
  builtInTitle.className = "settings-roots-section-title";
  builtInTitle.textContent = "Built-in";
  builtInHost.appendChild(builtInTitle);
  for (const entry of BUILT_IN_ROOT_LABELS) {
    const row = document.createElement("div");
    row.className = "settings-roots-row settings-roots-row-builtin";
    const path = document.createElement("code");
    path.className = "settings-roots-path";
    path.textContent = entry.label;
    const hint = document.createElement("span");
    hint.className = "settings-roots-hint";
    hint.textContent = entry.hint;
    row.appendChild(path);
    row.appendChild(hint);
    builtInHost.appendChild(row);
  }

  // Custom: live list with remove buttons.
  const extras = await loadFileViewerExtraRoots();
  customHost.innerHTML = "";
  const customTitle = document.createElement("div");
  customTitle.className = "settings-roots-section-title";
  customTitle.textContent = "Custom";
  customHost.appendChild(customTitle);
  if (extras.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-roots-empty";
    empty.textContent = "No custom paths yet.";
    customHost.appendChild(empty);
  } else {
    for (const p of extras) {
      const row = document.createElement("div");
      row.className = "settings-roots-row settings-roots-row-custom";
      const path = document.createElement("code");
      path.className = "settings-roots-path";
      path.textContent = p;
      const remove = document.createElement("button");
      remove.className = "settings-roots-remove";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        errEl.style.display = "none";
        const next = extras.filter((entry) => entry !== p);
        await saveFileViewerExtraRoots(next);
        await renderFileViewerRootsSection(root);
      });
      row.appendChild(path);
      row.appendChild(remove);
      customHost.appendChild(row);
    }
  }

  // Re-bind the Add button each render so the closure captures the
  // latest `extras` slice.
  addBtn.onclick = async () => {
    errEl.style.display = "none";
    let picked: string | null;
    try {
      picked = await window.reckAPI.dialog.pickFolder();
    } catch (e) {
      errEl.textContent =
        "Couldn't open the folder picker: " +
        (e instanceof Error ? e.message : String(e));
      errEl.style.display = "block";
      return;
    }
    if (!picked) return; // user cancelled
    if (typeof picked !== "string" || !picked.startsWith("/")) {
      errEl.textContent = "Picked path must be absolute.";
      errEl.style.display = "block";
      return;
    }
    if (extras.includes(picked)) {
      errEl.textContent = "That path is already in the list.";
      errEl.style.display = "block";
      return;
    }
    await saveFileViewerExtraRoots([...extras, picked]);
    await renderFileViewerRootsSection(root);
  };
}

/**
 * Render the editable linkifier allowlist section.
 *
 * Layout: single-line input + Save button on one row, then a chip grid
 * below — one chip per persisted entry; hovering a chip reveals an `×`.
 *
 * Behaviour:
 *   - First render with no persisted list → seed with
 *     `SEEDED_EXTENSIONLESS_FILENAMES` and persist immediately so the
 *     defaults are visible as chips (and editable).
 *   - Add via Save button OR Enter on the input. Empty/whitespace-only
 *     input is a silent no-op. Duplicates flash the input red.
 *   - Remove via × → `confirmDialog` (reused from new-pane-dialog.ts).
 *     Confirm → filter, persist, re-render. Cancel → no change.
 *
 * On any persist, `setExtensionlessAllowlist` is also called so the live
 * linkifier in the SAME renderer (Preferences runs in the main window)
 * sees the new allowlist without waiting for reload. Existing file-viewer
 * popups have their own renderer process; they re-hydrate on next mount.
 */
async function renderLinkifierAllowlistSection(
  root: HTMLElement,
): Promise<void> {
  const chipsHost = root.querySelector(
    "#s-linkifier-chips",
  ) as HTMLElement | null;
  const input = root.querySelector(
    "#s-linkifier-input",
  ) as HTMLInputElement | null;
  const saveBtn = root.querySelector(
    "#s-linkifier-save",
  ) as HTMLButtonElement | null;
  if (!chipsHost || !input || !saveBtn) return;

  let list: string[];
  const persisted = await loadLinkifierAllowlist();
  if (persisted === null) {
    list = [...SEEDED_EXTENSIONLESS_FILENAMES];
    await saveLinkifierAllowlist(list);
  } else {
    list = [...persisted];
  }
  // Keep the live allowlist in sync for any path-detection happening
  // in the main renderer (e.g. terminal panes rendered behind a
  // half-open Preferences view).
  setExtensionlessAllowlist(list);

  const renderChips = (): void => {
    chipsHost.innerHTML = "";
    for (const name of list) {
      const chip = document.createElement("span");
      chip.className = "linkifier-allowlist-chip";
      chip.setAttribute("data-name", name);
      const label = document.createElement("span");
      label.className = "linkifier-chip-label";
      label.textContent = name;
      const remove = document.createElement("button");
      remove.className = "linkifier-chip-remove";
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.textContent = "×";
      remove.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const confirmed = await confirmDialog(document.body, {
          title: "Remove from allowlist",
          body: `Are you sure you want to remove "${name}" from the file-link allowlist? Files with this basename will no longer be Cmd-clickable.`,
          confirmLabel: "Remove",
        });
        if (!confirmed) return;
        list = list.filter((entry) => entry !== name);
        await saveLinkifierAllowlist(list);
        setExtensionlessAllowlist(list);
        renderChips();
      });
      chip.appendChild(label);
      chip.appendChild(remove);
      chipsHost.appendChild(chip);
    }
  };
  renderChips();

  const flashError = (): void => {
    input.classList.add("linkifier-input-error");
    window.setTimeout(() => {
      input.classList.remove("linkifier-input-error");
    }, 2000);
  };

  const submit = async (): Promise<void> => {
    const raw = input.value.trim();
    if (raw.length === 0) return;
    if (list.includes(raw)) {
      flashError();
      return;
    }
    list = [...list, raw];
    await saveLinkifierAllowlist(list);
    setExtensionlessAllowlist(list);
    input.value = "";
    renderChips();
  };

  saveBtn.onclick = () => void submit();
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void submit();
    }
  });
}

/**
 * Render the drag-drop settings: an editable extension allowlist (chips,
 * auto-persisted like the linkifier list) plus the drop prompt template
 * textarea (persisted with the main Save button; reset button here).
 *
 * On first render with no persisted allowlist, seed from
 * `DEFAULT_DRAGDROP_EXTENSIONS` and persist so the defaults show as chips.
 * Extensions are normalised on save (lowercase, no leading dot).
 */
async function renderDragDropSection(root: HTMLElement): Promise<void> {
  const chipsHost = root.querySelector("#s-dragdrop-chips") as HTMLElement | null;
  const input = root.querySelector("#s-dragdrop-input") as HTMLInputElement | null;
  const saveBtn = root.querySelector("#s-dragdrop-save") as HTMLButtonElement | null;
  const promptEl = root.querySelector("#s-dragdrop-prompt") as HTMLTextAreaElement | null;
  const promptReset = root.querySelector("#s-dragdrop-prompt-reset") as HTMLButtonElement | null;
  if (!chipsHost || !input || !saveBtn || !promptEl || !promptReset) return;

  // Prompt textarea: current value, reset-to-default button.
  promptEl.value = await loadDropPromptTemplate();
  promptReset.onclick = () => {
    promptEl.value = DEFAULT_DROP_PROMPT_TEMPLATE;
  };

  let list: string[];
  const persisted = await loadDragDropAllowlist();
  if (persisted === null) {
    list = [...DEFAULT_DRAGDROP_EXTENSIONS];
    await saveDragDropAllowlist(list);
  } else {
    list = [...persisted];
  }

  const renderChips = (): void => {
    chipsHost.innerHTML = "";
    for (const ext of list) {
      const chip = document.createElement("span");
      chip.className = "linkifier-allowlist-chip";
      chip.setAttribute("data-name", ext);
      const label = document.createElement("span");
      label.className = "linkifier-chip-label";
      label.textContent = `.${ext}`;
      const remove = document.createElement("button");
      remove.className = "linkifier-chip-remove";
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${ext}`);
      remove.textContent = "×";
      remove.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const confirmed = await confirmDialog(document.body, {
          title: "Remove file type",
          body: `Remove ".${ext}" from the drag-drop allowlist? Dropping files of this type will be rejected.`,
          confirmLabel: "Remove",
        });
        if (!confirmed) return;
        list = list.filter((e) => e !== ext);
        await saveDragDropAllowlist(list);
        renderChips();
      });
      chip.appendChild(label);
      chip.appendChild(remove);
      chipsHost.appendChild(chip);
    }
  };
  renderChips();

  const flashError = (): void => {
    input.classList.add("linkifier-input-error");
    window.setTimeout(() => input.classList.remove("linkifier-input-error"), 2000);
  };

  const submit = async (): Promise<void> => {
    // Normalise here too so the duplicate check matches persisted form.
    const raw = input.value.trim().toLowerCase().replace(/^\.+/, "");
    if (raw.length === 0) return;
    if (list.includes(raw)) {
      flashError();
      return;
    }
    list = [...list, raw];
    await saveDragDropAllowlist(list);
    input.value = "";
    renderChips();
  };

  saveBtn.onclick = () => void submit();
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void submit();
    }
  });
}
