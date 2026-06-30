export interface TtsShortcutHandlers {
  /** Start (or restart) speech from current selection / mouse location. */
  onSpeak(): void;
  /**
   * Stop the current speech session. Currently no shortcut fires this —
   * Esc was retired as a binding because the rest of the app needs it.
   * The control bar's stop button is the user-facing stop affordance.
   * Kept on the interface so a future shortcut can wire to it without an
   * API break.
   */
  onStop(): void;
  /** Toggle pause/resume (⌘⇧X). Only fires when isActive() returns true. */
  onPauseToggle(): void;
  /** Bump rate by +0.05. Only fires when isActive() returns true. */
  onRateUp(): void;
  /** Bump rate by -0.05. Only fires when isActive() returns true. */
  onRateDown(): void;
  /**
   * Returns true while a speech session is in progress (playing or paused).
   * Used to gate Esc and rate-bump shortcuts so they don't steal keystrokes
   * when nothing is being spoken.
   */
  isActive(): boolean;
}

export function installTtsShortcuts(handlers: TtsShortcutHandlers): () => void {
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const lower = key.toLowerCase();

    // NOTE: Esc was previously bound to "stop" but Esc is heavily used
    // elsewhere in the app (closing dialogs, dismissing overlays, xterm
    // input). Stealing it for TTS made the rest of the UI feel sticky.
    // Stop is now exclusively the control bar's stop button.

    // Everything below requires Cmd/Ctrl + Shift.
    if (!mod || !e.shiftKey) return;

    if (lower === "s") {
      e.preventDefault();
      handlers.onSpeak();
      return;
    }

    if (lower === "x") {
      if (handlers.isActive()) {
        e.preventDefault();
        handlers.onPauseToggle();
      }
      return;
    }

    if (key === "+" || key === "=") {
      if (handlers.isActive()) {
        e.preventDefault();
        handlers.onRateUp();
      }
      return;
    }

    if (key === "-" || key === "_") {
      if (handlers.isActive()) {
        e.preventDefault();
        handlers.onRateDown();
      }
      return;
    }
  }

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
