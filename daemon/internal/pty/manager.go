package pty

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
)

// shortSessionID returns the first 8 characters of a session UUID,
// for logging. Session IDs are sensitive (they can be used to `--resume`
// a conversation the daemon persisted) so we never write the full value
// to logs that may ship to a central aggregator.
func shortSessionID(s string) string {
	if len(s) > 8 {
		return s[:8] + "…"
	}
	return s
}

// Manager holds all live panes, keyed by project id.
type Manager struct {
	mu       sync.RWMutex
	byProj   map[string][]*Pane // projectID -> panes
	byID     map[string]*Pane   // paneID -> pane
	projects map[string]config.Project
	// reservedSlots tracks shell SlotIDs claimed by in-flight restore
	// CreatePaneWith calls — between the slot-already-live check and
	// the actual pane registration, the slot is "reserved" so a second
	// concurrent restore can't also pass the check and create a
	// duplicate live pane aliasing the same store row. Keyed by SlotID
	// (strings are globally unique; no need to namespace by project).
	reservedSlots map[string]bool
	// defaultSpawnInFlight tracks projects with an in-flight
	// EnsureDefaultPane spawn. Same idea as reservedSlots: between the
	// "project is empty" check and the pane registration in
	// CreatePaneWith, two concurrent GET /projects/:id requests could
	// both see zero panes and both spawn (an earlier release follow-up). Keyed
	// by projectID; cleared when the spawn returns (success or error).
	defaultSpawnInFlight map[string]bool
	// aggregate stoplight cache
	projStoplight map[string]proto.Stoplight
	// default spawn commands
	claudeCmd  []string
	configPath string // where projects.toml lives
	// defaultShell is the fallback argv for a project that registers
	// without an explicit Shell. Resolved once by the daemon's startup
	// (main.go → config.ResolveBinary) so $PATH isn't consulted at
	// spawn time — closes the PATH-shadow attack class for shell panes.
	// Pre-resolution invariant: either empty (tests; no shell pane will
	// spawn) or all entries absolute paths.
	defaultShell []string
	// Optional session-index store. When non-nil, claude panes get a
	// generated UUID + --session-id / --name (or --resume) plus an
	// index Upsert / Touch on exit. Nil-safe: the Manager falls back to
	// plain claude invocations without any persistence.
	sessions *sessions.Store
	// claudeProjectsDir is the root Claude Code writes per-session JSONL
	// under (~/.claude/projects by default). Stored so the resume path can
	// recover a git-worktree session's real runtime cwd (issue #56). Empty
	// falls back to sessions.DefaultClaudeProjectsDir() lazily; tests set it
	// to a t.TempDir() via ManagerConfig.ClaudeProjectsDir.
	claudeProjectsDir string
	// Adapters is the multi-agent (claude, codex, shell) spawn registry.
	// Always non-nil once NewManager returns.
	adapters *agent.Registry
	// preambleDefaults holds the station-scoped fields of the baseline
	// system-prompt context (hostname, managed-projects root, satellite
	// hint from RECK_SATELLITE_HINT). Built once at construction time.
	// Per-spawn, the Manager copies this and overlays the project's
	// ID/Name/Cwd + derived mount hint before calling BuildSpawn. Zero
	// value is safe — the preamble template degrades gracefully on
	// empty fields (see agent.PreambleCtx doc).
	preambleDefaults agent.PreambleCtx
	// mode is the daemon posture this manager was constructed with —
	// station vs. local. Captured directly in addition to being baked
	// into preambleDefaults so callers can read it back without parsing
	// the preamble context. The HTTP layer's PUT /projects handler uses
	// this to gate the RPC: only ModeLocal accepts wholesale project
	// pushes from the Satellite. Zero value normalises to ModeStation
	// (same convention as resolvePreambleDefaults). Hybrid mode rev 3.1,
	// phase 8.
	mode agent.DaemonMode
	// permittedProjectPrefix is the absolute-path prefix every entry in
	// a PUT /projects payload must lie under. Empty means "use
	// $HOME/reck/projects/" lazily resolved at call time. Tests set this
	// to a t.TempDir() path so they don't depend on the test runner's
	// HOME. The trailing separator is appended on read (see
	// permittedProjectPrefixResolved) so callers don't need to remember
	// to add it. Hybrid mode rev 3.1, phase 8.
	permittedProjectPrefix string
	// autoNames resolves the latest Claude-Code-session custom-title per
	// Claude pane for the ProjectDetail poll path . Always
	// non-nil once NewManager returns — a nil *AutoNameCache would still
	// silently fall through to "no auto-name" via the outer
	// DisplayName-wins guard, but making it a hard invariant is cheaper
	// than audit-ing every caller site. Reads ~/.claude/projects/ by
	// default; tests may override the root via ManagerConfig.ClaudeProjectsDir.
	autoNames *agent.AutoNameCache
	// Listeners fired on dock/undock + pane state changes. Set by the
	// supervisor package so the MC surface can broadcast updates.
	onStateChange func()

	// removeProjectPersist writes the registry removal to disk. Test-
	// injectable so ordering can be asserted against the pane-kill
	// lifecycle (see TestRemoveProject_persistsBeforeKillingPanes).
	// Nil defaults to config.RemoveProject; non-nil overrides it.
	removeProjectPersist func(path, id string) error

	// removeProjectChildWaitTimeout caps the per-pane wait in
	// RemoveProject between pane.Kill() and os.RemoveAll(cwd). Five
	// seconds is long enough that a healthy SIGKILL lands and reaping
	// completes, short enough that a stuck child doesn't hang the HTTP
	// handler indefinitely. Test-overridable via setRemoveProjectWaitTimeout.
	removeProjectChildWaitTimeout time.Duration
}

// defaultRemoveProjectChildWaitTimeout is the upper bound on how long
// RemoveProject waits for a killed pane's child to reap before giving
// up on the directory delete. Packaged as a var (not const) so tests
// with slow-to-exit children can shorten it without sleeping full 5s.
var defaultRemoveProjectChildWaitTimeout = 5 * time.Second

// ErrSlotAlreadyLive is returned by CreatePaneWith when a RestoreSlotID
// names a shell slot that's already attached to a running pane (or a
// pane that's currently being spawned by a concurrent restore). The
// HTTP layer maps this to 409 Conflict. Exported so callers can match
// against it with errors.Is.
var ErrSlotAlreadyLive = errors.New("slot already live")

// ErrResumeWorktreeGone is returned by CreatePaneWith when a Claude session's
// transcript lives under a git worktree that no longer exists, so its real
// runtime cwd can't be recovered. Resuming in the project root would make
// Claude fork a fresh transcript (issue #56), so the resume is refused instead.
// The session stays visible and read-only (its transcript is intact); the
// restore path clears was_live so it stops trying to auto-respawn. The HTTP
// layer maps this to 409 Conflict. Exported so callers can match with errors.Is.
var ErrResumeWorktreeGone = errors.New("cannot resume: session's git worktree no longer exists")

// ManagerConfig bundles the daemon-wide spawn defaults the Manager needs
// for argv construction. Introduced alongside the an earlier release binary-resolution
// work so new knobs (defaultShell, codexCmd) don't force every test to
// rewrite a positional call site.
//
// Invariants the caller is expected to satisfy BEFORE constructing the
// Manager (enforced at daemon startup in main.go via config.ResolveBinary):
//
//   - ClaudeCmd[0] is absolute (not a bare name) or the adapter will
//     reject spawns with a clear error.
//   - CodexCmd, when non-empty, has CodexCmd[0] absolute. Empty disables
//     codex panes cleanly rather than falling back to $PATH.
//   - DefaultShell, when non-empty, has DefaultShell[0] absolute.
//     Empty means "no default shell" — shell-pane creates for projects
//     without an explicit Shell field will error.
type ManagerConfig struct {
	Projects     []config.Project
	ClaudeCmd    []string
	CodexCmd     []string
	DefaultShell []string
	ConfigPath   string
	Sessions     *sessions.Store
	// ClaudeProjectsDir is the root Claude Code writes per-session JSONL
	// transcripts into. Empty ⇒ ~/.claude/projects resolved lazily at
	// ProjectDetail time. Tests set this to a tmp dir so the autoname
	// cache can be fed synthetic transcripts without polluting the
	// user's real Claude state. an earlier release.
	ClaudeProjectsDir string
	// Mode is the host posture this daemon is running in (station vs.
	// local). Captured at construction and stamped on every PreambleCtx
	// the Manager builds, so the baseline system prompt picks the right
	// branch (station-aware text vs. laptop-local text). Empty defaults
	// to ModeStation — the legacy NewManager constructor relies on this
	// to preserve pre-hybrid behaviour for tests that don't care about
	// mode. The daemon entry point in main.go always sets it explicitly.
	Mode agent.DaemonMode
	// PermittedProjectPrefix is the absolute-path prefix every entry in
	// a PUT /projects payload (hybrid mode rev 3.1, phase 8) must lie
	// under. Defaults to $HOME/reck/projects/ when empty. Tests override
	// this to a t.TempDir() path so they can validate against a known
	// prefix without depending on the test runner's HOME. Production
	// daemons leave it empty so the default applies. The trailing
	// separator is appended internally; callers don't need to include it.
	PermittedProjectPrefix string
}

// NewManager. claudeCmd is the command to spawn for a claude pane; shell
// cmds come from project config (or Manager.defaultShell when a project
// has none). configPath is the registry file the manager writes to on
// AddProject/RemoveProject. sess is optional — when nil, claude panes
// spawn without session persistence.
//
// This constructor is the legacy 4-arg form; prefer NewManagerFromConfig
// in daemon entry points so codex + default-shell defaults are plumbed
// through explicitly. Tests that don't exercise codex/shell-default
// panes can keep calling this form — the default shell is resolved here
// via exec.LookPath($SHELL || /bin/sh) so existing call sites keep
// working without having to wire ManagerConfig.DefaultShell.
func NewManager(projects []config.Project, claudeCmd []string, configPath string, sess *sessions.Store) *Manager {
	shell := lookupDefaultShell()
	return NewManagerFromConfig(ManagerConfig{
		Projects:     projects,
		ClaudeCmd:    claudeCmd,
		DefaultShell: shell,
		ConfigPath:   configPath,
		Sessions:     sess,
	})
}

// lookupDefaultShell resolves $SHELL (falling back to /bin/sh then
// /bin/zsh) into an absolute path via exec.LookPath. Used only by the
// legacy NewManager constructor — production code paths resolve once
// at daemon startup in main.go and pass the result through
// ManagerConfig.DefaultShell.
//
// Returns nil when no shell can be resolved; callers then surface
// "project shell not configured" at spawn time rather than silently
// executing a bare command name.
func lookupDefaultShell() []string {
	candidate := os.Getenv("SHELL")
	if candidate == "" {
		candidate = "/bin/sh"
	}
	resolved, err := exec.LookPath(candidate)
	if err != nil {
		// /bin/sh is available on every POSIX host; last-ditch fallback.
		if candidate != "/bin/sh" {
			if rc, err2 := exec.LookPath("/bin/sh"); err2 == nil {
				resolved = rc
			} else {
				return nil
			}
		} else {
			return nil
		}
	}
	if !filepath.IsAbs(resolved) {
		abs, err := filepath.Abs(resolved)
		if err != nil {
			return nil
		}
		resolved = abs
	}
	return []string{resolved, "-l"}
}

