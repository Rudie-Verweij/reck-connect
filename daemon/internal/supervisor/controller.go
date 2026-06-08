// Package supervisor owns the Mission Control supervisor pane — a
// dedicated Claude Code instance spawned with a supervisor system prompt
// and loopback access to the daemon's HTTP API. The supervisor uses its
// built-in Bash+curl (and Read/Grep over docked project cwds) as its tool
// surface — no MCP server required.
//
// Ownership model:
//
//   - A single hidden meta-project (`__reck_supervisor__`) is registered
//     in the Manager. It does not show up in /projects or on the rail.
//   - The supervisor pane lives inside that meta-project. Starting it
//     spawns a fresh claude pane; stopping it kills the pane.
//   - The meta-project's cwd is a scratch directory under
//     $XDG_STATE_HOME (or ~/.local/state) — any work the supervisor
//     needs to do on disk lives there, separate from any real project.
//
// The package implements the http.MissionControlHandler interface so the
// daemon's router can wire it up without importing this package directly.
package supervisor

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

// SupervisorProjectID is the reserved meta-project ID hosting the
// supervisor pane. The Manager filters it out of Projects() /
// DockedProjects() so it never appears in normal listings.
const SupervisorProjectID = "__reck_supervisor__"

// SupervisorTokenEnvVar is the environment variable name that carries
// the supervisor's bearer token into its Claude pane. Separate from the
// main DAEMON_TOKEN so the supervisor's scope can be enforced at the
// auth layer (docked projects only) and so compromise of the supervisor
// doesn't surface the daemon's full bearer to the rest of the station.
const SupervisorTokenEnvVar = "RECK_SUPERVISOR_TOKEN"

// Controller is the Mission Control runtime. Construct with New and wire
// its HTTP handlers into the daemon router.
type Controller struct {
	mgr         *pty.Manager
	daemonURL   string
	tokenEnvVar string // name of env var carrying the supervisor's token inside its pane
	scratchDir  string
	alerts      *alertDispatcher

	// token is the supervisor's own bearer. It's generated once at
	// controller construction and never persisted; a daemon restart
	// rotates it, which is fine because the supervisor pane is
	// re-spawned at the same time.
	token string

	mu          sync.Mutex
	paneID      string // "" when the supervisor pane is not running
	subscribers map[int]chan proto.MissionControlStateResponse
	nextSub     int

	// startGate serialises StartSupervisor across concurrent callers AND
	// coordinates with StopSupervisor. When a spawn is in flight
	// startInFlight is non-nil and subsequent callers block on it, then
	// read startResultID / startResultErr once it closes. Without this,
	// two callers can both observe "no pane" under mu, both drop the
	// lock, and both call CreatePaneWith — producing two supervisor
	// panes, one of which leaks (the second write to paneID clobbers
	// the first).
	//
	// stopGeneration lets StopSupervisor cancel any in-flight or
	// about-to-start spawn. Each StartSupervisor captures the current
	// stopGeneration at its entry; after the (long, unlocked)
	// CreatePaneWith call returns the goroutine re-acquires startGate
	// and checks whether any Stop ran between entry and publish. If
	// so, the freshly-created pane is torn down immediately and
	// ErrSupervisorStopRequested is returned — the supervisor does
	// NOT end up running after an explicit stop request, even when
	// stop raced in mid-spawn.
	startGate      sync.Mutex
	startInFlight  chan struct{}
	startResultID  string
	startResultErr error
	stopGeneration uint64

	// testSpawnMidFn is a test-only hook called by doStartSupervisor
	// after CreatePaneWith returns but before the stop-race check and
	// paneID publish. Production is nil; set by tests that want to
	// deterministically race StopSupervisor with an in-flight spawn.
	testSpawnMidFn func()
}

// ErrSupervisorStopRequested is returned by StartSupervisor when
// StopSupervisor races in during the spawn window. The freshly-created
// pane (if any) is torn down before the error returns — callers can
// retry start cleanly or take the stop at face value.
var ErrSupervisorStopRequested = errors.New("supervisor: stop requested during start")

// Config configures a Controller.
type Config struct {
	Manager *pty.Manager
	// DaemonURL is the loopback URL the supervisor uses to reach the
	// daemon, e.g. "http://127.0.0.1:7315".
	DaemonURL string
	// AuthRequired indicates whether the daemon is running with a
	// DAEMON_TOKEN set. When false, no supervisor token is generated
	// and the supervisor pane gets no auth env — the system prompt
	// renders curl calls without the Authorization header.
	AuthRequired bool
	// ScratchDirRoot is the parent directory under which the meta-project
	// cwd is created. Defaults to $XDG_STATE_HOME/reck (or ~/.local/state/reck).
	ScratchDirRoot string
}

