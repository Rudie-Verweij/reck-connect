// Orchestrates dictation: builds the provider from settings, owns the
// engine, and types the transcript LIVE into the pane that was active when
// dictation started. Each transcription pass (interim or final) is the full
// text-so-far; we diff it against what's already typed and send just the
// delta (backspaces + new characters) straight into the PTY, so the words
// appear in the terminal input as you speak. No trailing newline (the user
// presses Enter) unless auto-submit is on.

import { TranscriptionEngine, type DictationState } from "./TranscriptionEngine";
import { DEFAULT_ONSET_CONFIG } from "./onsetDetector";
import { addOnset, makeChunk, stepChunk, type ChunkState, type Segment } from "./chunkModel";
import { DictationBar } from "./DictationBar";
import { DeepgramProvider } from "./providers/DeepgramProvider";
import { LocalWhisperProvider } from "./providers/LocalWhisperProvider";
import type { Transcriber, TranscriberStatus } from "./providers/types";
import {
  EMBEDDED_MODELS,
  embeddedModelRepo,
  loadTranscriptionSettings,
  type DictationAppearance,
  type TranscriptionSettings,
} from "./transcriptionSettings";

/** Where dictated text lands — typically the active terminal pane. */
export interface DictationTarget {
  /** Type text into the pane's PTY (no trailing newline). */
  insert(text: string): void;
  /** Send Enter (used only when auto-submit is on). */
  submit(): void;
}

/** The per-pane loading/status/level UI, implemented by DictationBar. */
export interface DictationUI {
  setState(state: DictationState): void;
  setStatus(status: TranscriberStatus | null): void;
  setLevel(level: number): void;
  /** Unstable ghost-tail text (never injected into the prompt). */
  setTail(text: string): void;
  /** Words HEARD (by voice energy) but not yet transcribed — ghost blobs. */
  setPendingWords(count: number): void;
  /** Phase-2 onset mode: the rolling sub-sentence chunk (blurred + crystallizing). */
  setChunk(segments: readonly Segment[]): void;
  /** Drop the whole chunk row. */
  clearChunk(): void;
  setError(message: string): void;
}

// DEL (0x7f) — the Backspace key. Terminal input lines erase the previous
// character on this, letting us "correct" earlier words when a later
// transcription pass revises them.
const DEL = "\x7f";

// Words per VOICED second (pauses already excluded, so ~4 during actual
// phonation). Drives the backlog estimate that sizes the ghost blobs.
const WORDS_PER_VOICED_SECOND = 4;
// Never render a wall of blobs (long lag / noisy room).
const MAX_PENDING_BLOBS = 8;
// Voice counts as "active right now" within this window of the last voiced
// chunk — while active, a floor of blobs shows regardless of transcription
// speed, so the leading-edge effect stays visible even on instant engines.
const VOICE_ACTIVE_MS = 300;
// After voice stops, the floor decays to 0 over this long — crystallizing,
// not a hard cut.
const FLOOR_DECAY_MS = 500;
// How many blobs the "you're being heard" floor shows while voicing.
const ACTIVE_FLOOR_BLOBS = 2;
// Backlog is reconciled to the transcript after this much silence, so stale
// blobs drain at the end of an utterance instead of squatting (kept short so
// the ghosts don't linger after you stop talking).
const SILENCE_RECONCILE_MS = 800;

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/**
 * How many ghost blobs to show. A live LEADING EDGE, not a cumulative lag
 * credit: while you're voicing, a small floor is always shown (so the effect
 * doesn't vanish the instant a fast engine catches up); on top of that, the
 * estimated un-transcribed backlog adds more (so a laggy engine like Whisper
 * shows a longer trail). The floor decays smoothly once you stop speaking.
 */
export function computeGhostBlobs(input: {
  heardWords: number;
  transcribedWords: number;
  msSinceVoice: number;
  max: number;
}): number {
  const lag = Math.max(0, input.heardWords - input.transcribedWords);
  let floor = 0;
  if (input.msSinceVoice < VOICE_ACTIVE_MS) {
    floor = ACTIVE_FLOOR_BLOBS;
  } else if (input.msSinceVoice < VOICE_ACTIVE_MS + FLOOR_DECAY_MS) {
    const t = (input.msSinceVoice - VOICE_ACTIVE_MS) / FLOOR_DECAY_MS; // 0→1
    floor = Math.round(ACTIVE_FLOOR_BLOBS * (1 - t));
  }
  return Math.min(input.max, Math.max(0, Math.max(floor, lag)));
}