// NewManagerFromConfig is the full constructor. Prefer this in production
// code paths; the daemon entry point resolves every binary to an absolute
// path at startup and threads them through here.
func NewManagerFromConfig(cfg ManagerConfig) *Manager {
	m := &Manager{
		byProj:                 make(map[string][]*Pane),
		byID:                   make(map[string]*Pane),
		projects:               make(map[string]config.Project),
		projStoplight:          make(map[string]proto.Stoplight),
		reservedSlots:          make(map[string]bool),
		defaultSpawnInFlight:   make(map[string]bool),
		claudeCmd:              append([]string(nil), cfg.ClaudeCmd...),
		defaultShell:           append([]string(nil), cfg.DefaultShell...),
		configPath:             cfg.ConfigPath,
		sessions:               cfg.Sessions,
		claudeProjectsDir:      cfg.ClaudeProjectsDir,
		adapters:               agent.NewRegistry(ValidateClaudeExtraArgs, cfg.CodexCmd),
		preambleDefaults:       resolvePreambleDefaults(cfg.Mode),
		autoNames:              agent.NewAutoNameCache(cfg.ClaudeProjectsDir),
		mode:                   normaliseDaemonMode(cfg.Mode),
		permittedProjectPrefix: cfg.PermittedProjectPrefix,
	}
	for _, p := range cfg.Projects {
		m.projects[p.ID] = p
		m.projStoplight[p.ID] = proto.StoplightGray
	}
	return m
}

// resolvePreambleDefaults gathers the daemon-scoped + station-scoped
// fields of the baseline preamble context at Manager construction time:
//
//   - Mode: from the `--mode` daemon flag (or ManagerConfig.Mode in
//     tests). Empty (zero value) is normalised to ModeStation so the
//     legacy NewManager constructor and any test that omits Mode keep
//     getting the pre-hybrid station-aware preamble.
//   - StationHostname: os.Hostname() best-effort; empty on error so
//     the preamble template omits the "(hostname)" parenthetical
//     rather than rendering "()" or a syscall-specific error.
//   - ManagedProjectsRoot: mirrored from the package-level
//     config.ManagedProjectsRoot so tests that override it (pointing
//     at a tmp dir) flow through to the preamble without extra wiring.
//   - SatelliteHint: from the RECK_SATELLITE_HINT env var, set by the
//     launchd plist on real deployments. Empty is fine — the preamble
//     falls back to a generic "your laptop" phrase.
//
// Per-project fields (ID, Name, Cwd, MountHintForSatellite) are
// resolved per-spawn inside CreatePaneWith so project renames / cwd
// edits take effect without a daemon restart.
func resolvePreambleDefaults(mode agent.DaemonMode) agent.PreambleCtx {
	mode = normaliseDaemonMode(mode)
	// Captured at construction; a mid-process hostname change (e.g. `scutil --set HostName`, network migration) drifts the value in PreambleCtx until daemon restart. Acceptable tradeoff — preamble freshness on hostname change isn't worth a fs.notify watcher on `/Library/Preferences/SystemConfiguration/preferences.plist`.
	host, _ := os.Hostname()
	return agent.PreambleCtx{
		Mode:                mode,
		StationHostname:     host,
		ManagedProjectsRoot: config.ManagedProjectsRoot,
		SatelliteHint:       os.Getenv("RECK_SATELLITE_HINT"),
	}
}

// normaliseDaemonMode collapses the zero value (empty string) to
// ModeStation, preserving the legacy NewManager / pre-hybrid default
// without forcing every test that doesn't care about mode to spell it
// out. Used by both resolvePreambleDefaults and the new mode-getter
// path so a single source of truth handles the "Mode unset → station"
// rule.
func normaliseDaemonMode(mode agent.DaemonMode) agent.DaemonMode {
	if mode == "" {
		return agent.ModeStation
	}
	return mode
}

// Mode returns the daemon mode this manager was constructed with,
// normalised to ModeStation when the caller didn't supply one. The
// HTTP layer reads this to gate PUT /projects (hybrid mode rev 3.1,
// phase 8): only ModeLocal accepts the wholesale push.
func (m *Manager) Mode() agent.DaemonMode {
	// No lock needed — mode is set once at construction and never
	// mutated. Reading a string is atomic in Go.
	return m.mode
}

// PermittedProjectPrefix returns the absolute-path prefix every cwd in
// a PUT /projects payload must lie under, with a trailing separator
// guaranteed. Empty configuration falls back to $HOME/reck/projects/.
// If $HOME is unset (extremely unusual; would also break the rest of
// the daemon's HOME-anchored paths) returns "" — callers must treat
// that as "deny all" rather than "permit anything", which is what the
// PUT /projects validator does (see ReplaceProjects).
//
// Hybrid mode rev 3.1, phase 8.
func (m *Manager) PermittedProjectPrefix() string {
	prefix := m.permittedProjectPrefix
	if prefix == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		prefix = filepath.Join(home, "reck", "projects")
	}
	prefix = filepath.Clean(prefix)
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return prefix
}

// buildPreambleCtx copies the station-scoped defaults and overlays the
// project-scoped fields for a specific spawn. Called once per
// CreatePaneWith before the adapter fires.
//
// MountHintForSatellite is derived from the project ID (not DisplayName
// or Name) because the install-satellite.sh mount script mirrors
// /Users/reck-connect/projects/<id> to ~/reck/projects/<id> using the
// literal directory name — anything else here would give station-Claude
// a wrong mount hint that wouldn't exist on the satellite. We only emit
// the hint when the project's Cwd is actually under ManagedProjectsRoot;
// projects with a custom Cwd (e.g. /Users/reck-connect/claude-code/*)
// aren't auto-mounted on the satellite so there's no satellite-side
// path to advertise.
func (m *Manager) buildPreambleCtx(p config.Project) agent.PreambleCtx {
	ctx := m.preambleDefaults
	ctx.ProjectID = p.ID
	ctx.ProjectName = p.Name
	ctx.ProjectCwd = p.Cwd
	if ctx.ManagedProjectsRoot != "" && p.ID != "" {
		// Check whether the cwd is actually under the managed root
		// before advertising a mount hint. filepath.Rel handles the
		// trailing-slash edge case; a "../" in the result means the
		// cwd is outside the root and the satellite mount won't
		// mirror it.
		if rel, err := filepath.Rel(ctx.ManagedProjectsRoot, p.Cwd); err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
			ctx.MountHintForSatellite = "~/reck/projects/" + p.ID
		}
	}
	return ctx
}

// OnStateChange registers a listener for dock/undock + pane state events.
// Only one listener is supported; the most recent call wins. Pass nil to
// clear. Safe to call before or after NewManager.
func (m *Manager) OnStateChange(fn func()) {
	m.mu.Lock()
	m.onStateChange = fn
	m.mu.Unlock()
}

// notifyStateChange fires the state-change listener, if any. Called
// without m.mu held; the listener runs on the caller's goroutine.
func (m *Manager) notifyStateChange() {
	m.mu.RLock()
	fn := m.onStateChange
	m.mu.RUnlock()
	if fn != nil {
		fn()
	}
}

// Adapters returns the agent adapter registry. Used by HTTP handlers
// that need to expose the supported kinds list.
func (m *Manager) Adapters() *agent.Registry { return m.adapters }

// Sessions returns the session index store, or nil if session persistence
// is disabled. Exposed for HTTP handlers that need to List entries and
// validate resume IDs.
func (m *Manager) Sessions() *sessions.Store { return m.sessions }

// AddProject persists a new project and registers it live. Returns the resolved
// Project (with derived ID if input ID was empty).
//
// When req.Cwd is empty, the daemon slugifies req.Name and creates a fresh
// directory under config.ManagedProjectsRoot. Both the project ID and the
// directory name are the collision-resolved slug, so the id matches the
// on-disk directory exactly.
func (m *Manager) AddProject(req proto.AddProjectRequest) (config.Project, error) {
	m.mu.RLock()
	existingIDs := make([]string, 0, len(m.projects))
	for id := range m.projects {
		existingIDs = append(existingIDs, id)
	}
	m.mu.RUnlock()

	// If the caller didn't specify a cwd, slugify the name and create
	// a fresh directory under the managed root. Slug collisions are
	// resolved against the current project set.
	if req.Cwd == "" {
		if strings.TrimSpace(req.Name) == "" {
			return config.Project{}, errors.New("name required when cwd is empty")
		}
		if config.Slugify(req.Name) == "" {
			return config.Project{}, errors.New("name produces empty slug; use ASCII letters/digits")
		}
		taken := map[string]bool{}
		for _, id := range existingIDs {
			taken[id] = true
		}
		slug := config.SlugifyUnique(req.Name, taken)
		target := filepath.Join(config.ManagedProjectsRoot, slug)
		if err := os.MkdirAll(config.ManagedProjectsRoot, 0o755); err != nil {
			return config.Project{}, fmt.Errorf("ensure managed root: %w", err)
		}
		if err := os.Mkdir(target, 0o755); err != nil {
			return config.Project{}, fmt.Errorf("mkdir %s: %w", target, err)
		}
		req.ID = slug
		req.Cwd = target
	}

	id := req.ID
	if id == "" {
		id = config.DeriveID(req.Name, existingIDs)
	} else {
		for _, existing := range existingIDs {
			if existing == id {
				return config.Project{}, errors.New("project id already exists")
			}
		}
	}

	st, err := os.Stat(req.Cwd)
	if err != nil || !st.IsDir() {
		return config.Project{}, errors.New("cwd must be an existing directory")
	}

	p := config.Project{
		ID:          id,
		Name:        req.Name,
		Cwd:         req.Cwd,
		DefaultPane: string(req.DefaultPane),
		Shell:       req.Shell,
		Preamble:    req.Preamble,
		// AddProject only succeeds after the cwd existence check above
		// (line ~382), so the freshly-registered project is, by
		// construction, available. config.Load will recompute this on
		// the next daemon restart by re-stat'ing the cwd.
		Available: true,
	}
	if p.DefaultPane == "" {
		p.DefaultPane = "claude"
	}
	if len(p.Shell) == 0 {
		// Pre-resolved at daemon startup; if still empty here the
		// operator hasn't configured a usable SHELL and shell panes
		// for this project will fail cleanly at BuildSpawn.
		p.Shell = append([]string(nil), m.defaultShell...)
	} else {
		// Caller-supplied shell: force absolute-path invariant so the
		// PATH-shadow guarantee holds for project-specific shells.
		resolved, err := config.ResolveBinary(fmt.Sprintf("project %q shell[0]", p.ID), p.Shell[0])
		if err != nil {
			return config.Project{}, err
		}
		p.Shell[0] = resolved
	}

	if err := config.AppendProject(m.configPath, p); err != nil {
		return config.Project{}, err
	}

	m.mu.Lock()
	m.projects[p.ID] = p
	m.projStoplight[p.ID] = proto.StoplightGray
	m.mu.Unlock()

	return p, nil
}

