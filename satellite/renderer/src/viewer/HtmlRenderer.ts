// satellite/renderer/src/viewer/HtmlRenderer.ts
// Static-HTML rendering surface for the file viewer. Unlike MarkdownRenderer
// (markdown source -> HTML), the file content IS HTML, so DOMPurify is the
// sole safety bar. We keep DOMPurify's audited default allowlist (structural
// + visual tags, sanitized inline `style`, `<style>` blocks) so real page
// markup renders, and forbid navigational/interactive surfaces that don't
// belong in an inert snapshot. The result is mounted via the shared
// renderedDom surface, so free-text path links + Cmd+click work here too.

import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { createRenderedDom, type RenderedDomOptions } from "./renderedDom";

export interface HtmlRenderer {
  /** Sanitize raw HTML file content into safe, inert HTML. */
  render(rawHtml: string): string;
  /** Replace `container` with `html` and wire Cmd+click link interception. */
  mount(container: HTMLElement, html: string): void;
  dispose(): void;
}

const HTML_PURIFY_CONFIG: DOMPurifyConfig = {
  // Interactive / navigational surfaces have no place in an inert preview.
  // (<iframe>/<object>/<embed> are already default-forbidden; listing them
  // documents intent and is belt-and-braces.)
  FORBID_TAGS: ["form", "iframe", "object", "embed", "base", "meta", "link"],
  FORBID_ATTR: ["srcdoc", "action", "formaction", "target", "ping"],
  ALLOW_DATA_ATTR: true,
  // Without this, DOMPurify's HTML parser treats a leading <style> (or other
  // head-only content) as implicit <head> content, then only serializes the
  // <body> back out — silently dropping it even though `style` is, and
  // remains, part of the default (non-forbidden) tag allowlist. FORCE_BODY
  // parses everything as body content instead; it does not loosen or change
  // which tags/attrs are allowed.
  FORCE_BODY: true,
};

export function createHtmlRenderer(opts: RenderedDomOptions = {}): HtmlRenderer {
  const dom = createRenderedDom(opts);
  return {
    render(rawHtml: string): string {
      const cleaned = DOMPurify.sanitize(rawHtml, HTML_PURIFY_CONFIG);
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
