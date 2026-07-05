# Learnings

Append per feature/phase: **What we learned**, **Surprises**, **Decisions**.

---

## Gone-worktree sessions: migrate + resume, not read-only (issue #56 follow-up, 2026-07-05)

Field-testing the complete #56 fix on the Pi (real "jerry" session) exposed that
"preserve read-only" isn't what the user wants for a *deleted* worktree — and
that the read-only state was being masked anyway.

**What we learned**
- Ground truth from the station: `e0030f80` (jerry) had a **2.75 MB** transcript
  under `…CyborgStudio--claude-worktrees-transcript-search-fts5/`, `was_live`
  cleared (my read-only path fired correctly), and its worktree was **gone**.
  Two 1268-byte **decoys** (`8e89099a`, `41e3352f`) sat at the project-root
  folder — fresh sessions the satellite spawned to fill the orphaned tab
  *before* the fix deployed. So "jerry starts fresh" was the satellite showing a
  decoy, while the real jerry sat preserved-but-invisible.
- **Claude Code changed its worktree layout** mid-flight: jerry (2026-07-02) used
  `<root>/.claude-worktrees/<name>` (flat, encodes with `--`); current Claude
  uses `<root>/.claude/worktrees/<name>` (nested). Recovery must not assume a
  fixed layout — `git worktree list` is the only reliable enumerator.
- Read-only preservation is a dead end UX-wise: the satellite fills the orphaned
  tab with a fresh session regardless. Better to make the session **resumable**:
  since the worktree is gone, the project root is its natural home, so
  **relocate the transcript into the project-root folder and `--resume` there**.
  Same id, full history, live — exactly "the session comes back."
- The migration must be gated on git *confirming* the worktree is gone
  (`gitWorktreePaths` now returns an ok flag). On a transient `git` failure we
  refuse (read-only, retry next boot) rather than relocate — otherwise a flaky
  git call would strand a still-live worktree session in the project root.

**Surprises**
- The decoys carried jerry's **display name** (names aren't unique; the id is the
  identity). Two rows both named "transcriptions-searchable-jerry" — only the
  session id disambiguates, which is exactly what `--resume` keys on.
- `List` (visibility gate) and `resolveResumeCwd` (recovery) resolved transcripts
  under *different* roots when `ClaudeProjectsDir` was set — harmless in prod
  (both default to `~/.claude/projects`) but a real inconsistency; restore now
  threads `m.claudeProjectsDir` into `List` so the two always agree.

**Decisions**
- **Migrate + resume** is the default for a git-confirmed gone worktree; the
  read-only refusal (`ErrResumeWorktreeGone`, 409) is now only the *unconfirmed*
  fallback. The transcript is **moved, never truncated**, so history can't be
  lost even if a later step fails.
- Leave the pre-fix decoy sessions in place (user's call) — the real session
  reappears in the picker and comes back live when opened.

## Git-worktree Claude sessions dropped on restore (issue #56, 2026-07-05)

A Claude session run in a git worktree vanished from its project on every daemon
restart despite an intact transcript. Claude Code keys its transcript folder on
its **runtime** cwd (`~/.claude/projects/<EncodeCwd(cwd)>/<sid>.jsonl`), but the
pane recorded its **launch** cwd (the project root). The complete fix recovers
the real cwd, resumes there, self-heals the record, and keeps deleted-worktree
sessions read-only. Plan in `.claude/plans/worktree-restore-fix.md`.

**What we learned**
- A read-side fix *alone* is actively harmful. Making `transcriptExists` glob
  worktree-suffixed folders keeps the session in `List`, but
  `restoreProjectOrphans` then auto-resumes it — and the claude adapter
  **hardcoded `plan.Cwd = req.Project.Cwd`** (`claude.go:84`) even on `--resume`,
  so it relaunches in the project root. `claude --resume` there can't find the
  transcript and forks a fresh one. The lookup fix and the resume-cwd fix must
  ship together.
- `EncodeCwd` is lossy (`/`, `.`, `-` all → `-`), so a worktree folder name
  can't be decoded back to a path. The robust recovery is the other direction:
  enumerate real worktree paths with `git worktree list --porcelain`, re-encode
  each, and match the one whose folder holds the transcript. No decode, no
  `/proc`/`lsof`, cross-platform.
- The cwd-mismatch guard and self-heal fight each other. Once the record's cwd
  is healed to the worktree (a *descendant* of the project root), the guard's
  exact-equality check (`e.Cwd != wantCwd`) would flag it as a reused-project-ID
  mismatch and clear `was_live`. Relaxing the guard to "equal **or** descendant"
  (`isWithinProject`, via `filepath.Rel`) is what lets the heal survive restarts.
- Removing a git worktree deletes its working dir but **not** its
  `~/.claude/projects/` transcript folder — so "worktree gone" means transcript
  present but cwd unmappable. That's a distinct state (`ErrResumeWorktreeGone` →
  read-only, `was_live` cleared, 409 on manual resume), separate from "no
  transcript at all" (legacy resume in the recorded cwd still fine).

