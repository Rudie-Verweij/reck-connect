import { TtsEngine } from "./TtsEngine";
import {
  createSpeakControlBar,
  type SpeakControlBar,
} from "./SpeakControlBar";
import { TtsController } from "./TtsController";
import { createThemeWatcher } from "./ttsTheme";
import { loadTtsSettings, saveTtsSettings } from "./ttsSettings";
import { installTtsShortcuts } from "./ttsShortcuts";
import type { SpeakSurfaceAdapter } from "./SpeakSurfaceAdapter";

export interface InitTtsOptions {
  /**
   * Resolves the currently-focused speak surface — any of TerminalPaneAdapter,
   * MarkdownSurfaceAdapter, or CodeMirrorSurfaceAdapter — or null if no
   * surface is currently focused. The adapter abstraction lets this
   * resolve any speakable surface, not just xterm panes.
   */
  getActiveSpeakSurface(): SpeakSurfaceAdapter | null;
}

export interface TtsHandle {
  dispose(): void;
}

/**
 * Initialise the TTS subsystem. Wires:
 *   - keyboard shortcuts (⌘⇧S / Esc / ⌘⇧P / ⌘⇧+ / ⌘⇧-)
 *   - mouse-position tracking
 *   - the speak engine and floating control bar
 *   - theme adaptation
 *   - persisted settings
 *
 * Returns a handle whose `dispose()` removes all listeners and the
 * floating control bar. Idempotent — calling dispose() twice is a no-op.
 *
 * Per-surface text resolution and word highlighting live in the adapter
 * (see SpeakSurfaceAdapter). `initTts` is therefore the same call for
 * every surface in the app — main-window panes, detached popouts, and
 * file-viewer popups all hit this entry point.
 */
export async function initTts(opts: InitTtsOptions): Promise<TtsHandle> {
  const settings = await loadTtsSettings();
  const themeWatcher = createThemeWatcher({
    light: settings.highlightColorLight,
    dark: settings.highlightColorDark,
  });

  let lastMousePoint: { pixelX: number; pixelY: number } | null = null;
  const onMouse = (ev: MouseEvent) => {
    lastMousePoint = { pixelX: ev.clientX, pixelY: ev.clientY };
  };
  window.addEventListener("mousemove", onMouse, { passive: true });

  const engine = new TtsEngine();
  const controller = new TtsController({
    engine,
    barFactory: (o) =>
      createSpeakControlBar({
        parent: o.parent,
        theme: o.theme,
        callbacks: o.callbacks,
        initialRate: o.initialRate,
        voiceName: o.voiceName,
        selectedVoice: o.selectedVoice,
        getVoiceOptions: o.getVoiceOptions,
      }) as SpeakControlBar,
    theme: themeWatcher.current(),
    settings,
    saveSettings: saveTtsSettings,
    getActiveSurface: () => opts.getActiveSpeakSurface(),
    getLastMousePoint: () => lastMousePoint,
    voicesProvider: () => engine.getVoices(),
  });

  const offTheme = themeWatcher.onChange((t) => controller.setTheme(t));

  const offShortcuts = installTtsShortcuts({
    onSpeak: () => controller.start(),
    onStop: () => controller.stop(),
    onPauseToggle: () => controller.pauseToggle(),
    onRateUp: () => controller.bumpRate(0.05),
    onRateDown: () => controller.bumpRate(-0.05),
    isActive: () => controller.isActive(),
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      offShortcuts();
      offTheme();
      themeWatcher.dispose();
      window.removeEventListener("mousemove", onMouse);
      controller.dispose();
      engine.dispose();
    },
  };
}
