// Dev/e2e harness for the markdown file viewer (issues #108/#109). Mounts the
// REAL createMarkdownRenderer inside the real `.file-viewer-root` /
// `.file-viewer-body` shell markup, so mermaid diagrams, KaTeX math, images and
// link handling can be exercised — and screenshotted — without a daemon, a
// preload script, or Electron. Mirrors usage-harness.ts.
//
// Not listed in vite.config.ts `rollupOptions.input`: this page exists only on
// the dev server and never reaches the shipped bundle.
//
// Query parameters:
//   ?fixture=rich|plain|bare  which document to render (default: rich)
//   ?theme=dark|light     palette (default: dark)
//
// The `plain` fixture is what proves the lazy-import contract: rendering it
// must not fetch mermaid or katex at all.

import "./styles.css";
import { createMarkdownRenderer } from "./viewer/MarkdownRenderer";
import { attachToc } from "./viewer/attachToc";

const FIXTURES: Record<string, string> = {
  // Exercises every Phase 1–4 surface at once: a diagram, inline + display
  // math, an image, enough headings for a TOC, and both link flavours.
  rich: `# Markdown viewer harness

Prose paragraph before the diagram, with an internal link to
[the renderer](./src/viewer/MarkdownRenderer.ts) and an external one to
[mermaid docs](https://mermaid.js.org/config/usage.html).

## Diagram

\`\`\`mermaid
flowchart TD
  A[Open .md popup] --> B{Has fences?}
  B -->|mermaid| C[Load mermaid chunk]
  B -->|none| D[Skip the 600 KB]
  C --> E[Replace fence with SVG]
\`\`\`

## Math

Inline: the identity $E=mc^2$ sits mid-sentence.

Display:

$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

### Bad equation degrades, it does not throw

Inline nonsense: $\\frac{1}{$ should render red, not break the page.

## Code is left alone

\`\`\`typescript
const notMath = "$E=mc^2$";
\`\`\`

## Image

![sample image](/fixtures/sample-image.svg)

### Nested heading four

Trailing prose so the last heading has something to scroll to.

#### Heading level four

More trailing prose. More trailing prose. More trailing prose.
More trailing prose. More trailing prose. More trailing prose.
`,

  // No diagrams, no math — the negative control for the lazy-import contract.
  plain: `# Plain document

Just prose, a list and a code block. Nothing here should pull in mermaid
or katex.

## A list

- one
- two
- three

\`\`\`typescript
const x = 1;
\`\`\`
`,

  // No headings at all — the TOC must offer no chip rather than a control
  // that opens an empty panel.
  bare: `Just a paragraph, with no headings anywhere in the document.

And a second paragraph so there is something to look at.
`,
};

interface HarnessShell {
  body: HTMLElement;
  content: HTMLElement;
  tocSlot: HTMLElement;
  tocToggleSlot: HTMLElement;
}

function buildShell(): HarnessShell {
  const root = document.createElement("div");
  root.className = "file-viewer-root";

  const header = document.createElement("div");
  header.className = "file-viewer-header";
  const title = document.createElement("div");
  title.className = "file-viewer-title";
  title.textContent = "markdown-harness.md";
  header.appendChild(title);

  const tocToggleSlot = document.createElement("div");
  tocToggleSlot.className = "file-viewer-toc-toggle-slot";
  header.appendChild(tocToggleSlot);

  const body = document.createElement("div");
  body.className = "file-viewer-body";

  const content = document.createElement("div");
  content.className = "file-viewer-content";
  const tocSlot = document.createElement("aside");
  tocSlot.className = "file-viewer-toc";
  tocSlot.hidden = true;
  content.append(tocSlot, body);

  root.appendChild(header);
  root.appendChild(content);
  document.body.appendChild(root);
  return { body, content, tocSlot, tocToggleSlot };
}

/** attachToc persists its open/closed state through window.reckAPI.config,
 *  which only exists behind the Electron preload. Back it with sessionStorage
 *  so the harness exercises the real persistence path (and so a Playwright
 *  reload can assert the state survived) without a preload. */
function installConfigStub(): void {
  (window as unknown as { reckAPI: unknown }).reckAPI = {
    config: {
      get: async <T>(k: string): Promise<T | null> => {
        const raw = sessionStorage.getItem(`harness:${k}`);
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      set: async (k: string, v: unknown): Promise<boolean> => {
        sessionStorage.setItem(`harness:${k}`, JSON.stringify(v));
        return true;
      },
    },
  };
}

async function main(): Promise<void> {
  installConfigStub();
  const params = new URLSearchParams(window.location.search);
  const theme = params.get("theme") === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);

  const fixture = params.get("fixture") ?? "rich";
  const source = FIXTURES[fixture] ?? FIXTURES.rich;

  const shell = buildShell();
  const body = shell.body;
  const renderer = createMarkdownRenderer({
    onLinkActivate: (href) => console.log("[harness] internal activate", href),
    onExternalActivate: (href) => console.log("[harness] external activate", href),
  });

  renderer.mount(body, renderer.render(source));
  await renderer.whenEnhanced();
  await attachToc({
    body,
    content: shell.content,
    tocSlot: shell.tocSlot,
    tocToggleSlot: shell.tocToggleSlot,
  });

  // Signal for Playwright / manual inspection: the post-mount passes have
  // settled, so the document height is final and it is safe to screenshot.
  document.body.dataset.enhanced = "true";
  console.log(`[harness] enhanced fixture=${fixture} theme=${theme}`);
}

void main();
