// Dictation Tuning Lab — a standalone dev page (dictation-lab.html) that
// REPLAYS a scripted dictation timeline through the REAL DictationBar overlay
// while every appearance knob is live-tunable on the right. It has no mic, no
// Electron, and no window.reckAPI dependency: the whole session is simulated
// by driving the same DictationBar methods the real TranscriptionController
// calls (setState / setLevel / setTail / setPendingWords).
//
// Served at /dictation-lab.html (dev + packaged). Pick a script, hit Replay,
// then tune crystallizeMs/blur/etc. until the ghost-text look feels right and
// "Copy settings JSON" the result into DEFAULT_APPEARANCE.

import "./styles.css";
import { DictationBar } from "./transcription/DictationBar";
import type { DictationState } from "./transcription/TranscriptionEngine";
import { addOnset, makeChunk, stepChunk, type ChunkState } from "./transcription/chunkModel";
import { renderAppearanceControls } from "./transcription/appearanceControls";
import { confirmDialog } from "./ui/confirmDialog";
import {
  DEFAULT_APPEARANCE,
  coerceAppearance,
  type DictationAppearance,
} from "./transcription/transcriptionSettings";

// ---------------------------------------------------------------------------
// Script model — a spoken utterance as timed word events
// ---------------------------------------------------------------------------

/** One spoken word's timeline in the simulation. */
interface LabWord {
  /** Final, correct spelling (what lands in the prompt). */
  final: string;
  /** ms: the onset is "heard" → a blurred blob appears instantly. */
  onset: number;
  /** ms: transcription resolves the word → it crystallizes (interim or final). */
  resolveAt: number;
  /** Optional wrong interim spelling, shown until `correctAt`. */
  interim?: string;
  /** ms: the interim is revised to `final` (re-crystallize on revision). */
  correctAt?: number;
}

interface LabScript {
  id: string;
  name: string;
  /** "preparing" (model-load) time before listening starts. */
  prepMs: number;
  words: LabWord[];
}

/** Steady-cadence word layout — models even speech. */
function layout(
  phrase: string,
  opts: { start: number; gap: number; resolveLag: number },
): LabWord[] {
  return phrase.split(" ").map((final, i) => {
    const onset = opts.start + i * opts.gap;
    return { final, onset, resolveAt: onset + opts.resolveLag };
  });
}

// --- The hand-authored scripts --------------------------------------------

function shortPhraseScript(): LabScript {
  return {
    id: "short",
    name: "Short phrase",
    prepMs: 250,
    words: layout("list the open files", { start: 300, gap: 240, resolveLag: 220 }),
  };
}

function longSentenceScript(): LabScript {
  return {
    id: "long",
    name: "Long sentence",
    prepMs: 320,
    words: layout(
      "please refactor the authentication module and add unit tests for the token refresh path",
      { start: 360, gap: 250, resolveLag: 200 },
    ),
  };
}

function noisyRevisingScript(): LabScript {
  // Slower, laggier speech with two spots where the interim guess is wrong and
  // later revised — exercising the re-crystallize-on-revision path (only the
  // corrected word re-animates).
  const words = layout("fix the auth bug in the login flow", {
    start: 340,
    gap: 300,
    resolveLag: 260,
  });
  // "auth" first heard as "aurth", corrected shortly after it resolves.
  words[2].interim = "aurth";
  words[2].correctAt = words[2].resolveAt + 360;
  // "login" first mis-heard as "log", corrected shortly after.
  words[6].interim = "log";
  words[6].correctAt = words[6].resolveAt + 300;
  return { id: "noisy", name: "Noisy / revising", prepMs: 300, words };
}

const SCRIPTS: LabScript[] = [
  shortPhraseScript(),
  longSentenceScript(),
  noisyRevisingScript(),
];

// --- Derived timing --------------------------------------------------------

// Voiced window per word (ms) — used only to compute "silence since last word"
// so the pause-flush (commitPauseMs) fires realistically between phrases.
const VOICED_MS = 240;
// Silence after the last word before the "transcribing" final pass runs. Long
// enough that a trailing pause-flush commits the last phrase first.
const FINAL_TAIL_MS = 1500;
const IDLE_TAIL_MS = 400;

interface Timing {
  listenStart: number;
  finalAt: number;
  idleAt: number;
  durationMs: number;
}

function timingFor(script: LabScript): Timing {
  const listenStart = script.prepMs;
  const lastActivity = script.words.reduce(
    (m, w) => Math.max(m, w.onset, w.resolveAt, w.correctAt ?? 0),
    listenStart,
  );
  const finalAt = lastActivity + FINAL_TAIL_MS;
  const idleAt = finalAt + IDLE_TAIL_MS;
  return { listenStart, finalAt, idleAt, durationMs: idleAt + 200 };
}

