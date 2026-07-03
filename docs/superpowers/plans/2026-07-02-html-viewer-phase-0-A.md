# Static HTML Viewer (Phase 0 + Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `.html`/`.htm` files as a sanitized, inert visual snapshot in the file-viewer popup, with the existing read-aloud (TTS), search, and Cmd-click link machinery working on it for free — after first de-duplicating the viewer's render-mode selection so later phases can extend it cleanly.

**Architecture:** Two slices. **Phase 0** introduces a pure `pickViewerMode()` classifier and extracts the identical TTS+search attach block, both currently duplicated across `renderForPath` (local) and `renderStationRemote` (SSH) in `FileViewerHost.ts` — behavior-preserving. **Phase A** extracts the rendered-DOM mount shared by markdown, adds `HtmlRenderer` (a wider DOMPurify profile over raw HTML), teaches the classifier about `.html`, and wires an `html-static` branch into both render functions. Static HTML mounts into the same `shell.body` document, so `MarkdownSurfaceAdapter` (TTS) and `MarkdownSearchAdapter` (search) are reused verbatim with zero new adapter code.

**Tech Stack:** TypeScript (strict), Electron renderer (vanilla DOM — **no React** in the satellite), `dompurify` ^3.4.2 (already a dependency), Vitest + jsdom for tests, pnpm.

## Global Constraints

- **No new runtime dependencies.** `dompurify` ^3.4.2, `markdown-it` ^14.1.1 are already present; add nothing.
- **No `console.log`/`console.debug` in new or refactored code** (repo rule; a hook flags it). Existing console lines being *moved* must be dropped during extraction.
- **No `any`.** Use `unknown` + narrowing at boundaries; explicit types on all exported functions.
- **Immutable updates** (spread; never mutate inputs) — matches `readMarkdownMode`/`writeMarkdownMode`.
- **Security is non-negotiable:** rendered HTML must never yield an executable `<script>`, `on*` handler, `<iframe>`, `<object>`, `<embed>`, or `javascript:`/`vbscript:` URL. Assert via DOM parsing, never substring matching.
- **Vanilla DOM only** — build elements with `document.createElement` / sanitized `innerHTML`, mirroring `MarkdownRenderer.ts` and `FileViewerHost.ts`. No framework.
- **Tests colocated** as `*.test.ts` next to source; DOM tests start with `// @vitest-environment jsdom`.
- **Working directory for all commands is `satellite/`.** Single-file test run: `pnpm exec vitest run <relative-path>`. Full suite: `pnpm test`. Types: `pnpm typecheck`.
- **Files stay focused** (<400 lines typical). New files: one responsibility each.

## File Structure

**New files:**
- `satellite/renderer/src/viewer/pickViewerMode.ts` — pure path→render-mode classifier + path predicates (`isMarkdownPath`, `isHtmlPath`, `isRenderablePath`).
- `satellite/renderer/src/viewer/pickViewerMode.test.ts` — classifier unit tests.
- `satellite/renderer/src/viewer/renderedDom.ts` — shared rendered-DOM mount: free-text path linkifier + Cmd-click interception, reused by markdown and HTML renderers.
- `satellite/renderer/src/viewer/renderedDom.test.ts` — mount/link tests.
- `satellite/renderer/src/viewer/HtmlRenderer.ts` — `createHtmlRenderer()`: raw HTML → sanitized DOM via a wider DOMPurify profile; delegates mounting to `renderedDom`.
- `satellite/renderer/src/viewer/HtmlRenderer.test.ts` — sanitization + reuse tests.

**Modified files:**
- `satellite/renderer/src/viewer/FileViewerHost.ts` — import `isMarkdownPath`/`isHtmlPath`/`isRenderablePath`/`pickViewerMode`; replace the duplicated mode branch in `renderForPath` (~1312–1385) and `renderStationRemote` (~914–1035) with the classifier; extract the identical TTS+search attach (~1462–1494 and ~1126–1160) into one helper; add the `html-static` render branch to both.
- `satellite/renderer/src/viewer/MarkdownRenderer.ts` — delegate `mount()` to `renderedDom` (removing the duplicated linkifier/handler + the `console.*` lines).
- `satellite/renderer/src/styles.css` — `.file-viewer-body` rules for the wider HTML tag set (near the existing markdown rules ~2339–2448).

