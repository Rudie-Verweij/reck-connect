// Package proto defines the wire protocol between reck-stationd and Satellite.
// Keep in sync with proto.ts and proto.md.
package proto

type Stoplight string

const (
	StoplightGray   Stoplight = "gray"
	StoplightGreen  Stoplight = "green"
	StoplightOrange Stoplight = "orange"
	StoplightRed    Stoplight = "red"
)

// StoplightSeverity provides a numeric ordering for project-level aggregation.
// Higher number = higher severity.
func StoplightSeverity(s Stoplight) int {
	switch s {
	case StoplightRed:
		return 3
	case StoplightOrange:
		return 2
	case StoplightGreen:
		return 1
	default:
		return 0
	}
}

type PaneKind string

const (
	PaneKindClaude PaneKind = "claude"
	PaneKindShell  PaneKind = "shell"
	PaneKindCodex  PaneKind = "codex"
)

type PaneState string

const (
	PaneStateRunning PaneState = "running"
	PaneStateExited  PaneState = "exited"
)

// AgentState is the canonical state of an AI-agent pane (e.g. Claude Code,
// Codex, Gemini CLI), driven by lifecycle hook events forwarded to the
// daemon. "unknown" is the default before any event has arrived.
type AgentState string

const (
	AgentStateUnknown   AgentState = ""
	AgentStateWorking   AgentState = "working"
	AgentStateIdle      AgentState = "idle"
	AgentStateAttention AgentState = "attention"
)

// --- WebSocket: Client → Server ---

type InputMessage struct {
	Type string `json:"type"` // "input"
	Data string `json:"data"` // base64
}

type ResizeMessage struct {
	Type string `json:"type"` // "resize"
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// --- WebSocket: Server → Client ---

type HelloMessage struct {
	Type      string    `json:"type"`   // "hello"
	Replay    string    `json:"replay"` // base64 (may be "")
	Cols      int       `json:"cols"`
	Rows      int       `json:"rows"`
	Stoplight Stoplight `json:"stoplight"`
}

type OutputMessage struct {
	Type string `json:"type"` // "output"
	Data string `json:"data"` // base64
}

type StatusMessage struct {
	Type      string    `json:"type"` // "status"
	Stoplight Stoplight `json:"stoplight"`
}

type ExitMessage struct {
	Type string `json:"type"` // "exit"
	Code int    `json:"code"`
}

type ErrorMessage struct {
	Type string `json:"type"` // "error"
	Msg  string `json:"msg"`
}

// --- HTTP response bodies ---

// HealthResponse is returned by GET /health.
//
// UptimeSec is int64 on the wire for consistency with time.Duration
// derivations on the daemon side, but TypeScript clients decode JSON
// numbers into float64 with precision limited to Number.MAX_SAFE_INTEGER
// (2^53 - 1 ≈ 9e15). Since uptime is in seconds that gives ~285 million
// years of safe range — no real daemon will ever approach it, but the
// proto doc is explicit about the bound so nobody changes this field to
// nanoseconds without reconsidering the drift.
type HealthResponse struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	UptimeSec int64  `json:"uptime_sec"`
	// CodexAvailable is true when the station resolved a codex binary on
	// PATH at startup (len(codexCmd) > 0). The Satellite reads it to show
	// the "Codex" new-pane button only where a codex pane can actually
	// spawn. Omitted/false ⇒ hide it (older daemons that don't send the
	// field decode to false, which is the safe default).
	CodexAvailable bool `json:"codex_available"`
}

