// satellite/renderer/src/viewer/renderedDom.ts
// Shared "mount already-sanitized HTML into a container" surface, used by
// the markdown and HTML renderers. Sets innerHTML, wraps bare file paths
// in Cmd-clickable links, and intercepts anchor clicks (plain clicks are
// always blocked; only Cmd+click activates, branching internal/external).
//
// The caller MUST pass HTML that is already sanitized — this module only
// ever assigns to innerHTML and creates text-only <a> elements, so it adds
// no new injection surface, but it is not itself a sanitizer.

import { detectPathsInLine } from "./LinkDetector";
import { attachLightbox, type LightboxHandle } from "./Lightbox";

const INTERNAL_LINK_CLASS = "reck-internal-link";
const PATH_LINK_TOOLTIP = "⌘+click to open";

export interface RenderedDomOptions {
  onLinkActivate?: (href: string, ev: MouseEvent) => void;
  onExternalActivate?: (href: string, ev: MouseEvent) => void;
}

export interface RenderedDomHandle {
  mount(container: HTMLElement, html: string): void;
  dispose(): void;
}

/** Anchors we treat as internal file references (relative/absolute/~ paths)
 *  rather than external URLs or in-page fragments. */
export function isInternalLinkHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  return true;
}

/**
 * True when `node` sits inside an `<svg>` subtree at or below `root`.
 *
 * Mermaid replaces each fence with inline SVG whose `<text>` elements hold the
 * diagram's node labels. Those are graphics, not prose: the surfaces that walk
 * this container's text nodes — in-popup search (`MarkdownSearchAdapter`) and
 * TTS (`MarkdownSurfaceAdapter`) — must skip them, or a search matches text the
 * highlight API can't paint and Speak reads a flowchart out loud.
 *
 * Checked by tag name rather than `instanceof SVGElement` so it holds for
 * documents from another realm (and in jsdom).
 */
export function isInsideSvg(node: Node, root: HTMLElement): boolean {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && (cur as Element).tagName.toLowerCase() === "svg") {
      return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

export function wrapFreeTextPaths(root: HTMLElement): void {
  const skipAncestor = (node: Node): boolean => {
    let cur: Node | null = node.parentNode;
    while (cur && cur !== root) {
      if (cur.nodeType === 1) {
        const tag = (cur as Element).tagName;
        if (tag === "PRE" || tag === "A") return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };

  const candidates: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (!skipAncestor(node)) candidates.push(node as Text);
    node = walker.nextNode();
  }

  for (const textNode of candidates) {
    const text = textNode.nodeValue ?? "";
    if (text.length === 0) continue;
    const matches = detectPathsInLine(text);
    if (matches.length === 0) continue;
    const frag = root.ownerDocument.createDocumentFragment();
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) {
        frag.appendChild(
          root.ownerDocument.createTextNode(text.slice(cursor, m.start)),
        );
      }
      const a = root.ownerDocument.createElement("a");
      a.className = INTERNAL_LINK_CLASS;
      a.setAttribute("href", m.text);
      a.setAttribute("title", PATH_LINK_TOOLTIP);
      a.textContent = m.text;
      frag.appendChild(a);
      cursor = m.end;
    }
    if (cursor < text.length) {
      frag.appendChild(root.ownerDocument.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

export function createRenderedDom(
  opts: RenderedDomOptions = {},
): RenderedDomHandle {
  let attachedContainer: HTMLElement | null = null;
  let attachedHandler: ((ev: MouseEvent) => void) | null = null;
  let lightbox: LightboxHandle | null = null;

  const detach = (): void => {
    if (attachedContainer && attachedHandler) {
      attachedContainer.removeEventListener("click", attachedHandler);
    }
    lightbox?.dispose();
    lightbox = null;
    attachedContainer = null;
    attachedHandler = null;
  };

  return {
    mount(container: HTMLElement, html: string): void {
      detach();
      container.innerHTML = html;
      wrapFreeTextPaths(container);
      const handler = (ev: MouseEvent): void => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest("a");
        if (!anchor) return;
        // Block ALL native anchor navigation regardless of modifier.
        ev.preventDefault();
        if (!ev.metaKey) return;
        const href = anchor.getAttribute("href");
        if (!href || href.startsWith("#")) return;
        if (isInternalLinkHref(href)) {
          opts.onLinkActivate?.(href, ev);
        } else {
          opts.onExternalActivate?.(href, ev);
        }
      };
      container.addEventListener("click", handler);
      attachedContainer = container;
      attachedHandler = handler;
      // Registered here so the same detach() tears it down. The two handlers
      // cannot conflict: this one acts only on anchors, the lightbox only on
      // images that are NOT inside an anchor.
      lightbox = attachLightbox(container);
    },
    dispose(): void {
      detach();
    },
  };
}
