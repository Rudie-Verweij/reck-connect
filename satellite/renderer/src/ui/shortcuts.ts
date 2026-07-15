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
// | Toggle rail (expanded ⟷ mini)   | ⌘B                      |
// | Collapse rail to mini           | ⌘⇧← (also bare ⇧←)      |
// | Expand rail                     | ⌘⇧→ (also bare ⇧→)      |
// | Clear terminal                  | ⌘K                      |
// | Detach focused pane to popout   | ⌘⇧O                     |
// | Jump to project 1–8             | ⌘1 – ⌘8                 |
//
// Bare ⇧←/⇧→ only fire when focus is outside a text-entry surface —
// xterm owns a hidden textarea, and stealing shift+arrow from the PTY
// would break selection keys mid-session.

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
  onCollapseRail: () => void;
  onExpandRail: () => void;
  onClearTerminal: () => void;
  onDetachActive: () => void;
  onJumpProject: (index: number) => void;
}

/**
 * True when `el` is a surface that owns its own keyboard input — a form
 * field or anything contentEditable. Covers xterm (its focus proxy is a
 * hidden <textarea>) and the rename/settings inputs, so the bare-shift
 * rail shortcuts never steal selection keys from typing surfaces.
 */
function isTextEntryTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function installShortcuts(handlers: ShortcutHandlers): () => void {
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;

    // Bare ⇧←/⇧→ rail collapse/expand — checked before the mod gate.
    // When a text-entry surface has focus we fall through untouched (no
    // preventDefault) so the PTY / input keeps its selection keys.
    if (!mod && !e.altKey && e.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      if (!isTextEntryTarget(document.activeElement)) {
        e.preventDefault();
        if (key === "ArrowLeft") handlers.onCollapseRail();
        else handlers.onExpandRail();
      }
      return;
    }

    if (!mod) return;
    const lower = key.toLowerCase();

    if (e.altKey) {
      if (key === "ArrowLeft") { e.preventDefault(); handlers.onFocusLeft(); return; }
      if (key === "ArrowRight") { e.preventDefault(); handlers.onFocusRight(); return; }
      if (key === "ArrowUp") { e.preventDefault(); handlers.onFocusUp(); return; }
      if (key === "ArrowDown") { e.preventDefault(); handlers.onFocusDown(); return; }
    }

    // ⌘⇧← / ⌘⇧→ collapse/expand the rail — global, unlike the bare-shift
    // variant above (works even while a terminal has focus).
    if (e.shiftKey && !e.altKey && key === "ArrowLeft") { e.preventDefault(); handlers.onCollapseRail(); return; }
    if (e.shiftKey && !e.altKey && key === "ArrowRight") { e.preventDefault(); handlers.onExpandRail(); return; }

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