// RemoveProject unregisters + kills all panes for the project + persists
// the removal. If the project's cwd canonically resolves under
// config.ManagedProjectsRoot, the directory is rm-rf'd after every pane
// child has exited (bounded wait). Projects with a cwd outside the
// managed root are unregistered only — the on-disk directory is left
// alone.
//
// Transactional ordering (per an earlier release.1):
//
//  1. Snapshot state (does NOT mutate in-memory maps yet).
//  2. Write registry removal to disk. If this fails, in-memory state
//     is untouched and callers can retry cleanly.
//  3. Only once disk write succeeds, mutate in-memory maps and kill
//     panes. A daemon crash between steps 2 and 3 leaves the disk
//     authoritative (project is gone); next startup won't respawn
//     orphans from a stale registry.
//  4. For each killed pane, wait up to defaultRemoveProjectChildWaitTimeout
//     for the child process to be reaped. This prevents the child
//     from holding open fds under the project cwd while the directory
//     is deleted.
//  5. If all children reaped and cwd is under the managed root, delete
//     the directory. If any child timed out, skip the delete and log
//     a manual-cleanup note — the cwd stays on disk but the daemon
//     no longer tracks it, so subsequent operations route around it.
func (m *Manager) RemoveProject(id string) error {
	m.mu.Lock()
	proj, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("project not found")
	}
	// Snapshot the cwd and pane list but do NOT mutate maps yet. Persist
	// the registry change to disk first so a crash mid-teardown leaves
	// disk authoritative. Only on persist success do we tear down the
	// live process tree.
	cwd := proj.Cwd
	panes := append([]*Pane(nil), m.byProj[id]...)
	m.mu.Unlock()

	// Step 1: persist to disk.
	persist := m.removeProjectPersist
	if persist == nil {
		persist = config.RemoveProject
	}
	if err := persist(m.configPath, id); err != nil {
		return err
	}

	// Step 2: now that disk reflects the removal, clear in-memory maps.
	m.mu.Lock()
	delete(m.projects, id)
	delete(m.projStoplight, id)
	delete(m.byProj, id)
	for _, pane := range panes {
		delete(m.byID, pane.ID)
	}
	m.mu.Unlock()

	// Step 3: kill panes.
	for _, pane := range panes {
		pane.Kill()
	}

	// Step 4: wait for child reaping before deleting any on-disk state.
	// A child that still has cwd as its working directory or has open
	// fds under it can collide with os.RemoveAll; waiting for Cmd.Wait
	// to return gets us past that race.
	//
	// We race ALL panes against a SHARED deadline rather than looping
	// per-pane. Serialised 5s waits would cost 5s × N panes worst-case,
	// blowing past launchd's 20s SIGKILL deadline at 4+ hung children.
	// With a shared ctx.WithTimeout, total teardown is bounded by the
	// single timeout value regardless of pane count.
	timeout := m.removeProjectChildWaitTimeout
	if timeout <= 0 {
		timeout = defaultRemoveProjectChildWaitTimeout
	}
	allExited := true
	if len(panes) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		var wg sync.WaitGroup
		// Atomic so goroutines can flip it without a mutex; we only
		// need "any pane timed out?" resolution, not an ordered list.
		var timedOut atomic.Bool
		wg.Add(len(panes))
		for _, pane := range panes {
			go func(p *Pane) {
				defer wg.Done()
				if !p.WaitForExitCtx(ctx) {
					timedOut.Store(true)
					slog.Warn("remove project: pane child did not exit within timeout",
						"id", id, "pane", p.ID, "timeout", timeout)
				}
			}(pane)
		}
		wg.Wait()
		if timedOut.Load() {
			allExited = false
		}
	}

	// Step 5: delete cwd only when safe (managed root) AND all children
	// have reaped. Leaving the directory on disk when a child hangs is
	// strictly safer than deleting it out from under live fds.
	if cwd != "" && config.IsUnderManagedRoot(cwd, config.ManagedProjectsRoot) {
		if !allExited {
			slog.Warn("remove project: skipping directory delete — one or more children still running; manual cleanup required",
				"id", id, "cwd", cwd)
		} else if err := os.RemoveAll(cwd); err != nil {
			slog.Warn("remove project dir",
				"id", id, "cwd", cwd, "err", err)
		}
	}
	return nil
}

// IsHiddenProjectID reports whether a project ID is reserved for internal
// use (e.g. the Mission Control supervisor). Hidden projects exist in the
// Manager but are excluded from Projects() / DockedProjects() so they
// never appear in normal listings or on the rail. Convention: any ID
// prefixed with `__`.
func IsHiddenProjectID(id string) bool {
	return strings.HasPrefix(id, "__")
}

// ReplaceProjectsInput is one entry in the wholesale project list pushed
// to the daemon via PUT /projects (hybrid mode rev 3.1, phase 8). Mirrors
// the wire shape (proto.PutProjectsEntry) but lives here so callers below
// the HTTP layer don't have to import proto.
type ReplaceProjectsInput struct {
	ID  string
	Cwd string
}

// ErrPutProjectsRejected wraps every validation failure returned by
// ReplaceProjects so callers (the HTTP handler) can render a single
// 400-class status without leaking which specific rule fired in the
// outermost log/error string. The wrapped detail is still readable via
// errors.Unwrap for the audit log.
//
// We use a sentinel + error.Is rather than a typed error so the HTTP
// layer's switch is a one-liner against this single value.
var ErrPutProjectsRejected = errors.New("put_projects: payload rejected")

// ReplaceProjects atomically replaces the in-memory project map with the
// given wholesale list. Used by the hybrid-mode PUT /projects RPC: the
// Satellite renders the rail from station-side state, then pushes the
// derived per-pane local-cwd map down to the local daemon so it can
// resolve project IDs to mounted folders for cwd of any local Claude
// pane.
//
// Validation (atomic — first failure rejects the whole payload):
//
//   - Each entry must have a non-empty ID and a non-empty cwd.
//   - cwd must be an absolute path (filepath.IsAbs).
//   - cwd, after filepath.Clean, must lie under PermittedProjectPrefix().
//   - cwd must not contain any ".." traversal segments after Clean.
//   - If cwd exists and is a symlink, the symlink target must also lie
//     under PermittedProjectPrefix(). Non-existent cwd is NOT a symlink
//     escape risk (the file doesn't exist, so it can't link out) — we
//     register it with Available=false instead, mirroring the Phase 7
//     semantics flowed through config.Load.
//   - Duplicate IDs in the same payload are rejected — the in-memory map
//     would silently keep the last entry, but that asymmetry is exactly
//     the kind of thing a paranoid reviewer worries about.
//
// Existence is NOT a validation rule: a missing cwd is registered with
// Available=false. The Satellite knows the mount may be in flux while
// sshfs is reconnecting; rejecting the whole push because one folder
// hasn't appeared yet would create a chicken-and-egg deadlock.
//
// Concurrency: validate-then-replace runs under m.mu held for the
// entire call. Two concurrent ReplaceProjects calls serialise; the
// final in-memory state equals one of the input payloads verbatim, no
// interleaved garbage. The validation-phase syscalls (Lstat,
// EvalSymlinks) happen with the lock held — they're tens-of-microseconds
// per entry and the alternative (validate outside the lock, replace
// inside) opens a TOCTOU window where a concurrent push could land its
// less-strict view of disk state. The Codex blocker-3 race the plan
// calls out also lives in this region; keeping the lock single-acquire
// closes both gaps with one mutex pattern.
//
// Hybrid mode rev 3.1, phase 8.
func (m *Manager) ReplaceProjects(inputs []ReplaceProjectsInput) error {
	prefix := m.PermittedProjectPrefix()
	if prefix == "" {
		// HOME unresolvable + no override configured — refuse the whole
		// push rather than silently accepting any path. The daemon would
		// have other problems already (logs, sessions, hooks all anchor
		// on $HOME) but this RPC is a trust boundary so it errs closed.
		return fmt.Errorf("%w: permitted project prefix unresolved (no $HOME)", ErrPutProjectsRejected)
	}

	// Capture (id, cwd) pairs for projects added by this push so we
	// can drain their sessions-store orphans after the lock releases.
	// RestoreOrphans at boot only walks IDs already in projects.toml
	// — a hybrid project pushed via PUT /projects after boot would
	// otherwise leave its WasLive=true entries dangling until the next
	// daemon restart that includes the project statically. Issue
	// surfaced when a station-resident project (id mismatch with local
	// toml) loses its local panes across Satellite quit/reopen cycles.
	//
	// Cwd is snapshotted alongside the ID under m.mu so the post-unlock
	// restore can compare against the entry's stored cwd. Without the
	// snapshot, a concurrent PUT replacing the same ID with a different
	// cwd between unlock and restore would let restoreProjectOrphans
	// respawn under the wrong project (Codex adversarial review TOCTOU
	// finding).
	type addedProject struct {
		id  string
		cwd string
	}
	var newlyAdded []addedProject

	// Use an inner func so we can release the lock before calling
	// restoreProjectOrphans (which acquires m.mu via CreatePaneWith).
	if err := m.replaceProjectsLocked(inputs, prefix, func(id, cwd string) {
		newlyAdded = append(newlyAdded, addedProject{id: id, cwd: cwd})
	}); err != nil {
		return err
	}

	// Outside lock: respawn orphan panes for each newly-pushed project.
	// Best-effort — failures are logged inside restoreProjectOrphans
	// and don't fail the PUT (the projects themselves are already
	// registered; restore is a UX nicety on top). Cwd from the snapshot
	// taken under m.mu, not refetched, to defend against the TOCTOU
	// race documented above.
	for _, ap := range newlyAdded {
		_ = m.restoreProjectOrphans(ap.id, ap.cwd, 0, 0)
	}
	return nil
}

