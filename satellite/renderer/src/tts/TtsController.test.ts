import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TtsController } from "./TtsController";
import { TTS_THEME_LIGHT } from "./ttsTheme";
import type { TtsSettings } from "./ttsSettings";
import {
  pixelToCell,
  resolveSpokenChunk,
  type ResolverTerminal,
} from "./PaneTextResolver";
import type {
  HighlighterTerminal,
} from "./XtermHighlighter";
import type { TtsBoundary, SpokenChunk } from "./TtsEngine";
import type {
  SpeakSurfaceAdapter,
  SurfaceKind,
  SurfacePoint,
} from "./SpeakSurfaceAdapter";

// ── Stubs ───────────────────────────────────────────────────────────

class StubEngine {
  startCalls: Array<{
    chunk: SpokenChunk;
    voice?: SpeechSynthesisVoice | null;
    rate?: number;
  }> = [];
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  reswapCalls: SpokenChunk[] = [];
  rate = 1.0;
  speaking = false;
  paused = false;
  boundaryCb?: (b: TtsBoundary) => void;
  endCb?: () => void;
  errorCb?: (e: Error) => void;
  degenerateCb?: () => void;

  start(chunk: SpokenChunk, opts?: { voice?: SpeechSynthesisVoice | null; rate?: number }) {
    this.startCalls.push({ chunk, voice: opts?.voice ?? null, rate: opts?.rate });
    this.speaking = true;
    this.paused = false;
  }
  stop() {
    this.stopCalls++;
    this.speaking = false;
    this.paused = false;
  }
  pause() {
    this.pauseCalls++;
    this.paused = true;
  }
  resume() {
    this.resumeCalls++;
    this.paused = false;
  }
  reswap(chunk: SpokenChunk) {
    this.reswapCalls.push(chunk);
  }
  setRate(r: number) {
    this.rate = r;
  }
  getRate() {
    return this.rate;
  }
  isSpeaking() {
    return this.speaking;
  }
  isPaused() {
    return this.paused;
  }
  on(
    event: "boundary" | "end" | "error" | "degenerate",
    cb: (...args: unknown[]) => void,
  ): () => void {
    if (event === "boundary") this.boundaryCb = cb as (b: TtsBoundary) => void;
    if (event === "end") this.endCb = cb as () => void;
    if (event === "error") this.errorCb = cb as (e: Error) => void;
    if (event === "degenerate") this.degenerateCb = cb as () => void;
    return () => undefined;
  }
  fireBoundary(b: TtsBoundary) {
    this.boundaryCb?.(b);
  }
  fireEnd() {
    this.speaking = false;
    this.endCb?.();
  }
  fireDegenerate() {
    this.degenerateCb?.();
  }
  dispose() {}
  async getVoices() {
    return [];
  }
}

// Surface stub implementing SpeakSurfaceAdapter directly. Records the
// highlights array + clearCalls so the assertions in this file can check
// what the controller painted.
class StubSurfaceAdapter implements SpeakSurfaceAdapter {
  readonly kind: SurfaceKind = "terminal";
  highlights: TtsBoundary[] = [];
  clearCalls = 0;
  themeColors: string[] = [];

  constructor(
    private readonly term: ResolverTerminal,
    private readonly containerEl: HTMLElement,
    private readonly xtermEl: HTMLElement,
    private readonly cellWidth: number,
    private readonly cellHeight: number,
  ) {}

  getContainerEl(): HTMLElement {
    return this.containerEl;
  }

  resolveSpokenChunk(point?: SurfacePoint): SpokenChunk {
    const sel = this.term.getSelection();
    if (sel && sel.length > 0) return resolveSpokenChunk(this.term);
    if (!point) return { text: "", rangeMap: [] };
    const rect = this.xtermEl.getBoundingClientRect();
    const cell = pixelToCell({
      pixelX: point.pixelX,
      pixelY: point.pixelY,
      containerLeft: rect.left,
      containerTop: rect.top,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      viewportTopLine: this.term.buffer.active.viewportY,
      cols: this.term.cols,
      rows: this.term.rows,
    });
    return resolveSpokenChunk(this.term, cell);
  }

  highlightBoundary(b: TtsBoundary): void {
    this.highlights.push(b);
  }

  clearHighlight(): void {
    this.clearCalls++;
  }

  setTheme(theme: { backgroundColor: string }): void {
    this.themeColors.push(theme.backgroundColor);
  }

  dispose(): void {}
}

