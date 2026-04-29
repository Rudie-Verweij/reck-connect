// Keyboard shortcuts (CMUX-aligned, Reck/V1-branded).
//
// | Action                          | Shortcut                |
// |---------------------------------|-------------------------|
// | New tab in active pane-box      | ⌘T                      |
// | Close active tab (cascades)     | ⌘W                      |
// | Split right (vertical)          | ⌘D                      |
// | Split down (horizontal)         | ⌘⇧D                     |
// | Next / prev tab in pane-box     | ⌘⇧] / ⌘⇧[               |
// | Focus pane-box directionally    | ⌥⌘← → ↑ ↓               |
// | Toggle rail                     | ⌘B                      |
// | Clear terminal                  | ⌘K                      |
// | Detach focused pane to popout   | ⌘⇧O                     |
// | Jump to project 1–8             | ⌘1 – ⌘8                 |

export interface ShortcutHandlers {
  onNewTab: () => void;
  onSplitVertical: () => void;
  onSplitHorizontal: () => void;
  onCloseActive: () => void;
  onNextTab: () => void;
  onPrevTab: () => void;
  onFocusLeft: () => void;
  onFocusRight: () => void;
  onFocusUp: () => void;
  onFocusDown: () => void;
  onToggleRail: () => void;
  onClearTerminal: () => void;
  onDetachActive: () => void;
  onJumpProject: (index: number) => void;
}

export function installShortcuts(handlers: ShortcutHandlers): () => void {
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key;
    const lower = key.toLowerCase();

    if (e.altKey) {
      if (key === "ArrowLeft") { e.preventDefault(); handlers.onFocusLeft(); return; }
      if (key === "ArrowRight") { e.preventDefault(); handlers.onFocusRight(); return; }
      if (key === "ArrowUp") { e.preventDefault(); handlers.onFocusUp(); return; }
      if (key === "ArrowDown") { e.preventDefault(); handlers.onFocusDown(); return; }
    }

    // ⌘⇧] / ⌘⇧[ next/prev tab
    if (e.shiftKey && (key === "]" || key === "}")) { e.preventDefault(); handlers.onNextTab(); return; }
    if (e.shiftKey && (key === "[" || key === "{")) { e.preventDefault(); handlers.onPrevTab(); return; }

    if (lower === "d") {
      e.preventDefault();
      if (e.shiftKey) handlers.onSplitHorizontal();
      else handlers.onSplitVertical();
      return;
    }
    if (lower === "w") { e.preventDefault(); handlers.onCloseActive(); return; }
    if (lower === "t") { e.preventDefault(); handlers.onNewTab(); return; }
    if (lower === "b") { e.preventDefault(); handlers.onToggleRail(); return; }
    if (lower === "k") { e.preventDefault(); handlers.onClearTerminal(); return; }
    // an earlier release: ⌘⇧O detaches the focused pane to its own window.
    // ⌘⇧D was the natural pick but it's already split-down; the
    // letter "O" reads as "open out / popout" and is unclaimed by any
    // existing CMUX-aligned binding here. Plain ⌘O is reserved for
    // future "open project" bindings, so the shifted variant is the
    // detach gesture.
    if (lower === "o" && e.shiftKey) { e.preventDefault(); handlers.onDetachActive(); return; }

    if (!e.shiftKey && !e.altKey && /^[1-8]$/.test(key)) {
      e.preventDefault();
      handlers.onJumpProject(Number(key));
      return;
    }
  }
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
