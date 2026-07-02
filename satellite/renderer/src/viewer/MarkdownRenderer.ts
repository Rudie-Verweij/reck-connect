// Markdown rendering surface for the file viewer.
//
// Pipeline:
//   markdown source
//     → markdown-it (html: false, GFM-ish features via plugins)
//     → fenced-code blocks highlighted by highlight.js
//     → DOMPurify sanitizes the HTML before innerHTML
//     → DOM-level Cmd+click interception rewrites internal-link clicks
//       into recursive openInViewer calls
//
// `html: false` is the real safety bar against raw `<script>` in markdown
// source; DOMPurify is belt-and-braces in case a future plugin re-enables
// HTML passthrough. Both are deliberate.

import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { detectPathsInLine } from "./LinkDetector";

export interface MarkdownRendererOptions {
  /**
   * Called when the user activates an `<a>` inside a mounted document with
   * the Cmd (meta) modifier held. The handler receives the raw href and the
   * underlying MouseEvent so the caller can decide whether to resolve it
   * relative to the opener, route external schemes elsewhere, etc.
   *
   * If omitted, Cmd+clicks do nothing special — useful in tests that only
   * exercise rendering.
   */
  onLinkActivate?: (href: string, ev: MouseEvent) => void;
  /**
   * Round 8.4 Bug C — Cmd+click handler for external `<a>` whose href is
   * NOT a relative path (http, https, mailto, etc.). The host can route
   * to `shell.openExternal` so external URLs open in the user's default
   * browser. Plain clicks still preventDefault unconditionally; only
   * Cmd+click invokes this callback. Omit to make external Cmd+clicks a
   * no-op (still no in-popup navigation).
   */
  onExternalActivate?: (href: string, ev: MouseEvent) => void;
}

export interface MarkdownRenderer {
  /** Render markdown source to sanitized HTML. */
  render(markdown: string): string;
  /**
   * Replace `container`'s contents with `html` and wire up the Cmd+click
   * interception against the (sole) handler attached to `container`.
   */
  mount(container: HTMLElement, html: string): void;
  /** Detach the click handler and clear internal references. */
  dispose(): void;
}

const INTERNAL_LINK_CLASS = "reck-internal-link";

/**
 * Round 7 Phase FF — native `title` tooltip shown on hover for every
 * Cmd-clickable path link (free-text wraps, markdown native links, and
 * the CodeMirror linkifier decoration). The OS surfaces it after ~1s.
 */
const PATH_LINK_TOOLTIP = "⌘+click to open";

/**
 * Round 6 Phase BB2 + Round 7 Phase HH — text-node walker that wraps
 * free-text path matches (`services/foo.ts`, `/etc/hosts`, `~/notes.md`)
 * in `<a class="reck-internal-link">` so they're underlined and
 * Cmd-clickable. Round 7 added inline-`<code>` support so backticked
 * paths in markdown (the dominant convention) now linkify too while
 * keeping their inline-code styling.
 *
 * Skip rules:
 *   - `<pre>` (fenced code blocks): tokens inside are intentional code,
 *     not file references — leave them alone.
 *   - `<a>` (existing anchors): avoid double-wrapping; markdown native
 *     links already carry `class="reck-internal-link"` via the
 *     `link_open` renderer rule.
 *   - `<code>` (inline backticks): NOT skipped. The text node sitting
 *     inside the `<code>` gets replaced with text + `<a>` + text; the
 *     `<a>` becomes a CHILD of the `<code>` so the gray-box styling
 *     stays intact AND the path becomes clickable.
 *
 * Caveat: paths split across nested inline elements
 * (`services/<em>foo</em>/x.ts`) don't match — `detectPathsInLine` sees
 * each text fragment separately. Acceptable v1; the markdown source can
 * always use a real markdown link.
 */
