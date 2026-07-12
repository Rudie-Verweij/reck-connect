// Orchestrates dictation: builds the provider from settings, owns the
// engine, and injects finalized transcripts into the pane that was active
// when dictation started. Interim text and status go to the UI bar only —
// only finals are typed into the PTY, without a trailing newline (the user
// presses Enter), unless auto-submit is enabled.

import { TranscriptionEngine, type DictationState } from "./TranscriptionEngine";
import { DeepgramProvider } from "./providers/DeepgramProvider";
import { LocalWhisperProvider } from "./providers/LocalWhisperProvider";
import type { Transcriber, TranscriberStatus } from "./providers/types";
import { embeddedModelRepo, type TranscriptionSettings } from "./transcriptionSettings";

/** Where dictated text lands — typically the active terminal pane. */
export interface DictationTarget {
  /** Type text into the pane's PTY (no trailing newline). */
  insert(text: string): void;
  /** Send Enter (used only when auto-submit is on). */
  submit(): void;
}

/** The floating per-pane UI (implemented by DictationBar in Task 5). */
export interface DictationUI {
  setState(state: DictationState): void;
  setInterim(text: string): void;
  setStatus(status: TranscriberStatus | null): void;
  setError(message: string): void;
}

export interface TranscriptionControllerDeps {
  settings: TranscriptionSettings;
  /** Resolve the injection target at the moment dictation starts. */
  resolveTarget: () => DictationTarget | null;
  ui?: DictationUI;
  /** Surface an error to the user (e.g. a toast). */
  onError?: (message: string) => void;
}

export class TranscriptionController {
  private engine: TranscriptionEngine;
  private settings: TranscriptionSettings;
  private target: DictationTarget | null = null;
  private injectedAny = false;

  constructor(private readonly deps: TranscriptionControllerDeps) {
    this.settings = deps.settings;
    this.engine = new TranscriptionEngine(this.makeProvider(), {
      onPartial: (t) => this.deps.ui?.setInterim(t),
      onFinal: (t) => this.injectFinal(t),
      onStatus: (s) => this.deps.ui?.setStatus(s),
      onError: (m) => {
        this.deps.ui?.setError(m);
        this.deps.onError?.(m);
      },
      onStateChange: (s) => this.onStateChange(s),
    });
  }

  private makeProvider(): Transcriber {
    if (this.settings.provider === "deepgram") return new DeepgramProvider();
    return new LocalWhisperProvider(embeddedModelRepo(this.settings.localModel));
  }

  private injectFinal(text: string): void {
    const clean = text.trim();
    if (!clean || !this.target) return;
    // Space-join successive final segments (Deepgram streams several).
    this.target.insert(this.injectedAny ? ` ${clean}` : clean);
    this.injectedAny = true;
  }

  private onStateChange(state: DictationState): void {
    this.deps.ui?.setState(state);
    this.deps.ui?.setStatus(null);
    if (state === "idle") {
      if (this.injectedAny && this.settings.autoSubmit) this.target?.submit();
      this.target = null;
      this.injectedAny = false;
    }
  }

  /** Push-to-talk / button: start when idle, stop when listening. */
  async toggle(): Promise<void> {
    const state = this.engine.getState();
    if (state === "idle") await this.startDictation();
    else if (state === "listening") await this.engine.stop();
    // "transcribing" → busy; ignore.
  }

  async startDictation(): Promise<void> {
    if (this.engine.getState() !== "idle") return;
    this.target = this.deps.resolveTarget();
    if (!this.target) {
      this.deps.onError?.("No active terminal to dictate into.");
      return;
    }
    this.injectedAny = false;
    this.deps.ui?.setInterim("");
    await this.engine.start();
  }

  async stopDictation(): Promise<void> {
    if (this.engine.getState() === "listening") await this.engine.stop();
  }

  async cancel(): Promise<void> {
    await this.engine.cancel();
    this.target = null;
    this.injectedAny = false;
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
      next.provider !== this.settings.provider || next.localModel !== this.settings.localModel;
    this.settings = next;
    if (providerChanged && this.engine.getState() === "idle") {
      this.engine.setProvider(this.makeProvider());
    }
  }

  dispose(): void {
    this.engine.dispose();
  }
}
