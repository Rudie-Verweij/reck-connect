// Full-size image viewer for the markdown popup.
//
// Rendered images are clamped by `.file-viewer-body img { max-width: 100% }`,
// so anything wider than the popup is only ever seen shrunk. Clicking one
// opens it over the document at its natural size.
//
// Registered from renderedDom.ts's mount() so the same detach() tears it down,
// and deliberately ignores Cmd/Ctrl+click: that chord already means "open this
// link" in the viewer, and a linked image must keep that behaviour.

export interface LightboxHandle {
  /** Remove listeners and close any open overlay. Idempotent. */
  dispose(): void;
}

export const LIGHTBOX_CLASS = "reck-lightbox";

/**
 * Make every `<img>` inside `container` open full-size on a plain click.
 *
 * The overlay is appended to `container` (the scroll body) rather than to
 * `document.body`, so it is torn down along with the rest of the rendered
 * document on the next mount.
 */
export function attachLightbox(container: HTMLElement): LightboxHandle {
  const doc = container.ownerDocument;
  let overlay: HTMLElement | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
  }

  function open(source: HTMLImageElement): void {
    // Re-entrancy guard: a second click while one is open replaces rather than
    // stacks, so close() can never leave an orphan behind.
    close();

    overlay = doc.createElement("div");
    overlay.className = LIGHTBOX_CLASS;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", source.alt || "Image");

    const full = doc.createElement("img");
    full.setAttribute("src", source.getAttribute("src") ?? "");
    full.setAttribute("alt", source.getAttribute("alt") ?? "");
    overlay.appendChild(full);

    container.appendChild(overlay);
  }

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;

    // Backdrop closes; the enlarged image itself does not.
    if (overlay && overlay.contains(target)) {
      if (target === overlay) close();
      return;
    }

    if (!(target instanceof HTMLImageElement)) return;
    // ⌘/Ctrl+click already means "open this" in the viewer — leave it to
    // renderedDom's anchor handler.
    if (ev.metaKey || ev.ctrlKey) return;
    // An image wrapped in a link is a navigation affordance, not a picture to
    // inspect; the anchor handler owns that click.
    if (target.closest("a")) return;

    open(target);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
  };

  container.addEventListener("click", onClick);
  // Document-level so Escape works without the overlay holding focus. Removed
  // in dispose(): popups re-render on every external file change, and a stale
  // handler per render is a real leak.
  doc.addEventListener("keydown", onKeyDown);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      container.removeEventListener("click", onClick);
      doc.removeEventListener("keydown", onKeyDown);
      close();
    },
  };
}