func (m *Manager) replaceProjectsLocked(inputs []ReplaceProjectsInput, prefix string, onNewlyAdded func(id, cwd string)) error {
	// Single mutex acquire for the whole validate-then-replace cycle.
	// See the doc comment above for why we don't split.
	m.mu.Lock()
	defer m.mu.Unlock()

	validated := make(map[string]config.Project, len(inputs))
	for i, in := range inputs {
		if in.ID == "" {
			return fmt.Errorf("%w: entry %d: id is required", ErrPutProjectsRejected, i)
		}
		if err := config.ValidateProjectID(in.ID); err != nil {
			return fmt.Errorf("%w: entry %d: %v", ErrPutProjectsRejected, i, err)
		}
		if in.Cwd == "" {
			return fmt.Errorf("%w: entry %d (id=%q): cwd is required", ErrPutProjectsRejected, i, in.ID)
		}
		if _, dup := validated[in.ID]; dup {
			return fmt.Errorf("%w: entry %d: duplicate id %q in payload", ErrPutProjectsRejected, i, in.ID)
		}

		// Order matters here. Each step reduces the surface area the
		// next step has to consider:
		//   1. absolute → filepath.Clean is now meaningful.
		//   2. clean    → traversal segments collapse out, so a literal
		//                 "..." remnant is a real ".." attempt.
		//   3. prefix   → cwd is anchored under the permitted root.
		//   4. symlink  → only at this point is it worth the syscall.
		if !filepath.IsAbs(in.Cwd) {
			return fmt.Errorf("%w: entry %d (id=%q): cwd must be an absolute path", ErrPutProjectsRejected, i, in.ID)
		}
		clean := filepath.Clean(in.Cwd)
		if hasTraversalSegment(clean) {
			return fmt.Errorf("%w: entry %d (id=%q): cwd contains a `..` traversal segment", ErrPutProjectsRejected, i, in.ID)
		}
		if !pathHasPrefix(clean, prefix) {
			return fmt.Errorf("%w: entry %d (id=%q): cwd is not under the permitted prefix", ErrPutProjectsRejected, i, in.ID)
		}

		// Symlink check is conditional on the path existing on disk. If
		// it doesn't exist we register Available=false; you can't escape
		// via a symlink whose source doesn't exist.
		//
		// Resolve the prefix through EvalSymlinks once per validation
		// loop so the symlink-target comparison uses canonical paths on
		// both sides. macOS in particular surfaces the same directory as
		// /var/folders/... and /private/var/folders/... depending on
		// whether the path was Lstat'd or EvalSymlinks'd. Without this
		// canonicalisation, a perfectly legitimate cwd that happens to
		// be a symlink-into-the-prefix would be rejected for "resolving
		// outside" the prefix the renderer (correctly) sent.
		isAvailable := true
		if info, err := os.Lstat(clean); err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				resolved, err := filepath.EvalSymlinks(clean)
				if err != nil {
					return fmt.Errorf("%w: entry %d (id=%q): cwd is a symlink whose target cannot be resolved", ErrPutProjectsRejected, i, in.ID)
				}
				resolvedPrefix, err := filepath.EvalSymlinks(strings.TrimRight(prefix, string(filepath.Separator)))
				if err != nil {
					// Prefix doesn't exist on disk — treat as deny-all.
					// Production daemons mkdir the permitted root at
					// startup so this is essentially a misconfig signal.
					return fmt.Errorf("%w: entry %d (id=%q): permitted prefix is not present on disk", ErrPutProjectsRejected, i, in.ID)
				}
				if !pathHasPrefix(filepath.Clean(resolved), ensureTrailingSep(resolvedPrefix)) {
					return fmt.Errorf("%w: entry %d (id=%q): cwd symlink resolves outside the permitted prefix", ErrPutProjectsRejected, i, in.ID)
				}
				// Resolved target exists by virtue of EvalSymlinks
				// succeeding; isAvailable stays true.
			} else if !info.IsDir() {
				// File-but-not-directory is a config bug, not a
				// missing-mount; reject so the operator notices.
				return fmt.Errorf("%w: entry %d (id=%q): cwd exists but is not a directory", ErrPutProjectsRejected, i, in.ID)
			}
		} else if os.IsNotExist(err) {
			// Phase 7 semantics: missing cwd → Available=false.
			isAvailable = false
		} else {
			// Stat failed for an unexpected reason (permission denied
			// most likely). Fail closed — we can't confirm the cwd is
			// safe, so don't trust it.
			return fmt.Errorf("%w: entry %d (id=%q): cwd stat failed", ErrPutProjectsRejected, i, in.ID)
		}

		validated[in.ID] = config.Project{
			ID:          in.ID,
			Name:        in.ID, // local-mode projects don't carry a separate display name on the wire; rail labels live on the station
			Cwd:         clean,
			DefaultPane: "claude",
			// an earlier release: PUT /projects entries don't carry a Shell
			// field on the wire — they describe a station-owned project
			// being mirrored to local for cwd resolution, not a fresh
			// project registration. Without seeding Shell from the
			// daemon's resolved default, shell-pane spawns against any
			// pushed project fail at adapter.BuildSpawn with "project
			// shell not configured". Mirror the AddProject fall-through
			// (line ~476) so the local daemon can spawn shell panes for
			// hybrid-mode projects exactly the same way it does for
			// projects.toml-defined ones.
			Shell:     append([]string(nil), m.defaultShell...),
			Available: isAvailable,
		}
	}

	// Capture the pre-replace ID set so we can compute "newly added"
	// (in payload AND not present before this call) for the post-unlock
	// orphan-restore hook. Must happen BEFORE the delete loop wipes
	// m.projects.
	preExisting := make(map[string]struct{}, len(m.projects))
	for id := range m.projects {
		preExisting[id] = struct{}{}
	}

	// Wholesale replace. We preserve hidden (meta) projects so the
	// Mission Control supervisor's __mc-* entry survives a push from a
	// Satellite that doesn't know about it. (Lock acquired above.)
	for id := range m.projects {
		if IsHiddenProjectID(id) {
			continue
		}
		delete(m.projects, id)
		delete(m.projStoplight, id)
	}
	for id, p := range validated {
		m.projects[id] = p
		m.projStoplight[id] = proto.StoplightGray
		if _, existed := preExisting[id]; !existed && onNewlyAdded != nil {
			onNewlyAdded(id, p.Cwd)
		}
	}
	return nil
}

// hasTraversalSegment reports whether a cleaned path still contains a
// literal ".." path segment. After filepath.Clean a path like
// "/a/b/../c" collapses to "/a/c", but "/a/.../b" or paths cleaned
// against a different OS's separator can still hide one. This is a
// belt-and-braces check on top of the prefix gate.
func hasTraversalSegment(p string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// pathHasPrefix reports whether `path` lies under `prefix`. Both must be
// cleaned. `prefix` is expected to end with a separator so a sibling
// like "/a/b-other" doesn't accidentally pass against "/a/b". We also
// accept exact equality with the prefix-minus-separator (i.e. cwd ==
// the permitted root itself) because that's a legitimate degenerate
// case the Satellite might push during initial setup.
func pathHasPrefix(path, prefix string) bool {
	if prefix == "" {
		return false
	}
	trimmed := strings.TrimRight(prefix, string(filepath.Separator))
	if path == trimmed {
		return true
	}
	return strings.HasPrefix(path, prefix)
}

// ensureTrailingSep guarantees a path ends with the OS path separator.
// Used to normalise an EvalSymlinks-canonicalised prefix so the prefix
// gate behaves consistently regardless of whether the resolved string
// comes back with or without a trailing slash.
func ensureTrailingSep(p string) string {
	if !strings.HasSuffix(p, string(filepath.Separator)) {
		return p + string(filepath.Separator)
	}
	return p
}

// paneStoplightsLocked collects the per-pane effective stoplights for a
// project in creation order (the iteration order of byProj[id], which is
// append-only). Returned slice is always non-nil so the JSON encoder
// emits `[]` rather than `null` for zero-pane projects — TS clients
// expect an array when the field is present.
//
// Caller must hold m.mu (read or write).
func (m *Manager) paneStoplightsLocked(id string) []proto.Stoplight {
	panes := m.byProj[id]
	out := make([]proto.Stoplight, 0, len(panes))
	for _, pn := range panes {
		out = append(out, pn.Info().Stoplight)
	}
	return out
}

// paneIDsLocked collects pane IDs for a project in the same creation
// order as paneStoplightsLocked (so the i-th id describes the i-th
// stoplight on the wire). an earlier release — the rail uses this to reorder
// indicator dots by layout position instead of creation order. Returned
// slice is always non-nil to mirror the PaneStoplights `[]`-on-empty
// convention.
//
// Caller must hold m.mu (read or write).
func (m *Manager) paneIDsLocked(id string) []string {
	panes := m.byProj[id]
	out := make([]string, 0, len(panes))
	for _, pn := range panes {
		out = append(out, pn.ID)
	}
	return out
}

// Projects returns all user-visible registered projects with their
// aggregate stoplight. Hidden (internal) projects are excluded.
func (m *Manager) Projects() []proto.Project {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]proto.Project, 0, len(m.projects))
	for id, p := range m.projects {
		if IsHiddenProjectID(id) {
			continue
		}
		out = append(out, proto.Project{
			ID:             id,
			Name:           p.Name,
			Cwd:            p.Cwd,
			Stoplight:      m.projStoplight[id],
			PaneCount:      len(m.byProj[id]),
			PaneStoplights: m.paneStoplightsLocked(id),
			PaneIDs:        m.paneIDsLocked(id),
			Docked:         p.Docked,
			Archived:       p.Archived,
			DisplayName:    p.DisplayName,
			Available:      p.Available,
		})
	}
	return out
}

// DockedProjects returns only user-visible projects that have opted into
// Mission Control. Hidden projects are excluded.
func (m *Manager) DockedProjects() []proto.Project {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]proto.Project, 0)
	for id, p := range m.projects {
		if IsHiddenProjectID(id) {
			continue
		}
		if !p.Docked {
			continue
		}
		out = append(out, proto.Project{
			ID:             id,
			Name:           p.Name,
			Cwd:            p.Cwd,
			Stoplight:      m.projStoplight[id],
			PaneCount:      len(m.byProj[id]),
			PaneStoplights: m.paneStoplightsLocked(id),
			PaneIDs:        m.paneIDsLocked(id),
			Docked:         true,
			Archived:       p.Archived,
			DisplayName:    p.DisplayName,
			Available:      p.Available,
		})
	}
	return out
}

// SetDocked updates a project's Mission Control dock state and persists it.
// Idempotent — returns nil when the project is already in the requested state.
// Returns an error if the project doesn't exist.
func (m *Manager) SetDocked(id string, docked bool) error {
	m.mu.Lock()
	p, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("project not found")
	}
	if p.Docked == docked {
		m.mu.Unlock()
		return nil
	}
	p.Docked = docked
	m.projects[id] = p
	m.mu.Unlock()
	if err := config.SetProjectDocked(m.configPath, id, docked); err != nil {
		// Roll back in-memory state on persistence failure so callers
		// see a consistent view.
		m.mu.Lock()
		p.Docked = !docked
		m.projects[id] = p
		m.mu.Unlock()
		return fmt.Errorf("persist dock state: %w", err)
	}
	m.notifyStateChange()
	return nil
}

