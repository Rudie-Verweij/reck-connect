# Markdown viewer integration — mermaid, math, TOC, lightbox

How the file viewer's rendered-markdown surface got MarkView-grade features, what
it deliberately doesn't do, and the constraints anyone extending it has to respect.

Ported from the integration plan in the `reck-stationd-linux` fork
(`docs/markdown-viewer-integration.md` there). That document was written against
a different tree; **three of its claims did not hold here**, and the differences
are recorded below rather than quietly dropped — they're the parts most likely to
be re-introduced by someone following the original.

Implemented across issues #109–#112 under epic #108.

---

## 1. Pipeline

```
markdown source
  → markdown-it (html: false, GFM-ish via plugins)
  → highlight.js on fenced code
  → DOMPurify sanitizes the HTML string          ← render() ends here
  → innerHTML into .file-viewer-body             ← mount() starts here
  → wrapFreeTextPaths (bare paths → ⌘-clickable) │
  → mermaid: fences → inline SVG                 │ post-mount, on live DOM
  → KaTeX: $…$ → typeset spans                   │
  → click handlers: link activation, lightbox    │
  → TOC built from heading ids                   ← after whenEnhanced()
```

| Stage | Library | File |
|---|---|---|
| Markdown → HTML | `markdown-it` (`html: false`) | `viewer/MarkdownRenderer.ts` |
| Heading slugs | `markdown-it-anchor` | same |
| Task lists | `markdown-it-task-lists` | same |
| Syntax highlighting | `highlight.js/lib/common` | same |
| Sanitization | `DOMPurify`, explicit allowlists | same |
| Lazy images | native `loading`/`decoding` | same |
| Diagrams | `mermaid` (lazy) | `viewer/markdownEnhancers.ts` |
| Math | `katex` (lazy) | same |
| Link interception, lightbox | — | `viewer/renderedDom.ts`, `viewer/Lightbox.ts` |
| Table of contents | — | `viewer/Toc.ts`, `viewer/attachToc.ts` |

---

## 2. The security boundary, and why it is where it is

**`html: false` is the primary XSS bar.** Raw HTML in markdown source is escaped
before DOMPurify ever sees it. DOMPurify is belt-and-braces behind that, in case a
future plugin re-enables HTML passthrough. Both are deliberate; see the header
comment in `MarkdownRenderer.ts`.

**Mermaid and KaTeX write past DOMPurify.** `render()` sanitizes the markdown-it
output *string*, which at that point still contains
`<pre><code class="language-mermaid">…`. Mermaid runs later, on the live DOM, and
the SVG it produces **is never sanitized**.

That is safe only because of two settings, which are therefore load-bearing rather
than stylistic — both have tests asserting them:

- `securityLevel: "strict"` — mermaid's own guard, rejecting scripts, links and
  HTML labels. **Do not lower it.** `"loose"` enables click handlers inside
  diagrams, i.e. script execution from user-authored markdown.
- `throwOnError: false` — one malformed equation renders red inline instead of
  aborting the pass.

**If you ever serialize the mounted container and re-sanitize it**, you must pass
`USE_PROFILES: { svg: true, svgFilters: true }` or every diagram is stripped.

### Widening `ALLOWED_TAGS`

Only widen it for markup that arrives **through the markdown-it → `render()`
pipeline**. Mermaid and KaTeX output does not, so it needs no entries. Tests pin
that `script`, `iframe`, `object`, `form` and inline event handlers stay out.

> Note when writing those tests: `html: false` **escapes** rather than deletes, so
> a dangerous substring survives as prose. `expect(html).not.toContain("onerror")`
> fails against perfectly safe output. Parse before asserting.

---

## 3. Corrections to the source plan

### 3.1 §8 "auto-refresh" was already shipped here

The plan proposes a `daemon/internal/fileviewer/watcher.go` with `fsnotify` plus a
websocket push. **This repo already had it** — `FileViewerHost.ts` wires
`files.onWatchEvent` → `watchSubscribe` → `handleExternalChange`, with sha-based
echo suppression so a self-write doesn't read as an external change.

