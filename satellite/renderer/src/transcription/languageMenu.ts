// Right-click menu for the mic button: "Language ▸" opening a scrollable
// submenu (Detect / English / Dutch / rest alphabetical) with a check on the
// current choice. Picking one persists the setting and hot-swaps the
// provider. Visually mirrors the rail context menu.

import { DICTATION_LANGUAGES } from "./languages";

export interface LanguageMenuProps {
  currentCode: string;
  onPick: (code: string) => void;
  /** When set, adds a "Hide dictation button" item below Language. */
  onHide?: () => void;
  /** When set, adds an "Advanced…" item. Receives the click position so the
   *  panel can anchor its bottom-center there. */
  onAdvanced?: (x: number, y: number) => void;
  /**
   * The mic button's rect. When given, the menu opens ABOVE the icon (aligned
   * to its left edge) rather than at the cursor — so it never covers the mic
   * or the live pill. Falls back to below the icon if there's no room above.
   */
  anchorRect?: { left: number; top: number; bottom: number };
}

export function showDictationContextMenu(x: number, y: number, props: LanguageMenuProps): void {
  // One menu at a time.
  document.querySelector(".dictation-context-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "dictation-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const langItem = document.createElement("button");
  langItem.type = "button";
  langItem.className = "dictation-menu-item";
  langItem.innerHTML = `<span>Language</span><span class="dictation-menu-arrow">▸</span>`;

  const submenu = document.createElement("div");
  submenu.className = "dictation-language-submenu";
  for (const lang of DICTATION_LANGUAGES) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dictation-menu-item";
    const isCurrent = lang.code === props.currentCode;
    item.innerHTML = `<span>${lang.label}</span>${isCurrent ? `<span class="dictation-menu-check">✓</span>` : ""}`;
    item.addEventListener("click", () => {
      cleanup();
      props.onPick(lang.code);
    });
    submenu.appendChild(item);
    if (isCurrent) queueMicrotask(() => item.scrollIntoView({ block: "center" }));
  }

  // Submenu opens on hover or click of the Language row and stays open while
  // the pointer is over either element.
  let submenuOpen = false;
  const openSubmenu = (): void => {
    if (submenuOpen) return;
    submenuOpen = true;
    menu.appendChild(submenu);
    // Right of the menu by default; flip left if it would leave the window.
    const menuRect = menu.getBoundingClientRect();
    const overflowsRight = menuRect.right + 200 > window.innerWidth;
    submenu.style.left = overflowsRight ? "auto" : "100%";
    submenu.style.right = overflowsRight ? "100%" : "auto";
    // The unfold animation should grow AWAY from the parent menu.
    submenu.style.transformOrigin = overflowsRight ? "top right" : "top left";
    // Keep the submenu's bottom on screen.
    const subRect = submenu.getBoundingClientRect();
    if (subRect.bottom > window.innerHeight - 8) {
      submenu.style.top = `${Math.max(8 - menuRect.top, window.innerHeight - 8 - subRect.height - menuRect.top)}px`;
    }
  };
  langItem.addEventListener("mouseenter", openSubmenu);
  langItem.addEventListener("click", openSubmenu);

  menu.appendChild(langItem);

  if (props.onHide) {
    const hideItem = document.createElement("button");
    hideItem.type = "button";
    hideItem.className = "dictation-menu-item";
    hideItem.innerHTML = `<span>Hide dictation button</span>`;
    hideItem.addEventListener("click", () => {
      cleanup();
      props.onHide?.();
    });
    // Hovering a sibling item retracts the language submenu.
    hideItem.addEventListener("mouseenter", () => {
      if (submenuOpen) {
        submenuOpen = false;
        submenu.remove();
      }
    });
    menu.appendChild(hideItem);
  }

  if (props.onAdvanced) {
    const advItem = document.createElement("button");
    advItem.type = "button";
    advItem.className = "dictation-menu-item";
    advItem.innerHTML = `<span>Advanced…</span>`;
    advItem.addEventListener("click", (ev) => {
      cleanup();
      props.onAdvanced?.(ev.clientX, ev.clientY);
    });
    advItem.addEventListener("mouseenter", () => {
      if (submenuOpen) {
        submenuOpen = false;
        submenu.remove();
      }
    });
    menu.appendChild(advItem);
  }

  document.body.appendChild(menu);

  // Position. With an anchor (the mic), open ABOVE the icon aligned to its
  // left edge, so the menu never covers the mic or the live pill; fall back
  // to below if there's no room above. Otherwise position at (x,y). Clamp on
  // screen either way.
  // offsetWidth/offsetHeight = untransformed layout size; getBoundingClientRect
  // reads short during the scale-in animation and would mis-place the menu.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const margin = 8;
  if (props.anchorRect) {
    const a = props.anchorRect;
    const left = Math.min(
      Math.max(margin, a.left),
      Math.max(margin, window.innerWidth - margin - w),
    );
    const above = a.top - margin - h;
    const top =
      above >= margin ? above : Math.min(a.bottom + margin, window.innerHeight - margin - h);
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  } else {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - margin) {
      menu.style.left = `${window.innerWidth - margin - w}px`;
    }
    if (rect.bottom > window.innerHeight - margin) {
      menu.style.top = `${window.innerHeight - margin - h}px`;
    }
  }

  const cleanup = (): void => {
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (e: PointerEvent): void => {
    if (!menu.contains(e.target as Node)) cleanup();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") cleanup();
  };
  // Defer so the opening right-click doesn't immediately dismiss it.
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}