// ArchiveProject puts a project to sleep. It kills every pane the project
// has open — freeing the PTY subprocesses that hold the bulk of the RAM —
// but, unlike DeletePane, it does NOT clear the session rows' was_live flag,
// so UnarchiveProject (or a manual restore) can respawn exactly what was
// running. The project stays registered with archived=true; its cwd is never
// touched. Idempotent: a nil no-op when already archived. Returns an error
// if the project doesn't exist.
//
// Ordering mirrors RemoveProject: persist the flag to disk FIRST so a crash
// mid-teardown leaves disk authoritative, then tear down the live panes.
func (m *Manager) ArchiveProject(id string) error {
	m.mu.RLock()
	p, ok := m.projects[id]
	m.mu.RUnlock()
	if !ok {
		return errors.New("project not found")
	}
	if p.Archived {
		return nil
	}

	if err := config.SetProjectArchived(m.configPath, id, true); err != nil {
		return fmt.Errorf("persist archive state: %w", err)
	}

	// Flip the in-memory flag and detach the live panes atomically.
	m.mu.Lock()
	p = m.projects[id]
	p.Archived = true
	m.projects[id] = p
	panes := append([]*Pane(nil), m.byProj[id]...)
	m.byProj[id] = nil
	for _, pane := range panes {
		delete(m.byID, pane.ID)
	}
	m.mu.Unlock()

	// Kill without clearing was_live — the one thing that separates archive
	// from a graceful DeletePane.
	for _, pane := range panes {
		pane.Kill()
	}

	// Reap children against a single shared deadline (same rationale as
	// RemoveProject: serialised per-pane waits would blow past launchd's
	// SIGKILL deadline with many hung children).
	timeout := m.removeProjectChildWaitTimeout
	if timeout <= 0 {
		timeout = defaultRemoveProjectChildWaitTimeout
	}
	if len(panes) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		var wg sync.WaitGroup
		wg.Add(len(panes))
		for _, pane := range panes {
			go func(p *Pane) {
				defer wg.Done()
				if !p.WaitForExitCtx(ctx) {
					slog.Warn("archive project: pane child did not exit within timeout",
						"id", id, "pane", p.ID, "timeout", timeout)
				}
			}(pane)
		}
		wg.Wait()
	}

	m.recomputeAggregate(id)
	m.notifyStateChange()
	return nil
}

// UnarchiveProject wakes an archived project: it clears the archived flag and
// respawns exactly the panes that were live when it was archived (their
// was_live rows were left intact). cols/rows size the respawned PTYs; pass 0
// to accept the store defaults — the client re-fits on attach, same as the
// boot restore path. Clearing the flag is a no-op when the project isn't
// archived; the restore walk still runs but skips panes that are already
// live. Returns an error if the project doesn't exist.
func (m *Manager) UnarchiveProject(id string, cols, rows int) error {
	m.mu.RLock()
	p, ok := m.projects[id]
	m.mu.RUnlock()
	if !ok {
		return errors.New("project not found")
	}

	if p.Archived {
		if err := config.SetProjectArchived(m.configPath, id, false); err != nil {
			return fmt.Errorf("persist unarchive state: %w", err)
		}
		m.mu.Lock()
		p = m.projects[id]
		p.Archived = false
		m.projects[id] = p
		m.mu.Unlock()
	}

	res := m.RestoreProjectOrphans(id, p.Cwd, cols, rows)
	slog.Info("unarchive project restore", "id", id,
		"restored", res.Restored, "skipped", res.Skipped, "failed", res.Failed, "read_only", res.ReadOnly)
	m.notifyStateChange()
	return nil
}

// SetProjectDisplayName updates a project's user-given label and persists
// it to projects.toml. Empty string clears the override. Idempotent —
// returns nil when the project is already in the requested state. Returns
// an error if the project doesn't exist.
func (m *Manager) SetProjectDisplayName(id string, displayName string) error {
	m.mu.Lock()
	p, ok := m.projects[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("project not found")
	}
	if p.DisplayName == displayName {
		m.mu.Unlock()
		return nil
	}
	prev := p.DisplayName
	p.DisplayName = displayName
	m.projects[id] = p
	m.mu.Unlock()
	if err := config.SetProjectDisplayName(m.configPath, id, displayName); err != nil {
		m.mu.Lock()
		p.DisplayName = prev
		m.projects[id] = p
		m.mu.Unlock()
		return fmt.Errorf("persist display_name: %w", err)
	}
	m.notifyStateChange()
	return nil
}

// SetPaneDisplayName persists a user-given label for the given pane.
// The pane must have a persistent identity — SessionID for Claude,
// SlotID for shell (Scope B). Empty string clears the
// override. Returns an error when the pane doesn't exist, has no
// identity (e.g. session store disabled at spawn), or the session store
// is unconfigured.
//
// Previously this rejected every shell pane because the lookup keyed by
// SessionID only — even though the daemon had no persistent identity
// for shell panes in that era, the live-bug handler at the HTTP layer
// still crashed shell renames. Scope B gives shell panes a SlotID and
// the identity fallback here makes the endpoint honest.
func (m *Manager) SetPaneDisplayName(projectID string, paneID string, displayName string) error {
	m.mu.RLock()
	pane, ok := m.byID[paneID]
	store := m.sessions
	m.mu.RUnlock()
	if !ok {
		return errors.New("pane not found")
	}
	if pane.ProjectID != projectID {
		return errors.New("pane not in project")
	}
	identity := pane.SessionID
	if identity == "" {
		identity = pane.SlotID
	}
	if identity == "" {
		return errors.New("pane has no persistent identity to rename against")
	}
	if store == nil {
		return errors.New("session persistence disabled")
	}
	if err := store.SetDisplayName(projectID, identity, displayName); err != nil {
		return fmt.Errorf("persist pane display_name: %w", err)
	}
	m.notifyStateChange()
	return nil
}

// ProjectDetail returns project + all its panes.
//
// For Claude panes without a user-set DisplayName, AutoName is populated
// from the session's own JSONL transcript (see agent.AutoNameCache).
// When DisplayName is set the daemon deliberately skips the JSONL read
// — clients render DisplayName unconditionally and AutoName would be a
// wasted disk hit. Shell panes never get AutoName (no Claude session,
// no transcript; an earlier release).
func (m *Manager) ProjectDetail(id string) (proto.ProjectDetail, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.projects[id]
	if !ok {
		return proto.ProjectDetail{}, false
	}
	projCwd := p.Cwd
	panes := make([]proto.Pane, 0, len(m.byProj[id]))
	for _, pn := range m.byProj[id] {
		info := pn.Info()
		// Per-pane label lookup: key by whichever identity is non-empty
		// (SessionID for Claude, SlotID for shell). an earlier release Scope B
		// extended shell renames to persist through the same sessions
		// store keyed by SlotID.
		identity := info.SessionID
		if identity == "" {
			identity = info.SlotID
		}
		if identity != "" && m.sessions != nil {
			if e, ok, err := m.sessions.Get(id, identity); err == nil && ok {
				info.DisplayName = e.DisplayName
			}
		}
		// AutoName: Claude panes only, and only when no user-set
		// DisplayName has been resolved above. Cache keyed by pane.ID
		// so two concurrent panes sharing a resumed SessionID don't
		// confuse each other's stat state (not currently possible — a
		// SessionID can only live on one pane at a time — but keeping
		// the cache pane-scoped is the defensive choice).
		if info.Kind == proto.PaneKindClaude && info.DisplayName == "" && info.SessionID != "" && m.autoNames != nil {
			info.AutoName = m.autoNames.Lookup(info.ID, id, projCwd, info.SessionID)
		}
		panes = append(panes, info)
	}
	return proto.ProjectDetail{
		ID:          id,
		Name:        p.Name,
		Cwd:         p.Cwd,
		Panes:       panes,
		DisplayName: p.DisplayName,
	}, true
}

// CreatePane spawns a new pane in the given project with default options.
func (m *Manager) CreatePane(projectID string, kind proto.PaneKind, cols, rows int) (*Pane, error) {
	return m.CreatePaneWith(projectID, kind, cols, rows, CreatePaneOptions{})
}

// CreatePaneOptions configures pane creation. Zero value ⇒ fresh claude
// session with a generated UUID, no extra argv.
type CreatePaneOptions struct {
	// ResumeSessionID, when non-empty and Kind is Claude, spawns
	// `claude --resume <uuid>` instead of a fresh session. The UUID
	// must match an entry in the project's session index; otherwise
	// CreatePaneWith returns an error.
	ResumeSessionID string

	// RestoreSlotID, when non-empty and Kind is Shell or Codex, asks the
	// daemon to respawn the pane under a previously recorded slot id
	// (Scope B). The slot id must match a shell/codex entry in the
	// project's session index and carry a stored argv; otherwise the
	// request is rejected. Mutually exclusive with ResumeSessionID.
	RestoreSlotID string

	// ExtraArgs is appended to argv for PaneKindClaude only; it is
	// silently ignored for shell panes. For Claude panes the args pass
	// through ValidateClaudeExtraArgs first — out-of-sandbox paths are
	// rejected.
	ExtraArgs []string

	// ExtraEnv are additional "KEY=VALUE" strings appended to the
	// child's environment on top of the daemon's env allowlist. Used
	// exclusively by the Mission Control supervisor to inject its own
	// (scoped) bearer token without widening the global allowlist —
	// regular pane creates should leave this nil so pane children
	// never see daemon-level secrets.
	ExtraEnv []string
	// GlobalPreamble is the satellite-stored "Reck Connect prompt" —
	// app-wide text the user configures in Satellite Settings that the
	// satellite sends on every CreatePane request. Threaded into
	// SpawnRequest.GlobalPreamble; the claude adapter composes it as a
	// middle layer between baseline and per-project preamble. Empty
	// string ⇒ no global layer (no separator emitted). Silently ignored
	// by non-Claude adapters.
	GlobalPreamble string
}

