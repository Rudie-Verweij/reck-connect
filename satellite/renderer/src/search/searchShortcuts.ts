// Global Cmd/Ctrl+F binding that opens the in-view search bar. Mirrors the
// self-contained `installTtsShortcuts` pattern: one window keydown
// listener, returns an unbind thunk.
//
// Shift+Cmd+F and Alt+Cmd+F are intentionally left alone so they remain
// free for a future project-wide search. Escape is handled inside the bar
// (only while its input is focused), not here.

export interface SearchShortcutHandlers {
  onFind(): void;
}

export function installSearchShortcuts(
  handlers: SearchShortcutHandlers,
): () => void {
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      handlers.onFind();
    }
  }
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