**Surprises**
- Claude's worktree folders encode with a `--` (e.g.
  `…CyborgStudio--claude-worktrees-feat`) because the `/.` in
  `<root>/.claude-worktrees/<name>` is two non-alphanumerics in a row.
- `restoreProjectOrphans` respawns *every* `was_live` orphan through the same
  `--resume` path, and its cwd-mismatch guard never fired for worktree rows
  (their recorded cwd *was* the project root), so nothing stopped the wrong-cwd
  resume — the bug hid behind a guard that looked like it should have caught it.
- `TestProjectDetail_autoNameCacheShortCircuitsOnRepeatedPoll` fails under
  `-race` (mtime cache-hit count) on `f29cbe3` too — a pre-existing timing
  flake, not caused by this change. Passes without `-race`.

**Decisions**
- **Complete fix, one PR** — supersede the read-side-only PR #57 rather than
  merge it standalone (it's unsafe alone). Layers: glob keeps it visible →
  `git worktree list` recovers the cwd → resume there + self-heal → relaxed
  guard preserves the heal → gone-worktree kept read-only.
- **Recover via `git worktree list`, not `/proc/<pid>/cwd`.** The process is
  dead at restore time, and a live one starts in the project root and only
  enters the worktree later, so a point-in-time cwd read is both unavailable and
  unreliable. Git enumeration is the durable source of truth.
- **Auto-resume live worktrees** (matches how normal sessions come back), only
  paying the `git` cost on a canonical-path miss so normal sessions are
  unaffected.

## Transcript view: TTS + Cmd-click + chat-start (follow-up to #51/#52, 2026-07-05)

Bringing the History overlay to feature-parity with the terminal / popout /
file-viewer by reusing existing components. Plan in
`.claude/plans/claude-transcript-view-enhancements.md`.

### Phase 1 — parser: harness-wrapper sanitization

**What we learned**
- A Claude session's opening is not "user prose → Claude reply". Real
  transcripts inject non-conversational **`role:"user"` strings**: a
  `<local-command-caveat>` preamble, `<task-notification>` background events,
  `<system-reminder>` blocks, and slash commands as
  `<command-name>…</command-name>` (sometimes with `<command-message>` /
  `<command-args>` / `<local-command-stdout>` siblings). Verified live across 8
  station transcripts: openings split ~PROSE 60, task-notification 13,
  local-command-caveat 11, command-name 11, local-command-stdout 10,
  system-reminder 8.
- The parser now runs `sanitizeUserString()` on string user content: captures
  the slash command as a slim `{ kind: "command", name }` block, strips every
  known wrapper (closed *or* run-to-end-of-message), and keeps whatever prose
  survives. A line that reduces to nothing is **skipped** — no phantom "You"
  turn.

**Surprises**
- Slash commands often arrive **standalone** (`<command-name>/model</command-name>`
  with no siblings), not as the combined `/clear`+message+args blob — so the
  sanitizer can't assume the sibling wrappers are present.
- A skipped noise line must **not** reset the open assistant turn. A mid-turn
  `<task-notification>` would otherwise split Claude's single turn in two, so
  the pure-noise path returns `null` *without* clearing `openAssistant`.

**Decisions**
- New `command` block kind (vs. dropping slash commands) so `/clear`, `/model`,
  `/compact` stay visible as the "how the chat opens" signal — rendered as a
  pill in Phase 2, not a prose bubble.
- Wrapper stripping is deliberately tolerant: unknown tags pass through as text
  (the JSONL schema is not a public API).

### Phase 2 — view: session divider, command pills, user-turn linkify

**What we learned**
- The `a.reck-internal-link` anchor-wrapper the file viewer uses is a private
  `wrapFreeTextPaths(root)` inside `MarkdownRenderer.ts`. Exporting it (vs.
  re-deriving via the already-exported `detectPathsInLine`) lets user prose
  turns get the *exact* same anchors — same class, same `⌘+click to open`
  tooltip, same skip rules — so Phase 3's single delegated handler covers user
  and assistant turns uniformly.
- Command blocks render inline as a slim pill (`.transcript-command`), branched
  in `renderTurn` before the tool-group fold — a `/clear` is user intent, not
  tool activity, so it must not land in the `<details>` tool group.

**Surprises**
- Assistant turns were already visually linkified (the `wrapFreeTextPaths` pass
  runs unconditionally inside `md.mount`), but user turns were raw `.textContent`
  with no anchors at all — so "make paths clickable" needed a *view* change
  (wrap user text), not just a click handler.

**Decisions**
- The start-of-session divider is a permanent first body child, hidden via
  `--hidden` until the first turn renders (so a loading/empty overlay doesn't
  claim a session began). Shows the short 8-char session id when provided.

### Phase 3 — Cmd+click opens any path

**What we learned**
- One delegated `click` listener on `.transcript-body` (not per-turn handlers)
  is the right seam: it survives incremental appends and dodges the
  `MarkdownRenderer.mount()` detach — a single shared renderer keeps a live
  listener only on the *last-mounted* turn, so relying on it would make only
  the newest Claude turn clickable.
- The handler matches **any** `a[href]`, not just `.reck-internal-link`, and
  always `preventDefault()`s — otherwise a plain click on a file href would
  navigate the Electron window. Opening requires ⌘, matching the terminal +
  file-viewer linkifiers.
- The controller stays free of reckAPI/cwd knowledge: it takes a
  `linkHandlers(host)` dep and forwards the result to the view. boot.ts builds
  the handler from the exact pane-linkifier pipeline (`resolveActivatePath` +
  `openInViewer` with `sourceHost`/`projectCwd`); popout passes the raw href
  and lets main resolve (a detached window has no project cwd).

**Surprises**
- The map agent reported markdown native links carry `reck-internal-link`; in
  fact the `link_open` override adds the class **only for internal hrefs**
  (`isInternalLinkHref`). External links are bare `<a>` — hence the broadened
  `a[href]` selector.
- There is **no** renderer-side reckAPI bridge to `shell.openExternal`, and the
  file viewer itself never wires `onExternalActivate`. So external links are
  preventDefaulted (no navigation) but not opened — consistent with the viewer.
  `onExternalActivate` is left plumbed for a future preload bridge.

### Phase 4 — TTS

**What we learned**
- `tts/MarkdownSurfaceAdapter` is drop-in: `TranscriptView.getSpeakSurface()`
  lazily builds `new MarkdownSurfaceAdapter({ container: root, body })` — the
  same (positioned container, scrollable markdown body) split the file viewer
  speaks with — cached and disposed in the view's `dispose()`.
- No second `initTts`: the main window already runs one TtsController
  (`boot.ts`), so a second would double the control bar + shortcuts. Instead the
  existing `getActiveSpeakSurface` closure gains a one-line switch — when
  `transcripts.get(rec.tab.paneId)` is open, return its speak surface — the
  exact mirror of the `initSearch` transcript switch already there. Same
  one-liner in `popout.ts`.

**Surprises**
- `MarkdownSurfaceAdapter`'s constructor is trivial (stores container/body;
  overlay + scroll listener are lazy), so it's jsdom-safe to unit-test the
  surface directly.