type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Cwd       string    `json:"cwd"`
	Stoplight Stoplight `json:"stoplight"`
	PaneCount int       `json:"pane_count"`
	// PaneStoplights is the per-pane effective stoplight list, ordered by
	// pane creation (same order as ProjectDetail.Panes). an earlier release: the
	// rail's indicator dots previously all shared the project aggregate
	// stoplight, so one busy pane flipped every dot on the row — the
	// count was useful, the color wasn't. With per-pane colors, the rail
	// glance can show "one working, one idle" without opening the project.
	//
	// Always emitted by phase-post-rollout daemons (no omitempty). TS clients
	// treat the field as optional and fall back to broadcasting the
	// project aggregate across PaneCount dots when talking to an older
	// daemon that omits it.
	PaneStoplights []Stoplight `json:"pane_stoplights"`
	// PaneIDs lines up with PaneStoplights one-for-one (same iteration
	// order on byProj[id], i.e. pane creation order). an earlier release — the
	// rail dots are ordered by layout position rather than creation
	// order, which the renderer can only do if it knows which paneId
	// each stoplight slot corresponds to. Without this field the
	// renderer falls back to creation order and dot positions can stop
	// matching the panes they describe.
	//
	// Always emitted by phase-post-rollout daemons (no omitempty so the
	// JSON encoder produces `[]` rather than `null` for zero-pane
	// projects, matching the PaneStoplights convention). Older
	// daemons omit the field entirely; the TS client treats `undefined`
	// as "no reorder info" and renders in PaneStoplights order.
	PaneIDs []string `json:"pane_ids"`
	// Archived is true when the user put the project to sleep: its panes
	// are killed to free RAM while its session rows keep was_live=true, so
	// the project can be restored on demand. Persisted in projects.toml.
	// Always emitted (no omitempty) so TS clients can rely on it.
	Archived bool `json:"archived"`
	// DisplayName is the user-given override. Empty means no override —
	// clients fall back to Name. Persisted in projects.toml so it survives
	// daemon restart and is shared across every client (desktop, Mini).
	DisplayName string `json:"display_name,omitempty"`
	// Available reports whether the project's cwd was reachable on the
	// daemon host at the most recent config.Load (hybrid mode rev 3.1,
	// phase 7). False means the project entry exists in projects.toml but
	// the directory is missing — the rail still renders the project so
	// the user can see it's stale instead of silently losing it.
	//
	// Always emitted by phase-7+ daemons (no omitempty). TS clients
	// declare it optional and treat `undefined` (older daemons) as
	// available=true — that matches the pre-phase-7 behaviour where any
	// project the daemon reported was, by definition, present on disk.
	Available bool `json:"available"`
}

// PaneCapabilities describes optional per-pane features the daemon is
// willing to serve. Renderers branch on these flags to pick between
// equivalent code paths (e.g. clipboard-image vs uploads); a missing
// capability means the field is undefined in JSON, which TS clients
// must treat as "not supported by this daemon".
//
// phase 2: ClipboardImage is true only when the pane is
// a Claude pane AND the daemon is darwin (the only platform with
// the macclipboard NSPasteboard write path). Shell panes always
// report false because writing 0x16 (Ctrl+V / SYN) into an
// interactive shell does something unrelated and surprising.
//
// Wire shape unchanged from the phase 2 introduction —
// older satellites that key off the boolean continue to work; the
// underlying meaning shifted from "sidecar reachable" to "darwin
// daemon" but the value is the same in practice on every supported
// deployment.
type PaneCapabilities struct {
	ClipboardImage bool `json:"clipboard_image"`
}

type Pane struct {
	ID        string    `json:"id"`
	Kind      PaneKind  `json:"kind"`
	State     PaneState `json:"state"`
	Stoplight Stoplight `json:"stoplight"`
	Pid       *int      `json:"pid,omitempty"`
	ExitCode  *int      `json:"exit_code,omitempty"`
	// Claude-only: the UUID we passed as --session-id (or --resume) at
	// spawn time. Empty for shell panes. Lets the Satellite surface the
	// session label on a running pane and power "resume elsewhere" flows.
	SessionID   string `json:"session_id,omitempty"`
	SessionName string `json:"session_name,omitempty"`
	// Capabilities is the set of optional features this pane supports.
	// Always emitted by phase-2-issue-96+ daemons; older daemons omit
	// it (TS clients treat undefined as "all caps off"). an earlier release
	// phase 2.
	Capabilities PaneCapabilities `json:"capabilities"`
	// DisplayName is the user-given override. Empty means no override —
	// clients fall back to a kind-based default ("Claude" / "Shell").
	// Persisted in the sessions store keyed by the pane's identity
	// (SessionID for Claude, SlotID for shell), so the label survives
	// pane respawn and kickstart.
	DisplayName string `json:"display_name,omitempty"`
	// AutoName is the daemon-derived label for Claude panes without a
	// user-set DisplayName . Populated from the latest
	// {"type":"custom-title","customTitle":"…"} record in the session's
	// own JSONL transcript under ~/.claude/projects/. Empty when the
	// user has set DisplayName (daemon skips the read — DisplayName wins),
	// when the JSONL has no title yet, or for shell panes.
	//
	// Client precedence chain for pane labels:
	//   DisplayName → AutoName → kind-based default ("Claude" / "Shell")
	//
	// Additive on the wire: old clients simply ignore it and keep the
	// Older behaviour of showing the kind default when no DisplayName
	// is set.
	AutoName string `json:"auto_name,omitempty"`
	// SlotID is the stable identifier for shell panes (Scope B).
	// Empty for Claude panes — they use SessionID instead. Same semantics
	// as SessionID in the Satellite's restore/rekey paths: regenerated
	// once on create, preserved across daemon restarts, used as the
	// resume key.
	SlotID string `json:"slot_id,omitempty"`
}

