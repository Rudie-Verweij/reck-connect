// Dictation keyboard shortcut (⌘⇧V) with hybrid press semantics:
//   - HOLD  = push-to-talk: recording runs while the chord is held and stops
//     on release (initTranscription decides using the held duration);
//   - TAP   = toggle: a short press starts recording and leaves it running;
//     tap again to stop.
// This module only reports raw press edges (start + end with the held time);
// the policy lives in initTranscription so it can consult dictation state.

export interface TranscriptionShortcutHandlers {
  /** The chord went down (never fired for key-repeat). */
  onPressStart(): void;
  /** The chord was released; `heldMs` is how long it was held. */
  onPressEnd(heldMs: number): void;
  /**
   * A bare Enter (no modifiers) was pressed — i.e. the user is SENDING the
   * message. Not preventDefault'd: the Enter still reaches the terminal to
   * submit; this is just the signal that they're done talking.
   */
  onSubmit(): void;
}

export function installTranscriptionShortcuts(
  handlers: TranscriptionShortcutHandlers,
): () => void {
  let downAt: number | null = null;

  function onKeyDown(e: KeyboardEvent): void {
    // Bare Enter = "send this message". Report it (the handler decides whether
    // dictation is active); never preventDefault so the terminal still submits.
    if (
      e.key === "Enter" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.repeat
    ) {
      handlers.onSubmit();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey || e.key.toLowerCase() !== "v") return;
    e.preventDefault();
    if (e.repeat || downAt !== null) return;
    downAt = performance.now();
    handlers.onPressStart();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (downAt === null) return;
    // The chord counts as released when ANY of its keys goes up — on macOS
    // the modifier often lifts before the letter.
    const k = e.key.toLowerCase();
    if (k !== "v" && k !== "meta" && k !== "control" && k !== "shift") return;
    const held = performance.now() - downAt;
    downAt = null;
    handlers.onPressEnd(held);
  }

  // CAPTURE phase: the focused xterm terminal handles Enter (it's terminal
  // input) and the event may not bubble up to window — capturing lets us see
  // the keydown BEFORE the terminal, so "Enter sends → stop dictation" fires
  // reliably. We still don't preventDefault Enter, so the terminal submits.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
  };
}