// New constructs a Controller, ensures the meta-project exists, and
// returns it ready to serve HTTP handlers. Does NOT auto-start the
// supervisor pane — the user kicks it off from the Satellite MC view.
func New(cfg Config) (*Controller, error) {
	if cfg.Manager == nil {
		return nil, errors.New("supervisor: Manager required")
	}
	if cfg.DaemonURL == "" {
		return nil, errors.New("supervisor: DaemonURL required")
	}
	scratchRoot := cfg.ScratchDirRoot
	if scratchRoot == "" {
		if s := os.Getenv("XDG_STATE_HOME"); s != "" {
			scratchRoot = filepath.Join(s, "reck")
		} else if h, err := os.UserHomeDir(); err == nil && h != "" {
			scratchRoot = filepath.Join(h, ".local", "state", "reck")
		} else {
			scratchRoot = filepath.Join(os.TempDir(), "reck-state")
		}
	}
	scratch := filepath.Join(scratchRoot, "supervisor")
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		return nil, fmt.Errorf("supervisor: mkdir %s: %w", scratch, err)
	}

	var token, tokenEnv string
	if cfg.AuthRequired {
		var err error
		token, err = generateToken()
		if err != nil {
			return nil, fmt.Errorf("supervisor: token gen: %w", err)
		}
		tokenEnv = SupervisorTokenEnvVar
	}
	c := &Controller{
		mgr:         cfg.Manager,
		daemonURL:   cfg.DaemonURL,
		tokenEnvVar: tokenEnv,
		scratchDir:  scratch,
		token:       token,
		subscribers: make(map[int]chan proto.MissionControlStateResponse),
	}
	c.alerts = newAlertDispatcher(c)

	if err := c.ensureMetaProject(); err != nil {
		return nil, err
	}

	// Subscribe to manager state-change notifications. We both broadcast
	// MC snapshots to WebSocket clients AND fan the transitions into the
	// alert dispatcher, which turns meaningful changes into "[reck] …"
	// lines injected into the supervisor pane's stdin.
	cfg.Manager.OnStateChange(c.handleStateChange)

	return c, nil
}

// handleStateChange is the single Manager.OnStateChange listener. It
// first runs the alert dispatcher (fast in-memory diff) and then fans
// out the full snapshot to WebSocket subscribers. Ordering matters —
// alerts should reach the supervisor before the Satellite UI refresh,
// since the user often watches both at once and we want the narrative
// to line up.
func (c *Controller) handleStateChange() {
	c.alerts.onStateChange()
	c.broadcastState()
}

// ensureMetaProject registers the reserved supervisor meta-project in
// the Manager if it isn't already present. In-memory only — the
// supervisor doesn't round-trip through projects.toml. Idempotent.
func (c *Controller) ensureMetaProject() error {
	if c.mgr.ProjectExists(SupervisorProjectID) {
		return nil
	}
	return c.mgr.AddMetaProject(proto.AddProjectRequest{
		ID:          SupervisorProjectID,
		Name:        "Mission Control Supervisor",
		Cwd:         c.scratchDir,
		DefaultPane: "claude",
	})
}

// SupervisorOnline reports whether the supervisor pane is currently alive.
func (c *Controller) SupervisorOnline() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.paneID == "" {
		return false
	}
	p, ok := c.mgr.PaneByID(c.paneID)
	if !ok || p.State() == proto.PaneStateExited {
		c.paneID = ""
		return false
	}
	return true
}