interface BarRecord {
  showCalls: number;
  hideCalls: number;
  states: string[];
  rates: number[];
  themes: number;
  voices: string[];
  callbacks: {
    onPlay(): void;
    onPause(): void;
    onResume(): void;
    onStop(): void;
    onRateChange(rate: number): void;
  };
}

function makeBarFactory() {
  let last: BarRecord | null = null;
  const factory = (opts: {
    parent: HTMLElement;
    callbacks: BarRecord["callbacks"];
    theme: { controlBg: string };
    initialRate?: number;
    voiceName?: string;
  }) => {
    const rec: BarRecord = {
      showCalls: 0,
      hideCalls: 0,
      states: [],
      rates: opts.initialRate !== undefined ? [opts.initialRate] : [],
      themes: 1,
      voices: opts.voiceName ? [opts.voiceName] : [],
      callbacks: opts.callbacks,
    };
    last = rec;
    return {
      show: () => {
        rec.showCalls++;
      },
      hide: () => {
        rec.hideCalls++;
      },
      setState: (s: string) => rec.states.push(s),
      setRate: (r: number) => rec.rates.push(r),
      setVoiceName: (v: string) => rec.voices.push(v),
      setTheme: () => {
        rec.themes++;
      },
      dispose: () => undefined,
    };
  };
  return {
    factory,
    get last(): BarRecord | null {
      return last;
    },
  };
}

// ── Active-surface fixture ──────────────────────────────────────────
//
// Builds a StubSurfaceAdapter wrapping a synthetic xterm-shaped buffer.
// Same fixture shape callers used pre-Phase-1 (just a different return
// type) — the assertions in every test below are unchanged.

