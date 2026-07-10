// Wire protocol types. Keep in sync with proto.go and proto.md.

export type Stoplight = "gray" | "green" | "orange" | "red";
export type PaneKind = "claude" | "shell" | "codex";
export type PaneState = "running" | "exited";
export type AgentState = "" | "working" | "idle" | "attention";

// Higher = more severe. For project-level aggregation (red > orange > green > gray).
export function stoplightSeverity(s: Stoplight): number {
  switch (s) {
    case "red":
      return 3;
    case "orange":
      return 2;
    case "green":
      return 1;
    default:
      return 0;
  }
}

// --- WebSocket: Client → Server ---

export interface InputMessage {
  type: "input";
  data: string; // base64
}

export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export type ClientMessage = InputMessage | ResizeMessage;

// --- WebSocket: Server → Client ---

export interface HelloMessage {
  type: "hello";
  replay: string; // base64 (may be "")
  cols: number;
  rows: number;
  stoplight: Stoplight;
}

export interface OutputMessage {
  type: "output";
  data: string; // base64
}

export interface StatusMessage {
  type: "status";
  stoplight: Stoplight;
}

export interface ExitMessage {
  type: "exit";
  code: number;
}

export interface ErrorMessage {
  type: "error";
  msg: string;
}

export type ServerMessage =
  | HelloMessage
  | OutputMessage
  | StatusMessage
  | ExitMessage
  | ErrorMessage;

// --- HTTP response bodies ---

export interface HealthResponse {
  status: string;
  version: string;
  uptime_sec: number;
  /** True when the station resolved a codex binary at startup; gates the
   *  "Codex" new-pane button. Absent on older daemons ⇒ treat as false. */
  codex_available?: boolean;
}

export interface Project {
  id: string;
  name: string;
  cwd: string;
  stoplight: Stoplight;
  pane_count: number;
  /**
   * Per-pane effective stoplights, ordered by pane creation (same order
   * as ProjectDetail.panes). an earlier release: lets the rail indicator dots
   * show each pane's state instead of all sharing the project aggregate.
   *
   * Optional on the wire so a renderer talking to a Older daemon
   * (which omits the field entirely) treats `undefined` as "fall back to
   * broadcasting `stoplight` across `pane_count` dots" — the Older
   * behaviour.
   */
  pane_stoplights?: Stoplight[];
  /**
   * Pane IDs aligned one-for-one with `pane_stoplights` (same creation
   * order). an earlier release — lets the renderer reorder the rail dots by
   * layout position instead of creation order, which it can only do if
   * it knows which paneId each stoplight slot corresponds to.
   *
   * Optional on the wire so a renderer talking to a Older daemon
   * (which omits the field entirely) treats `undefined` as "no reorder
   * info available — render in `pane_stoplights` order". phase-post-rollout
   * daemons always emit the field (as `[]` for zero-pane projects).
   */
  pane_ids?: string[];
  /**
   * True when the project is archived (asleep): its panes are killed to free
   * RAM, its saved layout is frozen, and it renders in the rail's Archive
   * section until restored. Optional on the wire — a daemon predating this
   * feature omits the field entirely; the renderer treats `undefined` as
   * "not archived" (same wire-compat convention as `available`).
   */
  archived?: boolean;
  /**
   * User-given override. Empty/absent means no override — render `name`.
   * Persisted in projects.toml; shared across every client.
   */
  display_name?: string;
  /**
   * True when the project's cwd was reachable on the daemon host at the
   * most recent config.Load (hybrid mode rev 3.1, phase 7). False means
   * the project entry exists in projects.toml but the directory is
   * missing — the rail can render a "stale" indicator instead of
   * silently dropping the row.
   *
   * Optional on the wire so a renderer talking to a pre-phase-7 daemon
   * (which omits the field entirely) treats `undefined` as
   * available=true — that matches the pre-phase-7 behaviour where any
   * project the daemon reported was, by definition, present on disk.
   * Phase-7+ daemons always emit the field as a real boolean.
   */
  available?: boolean;
}