type ProjectDetail struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Cwd         string `json:"cwd"`
	Panes       []Pane `json:"panes"`
	DisplayName string `json:"display_name,omitempty"`
}

// RenameRequest is the body for POST /projects/:id/rename and
// POST /projects/:id/panes/:pane_id/rename. An empty DisplayName clears
// the override (restore the canonical name / kind-based default).
type RenameRequest struct {
	DisplayName string `json:"display_name"`
}

type ProjectsListResponse struct {
	Projects []Project `json:"projects"`
}

type CreatePaneRequest struct {
	Kind PaneKind `json:"kind"`
	// Optional. When non-empty and Kind is "claude", the daemon spawns
	// `claude --resume <uuid>` instead of a fresh session. The UUID must
	// match an entry in the project's session index; otherwise the
	// request is rejected. Ignored for shell panes.
	ResumeSessionID string `json:"resume_session_id,omitempty"`
	// RestoreSlotID, when non-empty and Kind is "shell" or "codex", asks
	// the daemon to respawn the pane under a previously recorded slot id,
	// reusing the argv and cwd captured at the original create. The slot
	// id must match an entry in the project's session index of the same
	// kind or the request is rejected. Ignored for Claude panes.
	RestoreSlotID string `json:"restore_slot_id,omitempty"`
	// ExtraArgs, if non-empty, is appended to the argv of a Claude pane
	// at spawn time. Pre-split client-side (no shell quoting). Silently
	// ignored for shell panes. Subject to the daemon's allowlist — see
	// pty.ValidateClaudeExtraArgs.
	ExtraArgs []string `json:"extra_args,omitempty"`
	// GlobalPreamble is the satellite-stored "Reck Connect prompt" —
	// app-wide text the user configures in Satellite Settings, sent on
	// every CreatePane request. The claude adapter composes it as a
	// middle layer between the daemon-emitted baseline and the per-
	// project preamble (joined by the same separator). Silently ignored
	// for non-Claude panes. Subject to the same 16 KiB combined cap as
	// the other preamble layers.
	GlobalPreamble string `json:"global_preamble,omitempty"`
}

type CreatePaneResponse struct {
	PaneID string `json:"pane_id"`
}

type DeletePaneResponse struct {
	Ok bool `json:"ok"`
}

// --- Project CRUD (Track C1 additions) ---

// AddProjectRequest is the body of POST /projects.
// Cwd is optional — when empty, the daemon slugifies Name and creates
// the project under the managed projects root (/Users/reck-connect/projects/<slug>).
type AddProjectRequest struct {
	// ID is optional — if empty, daemon derives it from Name (slugified, collision-resolved).
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	Cwd  string `json:"cwd,omitempty"`
	// DefaultPane is one of PaneKind ("claude" | "shell" | "codex").
	// Empty value defaults to "claude" at registration time. Stored on
	// disk as a string to keep the config.toml ergonomic, but it must
	// match a PaneKind value — config.Validate rejects anything else.
	DefaultPane PaneKind `json:"default_pane,omitempty"`
	Shell       []string `json:"shell,omitempty"`    // for shell panes; defaults to user's $SHELL
	Preamble    string   `json:"preamble,omitempty"` // optional; --append-system-prompt for claude panes
}

type AddProjectResponse struct {
	Project Project `json:"project"`
}

// PutProjectsEntry is one entry in the wholesale project-list push the
// Satellite sends to a local-mode daemon (hybrid mode rev 3.1, phase 8).
// Only ID + Cwd are wire fields — name + display label live on the
// station side; the local daemon only needs enough to spawn Claude panes
// against a mounted folder.
type PutProjectsEntry struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
}

