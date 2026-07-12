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
}

export function installTranscriptionShortcuts(
  handlers: TranscriptionShortcutHandlers,
): () => void {
  let downAt: number | null = null;

  function onKeyDown(e: KeyboardEvent): void {
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

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