// StartSupervisor spawns the supervisor pane if it isn't already running.
// Returns the pane ID. Idempotent — calling it while the pane is alive
// returns the existing pane ID. Safe under concurrent callers: a singleflight
// gate (startGate + startInFlight) ensures only one spawn is attempted at
// a time; additional callers block on the in-flight channel and read the
// result. Without the gate, two goroutines could both observe "no pane"
// under mu, both drop the lock, and both call CreatePaneWith — producing
// two supervisor panes where only one is tracked (and the untracked one
// leaks, running with supervisor credentials).
//
// Start/Stop coordination: StartSupervisor captures the current
// stopGeneration before releasing startGate. After CreatePaneWith
// returns, the goroutine re-acquires startGate and checks whether
// stopGeneration has moved (i.e. StopSupervisor ran during the spawn
// window) or stopRequested is set. If either is true, the freshly-
// created pane is torn down and ErrSupervisorStopRequested is returned.
// This closes the pre-fix race where StopSupervisor could observe no
// paneID, report success, and still leave a supervisor pane running
// after the in-flight spawn published its pane ID.
func (c *Controller) StartSupervisor() (string, error) {
	// Capture the stopGeneration at Start's entry — BEFORE the fast
	// path or gate claim. A Stop that fires any time between now and
	// the post-spawn publish check bumps stopGeneration, causing the
	// check to fail and the freshly-created pane to be torn down.
	// Capturing at entry (not at claim) is deliberate: it makes the
	// window for "Stop wins over concurrent Start" cover the caller's
	// entire in-flight time, matching the Codex-finding invariant
	// that concurrent Stop/Start must leave the supervisor stopped.
	c.startGate.Lock()
	myStopGen := c.stopGeneration
	c.startGate.Unlock()

	// Fast path: already-running pane check. Held under the main
	// controller lock so the pane-id write and the pane-exit callback
	// serialise against each other.
	c.mu.Lock()
	if c.paneID != "" {
		if p, ok := c.mgr.PaneByID(c.paneID); ok && p.State() != proto.PaneStateExited {
			id := c.paneID
			c.mu.Unlock()
			return id, nil
		}
		c.paneID = ""
	}
	c.mu.Unlock()

	// Startup gate. If a spawn is already in flight, block on its
	// completion and return its result instead of double-spawning.
	c.startGate.Lock()
	if c.startInFlight != nil {
		waitCh := c.startInFlight
		c.startGate.Unlock()
		<-waitCh
		// Re-read the shared result under the gate. The spawn goroutine
		// writes both fields before closing the channel.
		c.startGate.Lock()
		id, err := c.startResultID, c.startResultErr
		c.startGate.Unlock()
		return id, err
	}
	// Recheck the pane under the gate — another goroutine might have
	// spawned and finished between our fast-path read and the gate
	// acquisition. Without this, the N+1th caller after a successful
	// spawn would pointlessly spawn again.
	c.mu.Lock()
	if c.paneID != "" {
		if p, ok := c.mgr.PaneByID(c.paneID); ok && p.State() != proto.PaneStateExited {
			id := c.paneID
			c.mu.Unlock()
			c.startGate.Unlock()
			return id, nil
		}
		c.paneID = ""
	}
	c.mu.Unlock()
	// Claim the in-flight slot. stopRequested is NOT cleared here —
	// a Stop that raced in before our claim must still win. Only a
	// post-spawn check against myStopGen (captured at entry above)
	// determines whether the publish proceeds.
	done := make(chan struct{})
	c.startInFlight = done
	c.startResultID = ""
	c.startResultErr = nil
	c.startGate.Unlock()

	id, err := c.doStartSupervisor(myStopGen)

	c.startGate.Lock()
	c.startResultID = id
	c.startResultErr = err
	c.startInFlight = nil
	c.startGate.Unlock()
	close(done)
	return id, err
}

