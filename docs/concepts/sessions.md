# Sessions

The sessions store persists a per-project index that maps pane identities (UUIDs) to metadata — name, cwd, timestamps, and (for shell panes) the original argv. This index is what powers the "Resume" and "Restore" flows after a daemon restart or crash.

Source: `daemon/internal/sessions/sessions.go`, `daemon/internal/http/router.go`, `proto/proto.md` (§Capability negotiation, §Identity rule).

## Persistent Identities

Every pane kind with persistence uses exactly one identity field. They are mutually exclusive:

| Kind | Identity field | Type | Stable across restarts |
|------|---------------|------|----------------------|
| `claude` | `SessionID` | RFC 4122 v4 UUID | Yes |
| `shell` | `SlotID` | RFC 4122 v4 UUID | Yes |
| `codex` | `SlotID` | RFC 4122 v4 UUID | Yes |

This is the **Identity Rule** from the protocol spec. Codex reuses the shell `SlotID` mechanism (it has no Claude session to resume; slot continuity is what carries a codex pane across a restart). `DismissSessionsRequest.session_ids` (misnamed for historical reasons) accepts Claude SessionIDs or shell/codex SlotIDs interchangeably — the daemon matches on whichever identity the entry carries.

## Session Index Storage

Sessions are stored on disk at:

```
~/.config/reck/sessions/<project_id>.json
```

Format: a JSON object `{ "entries": [...] }`. Each entry is an `Entry` struct:

```go
type Entry struct {
    SessionID    string          // claude: the --resume UUID
    SlotID       string          // shell: the slot UUID
    Kind         proto.PaneKind  // "claude" | "shell"; defaults to "claude" for pre-Scope-B rows
    Name         string          // human label (claude only; "project/short-uuid")
    Cwd          string          // cwd at spawn time
    CreatedAt    time.Time
    LastActiveAt time.Time
    LastPaneID   string          // pane ID that last hosted this session
    WasLive      bool            // true = was running at last observation
    DisplayName  string          // user-given override; persisted here
    ShellArgv    []string        // shell only: exact argv to re-exec on restore
}
```

The store is append-mostly: entries are never deleted (only `WasLive` is cleared on graceful close). `List()` filters Claude entries whose JSONL transcript no longer exists on disk — Claude Code TTLs its own transcripts at ~30 days, so missing-JSONL entries are invisible but not removed.

Shell entries pass through `List()` unconditionally because they have no external transcript to check.

## Session Lifecycle

### Claude pane

1. Daemon generates UUID at spawn time: `sessions.NewUUID()`.
2. Calls `claude --session-id <uuid> --name <project>/<short-uuid> ...`.
3. Upserts entry into store with `WasLive=true`.
4. On exit: `Touch` updates `LastActiveAt`.
5. On graceful `DeletePane`: `SetLive(false)` clears `WasLive`. No restore prompt next reconnect.
6. On daemon crash / unexpected exit: `WasLive` stays `true`. Restore candidates include this entry.

### Shell pane

1. Daemon generates a `SlotID` UUID at first create.
2. Stores `ShellArgv` (the resolved absolute argv) and `Cwd` (project's cwd at that moment) in the entry.
3. `WasLive=true` on spawn; cleared on graceful `DeletePane`.
4. On restore: daemon looks up entry by `SlotID` and replays `ShellArgv` + stored `Cwd` verbatim.

**Restore replays frozen argv and cwd** — project configuration that drifts after create (changed `shell` field, moved `cwd`) does NOT affect what a restore spawns. See [`concepts/panes.md`](./panes.md#shell-restore-replays-frozen-argv-and-cwd) for the authoritative explanation.

## Liveness Ticker

The daemon runs a background ticker (every 15 seconds) that calls `Touch` on every live pane with a persistent identity. This bounds the staleness of `LastActiveAt` so the restore prompt can show "running 20 seconds ago" rather than a stale timestamp from hours before the crash.

## `/restore-candidates` Endpoint

`GET /restore-candidates` returns sessions/slots the daemon believed were running (WasLive=true) but whose `LastPaneID` is no longer among the project's live panes — meaning the daemon (or host) restarted since.

### Capability Negotiation

Old Satellite builds assumed every restore candidate is a Claude row and would crash on a shell row (where `session_id` is absent). To protect deployment-skew compatibility, the endpoint defaults to Claude-only and requires an explicit opt-in for shell:

```
GET /restore-candidates                      # Claude-only (legacy default)
GET /restore-candidates?kinds=claude         # Claude-only (explicit)
GET /restore-candidates?kinds=claude,shell   # both kinds
GET /restore-candidates?kinds=shell          # shell-only
```

Unknown tokens in `kinds` are silently ignored. An explicit list containing only unknown tokens falls back to Claude-only rather than returning nothing.

If a `RestoreSlotID` names a slot that is already attached to a running pane, the daemon returns **409 Conflict** — the slot is no longer in the candidates list after a re-poll.

### `GET /projects/:id/sessions` — Claude-Resume Picker Only

This endpoint is semantically Claude-only despite its generic name. It filters out shell rows server-side unconditionally. Shell restore lives exclusively on `/restore-candidates`. The filtering prevents pre-Scope-B Satellite builds from crashing on a shell row.

## When Sessions Are Cleared

Sessions are NOT automatically deleted. They accumulate until:
1. `WasLive` is cleared on a graceful `DeletePane` (the entry stays in the file).
2. Claude Code deletes its own JSONL transcript (~30 days TTL). `List()` will then hide the entry (JSONL check fails) but not remove it from disk.
3. Manual deletion of `~/.config/reck/sessions/<project>.json`.

There is no max-age or size cap on the sessions file.

## Claude Resume Semantics

A Claude pane can be resumed via `POST /projects/:id/panes` with:

```json
{ "kind": "claude", "resume_session_id": "<uuid>" }
```

The daemon validates that:
1. The UUID exists in the sessions index for this project.
2. The entry's `Kind` is `claude` (not shell).
3. The entry's JSONL transcript exists on disk (validated inside `handleListSessions`; the validate-before-spawn path checks the index only).

On success, it spawns `claude --resume <uuid>` in the project's current `cwd`. Note: the cwd used for a resume is always the **current** project cwd, not the cwd at original spawn — Claude transcripts survive cwd moves.

## `DismissSessionsRequest` — Skip Without Restoring

`POST /projects/:id/sessions/dismiss` clears `WasLive` on a batch of session IDs/slot IDs. Used by the Satellite's "Skip" button on the restore prompt so subsequent reconnects do not re-offer the same sessions.