- In `popout.ts` the `initTts` closure is defined *before* the `transcripts`
  const — fine because the closure only runs on a user speak action (long after
  module init), and TS permits the forward reference from inside a function.

**Decisions**
- Surface is lazy: a History overlay that's never spoken carries no highlight
  overlay or scroll listener.

### Round 2 (2026-07-05) — polish pass from live use

Second batch of requests after using the History view: "transcript not found"
for some panes, questions/plans invisible, top-right control layout, styling.

#### P1 — "transcript not found" for worktree/subdir sessions

**What we learned**
- Root cause (probed live on the Pi): a Claude session that ran in a **git
  worktree** is written under `~/.claude/projects/<EncodeCwd(worktreeCwd)>/`,
  e.g. `-home-strijders-projects-CyborgStudio--claude-worktrees-transcript-search-fts5/`,
  NOT under the project's registered cwd dir. The daemon computed the path from
  `detail.Cwd` (the project cwd) → wrong dir → 404. Same for any project that
  never wrote a session.
- Fix: `sessions.FindTranscript()` prefers the canonical path but falls back to
  a `filepath.Glob(claudeDir/*/<sid>.jsonl)` — the session id is a
  globally-unique UUID, so the match is unambiguous. Handler validates the UUID
  first (already did), so no glob-metachar/traversal risk.

