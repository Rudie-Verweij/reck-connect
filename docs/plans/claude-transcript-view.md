# Claude-pane transcript view: exact scrollbar + full-chat search (issue #51)

## Context

A Claude pane's chat can't be scrolled or searched properly from the satellite: Claude Code
runs on the **alternate screen** with mouse tracking, so xterm only ever holds the ~40 visible
rows — no scrollback, no total length, no offset (established in #41, probe-verified). PR #49
made the wheel page the live TUI (wheel → PgUp/PgDn), but that is paging blind: no position,
no drag-to-seek, and ⌘F only sees the painted rows.

**The unlock (all verified):** Claude Code persists every session as JSONL at
`~/.claude/projects/<EncodeCwd(cwd)>/<session-uuid>.jsonl` on the machine it runs on (the Pi
for station panes), appended live turn-by-turn. Our daemon **already controls the mapping**:
`daemon/internal/agent/claude.go` `BuildSpawn()` passes `--session-id <uuid>` on fresh spawns /
`--resume <uuid>` on resumes; `daemon/internal/sessions/sessions.go` implements `EncodeCwd()` +
`transcriptExists()` at exactly that path; `GET /projects/{id}/sessions` already ships the
session index to the satellite. Duplicate `--session-id` errors ("already in use"), so every
spawn gets a fresh UUID — the daemon already handles this.

**Design decision (agreed with user):** render the transcript in our **own DOM overlay**
("History") over the Claude pane. The browser lays out the content at the pane's real width, so
`scrollHeight`/`clientHeight` are exact at any size — the existing *truthful* `OverlayScrollbar`
mode (thumb size/position, drag-to-seek, `ResizeObserver`) and `MarkdownSearchAdapter` tick
fractions work unchanged. Dragging the transcript scrollbar does **not** drive Claude's TUI
(the TUI accepts only relative page keys and never reports its offset — driving it would
reintroduce estimation). Division of labor: type + watch live output in the terminal (#49
wheel), read/scroll/search history in the transcript view. Content-anchored two-way sync is an
explicit non-goal for v1 (optional follow-up).

Repo: `original-reck-connect/reck-connect-public` (push to `mehdigreefhorst/reck-connect`).
Branch: `feat/claude-transcript-view` off `main`. TDD per phase, conventional commits, one PR
at the end referencing #51. Copy this plan into the repo's `.claude/plans/` on the feature
branch (per workflow).

## Phase 1 — Station: transcript endpoint (Go)

`GET /projects/{id}/sessions/{session_id}/transcript?offset=<bytes>`

- New handler file `daemon/internal/http/transcript.go`; route registered in
  `daemon/internal/http/router.go` (route table ~line 178, beside
  `r.Get("/projects/{id}/sessions", s.handleListSessions)`).
- Handler flow (mirrors `handleListSessions`, router.go:566): `chi.URLParam` →
  `s.rejectSupervisorOutOfScope` → `s.Manager.ProjectExists(id)` → get Cwd via
  `s.Manager.ProjectDetail(id).Cwd` (call the Manager method directly, NOT
  `handleProjectDetail`, which auto-spawns a default pane).
- Path: `filepath.Join(claudeProjectsDir, sessions.EncodeCwd(cwd), sessionID+".jsonl")` —
  the exact formula of unexported `transcriptExists` (`sessions.go:394-395`). Export a helper
  `sessions.TranscriptPath(claudeProjectsDir, cwd, sessionID)` and reuse it in both places.
  The claude projects dir is today an inline default inside `Store.List`
  (`~/.claude/projects` when `ListOptions.ClaudeProjectsDir` is empty, sessions.go:365-372) —
  export that default too and make it injectable on the handler for tests.
- Serving (net-new pattern; no file-GET precedent in the daemon): `os.Open` + `Seek(offset)` +
  `io.Copy` through an `io.LimitReader` cap (4 MB/request so multi-MB catch-up chunks);
  `Content-Type: application/x-ndjson`; headers `X-Reck-Transcript-Offset` (next offset) +
  `X-Reck-Transcript-More: 1` when bytes remain; `offset >= size` → 200 empty body, same
  offset. Query parsing mirrors `handlePaneOutput`'s `?bytes=` (router.go:1362-1366);
  responses via `writeJSON`/`nethttp.Error` conventions (router.go:1051).
- Validation/safety: `session_id` must parse as a UUID (→ 400; blocks traversal); unknown
  project → 404; missing transcript file → 404; existing bearer-auth middleware applies.
- Tests (table-driven, `go test -race`): reuse the `newServerWithSessions(t)` harness
  (router_test.go:943-967 — real `sessions.NewStore` + `pty.NewManager` + `newTestHandler`)
  and seed a `<tmp>/<EncodeCwd(cwd)>/<sid>.jsonl`; cases: happy path, offset semantics incl.
  beyond-EOF, chunk cap + More header, invalid UUID, unknown project/session, auth required.

## Phase 2 — client-core: API method (TS)

- `ApiClient.getTranscript(projectId, sessionId, offset)` → `{ chunk: string; nextOffset:
  number; hasMore: boolean }`, added after `listSessions()` (`client-core/src/api/client.ts:195`).
  The private `fetch<T>` enforces `application/json` (client.ts:114-118), so this method uses a
  small raw-text variant (same bearer auth client.ts:90-92, same `AbortSignal.timeout`,
  same `HttpError` on non-2xx) and reads `X-Reck-Transcript-Offset`/`-More` headers.
- Tests mirror the `listSessions` fetch-stub template (`client-core/src/api/client.test.ts:134`).

## Phase 3 — Satellite: parser + TranscriptView (TS)

- `satellite/renderer/src/transcript/parseTranscript.ts` — incremental JSONL → turns.
  Tolerant of unknown line types (real files contain `custom-title`, `agent-name`, `mode`,
  `permission-mode`, `bridge-session`, …); extracts user/assistant text and
  tool_use/tool_result blocks; skips sidechain lines; carries a partial trailing line between
  chunks (streaming-safe).
- `satellite/renderer/src/transcript/TranscriptView.ts` — DOM overlay shell modeled on the
  file viewer's `buildShell` (`viewer/FileViewerHost.ts:117-149`: positioned root → header +
  scrollable body), but mounted **in-pane** (positioned container over the terminal), not a
  separate window. Turns render via `createMarkdownRenderer()` (`viewer/MarkdownRenderer.ts:286`;
  `render(md): string` + `mount(container, html)`) — one container per turn so appends are
  incremental, no full re-render. Collapsible tool blocks; **follow mode** (stick to bottom
  while new turns stream; disengage when the user scrolls up, re-engage at bottom).