/**
 * Optional per-pane features the daemon is willing to serve. Renderers
 * branch on these to pick between equivalent code paths (e.g.
 * clipboard-image vs uploads).
 *
 * `clipboard_image`: true only when the pane is a Claude pane AND the
 * daemon is on darwin (the only platform with the in-process
 * NSPasteboard write path). Shell panes always report false because
 * writing 0x16 (Ctrl+V) into a shell would do something surprising.
 *
 * Wire shape unchanged from the phase 2 introduction; issue
 * An earlier release: phase 2 retired the per-user reck-clipboard sidecar that
 * previously gated this capability.
 */
export interface PaneCapabilities {
  clipboard_image: boolean;
}

export interface Pane {
  id: string;
  kind: PaneKind;
  state: PaneState;
  stoplight: Stoplight;
  pid?: number;
  exit_code?: number;
  /** Claude-only: the UUID passed as --session-id (or --resume). */
  session_id?: string;
  session_name?: string;
  /**
   * Optional per-pane capability flags. Phase-2-of-issue-96+ daemons
   * always emit this object; older daemons omit it. Treat
   * `capabilities === undefined` as "all caps off" (the Older-phase-2
   * behaviour where every paste went through /uploads).
   */
  capabilities?: PaneCapabilities;
  /**
   * User-given override. Empty/absent means no override — render the
   * kind-based default ("Claude" / "Shell"). Persisted keyed by the
   * pane's identity: session_id for Claude, slot_id for shell.
   */
  display_name?: string;
  /**
   * Daemon-derived fallback label for Claude panes without a user-set
   * `display_name` . Populated from the latest `custom-title`
   * record in the session's JSONL transcript under
   * `~/.claude/projects/`. Empty when `display_name` is set (daemon
   * skips the read — `display_name` wins), when the JSONL has no title
   * yet, or for shell panes.
   *
   * Client precedence chain:
   *   display_name → auto_name → kind-based default ("Claude" / "Shell")
   *
   * Additive on the wire: old clients simply ignore it and keep the
   * Older behaviour of showing the kind default.
   */
  auto_name?: string;
  /**
   * Shell-only: stable identifier for this shell pane (Scope B).
   * Regenerated on initial spawn, preserved on restore. Empty for Claude
   * panes (they use session_id instead).
   */
  slot_id?: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  cwd: string;
  panes: Pane[];
  display_name?: string;
}

/**
 * Body for POST /projects/:id/rename and
 * POST /projects/:id/panes/:pane_id/rename. An empty `display_name`
 * clears the override (restore canonical name / kind-based default).
 */
export interface RenameRequest {
  display_name: string;
}

export interface ProjectsListResponse {
  projects: Project[];
}

export interface CreatePaneRequest {
  kind: PaneKind;
  /** Optional — when set with kind="claude", spawns `claude --resume <uuid>`. */
  resume_session_id?: string;
  /**
   * Optional — when set with kind="shell", respawns a shell pane under a
   * previously recorded slot id, reusing the argv and cwd captured at
   * the original create (Scope B).
   */
  restore_slot_id?: string;
  /**
   * Optional. When non-empty, appended to the argv of a Claude pane at
   * spawn time. Pre-split client-side (no shell quoting). Silently
   * ignored for shell panes. Subject to a narrow daemon-side allowlist.
   */
  extra_args?: string[];
  /**
   * Optional. Satellite-stored "Reck Connect prompt" — app-wide text the
   * user configures in Satellite Settings, sent on every CreatePane
   * request and composed as a middle layer between the daemon-emitted
   * baseline and the per-project preamble (joined by the same separator).
   * Silently ignored for non-Claude panes. Subject to the same 16 KiB
   * combined cap as the other preamble layers.
   */
  global_preamble?: string;
}

export interface CreatePaneResponse {
  pane_id: string;
}

export interface DeletePaneResponse {
  ok: boolean;
}

// --- Project CRUD (Track C1 pairs with Track C2) ---