**Surprises**
- The worktree session's *internal* `"cwd"` field still reads the git root
  (`…/CyborgStudio`), but Claude places the file under `EncodeCwd(process.cwd())`
  = the worktree path. So trusting the recorded cwd wouldn't help — glob-by-id is
  the reliable locator.

#### P2/P3 — surfacing plans & questions

**What we learned**
- The invisible content was two tools (probed live): `AskUserQuestion` (116×)
  and `ExitPlanMode` (51×) — both were folding into the collapsed `🔧 N tool
  calls` group. The parser now special-cases them into first-class blocks:
  `plan` (`input.plan` + `input.planFilePath`), `question` (`input.questions[]`
  = `{question, header, options[{label,description}]}`), rendered as their own
  cards outside the tool group. Everything else stays collapsed.
- Plan approval is detectable: the ExitPlanMode tool_result content starts with
  the literal `"User has approved your plan"`. That folds to a slim `✓ Plan
  approved` chip. A decline surfaces as the next normal user turn (the user's
  own words), so no special handling needed.
- The plan card is deliberately compact: the plan **path is a ⌘-clickable
  link**, the full markdown sits in a collapsed `<details>` — "visible but not
  extensive," per the user.

**Surprises**
- Adding `plan_approved` broke the tool-result fold: `isToolResult` required
  *every* block to be `tool_result`, but the approval is now a `plan_approved`
  block — so the message was becoming a phantom user turn. Fixed by folding on
  `tool_result || plan_approved`.

**Decisions**
- User turns get an orange accent (left border + faint tint); the
  start-of-session divider is promoted to a real title. Regular tool calls stay
  collapsed-by-default (unchanged) — only plans/questions are surfaced.

#### P4 — clamp long user turns

**What we learned**
- The clamp must be a CSS `max-height`/`overflow` clip + fade mask, NOT
  `<details>`/`display:none` — the search subsystem's `TreeWalker` only matches
  text that's in layout, so `display:none` would hide it from search. The full
  text stays in the DOM; "Show more" toggles the clip. Threshold is a text proxy
  (>600 chars or >12 lines) because jsdom has no layout to measure height.

#### P5/P6 — unified top-right control stack

**What we learned**
- There was no shared controls container: the search bar and TTS bar were each
  independently `position:absolute` into `getContainerEl()` with hand-tuned
  offsets (TTS `top:8px`, search `top:48px`), and History was a `.tab-actions`
  button. New `ui/paneControls.ts` `ensurePaneControls(anchor)` is a find-or-
  create `.pane-controls` flex column (top-right, `align-items:flex-end`), and
  every mounter now routes through it: search + TTS pass
  `ensurePaneControls(anchor)` as their container; History moved into the stack
  via `ensureHistoryButton`. Order is fixed by CSS `order` (search 1, TTS 2,
  history 3), so it holds no matter which is present or when it was inserted.
- The anchor is the same element for all three: `wrapper.appendChild(term.container)`
  means `pane.container.parentElement === rec.wrapper`, so History (created in
  PaneLayout's record loop) and search/TTS (from boot's focus closures) resolve
  the *same* stack. Reused across pane / popout / file-viewer / transcript
  overlay by pointing `ensurePaneControls` at each surface's positioned root.

**Surprises**
- Making bars children of `.pane-controls` auto-neutralises the old
  `.file-viewer-root > .tts-control-bar` overrides (they're no longer *direct*
  children of the root), so no rules had to be deleted — only in-flow overrides
  added under `.pane-controls > …`.
- `getSpeakSurface()`'s container changed from `root` to the stack, breaking a
  test asserting `getContainerEl() === root`; updated to the `.pane-controls`
  child. Two pane-layout tests keyed on `.tab-actions [data-act=history]` moved
  to `.pane-controls-history`.