Still missing: the station-remote branch (`renderStationRemote`) doesn't subscribe.
That's a real gap, just not this work.

### 3.2 §5's `<details>`/`<summary>`/`<kbd>` additions are inert

The plan says to add them to `ALLOWED_TAGS` so GFM collapsible sections render.
They can't, because `html: false` escapes raw HTML first:

```js
md.render("<details><summary>s</summary>body</details>")
// → "<p>&lt;details&gt;&lt;summary&gt;s&lt;/summary&gt;body&lt;/details&gt;</p>"
```

The tags are listed as defense-in-depth for a future plugin that emits them
through the pipeline. **Do not flip `html: true` to make them work** — that
removes the primary XSS bar. A test pins the escaping so that change can't land
silently. If collapsible sections are wanted, use a narrow markdown-it container
plugin.

### 3.3 §3.2's mermaid recipe renders the diagram inside a code block

The plan passes `pre code.language-mermaid` straight to `mermaid.run({ nodes })`.
But `run()` replaces a node's **contents** — so the finished SVG ends up inside
`<pre><code>`, inheriting monospace and the code-block background.

Each fence is instead unwrapped into a `div.reck-mermaid` first, which also keeps
the source text so an unparseable definition degrades to readable text rather than
an empty gap.

### 3.4 The plan says nothing about search or TTS, and it needed to

Both `search/MarkdownSearchAdapter.ts` and `tts/MarkdownSurfaceAdapter.ts`
TreeWalk `.file-viewer-body`'s text nodes. Neither skipped SVG, so mermaid labels
would have been indexed by search — where the CSS Custom Highlight API can't paint
a Range, making a "match" a hit the user can never see — and read aloud by Speak.

One shared `isInsideSvg` predicate (in `renderedDom.ts`) now skips them in both.
**It matches by ancestry, not tag name**: mermaid v11 flowcharts put labels in
`<foreignObject>` HTML, not SVG `<text>`, so a `<text>`-only check would miss every
real diagram.

KaTeX runs with `output: "html"` for the same reason — the default
`htmlAndMathml` emits a parallel MathML subtree holding the LaTeX source, which
both walkers would pick up as a duplicate of every equation.

---

## 4. Lazy loading

Mermaid is ~600 KB and KaTeX ~280 KB JS + ~70 KB CSS + fonts. Most files opened in
the viewer contain neither diagrams nor math, so both passes check the DOM
*before* importing:

```ts
if (!container.querySelector("pre code.language-mermaid")) return;   // mermaid
if (!/\$|\\\(|\\\[/.test(container.textContent ?? "")) return;        // katex
```

The production build code-splits these into `mermaid.core-*.js` and a KaTeX chunk.
`e2e/markdown-viewer.spec.ts` asserts the contract from both sides: the rich
fixture requests both libraries, the plain fixture requests neither.

Lazy-importing also keeps both libraries out of the jsdom unit-test run.

---

## 5. Lifecycle

`mount()` stays synchronous — callers that only need prose on screen are
unaffected. `whenEnhanced()` returns the settled promise of the post-mount passes.

**Anything depending on final layout must await it.** The TOC does: mermaid and
KaTeX change document height, which moves every scroll-spy threshold.

A generation counter guards both passes. Each re-checks
`generation === mine && container.isConnected` after its import resolves, so a
popup that re-rendered or closed while a several-hundred-KB chunk was in flight is
never written into. `mount()` and `dispose()` both bump it.

---

## 6. Shared collapse behaviour

The TOC sidebar does **not** have its own collapse implementation. `ui/collapse-model.ts`
holds the drag arithmetic — sticky zone, elastic rubber-band stretch,
expand-commit — with thresholds as parameters; `ui/rail-collapse.ts` (the project
rail) and `viewer/tocCollapse.ts` are two instances. `createWidthAnimator` is
shared verbatim, and `.reck-collapse-chip` is the shared chip appearance.

If you add a third collapsible panel, make it a third instance.

`ui/rail-collapse.test.ts` is the safety net for that extraction — it predates it
and must keep passing **unedited**. If a change to the shared model requires
editing it, the change is wrong.

