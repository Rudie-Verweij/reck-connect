import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveTtsTheme,
  createThemeWatcher,
  TTS_THEME_LIGHT,
  TTS_THEME_DARK,
} from "./ttsTheme";

describe("TTS theme tokens", () => {
  // Per-mode highlight DEFAULTS (solid hex):
  //   light mode → warm amber  rgb(255, 201, 107) = #ffc96b
  //   dark  mode → pale yellow rgb(255, 241, 168) = #fff1a8

  it("light-mode palette uses the warm-amber highlight default", () => {
    expect(TTS_THEME_LIGHT.backgroundColor).toBe("#ffc96b");
    expect(TTS_THEME_LIGHT.controlAccent).toBeDefined();
  });

  it("dark-mode palette uses the pale-yellow highlight default", () => {
    expect(TTS_THEME_DARK.backgroundColor).toBe("#fff1a8");
    expect(TTS_THEME_DARK.controlAccent).toBeDefined();
  });

  it("light and dark highlights are different (so dark text in light mode and light text in dark mode both stay readable)", () => {
    expect(TTS_THEME_LIGHT.backgroundColor).not.toBe(
      TTS_THEME_DARK.backgroundColor,
    );
  });

  it("control-bar styling also differs between modes", () => {
    expect(TTS_THEME_LIGHT.controlBg).not.toBe(TTS_THEME_DARK.controlBg);
    expect(TTS_THEME_LIGHT.controlText).not.toBe(TTS_THEME_DARK.controlText);
  });
});

describe("resolveTtsTheme", () => {
  it("returns the dark palette when isDark=true", () => {
    expect(resolveTtsTheme(true)).toBe(TTS_THEME_DARK);
  });

  it("returns the light palette when isDark=false", () => {
    expect(resolveTtsTheme(false)).toBe(TTS_THEME_LIGHT);
  });

  it("overrides backgroundColor with the chosen colour per mode", () => {
    const dark = resolveTtsTheme(true, { light: "#aaa111", dark: "#bbb222" });
    expect(dark.backgroundColor).toBe("#bbb222");
    const light = resolveTtsTheme(false, { light: "#aaa111", dark: "#bbb222" });
    expect(light.backgroundColor).toBe("#aaa111");
    // Control-bar chrome is untouched by the override.
    expect(dark.controlAccent).toBe(TTS_THEME_DARK.controlAccent);
  });

  it("falls back to the default palette when the override for the mode is absent", () => {
    expect(resolveTtsTheme(true, { light: "#aaa111" }).backgroundColor).toBe(
      TTS_THEME_DARK.backgroundColor,
    );
  });
});

describe("createThemeWatcher (data-theme attribute on <html>)", () => {
  function setDataTheme(value: "light" | "dark" | null) {
    if (value === null) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", value);
    }
  }

  // MutationObserver callbacks fire as microtasks; flush by awaiting
  // a couple of resolved promises (one for the observer queue, one to
  // settle handler side-effects).
  async function flushMutations() {
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    setDataTheme(null);
  });

  afterEach(() => {
    setDataTheme(null);
  });

  it("returns the dark palette when data-theme='dark'", () => {
    setDataTheme("dark");
    const watcher = createThemeWatcher();
    expect(watcher.current()).toBe(TTS_THEME_DARK);
    watcher.dispose();
  });

  it("returns the light palette when data-theme='light'", () => {
    setDataTheme("light");
    const watcher = createThemeWatcher();
    expect(watcher.current()).toBe(TTS_THEME_LIGHT);
    watcher.dispose();
  });

  it("defaults to the dark palette when data-theme is absent (matches loadTheme()'s default)", () => {
    setDataTheme(null);
    const watcher = createThemeWatcher();
    expect(watcher.current()).toBe(TTS_THEME_DARK);
    watcher.dispose();
  });

  it("invokes onChange when the app flips data-theme from dark to light", async () => {
    setDataTheme("dark");
    const watcher = createThemeWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);

    setDataTheme("light");
    await flushMutations();
    expect(onChange).toHaveBeenCalledWith(TTS_THEME_LIGHT);
    watcher.dispose();
  });

  it("invokes onChange when the app flips data-theme from light to dark", async () => {
    setDataTheme("light");
    const watcher = createThemeWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);

    setDataTheme("dark");
    await flushMutations();
    expect(onChange).toHaveBeenCalledWith(TTS_THEME_DARK);
    watcher.dispose();
  });

  it("does NOT invoke onChange for unrelated attribute mutations on <html>", async () => {
    setDataTheme("dark");
    const watcher = createThemeWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);

    document.documentElement.setAttribute("lang", "en");
    await flushMutations();
    expect(onChange).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("dispose() stops further onChange calls", async () => {
    setDataTheme("dark");
    const watcher = createThemeWatcher();
    const onChange = vi.fn();
    watcher.onChange(onChange);
    watcher.dispose();

    setDataTheme("light");
    await flushMutations();
    expect(onChange).not.toHaveBeenCalled();
  });
});
