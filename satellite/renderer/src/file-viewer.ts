// File viewer popup entry. Boots a single FileViewerHost into the popup's
// body, reading `?path=...` from the window's location. Mirrors the
// popout.ts pattern: minimal entry that delegates to a host module.

import { mountFileViewer } from "./viewer/FileViewerHost";
import { loadTheme } from "./config";

async function bootFileViewer(): Promise<void> {
  // Apply the persisted theme so first paint doesn't flash cream-on-dark.
  // The BrowserWindow already opens with the right backgroundColor; this
  // sets the html-level attribute the CSS keys off.
  try {
    const theme = await loadTheme();
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // Default to light if config IPC fails — the popup will still render.
    document.documentElement.setAttribute("data-theme", "light");
  }

  const root = document.getElementById("viewer-root");
  if (!root) {
    document.body.textContent = "Error: viewer root missing";
    return;
  }
  await mountFileViewer({
    root,
    params: new URLSearchParams(window.location.search),
  });

  // ⌘W / Ctrl+W closes the popup window. Electron's accelerator typically
  // catches this at the OS level, but binding here gives a consistent
  // fallback when the renderer has focus on an editable input.
  window.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "w") {
      ev.preventDefault();
      window.close();
    }
  });
}

void bootFileViewer();