**Deferred to a Phase A fast-follow (not this plan):** a `<meta http-equiv="Content-Security-Policy">` in `file-viewer.html` as defense-in-depth (must be tuned not to break the module script / Google Fonts / inline styles the viewer already uses; static HTML is already inert without it).

---

## Phase 0 — de-duplicate render-mode selection (behavior-preserving)

### Task 1: `pickViewerMode` classifier

**Files:**
- Create: `satellite/renderer/src/viewer/pickViewerMode.ts`
- Test: `satellite/renderer/src/viewer/pickViewerMode.test.ts`

**Interfaces:**
- Produces: `isMarkdownPath(p: string): boolean`, `isRenderablePath(p: string): boolean`, `type ViewerMode = "markdown-rendered" | "source"`, `pickViewerMode(path: string, persisted: PersistedRenderMode | undefined): ViewerMode`, `type PersistedRenderMode = "rendered" | "source"`. (`isHtmlPath` + the `"html-static"` arm are added in Task 6.)

- [ ] **Step 1: Write the failing test**

```ts
// satellite/renderer/src/viewer/pickViewerMode.test.ts
import { describe, it, expect } from "vitest";
import {
  isMarkdownPath,
  isRenderablePath,
  pickViewerMode,
} from "./pickViewerMode";

describe("isMarkdownPath", () => {
  it("matches .md and .markdown case-insensitively", () => {
    expect(isMarkdownPath("/a/b.md")).toBe(true);
    expect(isMarkdownPath("/a/b.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/a/b.ts")).toBe(false);
  });
});

describe("isRenderablePath", () => {
  it("is true for markdown (Phase 0 scope)", () => {
    expect(isRenderablePath("/a/b.md")).toBe(true);
    expect(isRenderablePath("/a/b.ts")).toBe(false);
  });
});

describe("pickViewerMode", () => {
  it("renders markdown by default", () => {
    expect(pickViewerMode("/a/b.md", undefined)).toBe("markdown-rendered");
  });
  it("honours a persisted 'source' choice for markdown", () => {
    expect(pickViewerMode("/a/b.md", "source")).toBe("source");
  });
  it("uses source for non-renderable files regardless of persisted value", () => {
    expect(pickViewerMode("/a/b.ts", "rendered")).toBe("source");
    expect(pickViewerMode("/a/b.ts", undefined)).toBe("source");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run renderer/src/viewer/pickViewerMode.test.ts`
Expected: FAIL — cannot resolve `./pickViewerMode`.

- [ ] **Step 3: Write the implementation**

```ts
// satellite/renderer/src/viewer/pickViewerMode.ts
// Pure classifier for the file viewer's render mode. Centralises the
// path-type predicates and the (path, persisted-mode) -> ViewerMode
// decision that renderForPath and renderStationRemote both need, so the
// decision lives in exactly one place.

export type PersistedRenderMode = "rendered" | "source";

/** The concrete surface a viewer should mount for a file. */
export type ViewerMode = "markdown-rendered" | "source";

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

/** True for file types that offer a rendered view (and thus a
 *  rendered/source toggle). Extended in Phase A to include HTML. */
export function isRenderablePath(p: string): boolean {
  return isMarkdownPath(p);
}

/**
 * Decide the render mode. `persisted` is the per-path user preference
 * (`fileViewerModePerPath`); `undefined` means "no saved choice", which
 * defaults renderable files to their rendered view.
 */
export function pickViewerMode(
  path: string,
  persisted: PersistedRenderMode | undefined,
): ViewerMode {
  if (isMarkdownPath(path) && persisted !== "source") {
    return "markdown-rendered";
  }
  return "source";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run renderer/src/viewer/pickViewerMode.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/pickViewerMode.ts satellite/renderer/src/viewer/pickViewerMode.test.ts
git commit -m "refactor(viewer): add pure pickViewerMode classifier (#42)"
```

---

### Task 2: Route both render functions through the classifier