function wrapFreeTextPaths(root: HTMLElement): void {
  const skipAncestor = (node: Node): boolean => {
    let cur: Node | null = node.parentNode;
    while (cur && cur !== root) {
      if (cur.nodeType === 1) {
        const el = cur as Element;
        const tag = el.tagName;
        // Round 7 Phase HH — `<code>` removed from skip list.
        if (tag === "PRE" || tag === "A") return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };

  // Collect candidate text nodes up front. NodeIterator skips nodes the
  // walk would otherwise visit DURING our DOM rewrite (we replace nodes
  // inline, which invalidates the live walker).
  const candidates: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
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

    // Build a replacement fragment: a sequence of text + anchor + text +
    // anchor… in order, preserving non-matched gaps.
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
      // Round 7 Phase FF — native hover tooltip surfacing the keybind.
      a.setAttribute("title", PATH_LINK_TOOLTIP);
      a.textContent = m.text;
      frag.appendChild(a);
      cursor = m.end;
    }
    if (cursor < text.length) {
      frag.appendChild(
        root.ownerDocument.createTextNode(text.slice(cursor)),
      );
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

/**
 * Heuristic for "this anchor should be intercepted as an internal file
 * reference rather than an external link". We mark these at render time
 * with a stable class so the click handler can identify them cheaply
 * without re-parsing the href every time.
 */
function isInternalLinkHref(href: string): boolean {
  if (!href) return false;
  // Anchors / fragments don't open files.
  if (href.startsWith("#")) return false;
  // External schemes (http, https, mailto, etc.) are not internal.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  // Anything else — relative paths, absolute paths, ~/ paths — is treated
  // as a file reference.
  return true;
}

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const result = hljs.highlight(code, {
            language: lang,
            ignoreIllegals: true,
          });
          return (
            `<pre class="hljs"><code class="hljs language-${lang}">` +
            result.value +
            "</code></pre>"
          );
        } catch {
          // fall through to plain rendering
        }
      }
      // Plain fenced block: defer to markdown-it's default escape so the
      // content is not HTML-interpreted.
      return "";
    },
  });

  md.use(markdownItAnchor, {
    slugify: (s) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-"),
  });
  md.use(taskLists, { enabled: false, label: true, labelAfter: true });

  // Override the default link renderer to add `class="reck-internal-link"`
  // for hrefs we treat as file references. We don't strip dangerous schemes
  // here — `validateLink` below handles that — we only annotate.
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefAttr = token.attrGet("href") ?? "";
    if (isInternalLinkHref(hrefAttr)) {
      const existingClass = token.attrGet("class");
      token.attrSet(
        "class",
        existingClass ? `${existingClass} ${INTERNAL_LINK_CLASS}` : INTERNAL_LINK_CLASS,
      );
      // Round 7 Phase FF — native hover tooltip surfacing the keybind.
      if (!token.attrGet("title")) {
        token.attrSet("title", PATH_LINK_TOOLTIP);
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  // Tighten markdown-it's link validator: it permits `javascript:` only under
  // explicit opt-in, but the default also allows `vbscript:` and `data:`
  // image/SVG. We restrict to schemes we will actually click through.
  md.validateLink = (url) => {
    if (!url) return false;
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith("javascript:")) return false;
    if (trimmed.startsWith("vbscript:")) return false;
    if (trimmed.startsWith("data:") && !trimmed.startsWith("data:image/")) {
      return false;
    }
    return true;
  };

  return md;
}

const PURIFY_CONFIG: DOMPurifyConfig = {
  // Allow the classes our renderer adds (especially reck-internal-link) and
  // the highlight.js classnames. Defaults preserve `class` for benign tags.
  ALLOWED_ATTR: ["href", "title", "alt", "src", "class", "id", "type", "checked", "disabled"],
  ALLOWED_TAGS: [
    "a",
    "p",
    "br",
    "hr",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "span",
    "input",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "del",
  ],
  // Disallow form/iframe-style tags by omitting them from ALLOWED_TAGS.
  KEEP_CONTENT: true,
};

export function createMarkdownRenderer(
  opts: MarkdownRendererOptions = {},
): MarkdownRenderer {
  const md = createMarkdownIt();
  let attachedContainer: HTMLElement | null = null;
  let attachedHandler: ((ev: MouseEvent) => void) | null = null;

  const detach = (): void => {
    if (attachedContainer && attachedHandler) {
      attachedContainer.removeEventListener("click", attachedHandler);
    }
    attachedContainer = null;
    attachedHandler = null;
  };

  return {
    render(markdown: string): string {
      const rawHtml = md.render(markdown);
      const cleaned = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG);
      // DOMPurify.sanitize() returns either string or TrustedHTML depending
      // on the runtime; we always want the string form.
      return typeof cleaned === "string" ? cleaned : String(cleaned);
    },
    mount(container: HTMLElement, html: string): void {
      detach();
      container.innerHTML = html;
      // Round 6 Phase BB2 — wrap free-text path matches in
      // `<a class="reck-internal-link">` so they're underlined and
      // recursively clickable. Runs regardless of whether the host
      // wired callbacks — the wrapping itself is purely visual.
      wrapFreeTextPaths(container);
      // Round 8.4 Bug C — popup HTML view requires Cmd+click to
      // activate any link. Plain click on any anchor (internal,
      // external URL, or `#fragment`) calls preventDefault and
      // returns. Only Cmd+click branches by href type:
      //   - empty / `#fragment` → no-op (in-page navigation blocked)
      //   - internal (relative / absolute path / `~/` path) →
      //     onLinkActivate
      //   - external (http/https/mailto/etc.) → onExternalActivate
      // The handler attaches unconditionally so plain clicks are
      // always preventDefault'd, even when no host callback is
      // wired — otherwise the browser would navigate the popup.
      const handler = (ev: MouseEvent): void => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest("a");
        if (!anchor) return;
        const hrefForLog = anchor.getAttribute("href");
        console.log("[click:markdown] handler fired", {
          href: hrefForLog,
          metaKey: ev.metaKey,
        });
        // Block ALL native anchor navigation regardless of modifier.
        ev.preventDefault();
        if (!ev.metaKey) {
          console.debug("[click:markdown] no-op (no metaKey)", {
            href: hrefForLog,
          });
          return;
        }
        const href = anchor.getAttribute("href");
        if (!href) {
          console.debug("[click:markdown] no-op (empty href)");
          return;
        }
        if (href.startsWith("#")) {
          console.debug("[click:markdown] no-op (fragment)", { href });
          return;
        }
        if (isInternalLinkHref(href)) {
          console.log("[click:markdown] internal -> onLinkActivate", { href });
          opts.onLinkActivate?.(href, ev);
        } else {
          console.log("[click:markdown] external -> onExternalActivate", {
            href,
          });
          opts.onExternalActivate?.(href, ev);
        }
      };
      container.addEventListener("click", handler);
      attachedContainer = container;
      attachedHandler = handler;
    },
    dispose(): void {
      detach();
    },
  };
}