// PutProjectsRequest is the body of PUT /projects. The bare-array form
// `[{id, cwd}]` is also accepted by the handler for ergonomics — both
// shapes decode to the same in-memory list. Wholesale replace, not
// incremental: missing entries from a previous push are dropped.
type PutProjectsRequest struct {
	Projects []PutProjectsEntry `json:"projects"`
}

// PutProjectsResponse is returned on a successful PUT /projects. Count
// echoes the number of entries the daemon now tracks, so the Satellite
// can sanity-check the round-trip before issuing pane-create calls.
type PutProjectsResponse struct {
	Ok    bool `json:"ok"`
	Count int  `json:"count"`
}

// --- Session persistence  ---

// SessionInfo is one row in the per-project session index, surfaced via
// GET /projects/:id/sessions and GET /restore-candidates. created_at /
// last_active_at are RFC3339. LastPaneID is the pane that most recently
// hosted this session, if any — purely informational, not a live link.
//
// WasLive is true when the index believes the pane was still running at
// the most recent observation. The daemon refreshes it periodically
// while a pane is alive; a graceful DeletePane clears it. A daemon
// crash leaves it set — that's how restore-on-reconnect knows which
// sessions to offer.
//
// Kind + SlotID were added in an earlier release Scope B. Pre-Scope-B clients
// treat Kind as missing = "claude" (the only pane that used to appear
// here) and SlotID as absent, so the wire shape stays backwards-
// compatible.
type SessionInfo struct {
	SessionID    string   `json:"session_id,omitempty"`
	Name         string   `json:"name"`
	Cwd          string   `json:"cwd"`
	CreatedAt    string   `json:"created_at"`
	LastActiveAt string   `json:"last_active_at"`
	LastPaneID   string   `json:"last_pane_id,omitempty"`
	WasLive      bool     `json:"was_live,omitempty"`
	Kind         PaneKind `json:"kind,omitempty"`
	SlotID       string   `json:"slot_id,omitempty"`
}

type SessionsListResponse struct {
	Sessions []SessionInfo `json:"sessions"`
}

// RestoreCandidateGroup is the server-computed "sessions worth offering
// for restore" for a single project. Sessions included here all have
// WasLive=true AND their LastPaneID is not among the panes currently
// running in the project — i.e. the daemon believed them alive but the
// process isn't there anymore, so almost certainly the daemon (or host)
// restarted since.
type RestoreCandidateGroup struct {
	ProjectID   string        `json:"project_id"`
	ProjectName string        `json:"project_name"`
	Sessions    []SessionInfo `json:"sessions"`
}

type RestoreCandidatesResponse struct {
	Candidates []RestoreCandidateGroup `json:"candidates"`
}

// DismissSessionsRequest clears the was_live flag on a batch of session
// IDs within one project. Used by the Satellite's "Skip" button on the
// restore prompt so the user isn't re-prompted next boot.
type DismissSessionsRequest struct {
	SessionIDs []string `json:"session_ids"`
}

type DismissSessionsResponse struct {
	Dismissed int `json:"dismissed"`
}

// --- Image-paste uploads (phase 1) ---

// PaneUploadResponse is returned on a successful
// POST /panes/:pane_id/uploads. Path is an absolute filesystem path on
// the daemon host — the renderer types it into the PTY verbatim
// (followed by a space, no newline) so the user can decide when to
// submit. The daemon generates the filename server-side; client-
// supplied names are discarded.
type PaneUploadResponse struct {
	Path string `json:"path"`
}

// PaneUpload is one previously-posted image in a pane's upload tmpdir.
// Returned by GET /panes/:pane_id/uploads. Path is the same absolute
// filesystem path originally returned from the POST; SizeBytes + ModTime
// are derived from os.Stat at the time of the GET so callers can surface
// file metadata without a separate roundtrip. ModTime is RFC3339.
type PaneUpload struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	ModTime   string `json:"mod_time"` // RFC3339
}

// PaneUploadsListResponse is returned by GET /panes/:pane_id/uploads.
// Uploads are sorted newest-first by ModTime so a UI can trivially show
// the most recent paste at the top. Empty list when the pane has never
// received a successful upload (the per-pane tmpdir is lazily created).
type PaneUploadsListResponse struct {
	Uploads []PaneUpload `json:"uploads"`
}

// ArchiveProjectResponse confirms a project's new archived state after an
// archive/unarchive call. Archived is the state after the call.
type ArchiveProjectResponse struct {
	Archived bool `json:"archived"`
}
