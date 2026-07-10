# Wire Protocol — Reck Connect V2 Step 1

This document is the contract between `reck-stationd` (station daemon) and the Satellite (Electron app). Go and TypeScript definitions are hand-maintained in parallel at `proto.go` and `proto.ts`. They MUST match this doc field-for-field.

## Enum types

- `Stoplight`: `"gray" | "green" | "orange" | "red"`
- `PaneKind`: `"claude" | "shell" | "codex"`
- `PaneState`: `"running" | "exited"`
- `AgentState`: `"" | "working" | "idle" | "attention"` — hook-driven agent lifecycle state

## WebSocket messages

Endpoint: `ws://<station-host>:7315/ws/<project_id>/<pane_id>`

Auth (when `DAEMON_TOKEN` is set): the bearer is carried as a `Sec-WebSocket-Protocol` subprotocol of the form `reck-bearer.<token>`. Browsers can't set Authorization headers on WS upgrades, so this is the only standard hook available; the server echoes the offered subprotocol back in the 101 response. The previous `?token=<...>` query-string fallback is removed (query strings leak into access logs, devtools, referrers). Native clients (curl, Go) can still use `Authorization: Bearer <...>`.

`data` fields are base64-encoded raw bytes from the PTY (not UTF-8 strings).

### Client → Server

| Type | Fields |
|---|---|
| `input` | `data: string` |
| `resize` | `cols: number`, `rows: number` |

### Server → Client

| Type | Fields |
|---|---|
| `hello` | `replay: string`, `cols: number`, `rows: number`, `stoplight: Stoplight` |
| `output` | `data: string` |
| `status` | `stoplight: Stoplight` |
| `exit` | `code: number` |
| `error` | `msg: string` |

`hello` is sent once on WS upgrade with the last N KB of PTY buffer replay (N = 64 KB, configurable later).

## HTTP endpoints

Base: `http://<station-host>:7315`

Optional auth: `Authorization: Bearer <DAEMON_TOKEN>` — enforced if `DAEMON_TOKEN` is set in daemon env.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `HealthResponse` |
| GET | `/projects` | — | `ProjectsListResponse` |
| GET | `/projects/:id` | — | `ProjectDetail` |
| POST | `/projects/:id/panes` | `CreatePaneRequest` | `CreatePaneResponse` |
| DELETE | `/projects/:id/panes/:pane_id` | — | `DeletePaneResponse` |
| POST | `/projects/:id/panes/:pane_id/rename` | `RenameRequest` | `RenameRequest` |
| POST | `/projects/:id/rename` | `RenameRequest` | `RenameRequest` |
| POST | `/projects` | `AddProjectRequest` | `AddProjectResponse` |
| PUT | `/projects` | `PutProjectsRequest` (or bare `PutProjectsEntry[]`) | `PutProjectsResponse` (hybrid mode phase 8 — `--mode=local` only; 409 on station) |
| DELETE | `/projects/:id` | — | `DeletePaneResponse` (reused — `{ok: true}`) |
| GET | `/projects/:id/sessions` | — | `SessionsListResponse` (Claude-only; shell rows are filtered out server-side to keep the legacy resume-picker contract stable — see "Capability negotiation" below) |
| POST | `/projects/:id/sessions/dismiss` | `DismissSessionsRequest` | `DismissSessionsResponse` |
| GET | `/restore-candidates[?kinds=claude,shell]` | — | `RestoreCandidatesResponse` |
| POST | `/panes/:pane_id/input` | `{text, submit?}` | `{ok, bytes}` |
| GET | `/panes/:pane_id/output?bytes=N` | — | `{pane_id, agent_state, bytes, text}` |
| POST | `/panes/:pane_id/uploads` | `multipart/form-data` with `file` field | `PaneUploadResponse` |
| GET | `/panes/:pane_id/uploads` | — | `PaneUploadsListResponse` |
| POST | `/panes/:pane_id/clipboard-image` | raw image bytes; `Content-Type: image/png\|jpeg\|webp\|gif` | `{ok}` (200), 415 (unsupported MIME), 413 (too large), or 500 (NSPasteboard write failed). A later release retired the sidecar; the previous 503 fallback is gone — non-200 means renderer should fall back to the `/uploads` path. |

### Response shapes