function fakePane(opts: {
  selection?: string;
  selectionPosition?: { start: { x: number; y: number }; end: { x: number; y: number } };
  bufferLines: string[];
  baseY?: number;
  cursorY?: number;
}): SpeakSurfaceAdapter {
  const containerEl = document.createElement("div");
  containerEl.style.position = "relative";
  containerEl.style.width = "640px";
  containerEl.style.height = "480px";
  document.body.appendChild(containerEl);
  Object.defineProperty(containerEl, "getBoundingClientRect", {
    value: () => ({
      left: 0,
      top: 0,
      right: 640,
      bottom: 480,
      width: 640,
      height: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });

  const baseY = opts.baseY ?? 0;
  const cursorY = opts.cursorY ?? 0;
  const lines = opts.bufferLines;

  const resolverTerm: ResolverTerminal = {
    cols: 80,
    rows: 24,
    getSelection: () => opts.selection ?? "",
    getSelectionPosition: () => opts.selectionPosition,
    buffer: {
      active: {
        viewportY: 0,
        baseY,
        cursorY,
        length: lines.length,
        getLine: (i: number) => {
          if (i < 0 || i >= lines.length) return undefined;
          const text = lines[i];
          return {
            length: text.length,
            translateToString: () => text,
          };
        },
      },
    },
  };
  // No HighlighterTerminal needed — StubSurfaceAdapter records the
  // boundary calls directly. The real XtermHighlighter (which consumes
  // HighlighterTerminal) lives inside TerminalPaneAdapter and is
  // covered by its own test file.

  return new StubSurfaceAdapter(
    resolverTerm,
    containerEl,
    containerEl,
    8,
    16,
  );
}

// ── Tests ───────────────────────────────────────────────────────────

const COLORS = {
  highlightColorLight: "#fde68a",
  highlightColorDark: "#696241",
};
const DEFAULT_SETTINGS: TtsSettings = { voice: null, rate: 1.0, ...COLORS };

interface MakeOpts {
  pane?: SpeakSurfaceAdapter | null;
  point?: { pixelX: number; pixelY: number } | null;
  settings?: TtsSettings;
  saveSettings?: (s: TtsSettings) => Promise<void>;
}

function makeController(opts: MakeOpts = {}) {
  const engine = new StubEngine();
  const barFactoryWrap = makeBarFactory();
  const saveSettings = opts.saveSettings ?? (async () => undefined);
  const ctl = new TtsController({
    engine: engine as unknown as ConstructorParameters<typeof TtsController>[0]["engine"],
    barFactory: barFactoryWrap.factory as unknown as ConstructorParameters<
      typeof TtsController
    >[0]["barFactory"],
    theme: TTS_THEME_LIGHT,
    settings: opts.settings ?? DEFAULT_SETTINGS,
    saveSettings,
    getActiveSurface: () => opts.pane ?? null,
    getLastMousePoint: () => opts.point ?? null,
    voicesProvider: async () => [],
  });
  return { engine, ctl, barFactoryWrap };
}

describe("TtsController.start — text resolution", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing when there is no active pane", () => {
    const { engine, ctl } = makeController({ pane: null });
    ctl.start();
    expect(engine.startCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("speaks the selection when one is present (mouse point ignored)", () => {
    const pane = fakePane({
      bufferLines: ["alpha beta", "gamma"],
      selection: "alpha",
      selectionPosition: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 80, pixelY: 80 }, // would otherwise pick line 5 col 10
    });
    ctl.start();
    expect(engine.startCalls).toHaveLength(1);
    expect(engine.startCalls[0].chunk.text).toBe("alpha");
    ctl.dispose();
  });

  it("speaks from-mouse-to-end-of-buffer when no selection but a mouse point exists", () => {
    const pane = fakePane({
      bufferLines: ["alpha beta", "gamma"],
    });
    // pixelX=48 with cellWidth=8 → col=6 ('beta' starts at col 6 in 'alpha beta')
    // pixelY=0 with cellHeight=16, viewportY=0 → line 0
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 48, pixelY: 0 },
    });
    ctl.start();
    expect(engine.startCalls).toHaveLength(1);
    expect(engine.startCalls[0].chunk.text).toBe("beta\ngamma");
    ctl.dispose();
  });

  it("does nothing when there is no selection and no mouse point", () => {
    const pane = fakePane({ bufferLines: ["alpha beta"] });
    const { engine, ctl } = makeController({ pane, point: null });
    ctl.start();
    expect(engine.startCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("does nothing when the resolved text is empty", () => {
    const pane = fakePane({ bufferLines: ["", "  ", ""] });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    expect(engine.startCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("passes the persisted voice and rate to the engine", () => {
    const pane = fakePane({
      bufferLines: ["alpha"],
    });
    const settings = { voice: "Daniel", rate: 1.25, ...COLORS };
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
      settings,
    });
    ctl.start();
    expect(engine.startCalls[0].rate).toBe(1.25);
    // Note: voice is resolved from voicesProvider; null is fine here since
    // voicesProvider returns [] and the controller falls back to no voice.
    ctl.dispose();
  });
});

describe("TtsController.start — default voice resolution", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mkVoice(name: string, opts: { default?: boolean } = {}) {
    return {
      name,
      lang: "en-US",
      default: opts.default ?? false,
      localService: true,
      voiceURI: name,
    } as SpeechSynthesisVoice;
  }

  // The Albert bug: with no voice configured the controller used to pass
  // voice=null to the engine, letting Chromium pick its own default —
  // which on macOS with a Siri system voice is the novelty voice Albert.
  it("resolves an explicit default when no voice is configured", async () => {
    const albert = mkVoice("Albert", { default: true });
    const zoe = mkVoice("Zoe (Premium)");
    const pane = fakePane({ bufferLines: ["alpha"] });
    const engine = new StubEngine();
    const barFactoryWrap = makeBarFactory();
    const ctl = new TtsController({
      engine: engine as unknown as ConstructorParameters<typeof TtsController>[0]["engine"],
      barFactory: barFactoryWrap.factory as unknown as ConstructorParameters<
        typeof TtsController
      >[0]["barFactory"],
      theme: TTS_THEME_LIGHT,
      settings: DEFAULT_SETTINGS,
      saveSettings: async () => undefined,
      getActiveSurface: () => pane,
      getLastMousePoint: () => ({ pixelX: 0, pixelY: 0 }),
      voicesProvider: async () => [albert, zoe],
    });
    // Let the constructor's async voice preload settle.
    await new Promise((r) => setTimeout(r, 0));
    ctl.start();
    expect(engine.startCalls).toHaveLength(1);
    expect(engine.startCalls[0].voice?.name).toBe("Zoe (Premium)");
    // The bar shows a compact label for the actually-resolved voice.
    expect(barFactoryWrap.last?.voices).toContain("EN (Zoe)");
    ctl.dispose();
  });

  it("detects the chunk's language on Automatic and picks a voice for it", async () => {
    const zoe = mkVoice("Zoe (Premium)");
    const claire = {
      name: "Claire (Enhanced)",
      lang: "nl-NL",
      default: false,
      localService: true,
      voiceURI: "Claire (Enhanced)",
    } as SpeechSynthesisVoice;
    const pane = fakePane({
      bufferLines: [
        "welke knoppen heb je dat is een gewoon script en de server geeft het resultaat terug",
      ],
    });
    const engine = new StubEngine();
    const barFactoryWrap = makeBarFactory();
    const ctl = new TtsController({
      engine: engine as unknown as ConstructorParameters<typeof TtsController>[0]["engine"],
      barFactory: barFactoryWrap.factory as unknown as ConstructorParameters<
        typeof TtsController
      >[0]["barFactory"],
      theme: TTS_THEME_LIGHT,
      settings: DEFAULT_SETTINGS,
      saveSettings: async () => undefined,
      getActiveSurface: () => pane,
      getLastMousePoint: () => ({ pixelX: 0, pixelY: 0 }),
      voicesProvider: async () => [zoe, claire],
    });
    await new Promise((r) => setTimeout(r, 0));
    ctl.start();
    expect(engine.startCalls[0].voice?.name).toBe("Claire (Enhanced)");
    expect(barFactoryWrap.last?.voices).toContain("NL (Claire)");
    ctl.dispose();
  });
});

describe("TtsController.start — UI side effects", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the control bar and puts it in playing state", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { ctl, barFactoryWrap } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    expect(barFactoryWrap.last?.showCalls).toBeGreaterThan(0);
    expect(barFactoryWrap.last?.states).toContain("playing");
    ctl.dispose();
  });
});

