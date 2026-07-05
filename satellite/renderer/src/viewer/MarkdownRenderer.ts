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
import { createRenderedDom, isInternalLinkHref } from "./renderedDom";

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
  const dom = createRenderedDom({
    onLinkActivate: opts.onLinkActivate,
    onExternalActivate: opts.onExternalActivate,
  });
  return {
    render(markdown: string): string {
      const rawHtml = md.render(markdown);
      const cleaned = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG);
      // DOMPurify.sanitize() returns either string or TrustedHTML depending
      // on the runtime; we always want the string form.
      return typeof cleaned === "string" ? cleaned : String(cleaned);
    },
    mount(container: HTMLElement, html: string): void {
      dom.mount(container, html);
    },
    dispose(): void {
      dom.dispose();
    },
  };
}
