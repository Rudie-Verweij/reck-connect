# Archive Projects — Design Spec

- **Date:** 2026-07-02
- **Status:** Plan approved 2026-07-03 — implementation starts on explicit go
- **Author:** Mehdi (with Claude Code)
- **Area:** daemon (`reck-stationd`) + satellite (Electron/renderer) + proto + client-core

---

## 1. Problem

Every open project keeps its panes **live in memory the whole time**, even when you're
not looking at it. Switching projects in the rail does *not* close panes — the daemon
keeps every project's PTY subprocess alive (`claude` / `codex` / `shell`), and the
renderer keeps an xterm.js buffer per pane. With many projects open at once this is the
dominant RAM cost and the practical limit on how many projects you can keep around.

There is currently **no way to close a project's terminals while keeping the project**.
The only teardown paths are:

- `DeletePane` (`daemon/internal/pty/manager.go:1514`) — closes one pane and marks it
  "closed on purpose" (`SetLive(..., false)`), so it will **not** auto-restore.
- `RemoveProject` (`daemon/internal/pty/manager.go:535`) — deletes the whole project
  from `projects.toml` and `rm -rf`s its cwd.

Neither fits "put this project to sleep and free its RAM, but let me wake it up exactly
as I left it."

## 2. Goal

Add an **Archive** state to projects:

- **Archive a project** → kill all its panes (freeing daemon PTY subprocesses *and*
  renderer xterm buffers), but **preserve** everything needed to reopen it exactly as
  it was.
- **Archived projects consume ~zero RAM** — no live processes, no xterm buffers. They
  live on disk only.
- **Open/unarchive** → re-spawn all the panes that were live (same behavior as the
  existing "restore layout" on boot), re-attaching the saved split/tab arrangement.
- Archived projects appear in a **dedicated "Archive" section** at the bottom of the
  left rail, collapsed by default and visually distinct (dimmed).
- Archive/unarchive is reachable via **both** the rail right-click menu **and** dragging a
  project into (or out of) the Archive section — both ship in v1.