describe("TtsController.stop", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stops the engine, clears the highlight, and updates the bar to idle", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl, barFactoryWrap } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    ctl.stop();
    expect(engine.stopCalls).toBe(1);
    expect(barFactoryWrap.last?.states).toContain("idle");
    ctl.dispose();
  });
});

describe("TtsController.pauseToggle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pauses when playing", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl, barFactoryWrap } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    ctl.pauseToggle();
    expect(engine.pauseCalls).toBe(1);
    expect(barFactoryWrap.last?.states).toContain("paused");
    ctl.dispose();
  });

  it("resumes when paused", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl, barFactoryWrap } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    ctl.pauseToggle(); // pause
    ctl.pauseToggle(); // resume
    expect(engine.resumeCalls).toBe(1);
    expect(barFactoryWrap.last?.states).toContain("playing");
    ctl.dispose();
  });

  it("does nothing when not active", () => {
    const { engine, ctl } = makeController();
    ctl.pauseToggle();
    expect(engine.pauseCalls).toBe(0);
    expect(engine.resumeCalls).toBe(0);
    ctl.dispose();
  });
});

describe("TtsController.bumpRate", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("snaps the new rate and applies it to the engine", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
      settings: { voice: null, rate: 1.0, ...COLORS },
    });
    ctl.start();
    ctl.bumpRate(0.05);
    expect(engine.rate).toBe(1.05);
    ctl.dispose();
  });

  it("clamps within [0.5, 6.0]", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
      settings: { voice: null, rate: 6.0, ...COLORS },
    });
    ctl.start();
    ctl.bumpRate(0.05);
    expect(engine.rate).toBe(6.0);
    ctl.dispose();
  });

  it("persists the new rate via saveSettings (debounced)", () => {
    vi.useFakeTimers();
    try {
      const saved: TtsSettings[] = [];
      const pane = fakePane({ bufferLines: ["alpha"] });
      const { ctl } = makeController({
        pane,
        point: { pixelX: 0, pixelY: 0 },
        settings: { voice: null, rate: 1.0, ...COLORS },
        saveSettings: async (s) => {
          saved.push(s);
        },
      });
      ctl.start();
      ctl.bumpRate(0.1);
      // Debounced — not yet persisted.
      expect(saved).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(saved.at(-1)?.rate).toBe(1.1);
      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid bumps into a single save", () => {
    vi.useFakeTimers();
    try {
      const saved: TtsSettings[] = [];
      const pane = fakePane({ bufferLines: ["alpha"] });
      const { ctl } = makeController({
        pane,
        point: { pixelX: 0, pixelY: 0 },
        settings: { voice: null, rate: 1.0, ...COLORS },
        saveSettings: async (s) => {
          saved.push(s);
        },
      });
      ctl.start();
      ctl.bumpRate(0.05);
      ctl.bumpRate(0.05);
      ctl.bumpRate(0.05);
      vi.advanceTimersByTime(300);
      expect(saved).toHaveLength(1);
      expect(saved[0].rate).toBeCloseTo(1.15, 5);
      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TtsController.isActive", () => {
  it("is false initially", () => {
    const { ctl } = makeController();
    expect(ctl.isActive()).toBe(false);
    ctl.dispose();
  });

  it("is true while a session is in progress", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { ctl } = makeController({ pane, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    expect(ctl.isActive()).toBe(true);
    ctl.stop();
    expect(ctl.isActive()).toBe(false);
    ctl.dispose();
  });
});

describe("TtsController boundary→highlighter wiring", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("forwards engine boundary events to the highlighter", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    engine.fireBoundary({
      line: 0,
      col: 0,
      len: 5,
      word: "alpha",
      charIndex: 0,
    });
    // Inspect the highlighter via the controller's getter for tests.
    expect((ctl as unknown as { __highlights(): TtsBoundary[] }).__highlights().length).toBe(1);
    ctl.dispose();
  });
});

describe("TtsController end-of-utterance", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("sets bar to idle when the engine fires end", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl, barFactoryWrap } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    engine.fireEnd();
    expect(barFactoryWrap.last?.states).toContain("idle");
    expect(ctl.isActive()).toBe(false);
    ctl.dispose();
  });
});