// CreatePaneWith is the fuller form of CreatePane; callers that don't
// need options should use CreatePane. Argv construction is delegated to
// an agent.Adapter (claude / codex / shell) so the spawn invariants stay
// colocated with the agent itself rather than in this manager.
func (m *Manager) CreatePaneWith(projectID string, kind proto.PaneKind, cols, rows int, opts CreatePaneOptions) (*Pane, error) {
	m.mu.Lock()
	proj, ok := m.projects[projectID]
	if !ok {
		m.mu.Unlock()
		return nil, errors.New("project not found")
	}
	m.mu.Unlock()

	adapter, err := m.adapters.Lookup(kind)
	if err != nil {
		return nil, err
	}

	if opts.ResumeSessionID != "" && opts.RestoreSlotID != "" {
		return nil, errors.New("resume_session_id and restore_slot_id are mutually exclusive")
	}

	// Validate resume against the index before we attempt to spawn
	// anything. We want a clean 4xx at the HTTP layer, not a half-
	// started pane that dies because the UUID was bogus. Resume is
	// currently only meaningful for claude panes — other adapters
	// return ErrResumeUnsupported from BuildSpawn when asked.
	var resumeEntry *sessions.Entry
	if opts.ResumeSessionID != "" {
		if kind != proto.PaneKindClaude {
			return nil, agent.ErrResumeUnsupported
		}
		if m.sessions == nil {
			return nil, errors.New("session index unavailable")
		}
		e, ok, err := m.sessions.Get(projectID, opts.ResumeSessionID)
		if err != nil {
			return nil, fmt.Errorf("sessions lookup: %w", err)
		}
		if !ok {
			return nil, errors.New("unknown resume_session_id for this project")
		}
		// Defensive: a Claude entry has Kind=="claude"; if callers somehow
		// reach this path with a shell slot id in hand we want to fail
		// closed rather than re-exec claude without a session.
		if e.Kind != proto.PaneKindClaude {
			return nil, errors.New("resume_session_id refers to a non-claude entry")
		}
		// #56: recover the directory the transcript actually lives in so
		// `claude --resume` rehydrates the existing session instead of
		// forking a fresh transcript. For a worktree session e.Cwd is the
		// (mis-recorded) project root; resolveResumeCwd finds the worktree
		// and we self-heal e.Cwd here — the adapter reads it for plan.Cwd
		// and the post-spawn Upsert (below) persists the correction. If the
		// worktree is gone the transcript can't be located; refuse rather
		// than resume in the wrong cwd.
		realCwd, ok := m.resolveResumeCwd(proj.Cwd, e.Cwd, e.SessionID)
		if !ok {
			return nil, fmt.Errorf("%w: session %s", ErrResumeWorktreeGone, shortSessionID(e.SessionID))
		}
		e.Cwd = realCwd
		resumeEntry = &e
	}

	// Shell/codex restore: look up the slot entry by SlotID and hand it
	// to the adapter, which execs Entry.ShellArgv verbatim so the user
	// gets back the process they actually had running, not what today's
	// project default would produce. Codex mirrors shell — both are
	// slot-identified and neither resumes a Claude session.
	var restoreEntry *sessions.Entry
	if opts.RestoreSlotID != "" {
		if kind != proto.PaneKindShell && kind != proto.PaneKindCodex {
			return nil, errors.New("restore_slot_id is only valid for shell or codex panes")
		}
		if m.sessions == nil {
			return nil, errors.New("session index unavailable")
		}
		e, ok, err := m.sessions.Get(projectID, opts.RestoreSlotID)
		if err != nil {
			return nil, fmt.Errorf("sessions lookup: %w", err)
		}
		if !ok {
			return nil, errors.New("unknown restore_slot_id for this project")
		}
		// The stored entry's kind must match the requested kind — mixing a
		// shell slot into a codex request (or vice-versa) would replay the
		// wrong argv.
		if e.Kind != kind {
			return nil, fmt.Errorf("restore_slot_id refers to a %s entry, not %s", e.Kind, kind)
		}
		restoreEntry = &e
	}

	// Restore duplicate-prevention (Codex HIGH #2). Before we spawn,
	// atomically claim the SlotID under m.mu so two concurrent restore
	// calls can't both pass the check. Scans live panes + any
	// in-flight reservation; either means the slot is already taken.
	// We clear the reservation on the way out regardless of outcome —
	// once the pane is registered it shows up in the live-panes scan,
	// so the reservation is redundant after successful registration;
	// on failure we want the slot freed for a legitimate retry.
	if opts.RestoreSlotID != "" {
		slot := opts.RestoreSlotID
		m.mu.Lock()
		if m.reservedSlots[slot] || m.isSlotLiveLocked(slot) {
			m.mu.Unlock()
			return nil, fmt.Errorf("%w: slot %s", ErrSlotAlreadyLive, shortSessionID(slot))
		}
		m.reservedSlots[slot] = true
		m.mu.Unlock()
		defer func() {
			m.mu.Lock()
			delete(m.reservedSlots, slot)
			m.mu.Unlock()
		}()
	}

	plan, err := adapter.BuildSpawn(agent.SpawnRequest{
		Project:          proj,
		ResumeSessionID:  opts.ResumeSessionID,
		ResumeEntry:      resumeEntry,
		RestoreEntry:     restoreEntry,
		ExtraArgs:        opts.ExtraArgs,
		DefaultClaudeCmd: m.claudeCmd,
		Sessions:         m.sessions,
		Preamble:         m.buildPreambleCtx(proj),
		GlobalPreamble:   opts.GlobalPreamble,
	})
	if err != nil {
		return nil, err
	}

	// Cwd: the adapter's plan wins when it set one (shell restore uses
	// the stored Entry.Cwd; fresh spawns echo proj.Cwd). Empty ⇒
	// adapter didn't opt in, fall back to the project's current cwd.
	// Keeping the fallback means older adapters / zero-valued SpawnPlans
	// from future refactors don't accidentally spawn in "" (i.e. the
	// daemon's own process cwd, which would be wildly wrong).
	spawnCwd := plan.Cwd
	if spawnCwd == "" {
		spawnCwd = proj.Cwd
	}

	// Argv is logged with sensitive values redacted — see redactArgv.
	// Raw argv (including --session-id / --resume UUIDs and --api-key
	// secrets) never reaches slog.
	slog.Info("spawn pane",
		"project", projectID,
		"kind", string(kind),
		"agent", plan.AgentName,
		"argv", redactArgv(plan.Argv),
		"cwd", spawnCwd)
	// phase 2: the sidecar-mediated spawn path
	// has been retired. The daemon now runs as a per-user LaunchAgent
	// in both station and local mode, so claude children inherit the
	// user's Aqua audit session directly. Pasteboard reads via
	// osascript no longer fail with errAEPrivilegeError, and the
	// reck-clipboard sidecar — which existed solely to mediate that —
	// is gone.
	pane, err := Spawn(projectID, kind, plan.Argv, spawnCwd, cols, rows, opts.ExtraEnv)
	if err != nil {
		return nil, err
	}

	// Attach session metadata + index bookkeeping for claude panes. Other
	// adapters leave SessionID/SessionName empty — the Satellite hides
	// the label, so no UI work is needed here.
	if kind == proto.PaneKindClaude && m.sessions != nil {
		now := time.Now().UTC()
		switch {
		case plan.ResumedSessionID != "" && resumeEntry != nil:
			pane.SessionID = resumeEntry.SessionID
			pane.SessionName = resumeEntry.Name
			resumeEntry.LastActiveAt = now
			resumeEntry.LastPaneID = pane.ID
			resumeEntry.WasLive = true
			if err := m.sessions.Upsert(projectID, *resumeEntry); err != nil {
				slog.Warn("sessions: upsert on resume failed", "err", err, "project", projectID, "session", shortSessionID(resumeEntry.SessionID))
			}
		case plan.NewSessionID != "":
			pane.SessionID = plan.NewSessionID
			pane.SessionName = plan.SessionName
			if err := m.sessions.Upsert(projectID, sessions.Entry{
				Kind:         proto.PaneKindClaude,
				SessionID:    plan.NewSessionID,
				Name:         plan.SessionName,
				Cwd:          proj.Cwd,
				CreatedAt:    now,
				LastActiveAt: now,
				LastPaneID:   pane.ID,
				WasLive:      true,
			}); err != nil {
				slog.Warn("sessions: upsert on spawn failed", "err", err, "project", projectID, "session", shortSessionID(plan.NewSessionID))
			}
		}
		sid := pane.SessionID
		pid := pane.ID
		pane.OnExit(func(string) {
			if err := m.sessions.Touch(projectID, sid, pid, time.Now().UTC()); err != nil {
				slog.Warn("sessions: touch on exit failed", "err", err, "project", projectID, "session", shortSessionID(sid))
			}
		})
	}

	// Shell- and codex-pane session bookkeeping (Scope B). Both are
	// slot-identified (no Claude session): fresh spawns get a new SlotID
	// and a new Entry with the resolved argv captured for later restore;
	// the restore path reuses the same SlotID and bumps
	// LastActiveAt/LastPaneID/WasLive on the existing entry. The exit
	// callback touches last_active_at same as the Claude flow so the
	// restore-candidate heuristic has a fresh timestamp to report. Codex
	// mirrors shell here — it has no session to resume, so slot continuity
	// is what lets a codex tab survive a daemon restart.
	if (kind == proto.PaneKindShell || kind == proto.PaneKindCodex) && m.sessions != nil {
		now := time.Now().UTC()
		switch {
		case restoreEntry != nil:
			pane.SlotID = restoreEntry.SlotID
			restoreEntry.LastActiveAt = now
			restoreEntry.LastPaneID = pane.ID
			restoreEntry.WasLive = true
			if err := m.sessions.Upsert(projectID, *restoreEntry); err != nil {
				slog.Warn("sessions: upsert on slot restore failed", "kind", kind, "err", err, "project", projectID, "slot", shortSessionID(restoreEntry.SlotID))
			}
		default:
			pane.SlotID = sessions.NewUUID()
			// plan.Argv is the already-resolved absolute argv the
			// adapter chose. Storing it + spawnCwd means restore
			// ignores any subsequent edit to Project.Shell / Project.Cwd
			// — the original spawn is the invariant per the Scope B
			// spec. spawnCwd (== proj.Cwd on fresh shells) is what the
			// child actually ran in, so it's the honest record.
			argv := append([]string(nil), plan.Argv...)
			if err := m.sessions.Upsert(projectID, sessions.Entry{
				Kind:         kind,
				SlotID:       pane.SlotID,
				Cwd:          spawnCwd,
				ShellArgv:    argv,
				CreatedAt:    now,
				LastActiveAt: now,
				LastPaneID:   pane.ID,
				WasLive:      true,
			}); err != nil {
				slog.Warn("sessions: upsert on slot spawn failed", "kind", kind, "err", err, "project", projectID, "slot", shortSessionID(pane.SlotID))
			}
		}
		slot := pane.SlotID
		pid := pane.ID
		pane.OnExit(func(string) {
			if err := m.sessions.Touch(projectID, slot, pid, time.Now().UTC()); err != nil {
				slog.Warn("sessions: slot touch on exit failed", "kind", kind, "err", err, "project", projectID, "slot", shortSessionID(slot))
			}
		})
	}

	pane.OnStoplightChange(func(s proto.Stoplight) {
		m.recomputeAggregate(projectID)
		m.notifyStateChange()
	})
	pane.OnExit(func(paneID string) {
		// Drop the pane's AutoName cache row so the cache doesn't grow
		// unbounded across the daemon's lifetime. Safe to call with an
		// unknown id (no-op). an earlier release.
		if m.autoNames != nil {
			m.autoNames.Forget(paneID)
		}
		m.notifyStateChange()
	})
	m.mu.Lock()
	m.byProj[projectID] = append(m.byProj[projectID], pane)
	m.byID[pane.ID] = pane
	m.mu.Unlock()
	m.recomputeAggregate(projectID)
	m.notifyStateChange()
	return pane, nil
}

// GetPane looks up a pane by project + pane id.
func (m *Manager) GetPane(projectID, paneID string) (*Pane, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	pane, ok := m.byID[paneID]
	if !ok || pane.ProjectID != projectID {
		return nil, false
	}
	return pane, true
}

// PaneByID looks up a pane without requiring the caller to know its
// project. Used by the agent-event endpoint since hook shims only receive
// the pane ID via RECK_PANE_ID.
func (m *Manager) PaneByID(paneID string) (*Pane, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	pane, ok := m.byID[paneID]
	return pane, ok
}

// isSlotLiveLocked reports whether any currently-registered pane owns
// the given SlotID. Used by the restore path to reject a RestoreSlotID
// that's already attached to a running pane — without this, a double-
// restore (concurrent call, stale retry, hand-crafted API request)
// would spawn a duplicate live pane aliasing the same store row, and
// rename / liveness / delete bookkeeping would become non-deterministic.
// Caller must hold m.mu (Lock or RLock).
func (m *Manager) isSlotLiveLocked(slot string) bool {
	if slot == "" {
		return false
	}
	for _, p := range m.byID {
		if p.SlotID == slot {
			return true
		}
	}
	return false
}