**Decisions**
- `.pane-controls` sits at `z-index:31` (above the History overlay's 30) with
  `pointer-events:none` on the box + `auto` on children, so empty gaps don't eat
  surface clicks. Surfaces with a header (`.file-viewer-root`, `.transcript-view`)
  push the stack down via a per-surface `top` override.

## Codex preamble via `developer_instructions` (follow-up to #33, 2026-07-01)

Undeferred the #32 preamble for codex after web-researching the actual `codex` CLI.

**What we learned**
- The `codex` CLI has **no** `--append-system-prompt` flag (feature request openai/codex#11117 was closed unimplemented), but its generic `-c`/`--config` override sets **`developer_instructions`**, documented in `codex-rs/config/src/config_toml.rs` as *"inserted as a `developer` role message."* It's per-launch, non-invasive (no repo write / no `AGENTS.md` clobber), append-not-replace, and works for the interactive TUI — the clean analog to Claude's `--append-system-prompt`.
- The per-project preamble the user edits in the UI (project dialog / right-click) persists as `Project.Preamble` — the exact field the adapter injects, so codex honours it with zero extra plumbing.

**Surprises**
- The alternatives are all worse: `model_instructions_file` **replaces** the base prompt (officially discouraged), project `AGENTS.md` mutates the repo, `CODEX_HOME`/`--profile` are global user state, and there's **no** instruction-carrying env var. So the single `-c developer_instructions=` override is *the* mechanism.
- `argv_redact.go` didn't cover `-c key=value` (its equals-branch requires a `--` prefix), so the multi-KiB preamble would have flooded logs — extended it.

**Decisions**
- Inject **global + project** layers only; **exclude** the daemon baseline (`BaseStationPreamble`) because it's Claude-shaped ("Claude Code pane" + Claude hooks). Revisit if the baseline is generalised.
- Shipped as a **separate PR stacked on the first-class-codex branch**, grounded in the primary-source config key. **Not yet empirically verified** against a real codex binary (none installed on the Mac or Pi) — a one-line `codex -c developer_instructions=TESTMARKER` smoke-test on the station should confirm the key before relying on it in production.

## Codex first-class pane (issue #33, 2026-07-01)

Made the `codex` pane kind first-class: creatable from the New-pane dialog,
correctly labelled, and restart-durable — deferring only what depends on the
external `codex` CLI's (unverifiable) capabilities.

**What we learned**
- The audit of the 10 merged reck-connect PRs found **none** break a codex
  pane — every merged feature is agent-agnostic terminal/UI/connection
  machinery. The real gap was foundational: `codex` was a half-wired kind.
- The daemon spawn stack was already codex-complete (adapter registered,
  binary resolved, `default_pane="codex"` accepted). The *only* hard blocker
  to interactive create was a single allowlist line in `router.go`.
- **Shell is the template.** A shell pane — like codex — has no Claude
  session yet is creatable, labelled, and restart-durable via a disk-backed
  `SlotID` (`sessions.go` is file-backed; the renderer rekeys the saved tab
  by `slot_id`). Codex reuses the same `slot_id` field, so durability needed
  **no new proto field** — just codex arms alongside the existing shell arms.

**Surprises**
- There was **no** per-station capability signal at all (`/health` carried
  only status/version/uptime; `SupportedKinds()` lists codex unconditionally
  regardless of whether a binary exists). Advertising `codex_available` was
  the bulk of the "create" work — one boolean threaded proto → daemon →
  per-host renderer store → dialog.
- `defaultTabTitle` had only a `claude`/else arm, so every codex pane
  rendered as **"Shell"** in the tab bar and close dialogs.
- The codex adapter never read `ExtraArgs` validation like claude does; the
  dialog sends none, but admitting `kind=codex` to the HTTP API means a raw
  client could pass arbitrary codex flags (noted, not gated).

**Decisions**
- **Path A** (make codex first-class), not Path B (fence it off).
- Codex restore **replays the captured argv+cwd** (mirrors shell) rather than
  re-running the adapter fresh — keeps the "captured argv is the invariant"
  contract uniform across shell/codex.
- **Deferred** (no repo evidence the codex CLI supports them, so building
  blind would be speculative): the #32 preamble (`--append-system-prompt` is
  Claude-only; codex's convention is a filesystem `AGENTS.md`), `--resume`,
  the lifecycle-hook shim + rich stoplight (daemon side is already generic;
  only a `reck-codex-hook.sh` + installer are missing), and clipboard-image.