/** The word's spelling at time `t` (interim until corrected), once resolved. */
function spellingAt(w: LabWord, t: number): string {
  return w.interim !== undefined && (w.correctAt === undefined || t < w.correctAt)
    ? w.interim
    : w.final;
}

/** Full transcript (all resolved words, current spelling) at time `t`. */
function transcriptAt(words: LabWord[], t: number): string[] {
  const out: string[] = [];
  for (const w of words) if (w.resolveAt <= t) out.push(spellingAt(w, t));
  return out;
}

/** End of the most recent voiced window at `t` (−∞ if none) — for msSinceVoice. */
function voiceEndAt(words: LabWord[], t: number): number {
  let end = Number.NEGATIVE_INFINITY;
  for (const w of words) if (w.onset <= t) end = Math.max(end, w.onset + VOICED_MS);
  return end;
}

/** Simulated mic level (0..0.5): bumps while each word is being voiced. */
function levelAt(words: LabWord[], t: number): number {
  let level = 0.04;
  for (const w of words) {
    const center = w.onset + VOICED_MS / 2;
    const half = VOICED_MS / 2 + 90;
    const d = Math.abs(t - center);
    if (d < half) level = Math.max(level, 0.07 + (1 - d / half) * 0.4);
  }
  const jitter = (Math.sin(t / 47) + Math.sin(t / 91)) * 0.02;
  return Math.max(0, Math.min(0.5, level + jitter));
}

function phaseAt(t: number, tm: Timing): DictationState {
  if (t < tm.listenStart) return "preparing";
  if (t < tm.finalAt) return "listening";
  if (t < tm.idleAt) return "transcribing";
  return "idle";
}

// ---------------------------------------------------------------------------
// Replay engine — drives the REAL chunk model + DictationBar (no fakes)
// ---------------------------------------------------------------------------

class ReplayEngine {
  private bar: DictationBar | null = null;
  private script: LabScript;
  private timing: Timing;
  private position = 0; // ms playhead
  private playing = false;
  private wallStart = 0;
  private raf = 0;

  // Simulation state (reset on seek / rebuild).
  private chunk: ChunkState = makeChunk();
  private committed = "";
  private firedOnsets = 0;
  private nextSettleAt = 0;
  private finalDone = false;
  private curPhase: DictationState | null = null;

  constructor(
    private readonly stage: HTMLElement,
    private appearance: DictationAppearance,
    private readonly onTick: (position: number, duration: number, playing: boolean) => void,
    private readonly onCommitted: (text: string) => void,
    script: LabScript,
  ) {
    this.script = script;
    this.timing = timingFor(script);
    this.reset();
  }

  get durationMs(): number {
    return this.timing.durationMs;
  }

  setScript(script: LabScript): void {
    this.script = script;
    this.timing = timingFor(script);
    this.seek(0);
  }

  setAppearance(a: DictationAppearance): void {
    this.appearance = a;
    this.bar?.applyAppearance(a);
  }

  private reset(): void {
    this.bar?.dispose();
    this.bar = new DictationBar(this.stage, "Whisper Base", true, this.appearance);
    this.chunk = makeChunk();
    this.committed = "";
    this.firedOnsets = 0;
    this.nextSettleAt = this.timing.listenStart;
    this.finalDone = false;
    this.curPhase = null;
    this.onCommitted("");
  }

  /** Keep the bar's coarse state (loader/meter/spinner) in sync with `t`. */
  private ensurePhase(t: number): void {
    const phase = phaseAt(t, this.timing);
    if (phase === this.curPhase) return;
    this.curPhase = phase;
    this.bar?.setState(phase);
  }

  /** Fire word onsets whose time has passed — instant blurred blobs. */
  private fireOnsetsUpTo(t: number): void {
    let fired = false;
    while (
      this.firedOnsets < this.script.words.length &&
      this.script.words[this.firedOnsets].onset <= t
    ) {
      this.chunk = addOnset(this.chunk, this.firedOnsets + 1);
      this.firedOnsets++;
      fired = true;
    }
    if (fired) this.bar?.setChunk(this.chunk.segments);
  }