/** Collapse newlines (would submit the prompt) and trim so passes diff cleanly. */
function normalizeTranscript(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

export interface Injection {
  /** DEL keystrokes to undo the diverged tail of the previous pass. */
  backspaces: number;
  /** New characters to append after the backspaces. */
  suffix: string;
  /** The full text now considered injected (diff base for the next pass). */
  injected: string;
}

/**
 * Diff the next full-text pass against what's already typed and return just
 * the delta. An EMPTY next pass over existing text is a no-op (never erases
 * what's typed) — a filtered/failed final must not swallow the utterance.
 */
export function computeInjection(prev: string, rawNext: string): Injection {
  const next = normalizeTranscript(rawNext);
  if (next === "" && prev !== "") {
    return { backspaces: 0, suffix: "", injected: prev };
  }
  let common = 0;
  const max = Math.min(prev.length, next.length);
  while (common < max && prev[common] === next[common]) common++;
  return { backspaces: prev.length - common, suffix: next.slice(common), injected: next };
}

/** Resolved when dictation starts: where text goes and where UI mounts. */
export interface DictationSession {
  target: DictationTarget;
  /** The pane wrapper — anchor for the mic button state + status pill. */
  surface: HTMLElement;
}

export interface TranscriptionControllerDeps {
  settings: TranscriptionSettings;
  /** Resolve the target + UI surface at the moment dictation starts. */
  resolveSession: () => DictationSession | null;
  /** Surface an error to the user (e.g. a toast) when no UI bar exists. */
  onError?: (message: string) => void;
}

export class TranscriptionController {
  private engine: TranscriptionEngine;
  private settings: TranscriptionSettings;
  private target: DictationTarget | null = null;
  private bar: DictationBar | null = null;
  // What we've typed into the target this utterance (to diff the next pass).
  private injectedText = "";
  // Ghost-placeholder inputs: voiced-time word estimate vs words transcribed.
  private lastTail = "";
  private heardWords = 0;
  private lastVoiceAt = 0;
  // Phase-2 onset mode: the rolling chunk (blurred + crystallizing segments)
  // and the latest stable/tail transcript we align onto it. Terminal text is
  // committed phrase-by-phrase; `committedWords` (inside the chunk) is the
  // transcript-word offset already sent to the prompt.
  private chunk: ChunkState = makeChunk();
  private stableText = "";
  private tailText = "";
  private finalPending = false;
  // Settle/batch buffers. The transcript and ghost updates arrive far too
  // fast to render each one (Deepgram interims many×/s, level ticks ~8×/s) —
  // that made the pill and prompt flicker "super messy". We coalesce the
  // latest values here and flush them on a calm ~half-second cadence, so
  // words settle in readable batches instead of churning. The meter stays on
  // the raw tick (it's meant to be lively); the final flushes immediately.
  private pendingStable: string | null = null;
  private pendingTail = "";
  private tailDirty = false;
  private settleTimer: number | null = null;

  constructor(private readonly deps: TranscriptionControllerDeps) {
    this.settings = deps.settings;
    this.engine = new TranscriptionEngine(this.makeProvider(), {
      // Stable text (safe to type) — buffered, flushed on the settle tick.
      onPartial: (t) => {
        this.pendingStable = t;
        this.stableText = t;
      },
      // Unstable ghost tail — buffered; only the latest survives to the flush.
      onTail: (t) => {
        this.pendingTail = t;
        this.tailDirty = true;
        this.tailText = t;
      },
      // The complete utterance — apply immediately (no reason to wait).
      onFinal: (t) => {
        this.pendingStable = t;
        this.stableText = t;
        this.finalPending = true;
        this.flushSettle();
      },
      onStatus: (s) => this.bar?.setStatus(s),
      onProgress: (p) => this.bar?.setProgress(p),
      // Meter stays on the raw tick (lively); only note voice activity here.
      onLevel: (l) => {
        this.bar?.setLevel(l);
        if (l > 0.01) this.lastVoiceAt = performance.now();
      },
      onSpeechMs: (ms) => {
        // Fallback estimate mode only — "onset" mode uses onWordCount below.
        if (this.settings.appearance.ghostMode === "estimate") {
          this.heardWords = Math.round((ms / 1000) * WORDS_PER_VOICED_SECOND);
        }
      },
      onWordOnset: (id) => {
        // Onset mode: append a blurred placeholder the INSTANT a word starts,
        // and show it immediately (don't wait for the settle tick) — this is
        // the "text always starts blurred" moment.
        if (this.settings.appearance.ghostMode !== "onset") return;
        this.chunk = addOnset(this.chunk, id);
        this.bar?.setChunk(this.chunk.segments);
      },
      onError: (m) => {
        console.error("[dictation] error:", m);
        if (this.bar) this.bar.setError(m);
        else this.deps.onError?.(m);
        // A provider error mid-session (Deepgram socket drop, worker crash)
        // used to leave the engine stuck in listening/transcribing — the mic
        // frozen amber, the next click trying to stop a dead session. Force
        // back to idle so the button is always usable again.
        if (this.engine.isActive() && this.engine.getState() !== "preparing") {
          void this.engine.cancel();
        }
      },
      onStateChange: (s) => this.onStateChange(s),
    });
  }

  private makeProvider(): Transcriber {
    if (this.settings.provider === "deepgram") {
      return new DeepgramProvider({ language: this.settings.language });
    }
    // Live partials run on tiny (fast enough to keep up with speech); the
    // final pass uses the selected model for quality.
    return new LocalWhisperProvider(embeddedModelRepo(this.settings.localModel), {
      partialRepo: embeddedModelRepo("whisper-tiny"),
      language: this.settings.language,
    });
  }

  /** Short model name for the loading UI (local engine only). */
  private modelLabel(): string | null {
    if (this.settings.provider !== "local") return null;
    const m = EMBEDDED_MODELS.find((x) => x.id === this.settings.localModel);
    const short = m ? m.label.split("—")[0].trim() : this.settings.localModel;
    return `Whisper ${short}`;
  }

  /**
   * Type the full text-so-far into the pane live: diff against what we've
   * already injected and send just the delta — backspaces to undo any revised
   * tail, then the new suffix. Never backspaces past our own injected text, so
   * anything the user typed before dictating is safe.
   */
  private applyTranscript(text: string): void {
    if (!this.target) return;
    const { backspaces, suffix, injected } = computeInjection(this.injectedText, text);
    this.injectedText = injected;
    if (backspaces === 0 && suffix.length === 0) return;
    console.log(`[dictation] type: -${backspaces} +${JSON.stringify(suffix)}`);
    this.target.insert(DEL.repeat(backspaces) + suffix);
  }

  /**
   * Ghost placeholders: words we've HEARD (voice energy) minus words already
   * visible as text (typed stable words + the ghost tail). What remains is
   * rendered as blurred blobs — instant "I heard that" feedback that
   * crystallizes into words as the engine catches up.
   */
  private syncGhosts(): void {
    const transcribed = wordCount(this.injectedText) + wordCount(this.lastTail);
    const msSinceVoice =
      this.lastVoiceAt > 0 ? performance.now() - this.lastVoiceAt : Number.POSITIVE_INFINITY;
    // Once the mic has been quiet a beat, whatever the engine was going to
    // transcribe has arrived — reconcile the backlog so it drains at the end
    // of an utterance instead of squatting.
    if (msSinceVoice > SILENCE_RECONCILE_MS) {
      this.heardWords = Math.min(this.heardWords, transcribed);
    }
    const pending = computeGhostBlobs({
      heardWords: this.heardWords,
      transcribedWords: transcribed,
      msSinceVoice,
      max: MAX_PENDING_BLOBS,
    });
    this.bar?.setPendingWords(pending);
  }

  /** Batch the buffered updates on the settle tick. Onset mode drives the
   *  crystallizing chunk; estimate mode is the legacy blob path. */
  private flushSettle(): void {
    if (this.settings.appearance.ghostMode === "onset") this.flushOnset();
    else this.flushEstimate();
  }

  /** Milliseconds since the last voiced chunk (∞ if we haven't heard any). */
  private msSinceVoice(): number {
    return this.lastVoiceAt > 0 ? performance.now() - this.lastVoiceAt : Number.POSITIVE_INFINITY;
  }

  private words(text: string): string[] {
    const t = normalizeTranscript(text);
    return t === "" ? [] : t.split(/\s+/);
  }

  /** Append committed phrase text to the terminal (never revised once sent). */
  private commitToTerminal(text: string): void {
    if (!this.target || text === "") return;
    const sep = this.injectedText === "" ? "" : " ";
    this.injectedText = this.injectedText + sep + text;
    console.log(`[dictation] commit: +${JSON.stringify(sep + text)}`);
    this.target.insert(sep + text);
  }

  /**
   * Onset mode (Phase 2). Align the uncommitted transcript tail onto the chunk
   * (words crystallize left→right in the pill), then commit the leading
   * resolved run into the terminal once the chunk fills (commitWordCount) or
   * the speaker pauses (commitPauseMs). On final, everything remaining lands.
   */
  private flushOnset(): void {
    this.pendingStable = null;
    this.tailDirty = false;
    const a = this.settings.appearance;
    const allWords = this.words(`${this.stableText} ${this.tailText}`);
    const tailWords = allWords.slice(this.chunk.committedWords);

    const { chunk, commits, cleared } = stepChunk(
      this.chunk,
      tailWords,
      {
        msSinceVoice: this.msSinceVoice(),
        commitWordCount: a.commitWordCount,
        commitPauseMs: a.commitPauseMs,
        ghostResetMs: a.ghostResetMs,
      },
      this.finalPending,
    );
    for (const text of commits) this.commitToTerminal(text);
    this.chunk = chunk;
    this.finalPending = false;
    if (cleared) this.bar?.clearChunk();
    else this.bar?.setChunk(this.chunk.segments);
  }

  /**
   * Estimate mode (legacy). Apply the latest stable text into the prompt, the
   * latest ghost tail into the pill, and a single blob recompute.
   */
  private flushEstimate(): void {
    if (this.pendingStable !== null) {
      this.applyTranscript(this.pendingStable);
      this.pendingStable = null;
    }
    if (this.tailDirty) {
      this.lastTail = this.pendingTail;
      this.bar?.setTail(this.pendingTail);
      this.tailDirty = false;
    } else if (this.lastTail !== "" && this.engine.getState() === "listening") {
      // Stale-ghost reset: still recording but quiet with nothing pending →
      // the last interim never resolved (a mismatch left words squatting).
      // Clear it so the pill doesn't hold phantom words.
      if (this.msSinceVoice() > this.settings.appearance.ghostResetMs) {
        this.lastTail = "";
        this.bar?.setTail("");
      }
    }
    this.syncGhosts();
  }

  private startSettleTimer(): void {
    this.stopSettleTimer();
    this.settleTimer = window.setInterval(
      () => this.flushSettle(),
      this.settings.appearance.settleMs,
    );
  }

  private stopSettleTimer(): void {
    if (this.settleTimer !== null) {
      window.clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private resetSettleBuffers(): void {
    this.pendingStable = null;
    this.pendingTail = "";
    this.tailDirty = false;
  }

  /** Clear all per-utterance transcript/chunk state (start, cancel, idle). */
  private resetUtteranceState(): void {
    this.injectedText = "";
    this.lastTail = "";
    this.heardWords = 0;
    this.chunk = makeChunk();
    this.stableText = "";
    this.tailText = "";
    this.finalPending = false;
  }

  private onStateChange(state: DictationState): void {
    // The lifecycle, narrated — when a state looks stuck, the console says
    // which transition never happened.
    console.log(
      `[dictation] state → ${state} (${this.settings.provider}${
        this.settings.provider === "local" ? `/${this.settings.localModel}` : ""
      })`,
    );
    this.bar?.setState(state);
    if (state === "idle") {
      // Stop batching and DROP any unflushed buffer. The normal stop path
      // already applied the full utterance via onFinal's immediate flush;
      // the send/cancel path deliberately discards the buffered tail (the
      // user pressed Enter — a late injection would land in the next prompt).
      this.stopSettleTimer();
      this.resetSettleBuffers();
      if (this.injectedText.length > 0 && this.settings.autoSubmit) this.target?.submit();
      this.bar?.dispose();
      this.bar = null;
      this.target = null;
      this.resetUtteranceState();
    }
  }

  /** Push-to-talk / button: start when idle, stop when listening. */
  async toggle(): Promise<void> {
    const state = this.engine.getState();
    if (state === "idle") await this.startDictation();
    else if (state === "listening") await this.engine.stop();
    else if (state === "preparing") await this.cancel(); // abort a slow model load
    // A slow final pass (big model, long utterance) shouldn't hold the mic
    // hostage: clicking again abandons the improvement pass. The stable
    // words already typed into the prompt stay.
    else if (state === "transcribing") await this.cancel();
  }

  async startDictation(): Promise<void> {
    if (this.engine.getState() !== "idle") return;
    // Honor the CURRENT settings page state: engine/model/language edits
    // apply to the next dictation, not the next app launch.
    try {
      this.updateSettings(await loadTranscriptionSettings());
    } catch {
      // Config unreadable — dictate with the settings we already have.
    }
    const session = this.deps.resolveSession();
    if (!session) {
      this.deps.onError?.("No active terminal to dictate into.");
      return;
    }
    this.target = session.target;
    this.bar = new DictationBar(
      session.surface,
      this.modelLabel(),
      this.settings.fluidMotion,
      this.settings.appearance,
    );
    this.resetUtteranceState();
    this.resetSettleBuffers();
    this.applyOnsetConfig();
    this.startSettleTimer();
    await this.engine.start();
  }

  async stopDictation(): Promise<void> {
    if (this.engine.getState() === "listening") await this.engine.stop();
  }

  /**
   * The user pressed Enter to SEND the message — they're done talking. Abort
   * (don't finalize): the committed text is already in the prompt and about
   * to be sent, so a late final pass would land in the NEXT prompt. The
   * already-typed text is untouched by cancel(), so the Enter sends it.
   */
  async stopForSend(): Promise<void> {
    if (this.engine.isActive()) await this.cancel();
  }

  async cancel(): Promise<void> {
    this.stopSettleTimer();
    this.resetSettleBuffers();
    await this.engine.cancel();
    this.bar?.dispose();
    this.bar = null;
    this.target = null;
    this.resetUtteranceState();
  }

  isActive(): boolean {
    return this.engine.isActive();
  }

  getState(): DictationState {
    return this.engine.getState();
  }

  /** Apply new settings; swaps the provider if the engine is idle. */
  updateSettings(next: TranscriptionSettings): void {
    const providerChanged =
      next.provider !== this.settings.provider ||
      next.localModel !== this.settings.localModel ||
      next.language !== this.settings.language;
    this.settings = next;
    if (providerChanged && this.engine.getState() === "idle") {
      this.engine.setProvider(this.makeProvider());
    }
  }

  /** Current settings snapshot (the language menu reads + rewrites these). */
  getSettings(): TranscriptionSettings {
    return this.settings;
  }

  /**
   * Live-apply the appearance knobs (from the Advanced panel): update the
   * running pill immediately and re-time the settle loop to the new cadence.
   * Caller persists.
   */
  updateAppearance(next: DictationAppearance): void {
    this.settings = { ...this.settings, appearance: next };
    this.bar?.applyAppearance(next);
    this.applyOnsetConfig();
    if (this.settleTimer !== null) this.startSettleTimer();
  }

  /** Push the onset-detection thresholds from settings into the engine. */
  private applyOnsetConfig(): void {
    const a = this.settings.appearance;
    this.engine.setOnsetConfig({
      ...DEFAULT_ONSET_CONFIG,
      openThreshold: a.onsetOpen,
      closeThreshold: a.onsetClose,
    });
  }

  dispose(): void {
    this.stopSettleTimer();
    this.engine.dispose();
  }
}