// DeletePane kills and removes a pane. Graceful close — so if this was
// a claude pane with a session, the index's was_live flag is cleared:
// next daemon start shouldn't offer to restore a session the user
// explicitly ended.
func (m *Manager) DeletePane(projectID, paneID string) error {
	m.mu.Lock()
	pane, ok := m.byID[paneID]
	if !ok || pane.ProjectID != projectID {
		m.mu.Unlock()
		return errors.New("pane not found")
	}
	// Identity = SessionID for Claude, SlotID for shell. SetLive
	// matches on either via entryMatches — whichever is non-empty wins.
	identity := pane.SessionID
	if identity == "" {
		identity = pane.SlotID
	}
	delete(m.byID, paneID)
	list := m.byProj[projectID]
	for i, pn := range list {
		if pn.ID == paneID {
			m.byProj[projectID] = append(list[:i], list[i+1:]...)
			break
		}
	}
	m.mu.Unlock()
	if m.sessions != nil && identity != "" {
		if err := m.sessions.SetLive(projectID, identity, false); err != nil {
			slog.Warn("sessions: clear was_live on graceful close failed", "err", err, "project", projectID, "id", shortSessionID(identity))
		}
	}
	pane.Kill()
	m.recomputeAggregate(projectID)
	return nil
}

// AllPanes returns every live pane (for the stoplight ticker).
func (m *Manager) AllPanes() []*Pane {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Pane, 0, len(m.byID))
	for _, p := range m.byID {
		out = append(out, p)
	}
	return out
}

// RestoreOrphansResult summarises a RestoreOrphans run for callers
// (typically the daemon main, which logs the totals).
type RestoreOrphansResult struct {
	Restored int
	Skipped  int
	Failed   int
	// ReadOnly counts Claude sessions kept but not respawned because their
	// git worktree is gone (issue #56): the transcript is intact and stays
	// viewable, but resuming in the wrong cwd would fork a fresh one, so
	// was_live is cleared and the session is left read-only. Distinct from
	// Failed (an actual respawn error) so the boot summary is honest.
	ReadOnly int
}

// isWithinProject reports whether cwd is the project root itself or a directory
// nested under it — the test the restore guard uses to tell a legitimate
// worktree/subdir cwd (allow) from a foreign path left by a reused project ID
// (skip). Uses filepath.Rel so ".." traversal and shared-prefix siblings
// (/a/projX vs /a/proj) are correctly rejected.
func isWithinProject(cwd, projectRoot string) bool {
	c := filepath.Clean(cwd)
	r := filepath.Clean(projectRoot)
	if c == r {
		return true
	}
	rel, err := filepath.Rel(r, c)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// RestoreOrphans is the daemon-startup auto-restore path for issue
// #228. It walks the sessions store for entries that the previous
// daemon run last observed alive (WasLive=true with a non-empty
// LastPaneID), finds the ones not currently bound to a live pane,
// and respawns each via CreatePaneWith{ResumeSessionID|RestoreSlotID}.
//
// "Orphan" matches the legacy /restore-candidates definition exactly
// — the satellite-side prompt path used to walk the same set. With
// auto-restore on, the daemon drains them at boot and the satellite
// never sees a candidate.
//
// Failures (e.g. cwd gone, claude --resume rejected, shell argv
// no longer executable) clear the entry's WasLive flag so the next
// boot doesn't keep retrying. Successes leave WasLive=true on the
// re-upserted entry — that's what the existing CreatePaneWith path
// does on a normal user-driven restore.
//
// Best-effort: errors on individual entries are logged + counted but
// don't abort the rest of the walk. Panes that fail can still be
// recovered later via a manual user action (the /restore-candidates
// endpoint stays as a diagnostic + offline-broker fallback).
//
// Returns the per-run summary so caller can log it.
func (m *Manager) RestoreOrphans(cols, rows int) RestoreOrphansResult {
	var total RestoreOrphansResult
	if m.sessions == nil {
		return total
	}
	// Snapshot (id, cwd) for non-hidden projects, flagging archived ones.
	// Archived projects deliberately keep was_live=true rows so unarchive can
	// respawn them on demand — the boot walk must NOT resurrect them, or
	// archiving wouldn't survive a daemon restart.
	type projRef struct {
		id, cwd  string
		archived bool
	}
	m.mu.RLock()
	refs := make([]projRef, 0, len(m.projects))
	for id, p := range m.projects {
		if IsHiddenProjectID(id) {
			continue
		}
		refs = append(refs, projRef{id: id, cwd: p.Cwd, archived: p.Archived})
	}
	m.mu.RUnlock()
	for _, ref := range refs {
		if ref.archived {
			continue
		}
		r := m.restoreProjectOrphans(ref.id, ref.cwd, cols, rows)
		total.Restored += r.Restored
		total.Skipped += r.Skipped
		total.Failed += r.Failed
		total.ReadOnly += r.ReadOnly
	}
	return total
}

// claudeProjectsDirOrDefault returns the configured Claude transcript root, or
// the conventional ~/.claude/projects when unset. Empty string means "couldn't
// resolve" (no HOME) — callers treat that as "can't inspect the disk".
func (m *Manager) claudeProjectsDirOrDefault() string {
	if m.claudeProjectsDir != "" {
		return m.claudeProjectsDir
	}
	d, err := sessions.DefaultClaudeProjectsDir()
	if err != nil {
		return ""
	}
	return d
}

// resolveResumeCwd returns the directory `claude --resume <sessionID>` must
// launch in to rehydrate the existing transcript rather than fork a fresh one,
// and self-heals a mis-recorded worktree cwd along the way (issue #56).
//
// recordedCwd is the session entry's stored cwd (the pane's launch cwd). The
// resolution order:
//
//  1. Canonical: the transcript is already at recordedCwd's (or the project
//     root's) encoded folder — a plain stat, so normal sessions never touch git.
//  2. Live worktree: the session ran in a git worktree that still exists —
//     return that worktree cwd so the resume continues there.
//  3. Gone worktree (git confirmed): the transcript survives under a
//     worktree-suffixed folder but the worktree was removed. Relocate the
//     transcript into the project-root folder and resume there, so the session
//     comes back live with its full history instead of forking a fresh one.
//  4. No transcript anywhere: nothing to orphan — resume in the recorded cwd
//     (legacy behaviour preserved).
//
// ok=false means the resume must be refused (ErrResumeWorktreeGone): the
// transcript is present but git couldn't confirm the worktree is gone (git
// unavailable / transient failure), so relocating could strand a still-live
// worktree session. The caller keeps it read-only and retries on the next boot.
func (m *Manager) resolveResumeCwd(projectRoot, recordedCwd, sessionID string) (string, bool) {
	dir := m.claudeProjectsDirOrDefault()
	if dir == "" {
		// Can't inspect the disk — trust the recorded cwd rather than block
		// an otherwise-valid resume.
		return recordedCwd, true
	}
	// (1) Canonical candidates first (a plain stat) so a normal session pays
	// no git cost. projectRoot is included in case a row references a subdir
	// whose transcript actually landed at the root.
	canonical := []string{recordedCwd}
	if recordedCwd != projectRoot {
		canonical = append(canonical, projectRoot)
	}
	if cwd, ok := sessions.ResolveTranscriptCwd(dir, sessionID, canonical); ok {
		return cwd, true
	}
	// (2) Live worktree — match the transcript against the project's registered
	// worktrees. gitOK reports whether git actually ran (vs. missing/failed).
	worktrees, gitOK := gitWorktreePaths(projectRoot)
	if cwd, ok := sessions.ResolveTranscriptCwd(dir, sessionID, worktrees); ok {
		return cwd, true
	}
	// The transcript isn't at the canonical path or any live worktree.
	orphan, present := sessions.FindTranscriptUnderProject(dir, projectRoot, sessionID)
	if !present {
		// (4) No transcript anywhere → nothing to orphan; resume as before.
		return recordedCwd, true
	}
	if !gitOK {
		// Transcript present but git couldn't confirm the worktree set. Don't
		// relocate — a transient git failure must not strand a live worktree
		// session. Refuse; the caller keeps it read-only and retries next boot.
		return "", false
	}
	// (3) Gone worktree, git-confirmed: relocate the transcript into the
	// project-root folder and resume there.
	dest := sessions.TranscriptPath(dir, projectRoot, sessionID)
	if err := migrateTranscript(orphan, dest); err != nil {
		slog.Warn("resume: migrate orphaned worktree transcript failed — keeping read-only",
			"err", err, "session", shortSessionID(sessionID), "from", orphan, "to", dest)
		return "", false
	}
	slog.Info("resume: relocated orphaned worktree transcript to project root",
		"session", shortSessionID(sessionID), "from", orphan, "to", dest)
	return projectRoot, true
}

// RestoreProjectOrphans drains the sessions-store orphans for a single
// project. Used after a hybrid-mode PUT /projects adds a project ID
// that wasn't in projects.toml at boot — RestoreOrphans only walks
// projects already registered, so a newly-pushed ID never gets its
// orphans respawned without this hook.
//
// No-op when the project isn't registered (sessions can't be respawned
// without a known cwd) or when the sessions store is unavailable. The
// caller must pass the project's current authoritative cwd; entries
// whose stored Cwd differs are skipped to defend against project-ID
// reuse via PUT /projects (Codex adversarial review finding: a PUT
// payload that re-uses a dormant project ID with a different cwd would
// otherwise respawn the prior project's was_live=true rows under the
// new registration). Mismatched rows have their was_live cleared so
// the next boot doesn't keep retrying them.
func (m *Manager) RestoreProjectOrphans(projectID, projectCwd string, cols, rows int) RestoreOrphansResult {
	var result RestoreOrphansResult
	if m.sessions == nil {
		return result
	}
	return m.restoreProjectOrphans(projectID, projectCwd, cols, rows)
}

// restoreProjectOrphans is the per-project worker shared by RestoreOrphans
// (boot path) and RestoreProjectOrphans (hot-add path). Caller must NOT
// hold m.mu — CreatePaneWith acquires the lock itself.
//
// projectCwd is the project's CURRENT authoritative cwd at call time
// (snapshotted by the caller). Used to skip entries whose stored Cwd
// no longer matches — see RestoreProjectOrphans doc for the threat
// model.
func (m *Manager) restoreProjectOrphans(projectID, projectCwd string, cols, rows int) RestoreOrphansResult {
	var result RestoreOrphansResult
	if m.sessions == nil {
		return result
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if !m.ProjectExists(projectID) {
		return result
	}
	// List gates claude entries on transcriptExists; use the same projects
	// dir the resume path (resolveResumeCwd) will use, so the visibility gate
	// and the recovery agree. Empty → List defaults to ~/.claude/projects,
	// which is exactly what resolveResumeCwd defaults to as well.
	entries, err := m.sessions.List(projectID, sessions.ListOptions{ClaudeProjectsDir: m.claudeProjectsDir})
	if err != nil {
		slog.Warn("restore-orphans: list failed", "err", err, "project", projectID)
		return result
	}
	if len(entries) == 0 {
		return result
	}
	livePanes := m.PanesInProject(projectID)
	livePaneIDs := make(map[string]bool, len(livePanes))
	for _, p := range livePanes {
		livePaneIDs[p.ID] = true
	}
	wantCwd := filepath.Clean(projectCwd)
	for _, e := range entries {
		if !e.WasLive || e.LastPaneID == "" || livePaneIDs[e.LastPaneID] {
			continue
		}
		// Cwd-mismatch guard (Codex adversarial review finding).
		// If the stored row references a cwd outside the project
		// currently registered under this ID, the row belongs to a
		// prior incarnation of the ID and must NOT be respawned under
		// the new registration. Clear was_live so the row stops
		// resurfacing each boot, then skip.
		//
		// A cwd *within* the project (the root or a nested git
		// worktree) is legitimate — #56 self-heals worktree sessions
		// to their worktree cwd, a descendant of the root — so the
		// check allows descendants and only rejects foreign paths.
		// projectCwd == "" disables the check (boot path uses
		// proj.Cwd from m.Projects() which is always populated;
		// programmatic callers passing "" opt out deliberately).
		if wantCwd != "" {
			if !isWithinProject(e.Cwd, wantCwd) {
				slog.Warn("restore-orphans: cwd mismatch — skipping + clearing was_live",
					"project", projectID,
					"kind", e.Kind,
					"identity", shortSessionID(e.Identity()),
					"stored_cwd", e.Cwd,
					"current_cwd", projectCwd,
				)
				if cerr := m.sessions.SetLive(projectID, e.Identity(), false); cerr != nil {
					slog.Warn("restore-orphans: clear was_live on cwd-mismatch failed",
						"err", cerr, "project", projectID, "identity", shortSessionID(e.Identity()))
				}
				result.Skipped++
				continue
			}
		}
		// Guard: a corrupt row with no SessionID and no SlotID
		// has no identity to resume against. Without this guard
		// CreatePaneWith would fall through to a fresh-spawn path
		// (because empty ResumeSessionID/RestoreSlotID means
		// "no resume requested"), which would manufacture a
		// brand-new pane on every boot. Skip + try to clear
		// WasLive, but SetLive("") is a no-op on the store side
		// — the row stays orphaned forever and that's the lesser
		// evil vs. spurious panes.
		identity := e.Identity()
		if identity == "" {
			slog.Warn("restore-orphans: skipping row with no identity",
				"project", projectID, "kind", e.Kind, "last_pane_id", e.LastPaneID)
			result.Skipped++
			continue
		}
		opts := CreatePaneOptions{}
		switch e.Kind {
		case proto.PaneKindClaude:
			opts.ResumeSessionID = e.SessionID
		case proto.PaneKindShell, proto.PaneKindCodex:
			opts.RestoreSlotID = e.SlotID
		default:
			// Unknown kind — leave alone.
			result.Skipped++
			continue
		}
		pane, err := m.CreatePaneWith(projectID, e.Kind, cols, rows, opts)
		if err != nil {
			// #56: the session's git worktree is gone, so it can't be
			// resumed in the right cwd. This is expected, not a failure —
			// keep the transcript viewable read-only and stop retrying by
			// clearing was_live. Distinguished from a real respawn error
			// so the boot summary and logs stay honest.
			readOnly := errors.Is(err, ErrResumeWorktreeGone)
			if readOnly {
				slog.Info("restore-orphans: worktree gone — keeping session read-only",
					"project", projectID,
					"identity", shortSessionID(identity),
				)
			} else {
				slog.Warn("restore-orphans: respawn failed",
					"err", err,
					"project", projectID,
					"kind", e.Kind,
					"identity", shortSessionID(identity),
				)
			}
			if cerr := m.sessions.SetLive(projectID, identity, false); cerr != nil {
				slog.Warn("restore-orphans: clear was_live failed",
					"err", cerr, "project", projectID, "identity", shortSessionID(identity))
			}
			if readOnly {
				result.ReadOnly++
			} else {
				result.Failed++
			}
			continue
		}
		// Partial-success guard: CreatePaneWith logs-and-continues
		// when its post-spawn Upsert fails (warn-only, returns
		// nil). Verify the entry's LastPaneID was actually
		// re-bound to the freshly spawned pane; if not, the
		// pane is alive but the session row still points at
		// the old orphan id, so the next boot would try to
		// restore it again. Count as Failed so the operator
		// sees the partial state in the summary log.
		//
		// Race note: OnExit Touch can also rewrite LastPaneID
		// if the child has already exited. That's fine — Touch
		// only updates a row that already matches identity, and
		// in either case "the row no longer points at the old
		// orphan" is what we want to verify.
		refreshed, ok, gerr := m.sessions.Get(projectID, identity)
		if gerr != nil || !ok || refreshed.LastPaneID != pane.ID {
			slog.Warn("restore-orphans: bookkeeping incomplete after respawn",
				"project", projectID,
				"kind", e.Kind,
				"identity", shortSessionID(identity),
				"want_pane", pane.ID,
				"got_pane", refreshed.LastPaneID,
				"err", gerr,
			)
			result.Failed++
			continue
		}
		result.Restored++
	}
	return result
}

// PanesInProject returns live panes for a project.
func (m *Manager) PanesInProject(id string) []*Pane {
	m.mu.RLock()
	defer m.mu.RUnlock()
	list := m.byProj[id]
	out := make([]*Pane, len(list))
	copy(out, list)
	return out
}

// ProjectExists tells whether a project ID is registered.
func (m *Manager) ProjectExists(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.projects[id]
	return ok
}

// DefaultPaneKind returns the configured default for a project.
func (m *Manager) DefaultPaneKind(id string) proto.PaneKind {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.projects[id]
	if !ok {
		return proto.PaneKindClaude
	}
	return proto.PaneKind(p.DefaultPane)
}

// EnsureDefaultPane atomically spawns a default-kind pane in the project
// if and only if (a) the project exists, (b) it currently has zero live
// panes, and (c) no other goroutine is already running this same check
// for the same project. Returns the spawned pane (and true) when this
// call won the race, (nil, false, nil) when the spawn was unnecessary or
// already in flight on another goroutine, or (nil, false, err) when the
// CreatePaneWith call itself failed.
//
// an earlier release follow-up (Codex HIGH): the previous HTTP-handler shape did
// `len(PanesInProject) == 0` (RLock release) then `CreatePane`
// (independent lock acquisition). Two concurrent GET /projects/:id
// requests — browser auto-refresh, hybrid-mode primary+secondary pair,
// or even just a double-clicking user — could both observe empty and
// both spawn a starter pane. Atomic claim of `defaultSpawnInFlight[id]`
// under m.mu serialises the empty-check with the spawn intent so only
// the first caller proceeds; the second sees the flag (or, if the spawn
// already finished, a non-empty pane list) and returns false.
func (m *Manager) EnsureDefaultPane(projectID string, cols, rows int) (*Pane, bool, error) {
	m.mu.Lock()
	if _, exists := m.projects[projectID]; !exists {
		m.mu.Unlock()
		return nil, false, nil
	}
	if len(m.byProj[projectID]) > 0 {
		m.mu.Unlock()
		return nil, false, nil
	}
	if m.defaultSpawnInFlight[projectID] {
		m.mu.Unlock()
		return nil, false, nil
	}
	m.defaultSpawnInFlight[projectID] = true
	kind := proto.PaneKind(m.projects[projectID].DefaultPane)
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.defaultSpawnInFlight, projectID)
		m.mu.Unlock()
	}()

	pane, err := m.CreatePaneWith(projectID, kind, cols, rows, CreatePaneOptions{})
	if err != nil {
		return nil, false, err
	}
	return pane, true, nil
}

