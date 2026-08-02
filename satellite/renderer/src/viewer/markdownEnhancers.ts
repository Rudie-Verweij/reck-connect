// Post-mount enhancement passes for the rendered-markdown surface.
//
// These run AFTER `MarkdownRenderer.mount()` has put sanitized HTML in the
// container, because both libraries work on live DOM rather than on an HTML
// string: mermaid scans for `code.language-mermaid` and swaps in inline SVG,
// KaTeX scans text nodes for `$…$` delimiters and swaps in typeset spans.
//
// SECURITY — both write to the live DOM *past* DOMPurify.
// `render()` sanitizes the markdown-it output string, which at that point
// still contains `<pre><code class="language-mermaid">…`. The SVG mermaid
// substitutes later is never sanitized. That is safe only because mermaid
// runs with `securityLevel: "strict"`, which rejects scripts, links and HTML
// labels outright. Do NOT lower it. Same story for KaTeX, bounded by
// `output: "html"` + `throwOnError: false`.
//
// If a future flow ever serializes the mounted container and re-sanitizes it,
// it must pass `USE_PROFILES: { svg: true, svgFilters: true }` or every
// diagram will be stripped back out.
//
// Both passes lazy-import their library: mermaid is ~600 KB and KaTeX ~280 KB
// JS + ~70 KB CSS + fonts, and most files opened in the viewer contain
// neither diagrams nor math. Vite code-splits each into its own chunk. The
// lazy import also keeps both libraries out of the jsdom unit-test run.

/** Mermaid's own theme names for our two app themes. */
export type MermaidTheme = "dark" | "default";

/** The slice of mermaid's API we use — keeps the dynamic import typed
 *  without dragging mermaid's types into every consumer. */
export interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  run(options: {
    nodes: ArrayLike<HTMLElement>;
    suppressErrors?: boolean;
  }): Promise<unknown>;
}

/** KaTeX's auto-render entry point. */
export type RenderMathInElement = (
  element: HTMLElement,
  options: Record<string, unknown>,
) => void;

export interface EnhanceMermaidOptions {
  /** App theme; maps to mermaid's `theme`. Defaults to "default" (light). */
  theme?: MermaidTheme;
  /**
   * Re-checked AFTER the lazy import resolves. Returning false abandons the
   * pass without touching the DOM — the popup may have re-rendered or been
   * disposed while the ~600 KB chunk was in flight.
   */
  stillCurrent?: () => boolean;
  /** Injectable for tests; defaults to `import("mermaid")`. */
  loadMermaid?: () => Promise<MermaidLike>;
}

export interface EnhanceMathOptions {
  /** Same staleness contract as EnhanceMermaidOptions.stillCurrent. */
  stillCurrent?: () => boolean;
  /** Injectable for tests; defaults to `import("katex/contrib/auto-render")`. */
  loadKatex?: () => Promise<RenderMathInElement>;
}

/** Fenced ```mermaid blocks, as markdown-it renders them. highlight.js has no
 *  "mermaid" language, so the fence falls through to markdown-it's default
 *  renderer and keeps the `language-` prefix; DOMPurify's ALLOWED_ATTR keeps
 *  `class`. */
export const MERMAID_SELECTOR = "pre code.language-mermaid";

/**
 * Class on the element mermaid renders into.
 *
 * We do NOT hand mermaid the `<code>` node directly. `mermaid.run()` replaces
 * the node's *contents*, so pointing it at the fence leaves the finished SVG
 * sitting inside `<pre><code>` — inheriting the monospace font, the code-block
 * background and `white-space: pre`, which is not what a diagram should look
 * like. Instead each fence is unwrapped into a plain container first, and
 * mermaid renders into that.
 *
 * The container keeps the diagram source as its text, so a definition mermaid
 * can't parse degrades to readable text rather than an empty gap.
 */
export const MERMAID_HOST_CLASS = "reck-mermaid";

/** Delimiter pairs KaTeX's auto-render scans for. `$$` must precede `$` so a
 *  display block isn't consumed as two empty inline spans. */
const KATEX_DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
  { left: "\\[", right: "\\]", display: true },
] as const;

/** Any of the above opening delimiters, as a cheap substring pre-check. */
const MATH_HINT = /\$|\\\(|\\\[/;

export function hasMermaidBlocks(container: HTMLElement): boolean {
  return container.querySelector(MERMAID_SELECTOR) !== null;
}

export function hasMathDelimiters(container: HTMLElement): boolean {
  return MATH_HINT.test(container.textContent ?? "");
}

export async function enhanceMermaid(
  container: HTMLElement,
  opts: EnhanceMermaidOptions = {},
): Promise<void> {
  const fences = Array.from(
    container.querySelectorAll<HTMLElement>(MERMAID_SELECTOR),
  );
  if (fences.length === 0) return;

  try {
    const load =
      opts.loadMermaid ??
      (async () => (await import("mermaid")).default as unknown as MermaidLike);
    const mermaid = await load();
    // The container may have been re-rendered or disposed while the ~600 KB
    // chunk was downloading.
    if (opts.stillCurrent && !opts.stillCurrent()) return;

    mermaid.initialize({
      startOnLoad: false,
      // Load-bearing: mermaid's SVG bypasses DOMPurify entirely. See the file
      // header. Lowering this to "loose" enables click handlers inside
      // diagrams, i.e. script execution from user-authored markdown.
      securityLevel: "strict",
      theme: opts.theme ?? "default",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    });
    // Unwrap `<pre><code>` → a plain diagram container. See MERMAID_HOST_CLASS.
    const nodes = fences.map((code) => {
      const host = container.ownerDocument.createElement("div");
      host.className = MERMAID_HOST_CLASS;
      host.textContent = code.textContent ?? "";
      (code.closest("pre") ?? code).replaceWith(host);
      return host;
    });

    // Scoped to this container's nodes rather than a bare run(): the file
    // viewer is a popup and mermaid must not walk the rest of the document.
    await mermaid.run({ nodes, suppressErrors: true });
  } catch (err) {
    // A diagram that won't parse degrades to its source block. Never let it
    // take the surrounding document down with it.
    console.warn("[markdown] mermaid enhancement failed", err);
  }
}

export async function enhanceMath(
  container: HTMLElement,
  opts: EnhanceMathOptions = {},
): Promise<void> {
  if (!hasMathDelimiters(container)) return;

  try {
    const load =
      opts.loadKatex ??
      (async () => {
        // The stylesheet is what makes KaTeX's glyph positioning work at all —
        // without it equations render with broken layout. Imported alongside
        // the renderer so Vite puts both in the same lazy chunk.
        await import("katex/dist/katex.min.css");
        return (await import("katex/contrib/auto-render"))
          .default as unknown as RenderMathInElement;
      });
    const renderMathInElement = await load();
    if (opts.stillCurrent && !opts.stillCurrent()) return;

    renderMathInElement(container, {
      delimiters: KATEX_DELIMITERS.map((d) => ({ ...d })),
      // HTML-only output. The default ("htmlAndMathml") emits a parallel
      // MathML subtree holding the LaTeX source, which both the in-popup
      // search index and the TTS walker would pick up as a duplicate of every
      // equation.
      output: "html",
      // One malformed equation renders red inline instead of throwing and
      // aborting the whole pass.
      throwOnError: false,
      errorColor: "#cc0000",
    });
  } catch (err) {
    console.warn("[markdown] katex enhancement failed", err);
  }
}
