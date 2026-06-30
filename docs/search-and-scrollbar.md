# In-view search & overlay scrollbar

A reusable find widget (⌘/Ctrl+F) and an auto-hiding overlay scrollbar
that work identically across the three content surfaces — the **terminal**
(xterm), the **markdown viewer**, and the **CodeMirror source viewer**.

Source: `satellite/renderer/src/search/`. Tracking issue: #23.

## Design

One pure core, three thin per-surface adapters — the same shape as the TTS
subsystem (`renderer/src/tts/`).

| Module | Role |
|---|---|
| `matcher.ts` | Pure `findMatches(text, query, opts)` → offset ranges. Substring/regex + case + whole-word. Compiles to one `RegExp` over the original text so offsets stay aligned. Used by every surface, so semantics are identical everywhere. |
| `SearchSurfaceAdapter.ts` | The one abstraction: `getText()`, `highlightMatches()`, `scrollToMatch()`, `clearHighlights()`, optional `fractionForOffset()`. |
| `SearchBar.ts` | VSCode-style find widget (factory → handle). |
| `SearchController.ts` | Surface-agnostic orchestrator: runs the matcher, highlights, navigates (wrap-around), drives the counter, emits tick fractions. |
| `OverlayScrollbar.ts` + `scrollSurfaces.ts` | Auto-hiding themed scrollbar over any `ScrollSurface` (DOM scroller or xterm buffer); renders match ticks. |
| `initSearch.ts` | Single entry: owns the ⌘F binding + controller. |
| `CodeMirrorSearchAdapter` / `MarkdownSearchAdapter` / `TerminalSearchAdapter` | The only surface-specific code. |

### Per-surface specifics

- **Terminal** — `getText()` joins every physical buffer row (full
  scrollback) with newlines; matches are painted with xterm
  `registerMarker` + `registerDecoration` (like the TTS `XtermHighlighter`)
  and capped so a huge scrollback can't stall the renderer.
- **CodeMirror** — `Decoration.mark` via a `StateField`/`StateEffect`;
  scroll via `EditorView.scrollIntoView`.
- **Markdown** — a TreeWalker text index maps flat offsets back to DOM
  ranges; matches are highlighted with the **CSS Custom Highlight API**
  (`::highlight()`, Electron 30) — no DOM mutation.

## Scrollbar behaviour

Light, Reck-orange, draggable thumb. Fades in on scroll/wheel and out
after a short idle. Native scrollbars are hidden on all three surfaces so
the overlay is the single consistent affordance. Search-match positions are
drawn as ticks along the track.

## Wiring

`boot.ts` (main-window terminals), `popout.ts` (detached panes), and
`FileViewerHost.ts` (markdown + source) each construct the right adapter
and an `OverlayScrollbar`, then call `initSearch`. The file-viewer uses the
shared `attachViewerSearch` helper.

## Keyboard

- **⌘/Ctrl+F** — open / focus the search bar (Shift/Alt variants are left
  free for a future project-wide search).
- **Enter / Shift+Enter** — next / previous match.
- **Escape** — close (consumed only while the search input is focused).