export interface AddProjectRequest {
  /** Optional — daemon derives from name (slugified, collision-resolved) if empty. */
  id?: string;
  name: string;
  /** Optional — when omitted, daemon creates /Users/reck-connect/projects/<slug(name)>. */
  cwd?: string;
  default_pane?: PaneKind;  // defaults to "claude"
  shell?: string[];         // defaults to user's $SHELL on station
  preamble?: string;        // optional; --append-system-prompt for claude panes
}

export interface AddProjectResponse {
  project: Project;
}

/**
 * One entry in the wholesale project-list push from the Satellite to a
 * local-mode daemon (hybrid mode rev 3.1, phase 8 + 9). Only `id` + `cwd`
 * on the wire — the display name lives on the station side; the local
 * daemon just needs enough to spawn Claude panes against a mounted
 * folder.
 */
export interface PutProjectsEntry {
  id: string;
  cwd: string;
}

/**
 * Body of PUT /projects. The daemon's handler also accepts the bare
 * array `[{id, cwd}]`; both shapes decode to the same list. Wholesale
 * replace, not incremental — missing entries from a previous push are
 * dropped.
 */
export interface PutProjectsRequest {
  projects: PutProjectsEntry[];
}

/**
 * Returned on a successful PUT /projects. `count` echoes the number of
 * entries the daemon now tracks so the Satellite can sanity-check the
 * round-trip before issuing pane-create calls against any of those IDs.
 */
export interface PutProjectsResponse {
  ok: boolean;
  count: number;
}

// --- Session persistence  ---

export interface SessionInfo {
  /** Claude-only identifier. Empty for shell entries (they carry slot_id). */
  session_id?: string;
  name: string;
  cwd: string;
  created_at: string; // RFC3339
  last_active_at: string; // RFC3339
  last_pane_id?: string;
  /** True when the daemon believes this session is still running. Graceful close clears it; a crash leaves it set. */
  was_live?: boolean;
  /**
   * Pane kind — "claude" | "shell" | "codex". Pre-Scope-B wire shape
   * omitted this field entirely; receivers should treat missing kind as
   * "claude" to stay compatible with old daemons.
   */
  kind?: PaneKind;
  /** Shell-only identifier (Scope B). Empty for Claude entries. */
  slot_id?: string;
}

export interface SessionsListResponse {
  sessions: SessionInfo[];
}

/**
 * One project's "was live when the daemon last observed, but isn't now"
 * sessions — computed server-side so the Satellite can render a single
 * restore prompt without fanning out per project.
 */
export interface RestoreCandidateGroup {
  project_id: string;
  project_name: string;
  sessions: SessionInfo[];
}

export interface RestoreCandidatesResponse {
  candidates: RestoreCandidateGroup[];
}

export interface DismissSessionsRequest {
  session_ids: string[];
}

export interface DismissSessionsResponse {
  dismissed: number;
}

// --- Image-paste uploads (phase 1) ---

/**
 * Returned on a successful POST /panes/:pane_id/uploads. `path` is an
 * absolute filesystem path on the daemon host — the renderer types it
 * into the PTY verbatim (followed by a space, no newline) so the user
 * can decide when to submit. The daemon generates the filename
 * server-side; client-supplied names are discarded.
 */
export interface PaneUploadResponse {
  path: string;
}

/**
 * One previously-posted image in a pane's upload tmpdir. Returned by
 * `GET /panes/:pane_id/uploads`. `path` matches what the POST returned;
 * `size_bytes` and `mod_time` are derived from stat at list time.
 * `mod_time` is RFC3339.
 */
export interface PaneUpload {
  path: string;
  size_bytes: number;
  mod_time: string;
}

/**
 * Response body for `GET /panes/:pane_id/uploads`. Sorted newest-first
 * by `mod_time`. Empty list when the pane has never received a
 * successful upload.
 */
export interface PaneUploadsListResponse {
  uploads: PaneUpload[];
}

export interface ArchiveProjectResponse {
  archived: boolean;
}