  /** One settle tick: align the tail, commit due phrases (the SAME stepChunk
   *  the live controller runs), and render. */
  private settleStep(ts: number): void {
    const a = this.appearance;
    const allWords = transcriptAt(this.script.words, ts);
    const tailWords = allWords.slice(this.chunk.committedWords);
    const final = ts >= this.timing.finalAt && !this.finalDone;
    const msSinceVoice = ts - voiceEndAt(this.script.words, ts);
    const { chunk, commits, cleared } = stepChunk(
      this.chunk,
      tailWords,
      {
        msSinceVoice,
        commitWordCount: a.commitWordCount,
        commitPauseMs: a.commitPauseMs,
        ghostResetMs: a.ghostResetMs,
      },
      final,
    );
    if (commits.length > 0) {
      this.committed = [this.committed, ...commits].filter((s) => s !== "").join(" ");
      this.onCommitted(this.committed);
    }
    this.chunk = chunk;
    if (final) this.finalDone = true;
    if (cleared) this.bar?.clearChunk();
    else this.bar?.setChunk(this.chunk.segments);
  }

  /** Advance the simulation deterministically to sim time `t`. */
  private advanceTo(t: number): void {
    const settle = Math.max(80, this.appearance.settleMs);
    while (this.nextSettleAt <= t) {
      this.ensurePhase(this.nextSettleAt);
      this.fireOnsetsUpTo(this.nextSettleAt);
      if (phaseAt(this.nextSettleAt, this.timing) !== "preparing") {
        this.settleStep(this.nextSettleAt);
      }
      this.nextSettleAt += settle;
    }
    // Instant blobs for onsets between the last settle tick and now.
    this.fireOnsetsUpTo(t);
    this.ensurePhase(t);
    if (this.bar && phaseAt(t, this.timing) === "listening") {
      this.bar.setLevel(levelAt(this.script.words, t));
    }
  }

  private loop = (): void => {
    if (!this.playing) return;
    this.position = performance.now() - this.wallStart;
    if (this.position >= this.timing.durationMs) {
      this.position = this.timing.durationMs;
      this.advanceTo(this.position);
      this.playing = false;
      this.onTick(this.position, this.timing.durationMs, false);
      return;
    }
    this.advanceTo(this.position);
    this.onTick(this.position, this.timing.durationMs, true);
    this.raf = requestAnimationFrame(this.loop);
  };

  play(): void {
    if (this.playing) return;
    if (this.position >= this.timing.durationMs) this.seek(0);
    this.playing = true;
    this.wallStart = performance.now() - this.position;
    this.raf = requestAnimationFrame(this.loop);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onTick(this.position, this.timing.durationMs, false);
  }

  replay(): void {
    this.seek(0);
    this.play();
  }

  /** Seek to `t` — rebuild from scratch and re-simulate up to `t` (deterministic). */
  seek(t: number): void {
    const wasPlaying = this.playing;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    const clamped = Math.max(0, Math.min(t, this.timing.durationMs));
    this.reset();
    this.position = clamped;
    this.advanceTo(clamped);
    this.onTick(this.position, this.timing.durationMs, wasPlaying);
    if (wasPlaying) this.play();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.bar?.dispose();
    this.bar = null;
  }
}


// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(ms: number, total: number): string {
  return `${(ms / 1000).toFixed(1)}s / ${(total / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Page bootstrap
// ---------------------------------------------------------------------------

function boot(): void {
  const root = document.getElementById("lab");
  if (!root) return;

  // Working copy of the appearance settings (coerced defaults).
  let appearance: DictationAppearance = coerceAppearance(DEFAULT_APPEARANCE);
  let currentScript = SCRIPTS[0];

  // --- Header --------------------------------------------------------------
  const head = el("div", "lab-head");
  const headLeft = el("div");
  headLeft.append(
    el("h1", undefined, "Dictation Tuning Lab"),
    el(
      "p",
      undefined,
      "Replay a scripted dictation through the real DictationBar overlay and live-tune the crystallizing ghost-text look. No mic, no Electron — pure simulation. Copy the JSON into DEFAULT_APPEARANCE when it feels right.",
    ),
  );
  head.append(headLeft);
  root.append(head);

  const grid = el("div", "lab-grid");
  const leftCol = el("div", "lab-col");
  const rightCol = el("div", "lab-col");
  grid.append(leftCol, rightCol);
  root.append(grid);

  // --- LEFT: stage + playback ---------------------------------------------
  const stageCard = el("div", "lab-card");
  stageCard.append(el("h2", undefined, "Stage"));

  const stage = el("div", "lab-stage");
  const stageHint = el("div", "lab-stage-hint", "terminal pane");
  stage.append(stageHint);
  stageCard.append(stage);

  // Fake prompt line beneath the pill showing the committed transcript.
  const promptLine = el("div", "lab-prompt");
  const promptText = el("span", undefined, "");
  const caret = el("span", "caret");
  promptLine.append(el("span", undefined, "› "), promptText, caret);

  // Playback controls.
  const controls = el("div", "lab-controls");
  const replayBtn = el("button", "primary", "⟳ Replay");
  const playBtn = el("button", undefined, "▶ Play");
  const scriptPicker = el("select");
  for (const s of SCRIPTS) {
    const opt = el("option");
    opt.value = s.id;
    opt.textContent = s.name;
    scriptPicker.append(opt);
  }
  const themeBtn = el("button", undefined, "◑ Theme: dark");
  const picker = el("div", "lab-picker");
  picker.append(el("span", undefined, "Script:"), scriptPicker);
  controls.append(replayBtn, playBtn, picker, themeBtn);

  const scrubRow = el("div", "lab-scrub-row");
  const scrubber = el("input");
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.step = "10";
  const timeLabel = el("span", "lab-time", "0.0s / 0.0s");
  scrubRow.append(scrubber, timeLabel);

  stageCard.append(promptLine, controls, scrubRow);
  leftCol.append(stageCard);

  // --- Replay engine -------------------------------------------------------
  let isPlaying = false;
  const engine = new ReplayEngine(
    stage,
    appearance,
    (position, duration, playing) => {
      scrubber.max = String(Math.round(duration));
      scrubber.value = String(Math.round(position));
      timeLabel.textContent = fmtTime(position, duration);
      playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
      isPlaying = playing;
    },
    (text) => {
      promptText.textContent = text;
    },
    currentScript,
  );
  scrubber.max = String(Math.round(engine.durationMs));

  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      engine.pause();
      isPlaying = false;
    } else {
      engine.play();
      isPlaying = true;
    }
  });
  replayBtn.addEventListener("click", () => {
    engine.replay();
    isPlaying = true;
  });
  scriptPicker.addEventListener("change", () => {
    const next = SCRIPTS.find((s) => s.id === scriptPicker.value);
    if (!next) return;
    currentScript = next;
    engine.setScript(next);
    isPlaying = false;
  });
  scrubber.addEventListener("input", () => {
    engine.seek(Number(scrubber.value));
  });

  // Theme toggle (drives pillTheme:auto via documentElement dataset).
  let theme: "dark" | "light" = "dark";
  document.documentElement.dataset.theme = theme;
  themeBtn.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    stage.classList.toggle("light-pane", theme === "light");
    themeBtn.textContent = `◑ Theme: ${theme}`;
  });

  // --- RIGHT: appearance controls -----------------------------------------
  const ctrlCard = el("div", "lab-card");
  ctrlCard.append(el("h2", undefined, "Appearance"));

  const toolbar = el("div", "lab-toolbar");
  const copyBtn = el("button", "lab-btn", "⧉ Copy settings JSON");
  const resetBtn = el("button", "lab-btn", "↺ Reset to defaults");
  toolbar.append(copyBtn, resetBtn);
  ctrlCard.append(toolbar);

  // The SHARED controls (identical to the app's Advanced panel), inside a
  // scrollable container so every knob is reachable no matter the window height.
  const scrollHost = el("div", "lab-scroll");
  ctrlCard.append(scrollHost);
  rightCol.append(ctrlCard);

  const ctrlHandle = renderAppearanceControls(scrollHost, {
    current: appearance,
    onChange: (next) => {
      appearance = next;
      engine.setAppearance(appearance);
    },
  });

  // --- Toolbar actions -----------------------------------------------------
  const toast = el("div", "lab-toast");
  document.body.append(toast);
  function showToast(msg: string): void {
    toast.textContent = msg;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 1400);
  }

  copyBtn.addEventListener("click", () => {
    const json = JSON.stringify(ctrlHandle.getValue(), null, 2);
    const done = (): void => showToast("Settings JSON copied");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json).then(done, () => fallbackCopy(json, done));
    } else {
      fallbackCopy(json, done);
    }
  });

  resetBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Reset appearance to defaults?",
      detail: "This discards your current tuning and restores the shipped values.",
      confirmLabel: "Yes, reset",
      cancelLabel: "No",
    });
    if (!ok) return;
    appearance = coerceAppearance(DEFAULT_APPEARANCE);
    ctrlHandle.setAll(appearance);
    engine.setAppearance(appearance);
    showToast("Reset to defaults");
  });
}

/** Clipboard fallback for non-secure contexts (execCommand). */
function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } finally {
    ta.remove();
  }
}

boot();