### Layout constraints

- `.file-viewer-body` must remain **the sole scroll container**. Search, the TTS
  overlay positioning, toasts, banners and the spinner / Speak-bar partition all
  anchor to it. A browser test asserts nothing else in the popup scrolls.
- `.file-viewer-content`'s two children are placed **explicitly**
  (`grid-column: 1` / `2`). `[hidden]` resolves to `display: none`, which drops the
  aside out of grid flow — auto-placement then puts the body in the 0px first
  column, where it collapses to its own padding and renders nothing.

---

## 7. Config keys

New renderer config keys must be added to `CONFIG_KEYS` in `main/storage.ts` or the
IPC boundary silently rejects the renderer's get/set. `main/config-keys.test.ts`
guards this. The TOC's `fileViewerTocMode` / `fileViewerTocWidth` follow the rail's
contract: mode and width persist independently, and anything that isn't exactly the
expected value resolves to the default.

---

## 8. Testing

Split by what each environment can honestly judge.

**vitest / jsdom** — the surrounding contract: when the libraries load, what config
they're handed, staleness guards, sanitization boundaries, TOC construction against
a stubbed `IntersectionObserver`.

**Playwright vs `renderer/markdown-harness.html`** — whether it painted. jsdom has
no layout engine and cannot tell a rendered diagram from a blank div. The harness
follows the `usage-harness` / `tts-harness` precedent: dev-server-only, absent from
`vite.config.ts` `rollupOptions.input`, so it never reaches the shipped bundle.
Fixtures: `rich` (everything), `plain` (no diagrams/math — the lazy-load negative
control), `bare` (no headings — the no-TOC-chip case).

**Playwright + Electron (`e2e-electron/markdown-popup.spec.ts`)** — the real popup
window, real preload, real `file:openInViewer`. Writes its fixture into the
harness's temp `HOME`, which is a built-in allowed root (`main/file-roots.ts`).

`RECK_E2E_PORT` moves the dev server off 5173 — Vite's default across every
project, so when another repo owns it `reuseExistingServer` silently runs the whole
suite against that app.

### Writing assertions here

Three tests in this area were written wrong first and are worth learning from:

- Asserting on the raw HTML string when `html: false` escapes rather than deletes
  (see §2).
- "The lightbox shows the image bigger" — vacuous with a fixture narrower than the
  popup, and not even true on a wide, short window, since `object-fit: contain`
  fits to the shorter axis.
- Scroll-spy tested by scrolling to `scrollHeight`: with
  `rootMargin: "0px 0px -70% 0px"` only the top 30% counts, so at the bottom
  nothing is active and the assertion proves nothing. Scroll a named heading to
  the top instead.

---

## 9. Deliberately not copied from MarkView

| Feature | Why not |
|---|---|
| File browser sidebar (`showDirectoryPicker`) | Reck has its own file-tree pane |
| Toolbar settings popup | Reck has its own settings system |
| `chrome.i18n` translations | Internal tool |
| `chrome.storage.local` | Reck's config IPC |
| Polling auto-refresh | `fsnotify` + IPC is strictly better, and already shipped |
| 9-font selector | Reck's typography settings |
| Bundling MarkView's compiled `content.js` | Minified, hooks Chrome-only APIs, and redistributing a Web Store bundle is almost certainly disallowed. Its libraries are all MIT and on npm |

---

## 10. The preamble depends on this

`DEFAULT_RECK_CONNECT_PROMPT` in `renderer/src/config.ts` tells every Claude
session that the viewer renders mermaid and KaTeX, so agents emit diagrams and
math freely. That claim was false for as long as this feature was only a plan.

**If you disable or break either renderer, fix the preamble in the same change** —
otherwise the app is instructing agents to produce output it can't display.

---

## References

- Mermaid usage: <https://mermaid.js.org/config/usage.html>
- KaTeX auto-render: <https://katex.org/docs/autorender>
- DOMPurify config: <https://github.com/cure53/DOMPurify#can-i-configure-dompurify>