describe("TtsController.start — restart while speaking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("calls engine.start a second time (engine handles cancel internally)", () => {
    const pane = fakePane({
      bufferLines: ["alpha", "beta"],
    });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    expect(engine.startCalls).toHaveLength(1);
    ctl.start();
    expect(engine.startCalls).toHaveLength(2);
    ctl.dispose();
  });

  // Bug observed: starting TTS on
  // surface B while surface A was still highlighted left A's highlight
  // visible. Fix: TtsController.start() must clear the PREVIOUS surface's
  // highlight before swapping to the new one.
  it("clears the previous surface's highlight when switching surfaces mid-speak", () => {
    const surfaceA = fakePane({ bufferLines: ["alpha"] });
    const surfaceB = fakePane({ bufferLines: ["beta"] });
    let active: typeof surfaceA = surfaceA;
    const engine = new StubEngine();
    const barFactoryWrap = makeBarFactory();
    const ctl = new TtsController({
      engine: engine as unknown as ConstructorParameters<typeof TtsController>[0]["engine"],
      barFactory: barFactoryWrap.factory as unknown as ConstructorParameters<
        typeof TtsController
      >[0]["barFactory"],
      theme: TTS_THEME_LIGHT,
      settings: DEFAULT_SETTINGS,
      saveSettings: async () => undefined,
      getActiveSurface: () => active,
      getLastMousePoint: () => ({ pixelX: 0, pixelY: 0 }),
      voicesProvider: async () => [],
    });
    // Start on A — highlight a word so the stub records something.
    ctl.start();
    engine.fireBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    expect((surfaceA as unknown as { highlights: TtsBoundary[] }).highlights.length).toBe(1);
    // Surface A's clearCalls is still zero at this point.
    expect((surfaceA as unknown as { clearCalls: number }).clearCalls).toBe(0);
    // Now flip active surface to B and start speaking again. The fix
    // contract: A's clearHighlight gets called BEFORE the swap.
    active = surfaceB;
    ctl.start();
    expect((surfaceA as unknown as { clearCalls: number }).clearCalls).toBeGreaterThan(0);
    ctl.dispose();
  });
});

describe("TtsController degenerate-boundary wiring", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("clears the stuck highlight when the engine reports a degenerate stream", () => {
    const pane = fakePane({ bufferLines: ["alpha"] });
    const { engine, ctl } = makeController({
      pane,
      point: { pixelX: 0, pixelY: 0 },
    });
    ctl.start();
    engine.fireBoundary({ line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 });
    const stub = pane as unknown as { clearCalls: number };
    expect(stub.clearCalls).toBe(0);
    engine.fireDegenerate();
    expect(stub.clearCalls).toBe(1);
    ctl.dispose();
  });
});

