export interface TtsTheme {
  backgroundColor: string;
  foregroundColor?: string;
  controlAccent: string;
  controlBg: string;
  controlBorder: string;
  controlText: string;
}

// Per-mode highlight tuned for the typical terminal foreground colour:
//   light mode → dark text on a LIGHT amber  (#fde68a)
//   dark  mode → light text on a DARKER amber (#696241,
//                  the pre-blended result of
//                  rgba(253, 230, 138, 0.45) over black)
// Both are SOLID hex — no alpha-blending against the cell background,
// so the rendered colour is exactly what's specified. With
// XtermHighlighter's layer:"bottom" the cell text reads on top.
const TTS_HIGHLIGHT_BG_LIGHT = "#fde68a";
const TTS_HIGHLIGHT_BG_DARK = "#696241";

export const TTS_THEME_LIGHT: TtsTheme = {
  backgroundColor: TTS_HIGHLIGHT_BG_LIGHT,
  controlAccent: "#3b82f6",
  controlBg: "rgba(255, 255, 255, 0.96)",
  controlBorder: "rgba(0, 0, 0, 0.12)",
  controlText: "#1f2937",
};

export const TTS_THEME_DARK: TtsTheme = {
  backgroundColor: TTS_HIGHLIGHT_BG_DARK,
  controlAccent: "#60a5fa",
  controlBg: "rgba(30, 30, 32, 0.92)",
  controlBorder: "rgba(255, 255, 255, 0.16)",
  controlText: "#f3f4f6",
};

export function resolveTtsTheme(isDark: boolean): TtsTheme {
  return isDark ? TTS_THEME_DARK : TTS_THEME_LIGHT;
}

export interface TtsThemeWatcher {
  current(): TtsTheme;
  onChange(cb: (theme: TtsTheme) => void): () => void;
  dispose(): void;
}

// Resolve "dark" vs "light" from the canonical app theme channel: the
// `data-theme` attribute set on <html> by boot.ts (see
// `document.documentElement.setAttribute("data-theme", theme)` in the
// boot path and the toggle handler). The OS-level
// `prefers-color-scheme` was previously used here but does NOT match
// the app's theme — the satellite app has its own toggle, persisted in
// settings, and the OS may be in a different mode. Default is "dark"
// to match `loadTheme()`'s fallback in `renderer/src/config.ts`.
function readAppTheme(): "light" | "dark" {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" ? "light" : "dark";
}

export function createThemeWatcher(): TtsThemeWatcher {
  const listeners = new Set<(theme: TtsTheme) => void>();
  let lastTheme: "light" | "dark" = readAppTheme();

  const observer = new MutationObserver(() => {
    const next = readAppTheme();
    if (next === lastTheme) return; // attribute changed but value didn't
    lastTheme = next;
    const theme = resolveTtsTheme(next === "dark");
    for (const cb of listeners) cb(theme);
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return {
    current: () => resolveTtsTheme(readAppTheme() === "dark"),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      observer.disconnect();
      listeners.clear();
    },
  };
}