// doStartSupervisor is the actual spawn path, run under the singleflight
// gate so only one invocation is active at a time. Separated from
// StartSupervisor so the gate bookkeeping stays linear and easy to read.
//
// myStopGen is the stopGeneration value captured by the StartSupervisor
// caller at claim time. After CreatePaneWith returns we re-acquire
// startGate and check whether stopGeneration has moved OR stopRequested
// is set — either means a StopSupervisor ran during the spawn window
// and the new pane must NOT be published (otherwise the supervisor
// ends up running with its token/env after an explicit stop request).
// If stop won the race, the freshly-created pane is killed here and
// ErrSupervisorStopRequested propagates to the caller.
func (c *Controller) doStartSupervisor(myStopGen uint64) (string, error) {
	// Install the supervisor preamble on the meta-project, then spawn
	// a fresh claude pane. We set the preamble per-spawn (not once at
	// registration) so we can refresh it if the template ever changes
	// without restarting the daemon.
	prompt := c.renderSystemPrompt()
	if err := c.setMetaProjectPreamble(prompt); err != nil {
		return "", err
	}

	// Inject the supervisor's own bearer token (NOT the main DAEMON_TOKEN)
	// as an env var the system prompt tells Claude to dereference. This
	// keeps the daemon's primary token out of the supervisor pane and
	// lets the auth layer enforce scope (docked projects + meta only)
	// on requests that carry this token.
	var extraEnv []string
	if c.token != "" {
		extraEnv = []string{SupervisorTokenEnvVar + "=" + c.token}
	}
	pane, err := c.mgr.CreatePaneWith(SupervisorProjectID, proto.PaneKindClaude, 120, 40, pty.CreatePaneOptions{
		ExtraEnv: extraEnv,
	})
	if err != nil {
		return "", fmt.Errorf("supervisor: spawn pane: %w", err)
	}

	// Test hook: inject a deterministic sleep / synchronisation point
	// between CreatePaneWith and publish so a Stop test can reliably
	// race in during this window. Nil in production. Kept lock-less
	// so a test hook can freely take other locks without deadlock.
	if hook := c.testSpawnMidFn; hook != nil {
		hook()
	}

	// Stop-race check: a Stop that ran any time after this Start was
	// invoked (from entry through spawn) has bumped stopGeneration,
	// so myStopGen != current stopGeneration → cancel this spawn.
	// Hold startGate across the check AND the publish so a StopSupervisor
	// (which also takes startGate) can't sneak in between the check
	// and the paneID write.
	c.startGate.Lock()
	if c.stopGeneration != myStopGen {
		c.startGate.Unlock()
		// Tear down the pane we just created — don't leak it.
		if killErr := c.mgr.DeletePane(SupervisorProjectID, pane.ID); killErr != nil {
			slog.Debug("supervisor: stop-raced spawn teardown", "err", killErr, "pane", pane.ID)
		}
		return "", ErrSupervisorStopRequested
	}
	c.mu.Lock()
	c.paneID = pane.ID
	c.mu.Unlock()
	c.startGate.Unlock()

	// Refresh the alert baseline so transitions accumulated while the
	// supervisor was offline don't all fire now as stale notifications.
	c.alerts.refreshBaseline()

	// Ensure we clear the cached ID when the pane exits so the next
	// Start spawns a fresh one rather than returning a dead pointer.
	pane.OnExit(func(id string) {
		c.mu.Lock()
		if c.paneID == id {
			c.paneID = ""
		}
		c.mu.Unlock()
		c.broadcastState()
	})

	c.broadcastState()
	return pane.ID, nil
}

// StopSupervisor kills the supervisor pane, if running. No-op otherwise.
//
// Coordinates with an in-flight StartSupervisor via startGate: bumping
// stopGeneration inside the gate guarantees that any StartSupervisor
// whose myStopGen (captured at its entry) no longer matches the
// current stopGeneration will tear down its freshly-spawned pane at
// the post-spawn publish check rather than installing it as the live
// supervisor. Without this coordination, a Stop that observed
// paneID == "" while a spawn was mid-flight could return "success"
// while the in-flight spawn went on to publish a live supervisor pane
// after the Stop — leaving the supervisor running with its token/env
// despite an explicit stop request. Capturing myStopGen at the ENTRY
// to StartSupervisor (not at claim time) makes this coordination
// cover the entire "concurrent Start + Stop" window: any Stop fired
// at any point between Start's entry and its internal publish wins.
func (c *Controller) StopSupervisor() error {
	c.startGate.Lock()
	c.stopGeneration++
	c.mu.Lock()
	id := c.paneID
	c.paneID = ""
	c.mu.Unlock()
	c.startGate.Unlock()

	if id != "" {
		if err := c.mgr.DeletePane(SupervisorProjectID, id); err != nil {
			// The pane may have already exited on its own; that's fine.
			slog.Debug("supervisor: stop pane", "err", err, "pane", id)
		}
	}
	c.broadcastState()
	return nil
}

// SupervisorPaneID returns the live pane ID, or "".
func (c *Controller) SupervisorPaneID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.paneID
}

// snapshot builds the current MC state response.
func (c *Controller) snapshot() proto.MissionControlStateResponse {
	docked := c.mgr.DockedProjects()
	cards := make([]proto.MissionControlCard, 0, len(docked))
	for _, dp := range docked {
		if dp.ID == SupervisorProjectID {
			continue
		}
		panes := c.mgr.PanesInProject(dp.ID)
		cp := make([]proto.MissionControlPane, 0, len(panes))
		for _, pn := range panes {
			info := pn.Info()
			cp = append(cp, proto.MissionControlPane{
				PaneID:      info.ID,
				Kind:        info.Kind,
				AgentState:  pn.AgentState(),
				Stoplight:   info.Stoplight,
				SessionName: info.SessionName,
			})
		}
		cards = append(cards, proto.MissionControlCard{
			ProjectID:   dp.ID,
			ProjectName: dp.Name,
			Cwd:         dp.Cwd,
			Stoplight:   dp.Stoplight,
			PaneCount:   dp.PaneCount,
			Panes:       cp,
		})
	}
	return proto.MissionControlStateResponse{
		Cards:            cards,
		SupervisorOnline: c.SupervisorOnline(),
	}
}