describe("TtsController — highlight theme push to surface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pushes the configured theme colour to the surface on start()", () => {
    const pane = fakePane({ bufferLines: ["alpha beta"] }) as unknown as StubSurfaceAdapter;
    const { ctl } = makeController({ pane, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    expect(pane.themeColors).toContain(TTS_THEME_LIGHT.backgroundColor);
    ctl.dispose();
  });

  it("pushes a new colour to the live surface on setTheme()", () => {
    const pane = fakePane({ bufferLines: ["alpha beta"] }) as unknown as StubSurfaceAdapter;
    const { ctl } = makeController({ pane, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    ctl.setTheme({ ...TTS_THEME_LIGHT, backgroundColor: "#123456" });
    expect(pane.themeColors).toContain("#123456");
    ctl.dispose();
  });
});

// ── Content-change re-resolution (scroll → reswap) ──────────────────

/** Minimal single-word chunk (rangemap details irrelevant to these tests). */
function chunkText(text: string): SpokenChunk {
  return {
    text,
    rangeMap: [{ charStart: 0, charEnd: text.length, line: 0, col: 0, len: text.length }],
  };
}

/** A surface that supports the optional content-change hooks, with controls to
 *  drive the notification and inspect subscription state. */
function contentChangeSurface(opts: {
  chunk: SpokenChunk;
  upcoming: SpokenChunk | null;
}) {
  const container = document.createElement("div");
  container.style.position = "relative";
  document.body.appendChild(container);
  let cb: (() => void) | null = null;
  let unsub = false;
  let upcoming = opts.upcoming;
  const surface: SpeakSurfaceAdapter = {
    kind: "terminal",
    getContainerEl: () => container,
    resolveSpokenChunk: () => opts.chunk,
    highlightBoundary: () => undefined,
    clearHighlight: () => undefined,
    onContentChange: (fn: () => void) => {
      cb = fn;
      return () => {
        unsub = true;
        cb = null;
      };
    },
    resolveUpcomingChunk: () => upcoming,
    dispose: () => undefined,
  };
  return {
    surface,
    fire: () => cb?.(),
    unsubscribed: () => unsub,
    setUpcoming: (c: SpokenChunk | null) => {
      upcoming = c;
    },
  };
}

describe("TtsController — recompute upcoming words on content change", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reswaps the engine with a freshly-resolved chunk while playing", () => {
    const s = contentChangeSurface({
      chunk: chunkText("alpha beta"),
      upcoming: chunkText("alpha beta gamma"),
    });
    const { engine, ctl } = makeController({ pane: s.surface, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    expect(engine.startCalls).toHaveLength(1);
    s.fire();
    expect(engine.reswapCalls).toHaveLength(1);
    expect(engine.reswapCalls[0].text).toBe("alpha beta gamma");
    ctl.dispose();
  });

  it("does NOT reswap when the surface declines re-resolution (returns null)", () => {
    const s = contentChangeSurface({ chunk: chunkText("alpha"), upcoming: null });
    const { engine, ctl } = makeController({ pane: s.surface, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    s.fire();
    expect(engine.reswapCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("does NOT reswap on an empty recomputed chunk", () => {
    const s = contentChangeSurface({
      chunk: chunkText("alpha"),
      upcoming: { text: "", rangeMap: [] },
    });
    const { engine, ctl } = makeController({ pane: s.surface, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    s.fire();
    expect(engine.reswapCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("does NOT reswap while paused", () => {
    const s = contentChangeSurface({
      chunk: chunkText("alpha"),
      upcoming: chunkText("alpha beta"),
    });
    const { engine, ctl } = makeController({ pane: s.surface, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    ctl.pauseToggle(); // → paused
    s.fire();
    expect(engine.reswapCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("unsubscribes from content changes on stop", () => {
    const s = contentChangeSurface({
      chunk: chunkText("alpha"),
      upcoming: chunkText("alpha beta"),
    });
    const { engine, ctl } = makeController({ pane: s.surface, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    ctl.stop();
    expect(s.unsubscribed()).toBe(true);
    s.fire();
    expect(engine.reswapCalls).toHaveLength(0);
    ctl.dispose();
  });

  it("unsubscribes from content changes when playback ends", () => {
    const s = contentChangeSurface({
      chunk: chunkText("alpha"),
      upcoming: chunkText("alpha beta"),
    });
    const { engine, ctl } = makeController({ pane: s.surface, point: { pixelX: 0, pixelY: 0 } });
    ctl.start();
    engine.fireEnd();
    expect(s.unsubscribed()).toBe(true);
    ctl.dispose();
  });

  it("never subscribes for surfaces without the hooks (no crash)", () => {
    const pane = fakePane({ bufferLines: ["alpha beta"] });
    const { engine, ctl } = makeController({ pane, point: { pixelX: 0, pixelY: 0 } });
    expect(() => ctl.start()).not.toThrow();
    expect(engine.reswapCalls).toHaveLength(0);
    ctl.dispose();
  });
});
