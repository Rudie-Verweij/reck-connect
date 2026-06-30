export interface TtsTheme {
  backgroundColor: string;
  foregroundColor?: string;
  controlAccent: string;
  controlBg: string;
  controlBorder: string;
  controlText: string;
}

// Per-mode highlight tuned for the typical terminal foreground colour:
//   light mode → dark text under a LIGHT amber  (#fde68a)
//   dark  mode → light text under a DARKER amber (#696241,
//                  the pre-blended result of
//                  rgba(253, 230, 138, 0.45) over black)
// Solid hex; the surfaces paint them as a translucent overlay so the word
// reads through the tint in both themes. These are the DEFAULTS — the user
// can override each via the settings colour pickers (see ttsSettings.ts),
// which thread chosen colours into resolveTtsTheme() below.
export const TTS_HIGHLIGHT_BG_LIGHT = "#fde68a";
export const TTS_HIGHLIGHT_BG_DARK = "#696241";

/** User-chosen highlight colours per mode; either may be absent (→ default). */
export interface HighlightColorOverrides {
  light?: string;
  dark?: string;
}

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

export function resolveTtsTheme(
  isDark: boolean,
  highlightColors?: HighlightColorOverrides,
): TtsTheme {
  const base = isDark ? TTS_THEME_DARK : TTS_THEME_LIGHT;
  const override = isDark ? highlightColors?.dark : highlightColors?.light;
  // Only the highlight backgroundColor is user-configurable; the control-bar
  // chrome stays themed. An absent/empty override falls back to the default.
  return override ? { ...base, backgroundColor: override } : base;
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

export function createThemeWatcher(
  highlightColors?: HighlightColorOverrides,
): TtsThemeWatcher {
  const listeners = new Set<(theme: TtsTheme) => void>();
  let lastTheme: "light" | "dark" = readAppTheme();

  const observer = new MutationObserver(() => {
    const next = readAppTheme();
    if (next === lastTheme) return; // attribute changed but value didn't
    lastTheme = next;
    const theme = resolveTtsTheme(next === "dark", highlightColors);
    for (const cb of listeners) cb(theme);
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return {
    current: () => resolveTtsTheme(readAppTheme() === "dark", highlightColors),
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