**Files:**
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts` (remove local `isMarkdownPath` ~201–203; edit `renderForPath` ~1312–1385 and `renderStationRemote` ~914–1035)

**Interfaces:**
- Consumes: `isMarkdownPath`, `isRenderablePath`, `pickViewerMode` from `./pickViewerMode` (Task 1).

This task has no new unit test; its gate is the existing `FileViewerHost` suite + typecheck (behavior is unchanged).

- [ ] **Step 1: Remove the local predicate and import the classifier**

In `FileViewerHost.ts`, delete the local definition (lines ~201–203):

```ts
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}
```

Add to the import block near the top (after the `MarkdownRenderer` import on line 9):

```ts
import {
  isMarkdownPath,
  isRenderablePath,
  pickViewerMode,
  type PersistedRenderMode,
} from "./pickViewerMode";
```

- [ ] **Step 2: Rewrite the mode decision in `renderForPath`**

Replace lines ~1312–1316:

```ts
  const isMd = isMarkdownPath(filePath);
  const markdownMode: MarkdownMode = isMd
    ? await readMarkdownMode(result.resolvedPath)
    : "source";
  if (isMd) {
```

with:

```ts
  const renderable = isRenderablePath(filePath);
  const persisted: PersistedRenderMode | undefined = renderable
    ? await readMarkdownMode(result.resolvedPath)
    : undefined;
  const mode = pickViewerMode(filePath, persisted);
  if (renderable) {
```

Then replace the branch head at line ~1335:

```ts
  if (isMd && markdownMode === "rendered") {
```

with:

```ts
  if (mode === "markdown-rendered") {
```

(The mode-toggle closure just below still reads `next === "source"` for `initialUnlocked`; leave it. `readMarkdownMode` returns `"rendered" | "source"`, which is assignable to `PersistedRenderMode`.)

- [ ] **Step 3: Rewrite the mode decision in `renderStationRemote`**

Replace lines ~914–917:

```ts
  const isMd = isMarkdownPath(filePath);
  const markdownMode: MarkdownMode = isMd
    ? await readMarkdownMode(filePath)
    : "source";
```

with:

```ts
  const renderable = isRenderablePath(filePath);
  const persisted: PersistedRenderMode | undefined = renderable
    ? await readMarkdownMode(filePath)
    : undefined;
  const mode = pickViewerMode(filePath, persisted);
```

Replace the toggle gate at line ~987 (`if (isMd) {`) with `if (renderable) {`, and the branch head at line ~1004 (`if (isMd && markdownMode === "rendered") {`) with `if (mode === "markdown-rendered") {`.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If it flags an unused `MarkdownMode` import/type, leave `MarkdownMode` in place — `readMarkdownMode`/`writeMarkdownMode`/`mountModeToggle` still use it.

- [ ] **Step 5: Run the viewer regression suite**

Run: `pnpm exec vitest run renderer/src/viewer/FileViewerHost.test.ts`
Expected: PASS — markdown files still render, non-markdown still open in CodeMirror, the mode toggle still persists. (No behavior change.)

- [ ] **Step 6: Commit**

```bash
git add satellite/renderer/src/viewer/FileViewerHost.ts
git commit -m "refactor(viewer): select render mode via pickViewerMode in both paths (#42)"
```

---

### Task 3: Extract the duplicated TTS + search attach

**Files:**
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts` (add helper; replace ~1462–1494 and ~1126–1160)

**Interfaces:**
- Produces (module-private): `attachSpeakAndSearch(root: HTMLElement, shell: ViewerShell, codeEditor: CodeEditorHandle | null): void` — builds the surface adapter, starts TTS, and registers the `speakHandles`/`searchHandles` entries. Identical in both render functions today.

- [ ] **Step 1: Add the helper near the `speakHandles`/`searchHandles` declarations (~line 1171)**

```ts
/**
 * Attach the unified TTS engine + search bar to whichever surface the
 * viewer just mounted. When a CodeMirror editor exists we speak/search the
 * editor; otherwise we speak/search the rendered DOM in `shell.body`
 * (markdown today, static HTML in Phase A — both are plain DOM, so the
 * MarkdownSurfaceAdapter/MarkdownSearchAdapter handle them unchanged).
 * Registers per-root handles so the next render's teardown disposes them.
 */
function attachSpeakAndSearch(
  root: HTMLElement,
  shell: ViewerShell,
  codeEditor: CodeEditorHandle | null,
): void {
  const surface: SpeakSurfaceAdapter = codeEditor
    ? new CodeMirrorSurfaceAdapter({ container: root, view: codeEditor.view })
    : new MarkdownSurfaceAdapter({ container: root, body: shell.body });
  let ttsHandle: TtsHandle | null = null;
  void (async () => {
    try {
      ttsHandle = await initTts({ getActiveSpeakSurface: () => surface });
    } catch (e) {
      console.warn("[file-viewer] TTS disabled:", e);
    }
  })();
  speakHandles.set(root, {
    surface,
    dispose: () => {
      ttsHandle?.dispose();
      surface.dispose();
    },
  });
  searchHandles.set(
    root,
    attachViewerSearch({ root, body: shell.body, view: codeEditor?.view ?? null }),
  );
}
```

(`console.warn` matches the pre-existing line; only `console.log`/`console.debug` are disallowed.)

- [ ] **Step 2: Replace the inline block in `renderForPath`**

Delete lines ~1457–1494 (the `const surface: SpeakSurfaceAdapter = codeEditor ? … ` block through the `searchHandles.set(...)` call) and replace with:

```ts
  // Attach TTS + search to the surface we just mounted (shared with the
  // station path). Disposed by the next render's teardown.
  attachSpeakAndSearch(root, shell, codeEditor);
```

- [ ] **Step 3: Replace the inline block in `renderStationRemote`**

Delete the equivalent block at ~1126–1160 and replace with the same single call:

```ts
  attachSpeakAndSearch(root, shell, codeEditor);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run the viewer suite**

Run: `pnpm exec vitest run renderer/src/viewer/FileViewerHost.test.ts`
Expected: PASS — read-aloud and search still attach for both markdown and code, local and station.

- [ ] **Step 6: Commit**

```bash
git add satellite/renderer/src/viewer/FileViewerHost.ts
git commit -m "refactor(viewer): extract shared TTS+search attach helper (#42)"
```

---

## Phase A — static HTML preview

### Task 4: Extract the shared rendered-DOM mount

**Files:**
- Create: `satellite/renderer/src/viewer/renderedDom.ts`
- Create: `satellite/renderer/src/viewer/renderedDom.test.ts`
- Modify: `satellite/renderer/src/viewer/MarkdownRenderer.ts` (delegate `mount()`; drop the duplicated linkifier/handler + `console.*`)

**Interfaces:**
- Produces:
  - `interface RenderedDomOptions { onLinkActivate?: (href: string, ev: MouseEvent) => void; onExternalActivate?: (href: string, ev: MouseEvent) => void; }`
  - `interface RenderedDomHandle { mount(container: HTMLElement, html: string): void; dispose(): void; }`
  - `function createRenderedDom(opts?: RenderedDomOptions): RenderedDomHandle`
  - `function isInternalLinkHref(href: string): boolean`
- Consumes: `detectPathsInLine` from `./LinkDetector` (unchanged).

This module is the existing markdown `mount()` + `wrapFreeTextPaths` + `isInternalLinkHref` + click handler, verbatim **minus the `console.log`/`console.debug` lines** (repo no-console rule), made renderer-agnostic (it only ever sets sanitized `innerHTML`).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
// satellite/renderer/src/viewer/renderedDom.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRenderedDom } from "./renderedDom";

describe("createRenderedDom.mount", () => {
  it("sets innerHTML and wraps free-text paths as internal links", () => {
    const dom = createRenderedDom();
    const el = document.createElement("div");
    dom.mount(el, "<p>see services/foo.ts here</p>");
    const a = el.querySelector("a.reck-internal-link");
    expect(a?.getAttribute("href")).toBe("services/foo.ts");
  });

  it("blocks plain clicks and routes Cmd+click on internal links", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md">x</a>');
    const a = el.querySelector("a")!;

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(onLinkActivate).not.toHaveBeenCalled();

    const meta = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    a.dispatchEvent(meta);
    expect(onLinkActivate).toHaveBeenCalledWith("./x.md", expect.any(MouseEvent));
  });

  it("routes Cmd+click on external links to onExternalActivate", () => {
    const onExternalActivate = vi.fn();
    const dom = createRenderedDom({ onExternalActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="https://example.com">e</a>');
    el.querySelector("a")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onExternalActivate).toHaveBeenCalledWith(
      "https://example.com",
      expect.any(MouseEvent),
    );
  });

  it("dispose() detaches the click handler", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md">x</a>');
    const a = el.querySelector("a")!;
    dom.dispose();
    a.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onLinkActivate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run renderer/src/viewer/renderedDom.test.ts`
Expected: FAIL — cannot resolve `./renderedDom`.

- [ ] **Step 3: Create `renderedDom.ts`**

```ts
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

function wrapFreeTextPaths(root: HTMLElement): void {
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

  const detach = (): void => {
    if (attachedContainer && attachedHandler) {
      attachedContainer.removeEventListener("click", attachedHandler);
    }
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
    },
    dispose(): void {
      detach();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run renderer/src/viewer/renderedDom.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Point `MarkdownRenderer.mount` at the shared module**

In `MarkdownRenderer.ts`: delete the local `wrapFreeTextPaths` (lines ~89–150) and `isInternalLinkHref` (lines ~158–167), and add near the other imports:

```ts
import { createRenderedDom, isInternalLinkHref } from "./renderedDom";
```

`isInternalLinkHref` is still used by the `link_open` renderer rule (line ~217) — the import keeps that call working. Then replace the `createMarkdownRenderer` return object's `attachedContainer`/`attachedHandler`/`detach`/`mount`/`dispose` machinery (lines ~290–372) with delegation:

```ts
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
```

This removes the `console.log`/`console.debug` calls that lived in the old inline handler.

- [ ] **Step 6: Run the markdown regression suite**

Run: `pnpm exec vitest run renderer/src/viewer/MarkdownRenderer.test.ts`
Expected: PASS. If a click/linkify test asserted on `console` output (none observed at time of writing), update that test to assert on behavior instead — never re-add `console.log`.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add satellite/renderer/src/viewer/renderedDom.ts satellite/renderer/src/viewer/renderedDom.test.ts satellite/renderer/src/viewer/MarkdownRenderer.ts
git commit -m "refactor(viewer): extract shared rendered-DOM mount from MarkdownRenderer (#43)"
```

---

### Task 5: `HtmlRenderer` — sanitized static HTML

**Files:**
- Create: `satellite/renderer/src/viewer/HtmlRenderer.ts`
- Create: `satellite/renderer/src/viewer/HtmlRenderer.test.ts`

**Interfaces:**
- Consumes: `createRenderedDom`, `RenderedDomOptions` from `./renderedDom` (Task 4).
- Produces:
  - `interface HtmlRenderer { render(rawHtml: string): string; mount(container: HTMLElement, html: string): void; dispose(): void; }`
  - `function createHtmlRenderer(opts?: RenderedDomOptions): HtmlRenderer`

**Sanitization policy:** rely on DOMPurify's audited default allowlist (keeps structural/visual tags, sanitized inline `style`, and `<style>` blocks; strips `<script>`, `on*` handlers, `<iframe>`, `<object>`, `<embed>`, and dangerous URLs) and additionally forbid navigational/interactive surfaces that don't belong in an inert snapshot. This is intentionally *wider* than the markdown allowlist (which permits only ~25 tags) so real page markup renders.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
// satellite/renderer/src/viewer/HtmlRenderer.test.ts
import { describe, it, expect } from "vitest";
import { createHtmlRenderer } from "./HtmlRenderer";

const parse = (html: string): Document =>
  new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

describe("createHtmlRenderer.render", () => {
  it("keeps structural tags and inline styles", () => {
    const r = createHtmlRenderer();
    const doc = parse(
      r.render('<div class="card"><section style="color:red">hi</section></div>'),
    );
    expect(doc.querySelector("div.card")).not.toBeNull();
    const section = doc.querySelector("section");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("style")).toContain("color");
  });

  it("keeps <style> blocks", () => {
    const r = createHtmlRenderer();
    expect(r.render("<style>.a{color:red}</style><div class='a'>x</div>")).toContain(
      "<style",
    );
  });

  it("strips <script> but keeps sibling content", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render("<script>alert(1)</script><h1>Title</h1>"));
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelectorAll("h1").length).toBe(1);
  });

  it("strips on* event-handler attributes", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<img src="x" onerror="alert(1)">'));
    doc.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
      }
    });
  });

  it("strips <iframe>, <object>, <embed>, and <form>", () => {
    const r = createHtmlRenderer();
    const doc = parse(
      r.render(
        "<iframe src='e'></iframe><object></object><embed><form action='/x'><input></form>",
      ),
    );
    expect(doc.querySelectorAll("iframe,object,embed,form").length).toBe(0);
  });

  it("drops javascript: hrefs", () => {
    const r = createHtmlRenderer();
    const doc = parse(r.render('<a href="javascript:alert(1)">x</a>'));
    doc.querySelectorAll("a[href]").forEach((a) => {
      expect((a.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:")).toBe(
        false,
      );
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run renderer/src/viewer/HtmlRenderer.test.ts`
Expected: FAIL — cannot resolve `./HtmlRenderer`.

- [ ] **Step 3: Create `HtmlRenderer.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run renderer/src/viewer/HtmlRenderer.test.ts`
Expected: PASS (all cases). If `<style>` is stripped (jsdom/DOMPurify version quirk), the fix is to keep the default profile but NOT list `style` in any forbid list — it must remain default-allowed; do not switch to an explicit `ALLOWED_TAGS` allowlist (that would drop structural tags).

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/HtmlRenderer.ts satellite/renderer/src/viewer/HtmlRenderer.test.ts
git commit -m "feat(viewer): add createHtmlRenderer for sanitized static HTML (#43)"
```

---

### Task 6: Teach the classifier about HTML

**Files:**
- Modify: `satellite/renderer/src/viewer/pickViewerMode.ts`
- Modify: `satellite/renderer/src/viewer/pickViewerMode.test.ts`

**Interfaces:**
- Produces: `isHtmlPath(p: string): boolean`; `ViewerMode` gains `"html-static"`; `isRenderablePath` now also true for HTML; `pickViewerMode` returns `"html-static"` for `.html` with no `source` preference.

- [ ] **Step 1: Extend the test**

Add to `pickViewerMode.test.ts`:

```ts
import { isHtmlPath } from "./pickViewerMode";

describe("isHtmlPath", () => {
  it("matches .html and .htm case-insensitively", () => {
    expect(isHtmlPath("/a/b.html")).toBe(true);
    expect(isHtmlPath("/a/b.HTM")).toBe(true);
    expect(isHtmlPath("/a/b.md")).toBe(false);
  });
});

describe("pickViewerMode (html)", () => {
  it("renders .html statically by default", () => {
    expect(pickViewerMode("/a/b.html", undefined)).toBe("html-static");
  });
  it("honours a persisted 'source' choice for .html", () => {
    expect(pickViewerMode("/a/b.html", "source")).toBe("source");
  });
  it("treats .html as renderable", () => {
    expect(isRenderablePath("/a/b.html")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm exec vitest run renderer/src/viewer/pickViewerMode.test.ts`
Expected: FAIL — `isHtmlPath` undefined; `"html-static"` not returned.

- [ ] **Step 3: Update `pickViewerMode.ts`**

```ts
export type ViewerMode = "markdown-rendered" | "html-static" | "source";

export function isHtmlPath(p: string): boolean {
  return /\.html?$/i.test(p);
}

export function isRenderablePath(p: string): boolean {
  return isMarkdownPath(p) || isHtmlPath(p);
}

export function pickViewerMode(
  path: string,
  persisted: PersistedRenderMode | undefined,
): ViewerMode {
  if (persisted !== "source") {
    if (isMarkdownPath(path)) return "markdown-rendered";
    if (isHtmlPath(path)) return "html-static";
  }
  return "source";
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `pnpm exec vitest run renderer/src/viewer/pickViewerMode.test.ts`
Expected: PASS (markdown + html cases).

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/pickViewerMode.ts satellite/renderer/src/viewer/pickViewerMode.test.ts
git commit -m "feat(viewer): classify .html as html-static render mode (#43)"
```

---

### Task 7: Render `html-static` in `renderForPath` (local)

**Files:**
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts` (add import; add branch after the `markdown-rendered` branch ~1384)

**Interfaces:**
- Consumes: `createHtmlRenderer` from `./HtmlRenderer` (Task 5).

- [ ] **Step 1: Import the HTML renderer**

Near the `createMarkdownRenderer` import (line 9), add:

```ts
import { createHtmlRenderer } from "./HtmlRenderer";
```

- [ ] **Step 2: Add the `html-static` branch**

In `renderForPath`, the branch is currently `if (mode === "markdown-rendered") { … md … } else { … CodeMirror … }`. Insert an `else if` between them. After the markdown branch's closing `}` (the `md.mount(...)` block, ~line 1384) and before `else {`:

```ts
  } else if (mode === "html-static") {
    const html = createHtmlRenderer({
      onLinkActivate: (href) => {
        const target = href.startsWith("/")
          ? href
          : window.reckAPI.paths.resolveAgainst(result.resolvedPath, href);
        void window.reckAPI.files
          .openInViewer(target, {
            opener: result.resolvedPath,
            originalText: href,
            projectCwd: renderOpts.projectCwd,
          })
          .then((r) => {
            const res = r as
              | { ok?: boolean; code?: string; error?: string }
              | undefined;
            if (!res || res.ok !== true) {
              showToast(
                shell.body,
                res?.error ? `Could not open: ${res.error}` : "Could not open file.",
                3500,
              );
            }
          })
          .catch(() => {
            /* openInViewer failures surface via the toast above */
          });
      },
    });
    html.mount(shell.body, html.render(result.content));
  } else {
```

(This mirrors the markdown branch's local `onLinkActivate` — resolve relative hrefs against the opener, cascade through `openInViewer`, toast on failure — with the `console.log` trace lines omitted per the no-console rule.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Add a viewer-level regression case (if the harness supports it)**

Open `renderer/src/viewer/FileViewerHost.test.ts`. If it already stubs `window.reckAPI.files.read` and mounts a `.md` file, add an analogous case that reads a `.html` file and asserts the body contains the rendered element (e.g. a `<div>` from the file) rather than a CodeMirror editor. If the existing harness makes this impractical, skip and rely on the `HtmlRenderer` unit tests plus manual verification in Step 5 — do not force a brittle test.

Run: `pnpm exec vitest run renderer/src/viewer/FileViewerHost.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual smoke check**

Run the app (`pnpm dev` from `satellite/`), open a local `.html` file via a Cmd+click path link or the viewer. Expected: it renders as a page (not source), the Speak control bar reads its text aloud, search highlights matches, and the header shows the "Edit source" toggle. Toggling to source shows CodeMirror; toggling back returns to the render.

- [ ] **Step 6: Commit**

```bash
git add satellite/renderer/src/viewer/FileViewerHost.ts satellite/renderer/src/viewer/FileViewerHost.test.ts
git commit -m "feat(viewer): render local .html files as static preview (#43)"
```

---

### Task 8: Render `html-static` in `renderStationRemote` (SSH)

**Files:**
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts` (add the branch after the station `markdown-rendered` branch ~1035)

Keeps `.html` behavior consistent whether the file is local or opened from a station context. Mirrors the station markdown branch's `onLinkActivate` (which carries `sourceHost: "station"`).

- [ ] **Step 1: Add the branch**

In `renderStationRemote`, after the markdown branch's `md.mount(...)` closing (~line 1035) and before `else {`:

```ts
  } else if (mode === "html-static") {
    const html = createHtmlRenderer({
      onLinkActivate: (href) => {
        const target = href.startsWith("/")
          ? href
          : window.reckAPI.paths.resolveAgainst(filePath, href);
        const ctx: ClickContext = {
          surface: "popup-markdown",
          href,
          opener: filePath,
          target,
          sourceHost: "station",
          projectCwd: renderOpts.projectCwd,
        };
        void openInViewerWithToast({
          ctx,
          openInViewer: () =>
            window.reckAPI.files.openInViewer(target, {
              sourceHost: "station",
              opener: filePath,
              originalText: href,
              projectCwd: renderOpts.projectCwd,
            }) as Promise<{ ok?: boolean; code?: string; error?: string } | undefined>,
          showToast: (msg, o) =>
            showToast(shell.body, msg, { durationMs: o?.ttl, kind: o?.kind }),
        });
      },
    });
    html.mount(shell.body, html.render(result.content));
  } else {
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run the viewer suite**

Run: `pnpm exec vitest run renderer/src/viewer/FileViewerHost.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add satellite/renderer/src/viewer/FileViewerHost.ts
git commit -m "feat(viewer): render station .html files as static preview (#43)"
```

---

### Task 9: Style the wider HTML tag set

**Files:**
- Modify: `satellite/renderer/src/styles.css` (near the existing `.file-viewer-body` markdown rules, ~2339–2448)

The markdown rules already style `h1–h6`, `p`, `ul/ol/li`, `blockquote`, `code`, `pre`, `table`, `hr` under `.file-viewer-body`. Static HTML adds structural/media tags that need baseline layout so pages don't render cramped or overflow.

- [ ] **Step 1: Add rules**

Append near the other `.file-viewer-body` rules:

```css
/* Static HTML preview: baseline layout for structural/media tags the
   markdown renderer never emits. Keeps pages readable and prevents wide
   media/tables from breaking the popup's horizontal scroll. */
.file-viewer-body img,
.file-viewer-body picture,
.file-viewer-body video,
.file-viewer-body svg {
  max-width: 100%;
  height: auto;
}
.file-viewer-body figure {
  margin: 1em 0;
}
.file-viewer-body figcaption {
  font-size: 0.9em;
  opacity: 0.8;
}
.file-viewer-body section,
.file-viewer-body article,
.file-viewer-body header,
.file-viewer-body footer,
.file-viewer-body main,
.file-viewer-body aside,
.file-viewer-body nav {
  display: block;
}
.file-viewer-body details {
  margin: 0.5em 0;
}
```

- [ ] **Step 2: Manual verification**

Run `pnpm dev`, open a `.html` file with images and sections. Expected: images clamp to the body width (no horizontal overflow), sections/figures have sane spacing.

- [ ] **Step 3: Commit**

```bash
git add satellite/renderer/src/styles.css
git commit -m "style(viewer): baseline layout for static HTML tags (#43)"
```

---

## Follow-ups (not in this plan)

- **Viewer CSP** (`file-viewer.html`): add a `<meta http-equiv="Content-Security-Policy">` tuned to keep the module script, Google Fonts, and inline styles working while constraining sub-resource loads for rendered HTML. Deferred because static HTML is already inert (DOMPurify strips executable surfaces) and the CSP must be integration-tested against the existing markdown/code viewer to avoid regressions.
- **Full-document `.html`** with `<head>` metadata (external stylesheets, `<title>`): the inert snapshot renders body-level markup and inline `<style>` only; full external-CSS fidelity is Phase B's real Vite render.
- **Phase B** (issue #44): faithful Vite component preview — separate plan.

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-07-02-html-react-viewer-design.md`):**
- §9 Phase 0 (classifier + de-dup) → Tasks 1–3. ✅ (Both `renderForPath` and `renderStationRemote` routed through one classifier; the identical TTS+search block extracted.)
- §9 Phase A / §5 Tier 0 (static HTML, reuse TTS/search verbatim) → Tasks 4–9. ✅ (`HtmlRenderer` + shared `renderedDom`; TTS/search reused because content mounts into `shell.body` and `attachSpeakAndSearch` picks `MarkdownSurfaceAdapter` when there's no `codeEditor`.)
- §11 (sanitization; extension allowlist) → Task 5 config + tests. CSP + `file:read` MIME allowlist explicitly deferred to Follow-ups (noted, not silently dropped). ✅
- "Reuse `MarkdownSurfaceAdapter` verbatim" acceptance test → Task 4/5 prove HTML mounts to plain DOM; `attachSpeakAndSearch` uses the adapter unchanged. A dedicated "MarkdownSurfaceAdapter extracts text from HtmlRenderer output" assertion is covered implicitly (same `shell.body` DOM); add it to `HtmlRenderer.test.ts` if a reviewer wants it explicit.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion and the exact command + expected result. ✅

**Type consistency:** `ViewerMode` values (`markdown-rendered`, `html-static`, `source`) are used identically in `pickViewerMode` (Tasks 1, 6) and both branch sites (Tasks 2, 7, 8). `PersistedRenderMode` (`rendered|source`) matches `readMarkdownMode`'s return. `createRenderedDom`/`RenderedDomOptions`/`RenderedDomHandle` (Task 4) are consumed unchanged by `MarkdownRenderer` (Task 4) and `HtmlRenderer` (Task 5). `createHtmlRenderer(opts?: RenderedDomOptions)` matches its call sites (Tasks 7, 8). ✅
