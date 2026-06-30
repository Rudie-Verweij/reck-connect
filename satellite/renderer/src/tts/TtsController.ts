import {
  TtsEngine,
  snapRate,
  type SpokenChunk,
  type TtsBoundary,
} from "./TtsEngine";
import {
  createSpeakControlBar,
  type SpeakControlBar,
} from "./SpeakControlBar";
import type { TtsTheme } from "./ttsTheme";
import type { TtsSettings } from "./ttsSettings";
import type { SpeakSurfaceAdapter } from "./SpeakSurfaceAdapter";

export interface TtsControllerOptions {
  engine: TtsEngine;
  barFactory: (opts: {
    parent: HTMLElement;
    callbacks: {
      onPlay(): void;
      onPause(): void;
      onResume(): void;
      onStop(): void;
      onRateChange(rate: number): void;
    };
    theme: TtsTheme;
    initialRate?: number;
    voiceName?: string;
  }) => SpeakControlBar;
  theme: TtsTheme;
  settings: TtsSettings;
  saveSettings: (s: TtsSettings) => Promise<void>;
  /** Resolves the currently-focused speak surface (any of terminal,
   *  markdown, codemirror), or null if none is focused. */
  getActiveSurface: () => SpeakSurfaceAdapter | null;
  getLastMousePoint: () => { pixelX: number; pixelY: number } | null;
  voicesProvider: () => Promise<SpeechSynthesisVoice[]>;
}

type SessionState = "idle" | "playing" | "paused";

const SAVE_DEBOUNCE_MS = 200;

export class TtsController {
  private opts: TtsControllerOptions;
  private state: SessionState = "idle";
  private currentBar: SpeakControlBar | null = null;
  private currentBarSurfaceEl: HTMLElement | null = null;
  private currentSurface: SpeakSurfaceAdapter | null = null;
  private theme: TtsTheme;
  private settings: TtsSettings;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private voicesCache: SpeechSynthesisVoice[] = [];
  private detachEngineListeners: Array<() => void> = [];

  constructor(opts: TtsControllerOptions) {
    this.opts = opts;
    this.theme = opts.theme;
    this.settings = { ...opts.settings };
    void this.preloadVoices();
    this.attachEngine();
  }

  start(): void {
    const surface = this.opts.getActiveSurface();
    if (!surface) return;

    const chunk = this.resolveChunk(surface);
    if (!chunk || !chunk.text) return;

    // Clear any stale highlight from a previous surface BEFORE we swap.
    // Bug observed: starting TTS on B
    // while A was still painted left A's decoration visible because we
    // just overwrote `this.currentSurface` without touching A.
    if (this.currentSurface && this.currentSurface !== surface) {
      this.currentSurface.clearHighlight();
    }

    const voice = this.findVoice(this.settings.voice);
    this.opts.engine.start(chunk, { voice, rate: this.settings.rate });
    this.state = "playing";
    this.currentSurface = surface;
    // Push the configured highlight colour to the surface so its highlight
    // uses the user's choice (surfaces are built without a theme).
    surface.setTheme?.(this.theme);

    this.ensureBar(surface);
    this.currentBar?.show();
    this.currentBar?.setState("playing");
    this.currentBar?.setRate(this.settings.rate);
    this.currentBar?.setVoiceName(this.settings.voice ?? "Default voice");
  }

  stop(): void {
    this.opts.engine.stop();
    this.state = "idle";
    this.currentSurface?.clearHighlight();
    this.currentBar?.setState("idle");
  }

  pauseToggle(): void {
    if (this.state === "playing") {
      this.opts.engine.pause();
      this.state = "paused";
      this.currentBar?.setState("paused");
      return;
    }
    if (this.state === "paused") {
      this.opts.engine.resume();
      this.state = "playing";
      this.currentBar?.setState("playing");
    }
  }

  bumpRate(delta: number): void {
    const next = snapRate(this.settings.rate + delta);
    this.settings = { ...this.settings, rate: next };
    this.opts.engine.setRate(next);
    this.currentBar?.setRate(next);
    this.scheduleSave();
  }