// broadcastState pushes the latest snapshot to every MC WS subscriber.
// Non-blocking; a slow subscriber drops updates.
func (c *Controller) broadcastState() {
	snap := c.snapshot()
	c.mu.Lock()
	subs := make([]chan proto.MissionControlStateResponse, 0, len(c.subscribers))
	for _, ch := range c.subscribers {
		subs = append(subs, ch)
	}
	c.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- snap:
		default:
		}
	}
}

// NotifyStateChanged is the externally-callable trigger (implements
// http.MissionControlHandler) — fired after dock/undock HTTP calls.
func (c *Controller) NotifyStateChanged() { c.broadcastState() }

// subscribe registers a WS client. Caller must call unsubscribe when done.
func (c *Controller) subscribe() (int, chan proto.MissionControlStateResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextSub
	c.nextSub++
	ch := make(chan proto.MissionControlStateResponse, 4)
	c.subscribers[id] = ch
	return id, ch
}

func (c *Controller) unsubscribe(id int) {
	c.mu.Lock()
	delete(c.subscribers, id)
	c.mu.Unlock()
}

// setMetaProjectPreamble updates the meta-project's Preamble field so
// the next claude spawn picks up a fresh system prompt. The daemon's
// projects.toml is NOT rewritten — the preamble is a runtime-only
// attribute of the supervisor project and lives purely in memory.
func (c *Controller) setMetaProjectPreamble(preamble string) error {
	return c.mgr.SetProjectPreamble(SupervisorProjectID, preamble)
}

func (c *Controller) renderSystemPrompt() string {
	p := supervisorSystemPromptTemplate
	p = strings.ReplaceAll(p, "{{DAEMON_URL}}", c.daemonURL)
	envVar := c.tokenEnvVar
	if envVar == "" {
		envVar = "DAEMON_TOKEN_UNSET"
	}
	p = strings.ReplaceAll(p, "{{TOKEN_ENV}}", envVar)
	return p
}

// --- http.SupervisorAuthenticator interface ---

// CheckToken reports whether the given raw bearer is the supervisor's
// current token. Uses constant-time comparison.
func (c *Controller) CheckToken(bearer string) bool {
	if c.token == "" || bearer == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(bearer), []byte(c.token)) == 1
}

// IsProjectAccessible reports whether a supervisor-authenticated request
// may act on the given project. Scope is enforced live: revoking docked
// status (POST /projects/:id/undock) immediately strips the supervisor's
// access to that project's panes.
//
// Accessible projects:
//   - The supervisor's own meta-project (__reck_supervisor__).
//   - Any docked project — regardless of its pane count or stoplight.
//
// All other projects (non-docked user projects, unknown ids) are denied.
func (c *Controller) IsProjectAccessible(projectID string) bool {
	if projectID == "" {
		return false
	}
	if projectID == SupervisorProjectID {
		return true
	}
	for _, dp := range c.mgr.DockedProjects() {
		if dp.ID == projectID {
			return true
		}
	}
	return false
}

// IsPaneAccessible resolves a pane to its project and delegates to
// IsProjectAccessible. Unknown panes return false.
func (c *Controller) IsPaneAccessible(paneID string) bool {
	if paneID == "" {
		return false
	}
	pane, ok := c.mgr.PaneByID(paneID)
	if !ok {
		return false
	}
	return c.IsProjectAccessible(pane.ProjectID)
}

// generateToken returns a cryptographically random hex string suitable
// for use as a bearer token. 32 bytes → 64 hex chars → 256 bits of
// entropy; brute force over the network is infeasible.
func generateToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// --- helpers used by HTTP handlers in http.go ---

// writeJSON encodes v as JSON to w.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// (JSON body decoding moved to internal/httpx.DecodeJSONBody so the
// supervisor and the HTTP router share one source of truth for the
// size cap + trailing-data policy.)