- Scroll + search wiring is **one existing call**: `attachViewerSearch({ root, body, view:
  null })` (`search/attachViewerSearch.ts:30-56`) already composes `MarkdownSearchAdapter` +
  `domScrollSurface(body)` + `createOverlayScrollbar` + `initSearch` with exact tick
  fractions and returns a single `dispose()`. Nothing new to build for scroll/search.
- Transcript tailing: a small poller class mirroring `daemon/connection.ts` (start/stop
  guards :77-90, AbortController per fetch, re-arm in `finally` :139-154), ~1.5 s interval
  while the view is open.
- Tests (vitest, `// @vitest-environment jsdom` per file): parser fixtures from real
  transcript line shapes, partial-line carry, incremental append, follow-mode hysteresis,
  search fractions over the transcript DOM, poller start/stop with `vi.useFakeTimers()`
  (template: `daemon/connection.test.ts`), API stubs à la `viewer/FileViewerHost.test.ts`.

## Phase 4 — Pane integration + popout parity

- "History" toggle on Claude panes only: a leaf-toolbar `icon-btn` with `data-act="history"`
  in `ui/pane-layout.ts` (`.tab-actions` build at :980-997, click dispatch :999-1011,
  alongside `detach`/`split`), gated on the tab's `kind === "claude"` (`layout/split-tree.ts:67-87`).
  Overlay covers the pane's terminal area; the xterm keeps running underneath; Esc/toggle
  returns to live.
- Session resolution — two sources, in order: **(1)** the layout `Tab` already carries
  `sessionId?` (`split-tree.ts:67-87`, reconciled from `/projects` detail `Pane.session_id`,
  `proto.ts:163`) — use it directly when present; **(2)** fallback: `listSessions(projectId)`
  → `SessionInfo` (`proto.ts:308-326`), match `last_pane_id === paneId` preferring
  `was_live: true` (endpoint already filters to claude kind; the daemon records
  SessionID/LastPaneID/WasLive on every spawn — `pty/manager.go:1375-1386` — and on resume).
  Re-resolve on pane respawn (fresh UUID per spawn).
- Wire the overlay lifecycle in `satellite/renderer/src/boot.ts` next to the existing
  per-pane scrollbar wiring (`onPaneCreated`, boot.ts:1020-1036) and mirror in `popout.ts`
  (which already duplicates that wiring at popout.ts:206-227).
- Tests: toggle mounts/unmounts view + stops the poller; claude-only gating; session
  resolution order (Tab.sessionId → listSessions fallback); respawn re-resolution.

## Non-goals (v1)

- No two-way sync between transcript position and the live TUI viewport (experimental
  follow-up: content-anchoring; out of acceptance).
- No virtualized rendering unless a real multi-MB transcript measurably lags (incremental
  append + chunked fetch should carry v1).

## Risks

- JSONL schema is not a public API → tolerant parser + fixtures pinned to observed shapes.
- Multi-MB transcripts → offset-chunked fetch + incremental DOM append; virtualize later.
- Local-mode daemon serves the same endpoint with its own `~/.claude/projects` — same code path.

## Verification

- Go: `go test -race ./...` in `daemon/`; new handler tests green.
- TS: `pnpm exec vitest run` (client-core + satellite) green; `pnpm typecheck` clean.
  (Known pre-existing env-gated failures: project-push/rsync-copy — disjoint.)
- Live: `pnpm dev` against the station — open a long Claude chat → History shows the entire
  conversation; thumb exact and stays exact across pane resize; ⌘F finds matches anywhere with
  ticks; new turns stream in with follow-mode; drag seeks instantly; shell panes + file
  viewers untouched.
- PR to `mehdigreefhorst/reck-connect` closing #51.