// AddMetaProject registers a hidden project (ID must start with "__") in
// the Manager without persisting to projects.toml. Used by the Mission
// Control supervisor to host its internal pane. Safe to call repeatedly —
// returns nil when the meta-project is already registered.
func (m *Manager) AddMetaProject(req proto.AddProjectRequest) error {
	if !IsHiddenProjectID(req.ID) {
		return errors.New("meta-project ID must start with __")
	}
	if req.Cwd == "" {
		return errors.New("meta-project cwd required")
	}
	st, err := os.Stat(req.Cwd)
	if err != nil || !st.IsDir() {
		return errors.New("meta-project cwd must be an existing directory")
	}
	m.mu.Lock()
	if _, ok := m.projects[req.ID]; ok {
		m.mu.Unlock()
		return nil
	}
	p := config.Project{
		ID:          req.ID,
		Name:        req.Name,
		Cwd:         req.Cwd,
		DefaultPane: string(req.DefaultPane),
		Shell:       req.Shell,
		Preamble:    req.Preamble,
		// Meta-projects only register after the cwd check at the top of
		// AddMetaProject; they're always available for as long as they're
		// registered. (Hidden anyway — Projects() filters them out.)
		Available: true,
	}
	if p.DefaultPane == "" {
		p.DefaultPane = "claude"
	}
	if len(p.Shell) == 0 {
		// Meta-projects (the MC supervisor) don't ship their own shell;
		// fall through to the daemon-resolved default, which is already
		// absolute (see NewManagerFromConfig doc comment).
		p.Shell = append([]string(nil), m.defaultShell...)
	}
	m.projects[req.ID] = p
	m.projStoplight[req.ID] = proto.StoplightGray
	m.mu.Unlock()
	return nil
}

// SetProjectPreamble updates a project's runtime preamble. Used by the
// Mission Control supervisor to refresh the supervisor pane's system
// prompt between spawns. The change is NOT persisted to projects.toml —
// preamble lives in memory for the current daemon process only.
// Returns error when the project is unknown.
func (m *Manager) SetProjectPreamble(id, preamble string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.projects[id]
	if !ok {
		return errors.New("project not found")
	}
	p.Preamble = preamble
	m.projects[id] = p
	return nil
}

// RunLivenessTicker periodically refreshes last_active_at for every
// live pane with a persistent identity (Claude SessionID or shell
// SlotID). The purpose is bounding the staleness gap between "daemon
// was last known good" and "daemon crashed" — a 15s tick means the
// restore prompt can say something like "running 20 seconds ago"
// rather than "running at 10am" when the real crash was seconds ago.
//
// Safe to call when the sessions store is nil — becomes a no-op.
// Blocks until ctx is cancelled.
func (m *Manager) RunLivenessTicker(ctx context.Context, interval time.Duration) {
	if m.sessions == nil {
		<-ctx.Done()
		return
	}
	if interval <= 0 {
		interval = 15 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now().UTC()
			for _, p := range m.AllPanes() {
				identity := p.SessionID
				if identity == "" {
					identity = p.SlotID
				}
				if identity == "" {
					continue
				}
				if err := m.sessions.Touch(p.ProjectID, identity, p.ID, now); err != nil {
					slog.Warn("sessions: periodic touch failed", "err", err, "pane", p.ID, "id", shortSessionID(identity))
				}
			}
		}
	}
}

// recomputeAggregate updates the cached project-level stoplight.
func (m *Manager) recomputeAggregate(projectID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := m.byProj[projectID]
	agg := proto.StoplightGray
	for _, p := range list {
		s := p.Info().Stoplight
		if proto.StoplightSeverity(s) > proto.StoplightSeverity(agg) {
			agg = s
		}
	}
	m.projStoplight[projectID] = agg
}