- Unarchive/restore always **prompts for confirmation** ("Restore N panes for
  &lt;project&gt;?") before spinning the panes back up, on every path.

### Non-goals (v1)

- No deletion of project files (archive never touches the cwd — that's `RemoveProject`'s
  job).
- No auto-archiving by idle timer / LRU (could be a later enhancement).
- No cross-device archive policy differences — archive is a per-project persisted flag,
  same as `Docked`.

## 3. Key insight — reuse the existing restore machinery

Reck already has almost everything archive needs. Archive/unarchive is mostly *wiring
existing primitives together with one new flag*.

- **Session index already persists what to restore.** Each pane has a persisted
  `Entry` in `daemon/internal/sessions/sessions.go:56` with `SessionID` (Claude
  `--resume`), `SlotID` (shell/codex), `ShellArgv`, `Cwd`, `LastPaneID`, and a
  `WasLive bool`. `WasLive` is the exact bit that says "this pane was running — offer to
  restore it."
- **`WasLive` is only cleared on _graceful_ close.** `DeletePane` calls
  `SetLive(..., false)` (manager.go:1537). A crash/SIGKILL leaves `WasLive=true`, which
  is how "restore what I was doing" works on the next boot.
  **→ Archive kills panes but must NOT clear `WasLive`.** That single difference is the
  whole trick.
- **There is already a per-project restore primitive.**
  `RestoreProjectOrphans(projectID, cwd, cols, rows)` (manager.go:1617) re-spawns exactly
  the panes that were live for one project, on demand (it's already used for hybrid-mode
  hot-add). **This is the ready-made "unarchive" verb.**
- **The renderer already re-attaches saved layout to respawned panes.**
  `satellite/renderer/src/layout/reconcile.ts` rekeys the saved layout tree
  (`layouts_v2`, `config.ts:482`) onto freshly-spawned panes by kind-scoped identity
  (`sessionId`/`slotId`), preserving splits, ratios, and tab order bit-for-bit. This
  runs today after boot restore; unarchive reuses it verbatim.

So no new serialization format, no new restore algorithm. Archive = **(kill panes, keep
`WasLive`, set a flag)**; Unarchive = **(clear flag, call `RestoreProjectOrphans`, let
`reconcile.ts` do its thing)**.

## 4. Design overview

```
ARCHIVE  project P
  daemon:   config.SetProjectArchived(P, true)      # persist flag in projects.toml
            for each pane of P: pane.Kill()          # SIGTERM→SIGKILL the process group
            leave every session Entry WasLive=true   # <-- do NOT SetLive(false)
            keep P in m.projects (Archived=true), NEVER touch cwd
  renderer: dispose xterm instances for P's tabs (free renderer RAM)
            FREEZE P's layouts_v2 tree (do not reconcile-away to empty)
            move P's row into the Archive section, dimmed

UNARCHIVE project P  (== clicking an archived project, drag-out, or menu Unarchive)
  renderer: CONFIRM "Restore N panes for P?"           # prompt BEFORE spinning up
  daemon:   config.SetProjectArchived(P, false)
            RestoreProjectOrphans(P, cwd, cols, rows)  # respawn was_live panes
  renderer: reconcile.ts rekeys the frozen layouts_v2 tree onto respawned panes
            move P's row back into the active list; select it
```

## 5. Data model changes

### 5.1 `daemon/internal/config/config.go`

Add `Archived` to `Project` (mirror `Docked` exactly — line 40):

```go
// Archived is true when the user put this project to sleep: its panes are
// killed to free RAM, but its session rows keep was_live=true so unarchive
// can respawn them. Persisted so archive survives daemon restarts. Distinct
// from Docked and from removal (archive never deletes the cwd).
Archived bool `toml:"archived,omitempty"`
```

Add a mutator cloned from `SetProjectDocked` (config.go:282):

```go
func SetProjectArchived(path string, id string, archived bool) error { ... }
```

Render the field in `renderProjectBlock` next to `docked`.

### 5.2 `proto/proto.go` + `proto/proto.ts`

Add `Archived bool` / `archived: boolean` to the wire `Project` type (proto.go:122).
`proto/proto_contract_test.go` enforces Go↔TS parity — update both or the test fails.

### 5.3 `client-core/src/api/client.ts`

Add `archiveProject(id)` / `unarchiveProject(id)` mirroring
`dockProject`/`undockProject` (client.ts:281/304):

```ts
archiveProject(projectId: string)   { return this.fetch(`/projects/${enc(projectId)}/archive`,   { method: "POST" }); }
unarchiveProject(projectId: string) { return this.fetch(`/projects/${enc(projectId)}/unarchive`, { method: "POST" }); }
```

## 6. Daemon changes

### 6.1 New manager verbs — `daemon/internal/pty/manager.go`

`ArchiveProject(id)` — model on `RemoveProject` (manager.go:535) **minus** the deletion
parts:

- Snapshot `cwd` + pane list under lock; unlock.
- `config.SetProjectArchived(configPath, id, true)` **first** (disk authoritative on
  crash, same ordering discipline as `RemoveProject`).
- Update in-memory project (`Archived=true`); remove panes from `byID`/`byProj`;
  **keep the project entry in `m.projects`**.
- `pane.Kill()` each pane; race them against a shared timeout (reuse
  `RemoveProject`'s `WaitForExitCtx` block).
- **Do NOT call `sessions.SetLive(..., false)`** and **do NOT delete the cwd**.
- `notifyStateChange()` so the next poll reflects it.

`UnarchiveProject(id, cols, rows)`:

- `config.SetProjectArchived(configPath, id, false)`; set in-memory `Archived=false`.
- Snapshot the project's authoritative cwd, call
  `RestoreProjectOrphans(id, cwd, cols, rows)`.
- `notifyStateChange()`.

### 6.2 Boot restore must skip archived — `RestoreOrphans` (manager.go:1588)

`RestoreOrphans` iterates `m.Projects()` and respawns every `WasLive` pane. Since archive
deliberately leaves `WasLive=true`, **archived projects would get respawned on the next
daemon restart** unless excluded. Add a guard:

```go
for _, proj := range m.Projects() {
    if proj.Archived { continue }   // stay asleep across restarts
    ...
}
```

This is the one correctness-critical change beyond the happy path.

### 6.3 HTTP routes — `daemon/internal/http/router.go:172`

Add next to dock/undock, handlers cloned from `handleDockProject`/`handleUndockProject`:

```go
r.Post("/projects/{id}/archive",   s.handleArchiveProject)
r.Post("/projects/{id}/unarchive", s.handleUnarchiveProject)
```

`handleUnarchiveProject` needs `cols/rows` for the initial spawn — take them from the
request body (like `handleCreatePane`) or fall back to the manager's stored default size.

## 7. Renderer / UI changes

### 7.1 Rail — Archive section + context menu (`satellite/renderer/src/ui/rail.ts`)

- Partition projects into **active** vs **archived** (`p.archived`). Render active rows as
  today; render a collapsible **"Archive (N)"** group pinned above the Add button, its
  rows dimmed. Persist the collapsed/expanded state in renderer config.
- Add an **Archive / Unarchive** item to `showRailContextMenu` (rail.ts:401), mirroring
  the existing `dock` item. Add `archived: boolean` + `onToggleArchive: () => void` to
  the handler bag and to `RailProps` (rail.ts:6).
- **(v1) make the Archive group a drop target:** reuse the existing
  `dragstart`/`dragover`/`drop` plumbing (rail.ts:299) so dragging a row **into** the group
  archives it, and dragging one **out** unarchives it. Drag-in archives immediately;
  drag-out goes through the restore confirm (§7.2). Show a drop-highlight on the group
  while a row is dragged over it.

### 7.2 Boot wiring (`satellite/renderer/src/boot.ts`)

- Add an `onToggleArchive` handler modeled on `onToggleDock` (boot.ts:737):
  call `client.archiveProject` / `client.unarchiveProject`, then refresh.
- **Click-to-open an archived project → confirm, then restore.** The rail's `onSelect`
  for an archived project shows a confirmation ("Restore N panes for &lt;project&gt;?") and,
  only on confirm, calls `unarchiveProject` then selects it. The **same confirm gates
  drag-out and the context-menu Unarchive** — one shared code path — so heavy processes are
  never spun up by accident. (Archiving is not gated; it's cheap and reversible.)
- **Freeze layout for archived projects.** When a project is archived, the daemon poll
  shows it with no panes. The normal reconcile path drops stale tabs and would
  `saveLayout` an *empty* tree over the good one. Guard reconcile/save so an
  archived project's `layouts_v2` entry is **preserved untouched**, and re-run reconcile
  on unarchive when panes reappear (boot.ts:2144 matching gate).
- **Dispose renderer terminals on archive.** Freezing the *saved* tree is not enough to
  reclaim renderer RAM — the live xterm instances for the project's tabs must be
  disposed. Tear down the visual panes for the archived project (same disposal path used
  when a project's panes go away), keeping only the frozen serialized tree.
- If the **currently-selected** project is archived, switch selection to another active
  project (or the empty state).

### 7.3 Distinct rendering

Archived rows: dimmed, no stoplight, an "asleep"/archive glyph. Optionally show pane count
("3 panes, asleep") so the user knows what unarchive will spin up.

## 8. Edge cases & risks

| # | Case | Handling |
|---|------|----------|
| 1 | Daemon restart while archived | `RestoreOrphans` skips `Archived` projects (§6.2) — stays asleep. |
| 2 | Empty tree clobbers saved layout | Freeze `layouts_v2` for archived projects (§7.2). |
| 3 | Renderer RAM not freed | Explicitly dispose xterm instances at archive (§7.2), not just kill daemon panes. |
| 4 | Archiving the active project | Reselect another active project / empty state (§7.2). |
| 5 | Unarchive spawns heavy processes unexpectedly | Every unarchive path (click, drag-out, menu) goes through one shared "Restore N panes?" confirm before spawning. |
| 6 | Codex/shell panes | Restore already keyed on `SlotID`+`ShellArgv`; unarchive path is kind-agnostic. |
| 7 | Local vs station host | Archive flag is per-project in the owning daemon's registry; unarchive respawns on the same host as before. Verify both hosts. |
| 8 | Project cwd went missing (`Available=false`) while archived | Unarchive should surface the existing "stale" indicator instead of failing hard. |
| 9 | Crash mid-archive (panes killed, flag not yet written) | Persist flag **before** killing panes (same ordering as `RemoveProject`) so disk is authoritative. |

## 9. Testing

**Daemon (Go, table-driven, `-race`):**
- `SetProjectArchived` round-trips through `projects.toml` (set/clear/idempotent/unknown-id).
- `ArchiveProject` kills panes, keeps project in registry, leaves every `Entry.WasLive=true`,
  never touches cwd.
- `UnarchiveProject` respawns exactly the previously-live panes (assert count + identities).
- `RestoreOrphans` skips archived projects (the boot-survival guard).
- HTTP: `POST /archive` + `/unarchive` happy path + unknown id (clone dock handler tests).
- proto contract test stays green (Archived added to both sides).

**Renderer (vitest):**
- Rail partitions active vs archived; Archive group renders + collapses.
- Context menu shows Archive/Unarchive by state; invokes the right client call.
- Reconcile does **not** overwrite a frozen `layouts_v2` when a project has no live panes
  due to archive.
- Unarchive → reconcile re-attaches the frozen tree to respawned panes (identity rekey).

**Manual/E2E smoke:** archive a multi-pane project → RSS drops, daemon PTY children gone;
unarchive → same layout returns; restart daemon while archived → stays asleep.

## 10. Phased implementation plan

**Phase 1 — Daemon core (no UI).**
`Archived` field + `SetProjectArchived`; `ArchiveProject`/`UnarchiveProject`; `RestoreOrphans`
skip-archived guard; unit tests. *Exit:* can archive/unarchive via a direct HTTP call and it
survives restart.

**Phase 2 — Wire contract + HTTP + client.**
proto (Go+TS) `Archived`; `/archive` + `/unarchive` routes & handlers; `client-core`
`archiveProject`/`unarchiveProject`; contract + handler tests.

**Phase 3 — Rail UI (right-click + drag).**
Active/archived partition; collapsible Archive section (dimmed rows, unified across hosts);
context-menu Archive/Unarchive; `onToggleArchive` in boot; distinct rendering; **Archive
section as a drop target** (drag in = archive, drag out = unarchive) reusing the existing
rail DnD plumbing (rail.ts:299) with a drop-highlight. *Exit:* both right-click and drag
archive work end-to-end.

**Phase 4 — Open/restore behavior + real RAM reclaim.**
One shared **"Restore N panes?" confirm** gating every unarchive path (click, drag-out,
menu); on confirm → unarchive + `RestoreProjectOrphans`. Freeze `layouts_v2` for archived
projects; dispose renderer xterm instances on archive; reselect-on-archive-active. *Exit:*
the full RAM-reclaim + confirmed-restore loop works and renderer RSS actually drops.

## 11. Decisions (confirmed 2026-07-03)

1. **Archive UI = collapsible section at the bottom of the rail**, unified across
   station + local hosts. Matches "a bottom button / archive folder" and doubles as the
   drag drop-target.
2. **v1 triggers = right-click menu AND drag-to-archive** (both ship in v1). Drag into the
   Archive section archives; drag out unarchives.
3. **Open behavior = confirm before restore.** Clicking an archived project (or drag-out,
   or menu Unarchive) shows one shared "Restore N panes for &lt;project&gt;?" confirm, then
   unarchives + restores all panes. Archiving itself is not gated.
4. **Wording = "Archive."**
5. **Deliverable now = GitHub issue with this plan; implement only on explicit go.**

## 12. Resolved from earlier open questions

- **Prompt before restore:** YES — always confirm ("Restore N panes?") before unarchiving,
  on every path (click, drag-out, menu).
- **Wording:** "Archive".
- **Per-host vs unified:** one **unified** Archive section across station + local; each
  project unarchives on its own host.

## 13. Central files (implementation map)

| File | Change |
|---|---|
| `daemon/internal/config/config.go` | `Archived` field (:40), `SetProjectArchived` (clone :282), render block (:216) |
| `daemon/internal/pty/manager.go` | `ArchiveProject`/`UnarchiveProject`; skip-archived in `RestoreOrphans` (:1588); model on `RemoveProject` (:535), reuse `RestoreProjectOrphans` (:1617); do NOT copy `DeletePane`'s `SetLive(false)` (:1537) |
| `daemon/internal/sessions/sessions.go` | none — `WasLive` (:56) must survive archive untouched |
| `daemon/internal/http/router.go` | `/archive` + `/unarchive` routes (:172) + handlers (clone dock) |
| `daemon/cmd/reck-stationd/main.go` | boot `RestoreOrphans` (:450) now skips archived |
| `proto/proto.go` + `proto/proto.ts` | `Archived` on `Project` (:122); keep contract test green |
| `client-core/src/api/client.ts` | `archiveProject`/`unarchiveProject` (clone :281/:304) |
| `satellite/renderer/src/ui/rail.ts` | Archive section, context-menu item, `onToggleArchive`, DnD drop target |
| `satellite/renderer/src/boot.ts` | `onToggleArchive`, click=auto-restore, freeze layout, dispose terminals (:737, :2144) |
| `satellite/renderer/src/config.ts` | preserve `layouts_v2` (:482) for archived projects |
| `satellite/renderer/src/layout/reconcile.ts` | re-attach frozen tree on unarchive |
| `satellite/renderer/src/project-push.ts` / `daemon/project-refresh.ts` | flow `archived` to the rail |