```ts
// uptime_sec is int64 on the Go wire but JS decodes it as float64.
// Safe range is Number.MAX_SAFE_INTEGER ≈ 9e15 (~285 million years
// in seconds), well beyond any realistic daemon uptime — the doc
// makes this explicit so nobody switches the unit to nanoseconds
// without reopening the drift discussion.
interface HealthResponse { status: string; version: string; uptime_sec: number }
interface Project { id: string; name: string; cwd: string; stoplight: Stoplight; pane_count: number; pane_stoplights?: Stoplight[]; pane_ids?: string[]; archived?: boolean; display_name?: string; available?: boolean }
// pane_stoplights — per-pane effective stoplight list, ordered by pane
// creation (same order as ProjectDetail.panes). Older daemons omit the
// field; clients fall back to broadcasting `stoplight` across
// `pane_count` dots.
// pane_ids — pane IDs aligned one-for-one with pane_stoplights (same
// creation order). Lets the renderer reorder the rail dots by layout
// position. Older daemons omit the field; clients render in
// pane_stoplights order.
interface Pane {
  id: string;
  kind: PaneKind;
  state: PaneState;
  stoplight: Stoplight;
  pid?: number;
  exit_code?: number;
  session_id?: string;   // Claude-only stable identity
  session_name?: string;
  display_name?: string; // user-set override
  auto_name?: string;    // Claude-only daemon-derived fallback — latest custom-title from the session's JSONL transcript; empty when display_name is set or no title exists yet
  slot_id?: string;      // Shell-only stable identity (Scope B)
  capabilities?: PaneCapabilities; // newer daemons always emit; older daemons omit (treat undefined as all-caps-off)
}
// Per-pane optional feature flags. `clipboard_image`: true only when
// the pane is Claude AND the daemon is darwin (the only platform with
// the in-process NSPasteboard write path). Shell panes always report
// false because writing 0x16 (Ctrl+V) to a shell would do something
// surprising.
//
// Wire shape unchanged from the original capability rollout; a later
// release retired the per-user reck-clipboard sidecar that previously
// gated the capability.
interface PaneCapabilities {
  clipboard_image: boolean;
}
interface ProjectDetail { id: string; name: string; cwd: string; panes: Pane[]; display_name?: string }
interface ProjectsListResponse { projects: Project[] }
interface CreatePaneRequest {
  kind: PaneKind;
  resume_session_id?: string;  // claude-only: spawn `claude --resume <uuid>`
  restore_slot_id?: string;    // shell-only (Scope B): respawn under a stored SlotID with captured argv
  extra_args?: string[];       // optional; appended to Claude pane argv, ignored for shell panes
  global_preamble?: string;    // claude-only: satellite "Reck Connect prompt", middle preamble layer (baseline + global + project)
}
interface CreatePaneResponse { pane_id: string }
interface DeletePaneResponse { ok: boolean }
interface AddProjectRequest {
  id?: string;              // optional; derived from name if omitted
  name: string;
  cwd?: string;             // optional; when omitted, daemon creates /Users/reck-connect/projects/<slug(name)>
  default_pane?: PaneKind;  // "claude" | "shell" | "codex"; defaults "claude"
  shell?: string[];                    // defaults user $SHELL
  preamble?: string;                   // optional; injected as --append-system-prompt on claude panes
}
interface AddProjectResponse { project: Project }
interface RenameRequest { display_name: string }

// --- Hybrid mode phase 8 + 9: local-daemon project-list push ---
// Only valid against a `--mode=local` daemon; station returns 409.
// Validation at the daemon: absolute path + permitted-prefix + no-
// traversal + no-escaping-symlink. Missing cwd is registered with
// available=false instead of rejected. The handler also accepts the
// bare-array form `[{id, cwd}]` for ergonomics; both decode to the
// same in-memory list.
interface PutProjectsEntry { id: string; cwd: string }
interface PutProjectsRequest { projects: PutProjectsEntry[] }
interface PutProjectsResponse { ok: boolean; count: number }

// --- Session persistence (extended for Scope B) ---
interface SessionInfo {
  session_id?: string;    // Claude identity, empty on shell rows
  slot_id?: string;       // Shell identity (Scope B), empty on Claude rows
  kind?: PaneKind;        // pre-Scope-B omits; clients default to "claude"
  name: string;
  cwd: string;
  created_at: string;     // RFC3339
  last_active_at: string; // RFC3339
  last_pane_id?: string;
  was_live?: boolean;
}
interface SessionsListResponse { sessions: SessionInfo[] }
interface RestoreCandidateGroup { project_id: string; project_name: string; sessions: SessionInfo[] }
interface RestoreCandidatesResponse { candidates: RestoreCandidateGroup[] }
interface DismissSessionsRequest { session_ids: string[] }   // identity values: Claude SessionID or shell SlotID
interface DismissSessionsResponse { dismissed: number }

interface ArchiveProjectResponse { archived: boolean }

// --- Image-paste uploads ---
// POST /panes/:pane_id/uploads — multipart/form-data with one `file`
// part. Bearer-auth enforced; no loopback exemption. MIME allowlist:
// image/png, image/jpeg, image/webp, image/gif. Size cap 20 MiB. Live
// pane binding — 404 if pane id isn't currently running. Filenames are
// generated server-side ('<unix-ns>-<16-hex>.<ext>'); client-supplied
// names are discarded. Returned absolute path is bearer-authorised
// data — the renderer types it into the PTY verbatim (followed by a
// space, no newline).
interface PaneUploadResponse { path: string }

// GET /panes/:pane_id/uploads — lists images currently staged in the
// pane's tmpdir. Same auth as the POST. Empty
// list when the pane has never received a successful upload (200, not
// 404). Ordered newest-first by mod_time.
interface PaneUpload { path: string; size_bytes: number; mod_time: string }
interface PaneUploadsListResponse { uploads: PaneUpload[] }

// --- Image-paste clipboard ---
// POST /panes/:pane_id/clipboard-image — bytes are written directly to
// NSPasteboard via cgo + AppKit (internal/macclipboard). The daemon
// itself runs in the user's Aqua session as a LaunchAgent, so the
// previous reck-clipboard sidecar workaround is gone. After the pasteboard write, the daemon writes 0x16
// (Ctrl+V) into the pane PTY; Claude Code reads the pasteboard and
// creates an [Image #N] chip. Bearer-auth, no loopback exemption.
// MIME allowlist: image/png|jpeg|webp|gif. Size cap 20 MiB. Live-pane
// binding (404 unknown). NSPasteboard rejection / unsupported MIME →
// 500 (was 503 in the sidecar era). Renderer gates on
// `Pane.capabilities.clipboard_image`; the flag is true only for
// Claude panes when the daemon is on darwin.
```