  setRate(rate: number): void {
    const next = snapRate(rate);
    this.settings = { ...this.settings, rate: next };
    this.opts.engine.setRate(next);
    this.currentBar?.setRate(next);
    this.scheduleSave();
  }

  async setVoice(name: string | null): Promise<void> {
    this.settings = { ...this.settings, voice: name };
    this.currentBar?.setVoiceName(name ?? "Default voice");
    await this.opts.saveSettings(this.settings);
  }

  setTheme(theme: TtsTheme): void {
    this.theme = theme;
    this.currentBar?.setTheme(theme);
    // Recolour the live highlight too (e.g. on a light/dark toggle mid-read).
    this.currentSurface?.setTheme?.(theme);
  }

  isActive(): boolean {
    return this.state !== "idle";
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const off of this.detachEngineListeners) off();
    this.detachEngineListeners = [];
    this.currentBar?.dispose();
    this.currentBar = null;
    this.currentSurface?.clearHighlight();
    this.currentSurface = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  // Test introspection — surfaces a `highlights` or `__highlights()`
  // array if the current surface adapter exposes one. The
  // TerminalPaneAdapter and the test-only StubSurfaceAdapter both
  // implement this for the boundary→highlighter wiring tests.
  __highlights(): TtsBoundary[] {
    const surface = this.currentSurface as unknown as {
      highlights?: TtsBoundary[];
      __highlights?: () => TtsBoundary[];
    } | null;
    if (!surface) return [];
    if (typeof surface.__highlights === "function") return surface.__highlights();
    return surface.highlights ?? [];
  }

  private resolveChunk(surface: SpeakSurfaceAdapter): SpokenChunk | null {
    const point = this.opts.getLastMousePoint();
    return surface.resolveSpokenChunk(point ?? undefined);
  }

  private ensureBar(surface: SpeakSurfaceAdapter): void {
    const container = surface.getContainerEl();
    if (this.currentBar && this.currentBarSurfaceEl === container) return;
    this.currentBar?.dispose();
    this.currentBarSurfaceEl = container;
    this.currentBar = this.opts.barFactory({
      parent: container,
      theme: this.theme,
      initialRate: this.settings.rate,
      voiceName: this.settings.voice ?? "Default voice",
      callbacks: {
        onPlay: () => this.start(),
        onPause: () => this.pauseToggle(),
        onResume: () => this.pauseToggle(),
        onStop: () => this.stop(),
        onRateChange: (r) => this.setRate(r),
      },
    });
  }

  private attachEngine(): void {
    const offBoundary = this.opts.engine.on("boundary", (b: TtsBoundary) => {
      this.currentSurface?.highlightBoundary(b);
    });
    const offEnd = this.opts.engine.on("end", () => {
      this.state = "idle";
      this.currentSurface?.clearHighlight();
      this.currentBar?.setState("idle");
    });
    const offError = this.opts.engine.on("error", () => {
      this.state = "idle";
      this.currentSurface?.clearHighlight();
      this.currentBar?.setState("idle");
    });
    // The engine detected a degenerate boundary stream
    // (charIndex stuck at 0, e.g. a speech-poison character we don't
    // know yet). The painted highlight is frozen on word #1 and lying;
    // clear it. Playback continues — only the highlight is withdrawn.
    const offDegenerate = this.opts.engine.on("degenerate", () => {
      this.currentSurface?.clearHighlight();
    });
    this.detachEngineListeners.push(offBoundary, offEnd, offError, offDegenerate);
  }

  private async preloadVoices(): Promise<void> {
    try {
      this.voicesCache = await this.opts.voicesProvider();
    } catch {
      this.voicesCache = [];
    }
  }

  private findVoice(name: string | null): SpeechSynthesisVoice | null {
    if (!name) return null;
    return this.voicesCache.find((v) => v.name === name) ?? null;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.opts.saveSettings({ ...this.settings });
      this.saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  }
}

// Re-export for backwards compatibility — initTts.ts and external
// callers that import { ActivePane } may still exist; they get a thin
// type alias mapped onto the new SpeakSurfaceAdapter contract. The
// fields differ enough that consumers must migrate to the adapter
// pattern; this alias just keeps the old name resolving while the
// rename ripples through.
export type ActivePane = SpeakSurfaceAdapter;