## IDs

- `project_id`: URL-safe slug, user-authored in `projects.toml`.
- `pane_id`: daemon-generated, `p_<12 hex chars>` (e.g., `p_a1b2c3d4e5f6`). Regenerated on every spawn.
- `session_id` (Claude only): RFC 4122 v4 UUID. Stable across daemon restarts — the Satellite uses it to rekey saved layouts and to resume transcripts via `claude --resume`.
- `slot_id` (shell only, Scope B): RFC 4122 v4 UUID. Same role as `session_id` for shell panes. Restore respawns under the recorded `slot_id` with the argv the daemon captured at the original create.

## Identity rule

Every persistent pane has exactly one identity:

- Claude panes → `session_id`. `slot_id` is always empty.
- Shell panes  → `slot_id`.    `session_id` is always empty.

This extends to the restore / rename / dismiss endpoints. `DismissSessionsRequest.session_ids` is misnamed for historical reasons — it accepts Claude SessionIDs or shell SlotIDs interchangeably and the daemon matches on whichever identity the entry carries.

## Capability negotiation (Scope B)

`GET /restore-candidates` defaults to Claude-only output. A
post-Scope-B client that handles shell restore opts in via the
`kinds` query param:

```
GET /restore-candidates                     → Claude-only (legacy / default)
GET /restore-candidates?kinds=claude        → Claude-only (explicit)
GET /restore-candidates?kinds=claude,shell  → both
GET /restore-candidates?kinds=shell         → shell-only
```

Unknown tokens are silently ignored server-side, so a future
`?kinds=codex,...` sent to an older daemon degrades to "known kinds in
the list". An explicit list containing only unknown tokens falls back
to Claude-only rather than returning nothing — the client clearly
wants *some* restore surface.

Rationale: pre-Scope-B Satellite builds render a restore row as
`s.session_id.slice(0, 8)` and crash on a shell row (where
`session_id` is absent). The opt-in keeps legacy clients safe while
letting new clients consume the widened surface from a single
endpoint. For the same reason, `GET /projects/:id/sessions` — the
Claude-resume picker — filters shell rows out server-side
unconditionally. Shell restore lives exclusively on
`/restore-candidates` with the opt-in.

The daemon spawns a duplicate live pane would be a bug: on
`POST /projects/:id/panes` with a `restore_slot_id` that names a slot
already attached to a running pane, the daemon returns **409
Conflict**. Clients hitting this can re-poll `/restore-candidates`
and the slot will no longer be offered.

## ID derivation on Add

When `AddProjectRequest.id` is empty, the daemon derives the id from `name`:

1. Lowercase.
2. Replace any non-`[a-z0-9]` run with `-`.
3. Trim leading/trailing `-`.
4. If the result is empty or collides with an existing project id, append `-2`, `-3`, … until unique.

## Cwd fallback on Add

When `AddProjectRequest.cwd` is empty, the daemon creates the project
directory at `/Users/reck-connect/projects/<slug>` (same slug rules as
above, applied to `name`) and uses that as the project's `cwd`. When
`cwd` is provided, the daemon registers the existing directory without
creating or modifying it.

## Project availability (hybrid mode rev 3.1, phase 7)

`Project.available` reports whether the project's `cwd` was reachable on
the daemon host the last time `config.Load` ran:

- `true` — `cwd` exists and is a directory; project is fully usable.
- `false` — the entry exists in `projects.toml` but the directory is
  missing (e.g. the user moved or deleted the folder, or, for hybrid
  mode local panes, the sshfs mount is gone). The daemon used to drop
  these entries silently; rev 3.1 surfaces them so the rail can render a
  "stale" indicator instead of losing the project from the user's view.

Wire compatibility: phase-7+ daemons always emit `available` as a real
boolean. Pre-phase-7 daemons omit the field; clients should treat
`undefined` as `available = true` (the pre-phase-7 invariant — any
project the daemon reported was, by definition, present on disk).

## Stoplight semantics (per pane)

Derived from PTY output activity:

- `gray` — just spawned, no output yet
- `orange` — output bytes observed within last 5s (N)
- `green` — quiet ≥ 30s (M), no red signal
- `red` — best-effort; trailing `?`/`>`/`:` + stable for > 2s. May be unimplemented in step 1 if unreliable.

Project-level stoplight (in `/projects` rows): max severity across panes, ordering `red > orange > green > gray`. Zero panes → `gray`.
