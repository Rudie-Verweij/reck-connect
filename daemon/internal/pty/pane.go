// Package pty manages the per-pane PTY lifecycle and byte streaming.
package pty

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/rudie-verweij/reck-connect/daemon/internal/events"
	"github.com/rudie-verweij/reck-connect/daemon/internal/launcher"
	"github.com/rudie-verweij/reck-connect/daemon/internal/macclipboard"
	"github.com/rudie-verweij/reck-connect/proto"
)

// PaneLauncher is the subset of *launcher.Launcher the pane spawn path uses.
// Defined as an interface so tests can stub it without dragging in the cgo
// helper-process spawn machinery. Production wiring happens in
// cmd/reck-stationd/main.go via SetPaneLauncher.
type PaneLauncher interface {
	SpawnPane(req launcher.SpawnRequest) (*launcher.PaneHandle, error)
}

var paneLauncher PaneLauncher

// SetPaneLauncher swaps in a PaneLauncher so future Spawn calls route the
// child fork+exec through the reck-pane-launcher helper. Pre-issue-#225
// behaviour (direct exec.Command + pty.StartWithSize from inside the daemon
// process) is restored by passing nil. Tests do not call this and so always
// use the direct path.
func SetPaneLauncher(l PaneLauncher) { paneLauncher = l }

// osc777Re matches Claude Code's "needs approval" notification.
// We deliberately anchor only on the 777;notify;Claude Code; prefix so the
// regex survives Anthropic tweaking the user-visible message.
var osc777Re = regexp.MustCompile(`\x1b\]777;notify;Claude Code;[^\x07]*\x07`)

// Pane is one live PTY session.
type Pane struct {
	ID        string
	ProjectID string
	Kind      proto.PaneKind
	Cwd       string
	Cmd       *exec.Cmd
	Tty       *os.File // master side of the PTY
	CreatedAt time.Time
	// Claude-only: the UUID we passed to claude via --session-id (fresh)
	// or --resume (resumed), and the human-readable label passed via
	// --name. Empty for shell panes. Wired into the session index so a
	// daemon restart / pane close doesn't sever the user from the
	// conversation on disk.
	SessionID   string
	SessionName string
	// Shell-only: the stable slot id this pane belongs to (an earlier release
	// Scope B). Generated once on fresh create, preserved across respawn
	// under the same SlotID via RestoreSlotID. Empty for Claude panes.
	SlotID string

	mu       sync.Mutex
	state    proto.PaneState
	exitCode *int
	cols     int
	rows     int

	// subscribers: WS connections receiving output
	subs      map[int]*Subscriber
	nextSubID int

	// ring buffer of recent output for replay-on-connect
	replay *replayBuffer

	// stoplight state, updated by stoplight pkg via SetStoplight.
	// This is the *raw* (agent-/byte-flow-driven) value. The
	// effective stoplight surfaced to Info / Subscribe / subscriber
	// fan-out is computed via `effectiveStoplightLocked` which ORs
	// in the `cwdAvailable` signal the mount probe drives. Keeping
	// raw + cwd-overlay as separate fields means the stoplight
	// runner can keep computing the underlying agent state every
	// tick without the probe's "red because cwd gone" ever being
	// clobbered — when cwd recovers, the raw value is still there
	// to fall back on.
	stoplight proto.Stoplight
	// cwdAvailable is false iff the mount probe's most recent
	// os.Stat of `Cwd` failed. Default true. When false, the
	// effective stoplight is forced to red regardless of the agent
	// layer. Phase 10a (hybrid mode plan rev 3.1): closes the
	// silent-mount-loss observability gap.
	cwdAvailable      bool
	lastOutputAt      time.Time
	awaitingApproval  bool
	onStoplightChange func(proto.Stoplight)

	// agent-hook-driven state (for PaneKindClaude and future hooked agents).
	// Updated via RecordEvent when a lifecycle hook forwards an event.
	agentState proto.AgentState
	eventLog   *events.Log

	// onExit callbacks fire exactly once when the child exits. Wired by
	// the session index to Touch last_active_at on unexpected death.
	onExit []func(paneID string)

	// cleanupFuncs fire exactly once when the pane is torn down —
	// whichever comes first: the child exits (waitLoop), or DeletePane
	// kills + unregisters it. Used by features that stash per-pane
	// state outside the pane struct (e.g. the image-paste upload
	// tmpdir at `$TMPDIR/reck-pane-<id>/`) and need a hook to remove
	// it when the pane goes away. Callbacks run in registration order,
	// errors are swallowed — cleanup is best-effort.
	//
	// Not merged with onExit because these run on both orderly close
	// and kill paths; onExit is scoped to "child actually exited" for
	// the session index's last_active_at logic.
	cleanupFuncs []func()
	cleanupDone  bool

	// uploadsCtx is cancelled by runCleanup before cleanup callbacks
	// fire. Upload handlers chain this with r.Context() so an in-flight
	// io.Copy aborts on pane-kill — otherwise the tmpdir rm-rf cleanup
	// would race against bytes still being written into the dir.
	// http.Request.Context only fires on client-disconnect or server
	// shutdown, not on pane-local teardown, so the pane owns its own.
	uploadsCtx    context.Context
	uploadsCancel context.CancelFunc

	// exited is closed by waitLoop once Cmd.Wait returns and the pane's
	// exit-code/state fields are populated. Used by WaitForExit to let
	// callers (notably RemoveProject during teardown) block on child
	// reaping with a bounded timeout before deleting the project dir.
	// Not nil once Spawn returns.
	exited chan struct{}

	// HookSecret is the per-pane 32-byte HMAC secret (hex-encoded)
	// the lifecycle-hook shim uses to sign agent-event POSTs. Audit
	// fix F4 : replaces the old "any loopback caller can post
	// to /panes/:id/agent-event" exemption with a per-pane HMAC. The
	// secret is generated on Spawn and injected into the child via
	// RECK_HOOK_SECRET so only the pane's own children can sign
	// events for it. Never logged. Never echoed back over any HTTP
	// or WS surface — it leaves the daemon exactly once, into the
	// pane child's environment.
	HookSecret string

	// launcherHandle is non-nil when the pane was spawned via the
	// reck-pane-launcher helper (production path post issue #225).
	// Holds the per-pane control conn + ExitCh so the wait/kill paths
	// can coordinate with the helper. Nil for direct-spawn panes (tests
	// and the legacy path).
	launcherHandle *launcher.PaneHandle
}

// Subscriber is a single WS connection listening to this pane.
type Subscriber struct {
	ID     int
	Output chan<- []byte
	Status chan<- proto.Stoplight
	Exit   chan<- int
	Err    chan<- string
}

func newPaneID() string {
	var b [6]byte
	rand.Read(b[:])
	return "p_" + hex.EncodeToString(b[:])
}

// newHookSecret returns a freshly-generated per-pane HMAC secret,
// 32 random bytes hex-encoded (64 chars). Audit fix F4 : the
// shim uses this to sign agent-event POSTs so a non-pane local
// process can't forge stoplight transitions. We pull from
// crypto/rand and surface the read error as a panic — the daemon
// has no meaningful recovery if the kernel CSPRNG is unavailable,
// and continuing with a zero-byte secret would silently degrade
// every spawn to "any local process can sign for this pane".
func newHookSecret() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("pty: rand.Read for hook secret failed: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// envAllowlist is the set of environment variables the daemon will
// forward into pane child processes. Everything else the daemon inherits
// — in particular DAEMON_TOKEN, ANTHROPIC_API_KEY, AWS credentials, and
// anything a launchd plist may have stashed — is dropped at spawn so a
// pane child (Claude, a shell the user is typing into, or an npm script)
// cannot read it.
//
// Added entries should be values the child *needs* to function:
//   - PATH, HOME, USER, SHELL, LANG/LC_*, TZ: baseline for any binary
//   - XDG_*: some CLIs respect these for config/cache paths
//   - LOGNAME: macOS login shells dereference it in rc files
//   - DISPLAY, SSH_*: only present in interactive-ssh contexts; harmless
//   - TMPDIR: macOS-specific, required for some Go/rust tooling
//
// Anything Reck-specific (RECK_PANE_ID, RECK_PROJECT_ID, RECK_DAEMON_URL)
// is injected by Spawn explicitly — do NOT rely on the daemon's own env
// to carry them, because a future daemon refactor may set them only on
// the child via extraEnv.
var envAllowlist = map[string]bool{
	"PATH":            true,
	"HOME":            true,
	"USER":            true,
	"LOGNAME":         true,
	"SHELL":           true,
	"LANG":            true,
	"LC_ALL":          true,
	"LC_CTYPE":        true,
	"TZ":              true,
	"TMPDIR":          true,
	"DISPLAY":         true,
	"XDG_CONFIG_HOME": true,
	"XDG_CACHE_HOME":  true,
	"XDG_DATA_HOME":   true,
	"XDG_STATE_HOME":  true,
	"XDG_RUNTIME_DIR": true,
	"SSH_AUTH_SOCK":   true,
	"SSH_AGENT_PID":   true,
	"COLORTERM":       true,
	// Reck's own injected env. RECK_DAEMON_URL is set by cmd/reck-stationd
	// once the listener binds so pane children + hook shims know where
	// to POST lifecycle events.
	"RECK_DAEMON_URL": true,
}

// envAllowlistPrefixes is a set of env-var prefixes that are also
// forwarded.
//   - LC_*: locale vars are an open-ended family.
//   - CLAUDE_CODE_*: user-intended Claude Code configuration (experimental
//     feature flags, non-secret runtime options). Prefix-allowlisting this
//     family means the daemon doesn't need a code change every time
//     Anthropic ships a new CLAUDE_CODE_* toggle. Auth material uses
//     ANTHROPIC_*, AWS_*, CLAUDE_API_*, etc., which are deliberately NOT
//     in this prefix set and never will be.
var envAllowlistPrefixes = []string{"LC_", "CLAUDE_CODE_"}

// paneBaseEnv returns the daemon's env filtered through envAllowlist.
// Used by Spawn to construct the child environment from a known-safe
// subset rather than inheriting the daemon's own secrets.
func paneBaseEnv() []string {
	out := make([]string, 0, len(envAllowlist))
	for _, kv := range os.Environ() {
		eq := 0
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				eq = i
				break
			}
		}
		if eq == 0 {
			continue
		}
		k := kv[:eq]
		if envAllowlist[k] {
			out = append(out, kv)
			continue
		}
		for _, p := range envAllowlistPrefixes {
			if len(k) >= len(p) && k[:len(p)] == p {
				out = append(out, kv)
				break
			}
		}
	}
	return out
}

// Spawn a new pane. `spawnCmd` is the command + args; `cwd` the directory.
// The pane's ID is generated before exec so it can be exposed to the child
// via RECK_PANE_ID — this is what agent lifecycle hooks read to correlate
// their events back to the right pane when POSTing to the daemon.
//
// extraEnv is appended (after the allowlisted base env) to the child's
// environment. Use this for per-pane values like RECK_DAEMON_URL. The
// daemon's own environment is NOT inherited wholesale — see paneBaseEnv
// for the allowlist rationale.
func Spawn(projectID string, kind proto.PaneKind, spawnCmd []string, cwd string, cols, rows int, extraEnv []string) (*Pane, error) {
	id := newPaneID()
	hookSecret := newHookSecret()
	env := paneBaseEnv()
	env = append(env,
		"TERM=xterm-256color",
		"RECK_PANE_ID="+id,
		"RECK_PROJECT_ID="+projectID,
		// Audit fix F4 : per-pane HMAC secret the lifecycle-hook
		// shim signs agent-event POSTs with. Replaces the old
		// loopback-exemption that let any local process forge events.
		// See hookauth.go for the verification side.
		"RECK_HOOK_SECRET="+hookSecret,
	)
	env = append(env, extraEnv...)

	uploadsCtx, uploadsCancel := context.WithCancel(context.Background())
	p := &Pane{
		ID:            id,
		ProjectID:     projectID,
		Kind:          kind,
		Cwd:           cwd,
		state:         proto.PaneStateRunning,
		cols:          cols,
		rows:          rows,
		subs:          make(map[int]*Subscriber),
		replay:        newReplayBuffer(64 * 1024),
		stoplight:     proto.StoplightGray,
		cwdAvailable:  true,
		lastOutputAt:  time.Now(),
		eventLog:      events.NewLog(256),
		exited:        make(chan struct{}),
		uploadsCtx:    uploadsCtx,
		uploadsCancel: uploadsCancel,
		HookSecret:    hookSecret,
	}

	// Two spawn paths:
	//   (a) launcher mode (production, issue #225 fix): delegate fork+exec
	//       to the reck-pane-launcher helper so the child's TCC
	//       responsible-process is the helper, not reck-stationd. We
	//       receive the pty master fd via SCM_RIGHTS and a pid; the helper
	//       owns cmd.Wait and notifies us on exit via PaneHandle.ExitCh.
	//   (b) direct mode (tests + legacy fallback): exec.Command +
	//       pty.StartWithSize from inside the daemon process. Identical
	//       behaviour to pre-launcher daemons. waitLoop reaps via
	//       cmd.Wait. Used whenever SetPaneLauncher hasn't been called.
	if paneLauncher != nil {
		h, err := paneLauncher.SpawnPane(launcher.SpawnRequest{
			Argv: spawnCmd,
			Env:  env,
			Dir:  cwd,
			Cols: cols,
			Rows: rows,
		})
		if err != nil {
			uploadsCancel()
			return nil, err
		}
		p.launcherHandle = h
		p.Tty = h.Tty
		// Stub Cmd so existing readers (Pane.Info Pid, manager_test
		// asserting Cmd.Dir on restore) keep working unchanged. The
		// stub is never .Start'd or .Wait'd — those go through the
		// helper. Process is constructed via os.FindProcess so
		// .Process.Pid and best-effort .Process.Signal calls still
		// resolve the real child pid the helper handed us back.
		proc, _ := os.FindProcess(h.Pid)
		p.Cmd = &exec.Cmd{
			Path:    spawnCmd[0],
			Args:    append([]string(nil), spawnCmd...),
			Dir:     cwd,
			Env:     env,
			Process: proc,
		}
	} else {
		cmd := exec.Command(spawnCmd[0], spawnCmd[1:]...)
		cmd.Dir = cwd
		cmd.Env = env
		winsize := &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}
		ttyF, err := pty.StartWithSize(cmd, winsize)
		if err != nil {
			uploadsCancel()
			return nil, err
		}
		p.Cmd = cmd
		p.Tty = ttyF
	}

	go p.readLoop()
	go p.waitLoop()
	return p, nil
}

func (p *Pane) readLoop() {
	buf := make([]byte, 4096)
	for {
		n, err := p.Tty.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			hasOSC777 := osc777Re.Match(chunk)
			p.mu.Lock()
			p.replay.write(chunk)
			p.lastOutputAt = time.Now()
			// OSC 777 → Claude Code is waiting for tool approval. Any other
			// output means Claude resumed (user responded or sequence cleared).
			p.awaitingApproval = hasOSC777
			subs := make([]*Subscriber, 0, len(p.subs))
			for _, s := range p.subs {
				subs = append(subs, s)
			}
			p.mu.Unlock()
			for _, s := range subs {
				select {
				case s.Output <- chunk:
				default:
					// slow subscriber, drop
				}
			}
		}
		if err != nil {
			if err != io.EOF {
				p.notifyErr(err.Error())
			}
			return
		}
	}
}

func (p *Pane) waitLoop() {
	var code int
	if p.launcherHandle != nil {
		// Helper owns cmd.Wait; we receive the exit code over the
		// per-pane control conn. The helper sends -1 on conn EOF if
		// the child died without it observing a normal exit, so a
		// closed channel without a sent value (zero) means "clean
		// exit code 0" rather than "lost track of child".
		c, ok := <-p.launcherHandle.ExitCh
		if !ok {
			code = -1
		} else {
			code = c
		}
	} else {
		err := p.Cmd.Wait()
		code = 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if err != nil {
			code = -1
		}
	}
	p.finalizeExit(code)
}

// finalizeExit applies the exit-state update + subscriber/onExit
// fanout + cleanup. Reached from waitLoop on direct-spawn child exit;
// sidecar-spawn path retired in phase 2.
func (p *Pane) finalizeExit(code int) {
	p.mu.Lock()
	p.state = proto.PaneStateExited
	p.exitCode = &code
	subs := make([]*Subscriber, 0, len(p.subs))
	for _, s := range p.subs {
		subs = append(subs, s)
	}
	exitCbs := make([]func(string), len(p.onExit))
	copy(exitCbs, p.onExit)
	p.onExit = nil
	exited := p.exited
	p.mu.Unlock()
	// Signal WaitForExit waiters before firing subscriber/exit callbacks
	// so any caller blocked on WaitForExit sees the final state as soon
	// as Cmd.Wait returns — ordering doesn't matter for correctness here
	// (state is already flushed under the lock) but closing early cuts
	// the latency of a RemoveProject teardown.
	close(exited)
	for _, s := range subs {
		select {
		case s.Exit <- code:
		default:
		}
	}
	for _, cb := range exitCbs {
		cb(p.ID)
	}
	p.runCleanup()
}

// WaitForExit blocks until the pane's child process exits, or until the
// timeout elapses. Returns true iff the child exited. Safe to call from
// any goroutine; safe to call multiple times (the signal channel is
// closed, not drained).
//
// Use case: RemoveProject kills panes then waits here before rm-rf'ing
// the project cwd, so the child doesn't race with the directory delete
// holding open fds under it.
//
// A zero/negative timeout blocks indefinitely. A zero timeout should be
// avoided in teardown paths — callers always want an upper bound.
//
// For multi-pane teardowns that need a SHARED deadline across panes,
// prefer WaitForExitCtx — one ctx.WithTimeout outside the loop races
// every pane against the same clock instead of multiplying N × timeout.
func (p *Pane) WaitForExit(timeout time.Duration) bool {
	p.mu.Lock()
	ch := p.exited
	p.mu.Unlock()
	if ch == nil {
		// Pane was never fully constructed (only possible in tests that
		// bypass Spawn). Treat as already-exited so callers don't hang.
		return true
	}
	if timeout <= 0 {
		<-ch
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ch:
		return true
	case <-timer.C:
		return false
	}
}

// WaitForExitCtx is the ctx-aware form of WaitForExit: returns true iff
// the child exited before ctx cancellation / deadline. Built so
// RemoveProject can tear down N panes in parallel under a single
// shared deadline — O(N × 5s) serialized waits would blow past
// launchd's 20s SIGKILL deadline at 4+ hung panes.
//
// Usage pattern:
//
//	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
//	defer cancel()
//	var wg sync.WaitGroup
//	for _, pane := range panes {
//	    wg.Add(1)
//	    go func(p *Pane) { defer wg.Done(); exited := p.WaitForExitCtx(ctx); ... }(pane)
//	}
//	wg.Wait()
func (p *Pane) WaitForExitCtx(ctx context.Context) bool {
	p.mu.Lock()
	ch := p.exited
	p.mu.Unlock()
	if ch == nil {
		return true
	}
	select {
	case <-ch:
		return true
	case <-ctx.Done():
		// If the child happens to have exited just as ctx cancelled,
		// prefer the "exited" truth to avoid spurious timeout reports.
		select {
		case <-ch:
			return true
		default:
			return false
		}
	}
}

// OnExit registers a callback fired once when the pane's child exits.
// Safe to call any number of times — callbacks run in registration order.
//
// Race-fix (an audit finding): a fast-exiting child (e.g. /bin/false)
// can finalize before CreatePaneWith has finished wiring its OnExit
// callbacks — Spawn returns the moment pty.StartWithSize hands back the
// master fd, but the wait goroutine is already running by then. If the
// child exits between Spawn returning and OnExit being called, the
// callback would have been silently lost: finalizeExit copies and
// clears p.onExit under the lock, so a later append would never fire.
//
// Behaviour: if the pane has already exited (state == Exited and
// exitCode is populated), invoke cb synchronously with the pane ID
// before returning. Newly-registered callbacks against a still-running
// pane queue normally and run from finalizeExit. The pane's mutex
// serialises with finalizeExit so we can't observe a half-finalized
// state where exit was decided but callbacks haven't drained yet.
func (p *Pane) OnExit(cb func(paneID string)) {
	if cb == nil {
		return
	}
	p.mu.Lock()
	if p.state == proto.PaneStateExited {
		// Already exited — finalizeExit has already drained any
		// previously-registered callbacks. Run this one synchronously
		// (outside the lock) so caller semantics are identical to a
		// callback that registered just before exit.
		p.mu.Unlock()
		cb(p.ID)
		return
	}
	p.onExit = append(p.onExit, cb)
	p.mu.Unlock()
}

// AddCleanup registers a callback fired exactly once when this pane is
// torn down, on whichever path gets there first: the child exits on its
// own (waitLoop → runCleanup) or DeletePane/RemoveProject explicitly
// kills it (Kill → runCleanup). Safe to call concurrently; safe to call
// multiple times; the callback runs in registration order. If the pane
// has already torn down, the callback runs synchronously before return
// so callers never leak state by racing against a just-exited pane.
//
// Used by features that park per-pane state outside the pane struct
// (e.g. the image-paste upload tmpdir) and need a hook to remove it
// without threading pane-exit wiring through every feature.
func (p *Pane) AddCleanup(cb func()) {
	if cb == nil {
		return
	}
	p.mu.Lock()
	if p.cleanupDone {
		p.mu.Unlock()
		cb()
		return
	}
	p.cleanupFuncs = append(p.cleanupFuncs, cb)
	p.mu.Unlock()
}

// runCleanup fires all registered cleanup callbacks exactly once.
// Idempotent: second+ calls are no-ops. Callers hold no locks.
//
// uploadsCtx cancellation fires before the cleanup callbacks so any
// in-flight upload io.Copy aborts before the tmpdir rm-rf callback
// runs; otherwise the rm-rf would race bytes still being written into
// the dir (POSIX lets writes continue on an unlinked fd, but the
// bytes go nowhere).
func (p *Pane) runCleanup() {
	p.mu.Lock()
	if p.cleanupDone {
		p.mu.Unlock()
		return
	}
	p.cleanupDone = true
	cbs := make([]func(), len(p.cleanupFuncs))
	copy(cbs, p.cleanupFuncs)
	p.cleanupFuncs = nil
	cancel := p.uploadsCancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	for _, cb := range cbs {
		func() {
			defer func() { _ = recover() }()
			cb()
		}()
	}
}

// UploadsCtx returns a context that is cancelled when the pane is
// torn down (via Kill or waitLoop). Upload handlers should chain this
// with their r.Context() so either client-disconnect or pane-kill
// aborts an in-flight io.Copy. Panes constructed outside Spawn (test
// harnesses that bypass exec) return context.Background() — callers
// must tolerate a never-cancelling ctx in that case.
func (p *Pane) UploadsCtx() context.Context {
	p.mu.Lock()
	ctx := p.uploadsCtx
	p.mu.Unlock()
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

// Write forwards bytes to the PTY master (stdin of the child).
func (p *Pane) Write(data []byte) error {
	_, err := p.Tty.Write(data)
	return err
}

// Resize propagates a new terminal size.
//
// No-ops when cols/rows match the pane's last-applied size. Without this
// guard, every pane switch + refit() shipped a redundant pty.Setsize, which
// fires SIGWINCH in the child on every switch — spurious, and a suspected
// (though unconfirmed) contributor to the intermittent xterm scroll-wedge
// tracked in an earlier release. Fresh panes initialise cols/rows at Spawn time, so the
// first post-spawn call with matching dims correctly no-ops rather than
// re-issuing the initial size.
func (p *Pane) Resize(cols, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if cols == p.cols && rows == p.rows {
		return nil
	}
	if err := pty.Setsize(p.Tty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		return err
	}
	p.cols = cols
	p.rows = rows
	return nil
}

// Kill terminates the child process. Safe on partially-constructed
// panes (nil Cmd or Tty) so RemoveProject teardown tests can exercise
// the ordering/timeout logic without spawning real child processes.
//
// an audit finding: direct-spawn panes get a SIGTERM to the
// child's entire process group, then SIGKILL after a 2s grace if the
// group hasn't fully reaped. Without this, sub-shells / piped tools /
// claude's tool-call grandchildren would be reparented to init and
// leak. The PTY library (creack/pty) sets Setsid+Setctty on Spawn so
// the child is already its own session leader / process-group leader
// with the PTY as controlling terminal — see pty.StartWithSize. We
// just have to address the kill at the group instead of the leader.
//
// Note: Cmd.Wait (in waitLoop) only reaps the group LEADER. Any
// grandchildren survive only as long as they're alive; SIGKILL to
// the pgroup ensures they die, and the kernel reparents the zombies
// to init which reaps them. The daemon doesn't try to wait on
// grandchildren — that's by design and not a leak.
//
// phase 2: the sidecar branch  has been retired.
// All panes are now direct-spawn so this only handles the process-group
// kill path. If a future spawn variant lands, gate it explicitly.
func (p *Pane) Kill() {
	if p.Cmd != nil && p.Cmd.Process != nil {
		pid := p.Cmd.Process.Pid
		// Resolve pgid SYNCHRONOUSLY here, before launching killGroupAsync
		// AND before p.Tty.Close() below. Two reasons (codex review of
		// #243):
		//   - Closing the daemon-side master fd tears down the
		//     controlling-terminal session; the kernel signals the
		//     session leader with SIGHUP. Default SIGHUP action is
		//     exit, so the leader can be reaped by waitLoop (direct
		//     mode) or the helper's cmd.Wait (launcher mode) before
		//     the goroutine ever runs.
		//   - In launcher mode the helper owns Cmd.Wait independently
		//     of the daemon — the leader can be reaped at any time,
		//     racing a lazily-resolved Getpgid.
		// If Getpgid races a reap and ESRCHs we lose the pgid; we'd
		// fall back to single-pid SIGKILL on a possibly-recycled pid,
		// and any descendants in the original pgroup (the orphan-leak
		// this fix is for) survive untouched. Resolving here closes
		// that window.
		//
		// If the leader is already reaped at the moment Kill is called,
		// skip — there's no group address to use, and descendants are
		// either reapOrphanIfAlive's job (launcher mode, already
		// covered by the launcher-EOF path) or already gone with the
		// leader (direct-spawn — no orphan-handler path).
		if pgid, err := syscall.Getpgid(pid); err == nil {
			// Process-group kill so all of claude's children (sub-shells,
			// greps, etc.) die together. In launcher mode the daemon is
			// not the child's parent, but kill(2) only requires same-uid
			// permission — and reck-stationd + reck-pane-launcher both
			// run as the user, so the syscall succeeds. The helper's
			// cmd.Wait reaps the leader either way and posts ExitNotice.
			go p.killGroupAsync(pid, pgid)
		}
	}
	if p.Tty != nil {
		p.Tty.Close()
	}
	// Deliberately do NOT close p.launcherHandle here. Closing the
	// per-pane control conn would make the daemon-side exit-reader
	// goroutine see EOF and fire a synthetic -1 onto ExitCh, which
	// closes p.exited inside finalizeExit — and killGroupAsync's
	// 2s SIGTERM grace selects on p.exited. A SIGTERM-trapping child
	// would then be reported as exited milliseconds after Kill returns,
	// and the SIGKILL escalation never runs (codex review v3 of
	// issue #242). The helper closes its own end after cmd.Wait
	// reaps the leader, so the conn is released on actual exit; the
	// exit-reader goroutine defers uc.Close() to release the fd
	// when it's done reading.
	// Cleanup also runs from waitLoop once the child reaps, but
	// DeletePane / RemoveProject call Kill synchronously and don't
	// wait — firing here keeps cleanup timely and is idempotent via
	// cleanupDone.
	p.runCleanup()
}

// killGroupAsync sends SIGTERM to the child's process group, polls for
// group emptiness up to 2s, then SIGKILLs the group if anything is still
// alive. Must be invoked in its own goroutine — the caller (Kill) is on
// the DeletePane/RemoveProject hot path and can't block on a 2s grace.
//
// pgid must be captured synchronously by the caller (Pane.Kill resolves
// it via Getpgid before launching this goroutine and before closing the
// PTY master). Resolving lazily here would race against the leader being
// reaped (PTY-close SIGHUP in direct mode, helper cmd.Wait in launcher
// mode), with the failure mode of single-pid SIGKILL on a possibly-
// recycled pid while the original pgroup's descendants leak — see
// codex review of #243.
//
// Why poll the group instead of waiting on p.exited (the issue #243
// bug itself): a Unix process group can outlive its leader. p.exited
// closes when waitLoop observes Cmd.Wait return, which fires on LEADER
// reap only. A leader that exits cleanly on SIGTERM while a descendant
// traps it (e.g. an MCP server with its own signal handler) would close
// p.exited within milliseconds and skip SIGKILL escalation — leaving
// the descendant reparented to launchd, holding cwd / RAM / mounts,
// with the pane already marked Exited. Polling kill(-pgid, 0) checks
// group emptiness directly: ESRCH means the group has no remaining
// members, anything else means descendants survive and the grace clock
// keeps running.
//
// Safety guards (mirror reapOrphanIfAlive in launcher/spawn.go — same
// rationale, since both paths call kill(-pgid, …)):
//   - pid/pgid <= 0:           invalid input (silent skip)
//   - pgid == 1:               launchd's group, never ours
//   - pgid == daemon-pgrp:     would SIGKILL reck-stationd itself
//   - pgid != pid:             Setsid invariant violation — either
//                              future spawn variant forgot Setsid, or
//                              the pid was recycled / moved pgroups
//                              between Spawn and Kill (the snapshot
//                              window is tiny but non-zero). Skip
//                              rather than nuke a stranger's pgroup.
func (p *Pane) killGroupAsync(pid, pgid int) {
	if pid <= 0 || pgid <= 0 {
		return
	}
	daemonPgrp := syscall.Getpgrp()
	if pgid == 1 || pgid == daemonPgrp {
		slog.Warn("kill-group: refusing — unsafe pgid target",
			"pane_id", p.ID, "pid", pid, "pgid", pgid, "daemon_pgrp", daemonPgrp)
		return
	}
	if pgid != pid {
		slog.Warn("kill-group: pgid does not match leader pid — Setsid invariant violated, skipping kill",
			"pane_id", p.ID, "pid", pid, "pgid", pgid)
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	// Group-emptiness poll. kill(-pgid, 0) returns ESRCH iff the group
	// has no remaining members (signal 0 only does permission + existence
	// checks, no signal is delivered).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pgid, 0); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	// SIGKILL is uncatchable; surviving descendants must die. The kernel
	// reparents zombies to launchd which reaps them.
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

// effectiveStoplightLocked returns the stoplight value surfaced to
// the outside world (HTTP `Info`, WS `Subscribe` replay, WS status
// channel fan-out). Caller must hold p.mu.
//
// Phase 10a: when `cwdAvailable` is false (mount probe saw os.Stat
// fail on `Cwd`), the effective value is always `red`. Keeping this
// split from the raw `stoplight` means the stoplight runner and
// agent hooks can keep writing their value on every tick — the
// probe's signal still wins until cwd recovers.
func (p *Pane) effectiveStoplightLocked() proto.Stoplight {
	if !p.cwdAvailable {
		return proto.StoplightRed
	}
	return p.stoplight
}

// Subscribe registers a WS subscriber. Returns the subscriber ID + replay buffer.
func (p *Pane) Subscribe(output chan []byte, status chan proto.Stoplight, exit chan int, errCh chan string) (int, []byte, int, int, proto.Stoplight) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id := p.nextSubID
	p.nextSubID++
	p.subs[id] = &Subscriber{ID: id, Output: output, Status: status, Exit: exit, Err: errCh}
	return id, p.replay.snapshot(), p.cols, p.rows, p.effectiveStoplightLocked()
}

// Unsubscribe removes a subscriber.
func (p *Pane) Unsubscribe(id int) {
	p.mu.Lock()
	delete(p.subs, id)
	p.mu.Unlock()
}

// Info returns a snapshot for HTTP responses.
func (p *Pane) Info() proto.Pane {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := proto.Pane{
		ID:          p.ID,
		Kind:        p.Kind,
		State:       p.state,
		Stoplight:   p.effectiveStoplightLocked(),
		SessionID:   p.SessionID,
		SessionName: p.SessionName,
		SlotID:      p.SlotID,
		Capabilities: proto.PaneCapabilities{
			// phase 2: clipboard-image gated on (a) the pane being
			// Claude (writing 0x16 to a shell would do something
			// unrelated) and (b) the daemon having a working clipboard
			// backend. macclipboard.Available() is true on darwin
			// always, and on linux when xclip is on PATH and $DISPLAY
			// is set (the install script provisions Xvfb on TTY-only
			// stations to satisfy that). Other platforms fall back to
			// the /uploads path-typing route.
			ClipboardImage: p.Kind == proto.PaneKindClaude && macclipboard.Available(),
		},
	}
	if p.Cmd != nil && p.Cmd.Process != nil {
		pid := p.Cmd.Process.Pid
		out.Pid = &pid
	}
	if p.exitCode != nil {
		out.ExitCode = p.exitCode
	}
	return out
}

// SetStoplight is called by the stoplight package.
//
// Phase 10a: fires subscribers on changes to the EFFECTIVE
// stoplight, not the raw agent-driven value. If `cwdAvailable` is
// false, a stoplight runner writing `green` here will store `green`
// in the raw field but the subscribers keep seeing `red` (because
// that's the effective value both before and after this write). This
// is the contract codex round-4 asked for: mount-loss red is not
// clobbered by every 1 Hz tick of the stoplight runner.
func (p *Pane) SetStoplight(s proto.Stoplight) {
	p.mu.Lock()
	prev := p.effectiveStoplightLocked()
	p.stoplight = s
	next := p.effectiveStoplightLocked()
	subs := make([]*Subscriber, 0, len(p.subs))
	for _, sub := range p.subs {
		subs = append(subs, sub)
	}
	cb := p.onStoplightChange
	p.mu.Unlock()
	if prev == next {
		return
	}
	for _, sub := range subs {
		select {
		case sub.Status <- next:
		default:
		}
	}
	if cb != nil {
		cb(next)
	}
}

// SetCwdAvailable flips the mount-probe's cwd-reachability signal for
// this pane. Falsy → effective stoplight forces red regardless of
// agent state; truthy → effective stoplight falls back to the raw
// stoplight the runner / hooks have accumulated. Fires subscribers +
// OnStoplightChange iff the effective stoplight actually transitions.
// Phase 10a (hybrid mode plan rev 3.1).
func (p *Pane) SetCwdAvailable(available bool) {
	p.mu.Lock()
	prev := p.effectiveStoplightLocked()
	p.cwdAvailable = available
	next := p.effectiveStoplightLocked()
	subs := make([]*Subscriber, 0, len(p.subs))
	for _, sub := range p.subs {
		subs = append(subs, sub)
	}
	cb := p.onStoplightChange
	p.mu.Unlock()
	if prev == next {
		return
	}
	for _, sub := range subs {
		select {
		case sub.Status <- next:
		default:
		}
	}
	if cb != nil {
		cb(next)
	}
}

// CwdAvailable reports whether the mount probe believes `Cwd` is
// currently reachable. Exposed for tests + probe recovery logic.
func (p *Pane) CwdAvailable() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cwdAvailable
}

// OnStoplightChange registers a callback (used by Manager to update aggregates).
func (p *Pane) OnStoplightChange(cb func(proto.Stoplight)) {
	p.mu.Lock()
	p.onStoplightChange = cb
	p.mu.Unlock()
}

// LastOutputAt returns when the pane last emitted bytes.
func (p *Pane) LastOutputAt() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastOutputAt
}

// AwaitingApproval returns true if the most recent output chunk contained
// Claude Code's OSC 777 "tool approval" notification and no subsequent
// chunk has cleared it.
func (p *Pane) AwaitingApproval() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.awaitingApproval
}

// ReplayTail returns the most recent bytes for prompt-waiting heuristics.
func (p *Pane) ReplayTail(n int) []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.replay.tail(n)
}

// State returns the current PaneState.
func (p *Pane) State() proto.PaneState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

// ExitCode returns the pane's exit code if the process has exited, or nil
// while it's still running.
func (p *Pane) ExitCode() *int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exitCode == nil {
		return nil
	}
	c := *p.exitCode
	return &c
}

// AgentState returns the pane's current event-driven agent state. Empty
// string (AgentStateUnknown) before any hook event has arrived.
func (p *Pane) AgentState() proto.AgentState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.agentState
}

// EventLog returns the pane's append-only event log (thread-safe).
func (p *Pane) EventLog() *events.Log { return p.eventLog }

// RecordEvent appends an event to the pane's log and advances its
// agent-state machine. Called by the daemon's HTTP handler when a hook
// shim POSTs a lifecycle event.
//
// State transitions:
//
//	user_prompt / pre_tool / post_tool       → working
//	post_tool_failure (is_interrupt)         → unknown (user hit Escape mid-tool)
//	post_tool_failure (other)                → working (Claude will likely retry)
//	user_interrupt                           → unknown (user hit Escape between tools)
//	permission_request / permission_denied   → attention (user must decide)
//	elicitation                              → attention (MCP needs input)
//	stop / stop_failure                      → idle
//	notification                             → log only; no state change
//	session_start / session_end              → log only; no state change
//
// Interrupt → Unknown (gray), NOT Idle (green). Green signals "task
// finished, notice me"; an abandoned turn is neither completed nor
// attention-worthy — grey is the semantic match. Idle stays reserved
// for natural Stop events where Claude returned a final answer.
//
// Claude Code doesn't fire Stop on a user-initiated interrupt. It fires
// PostToolUseFailure with is_interrupt=true only when Escape lands
// during a tool call; interrupts during the thinking/response phase
// produce no hook events at all — the WS handler synthesizes
// KindUserInterrupt when it sees a lone ESC keystroke on a working
// Claude pane.
//
// Notification is intentionally non-transitioning: Claude Code fires it
// both for "permission needed" (which WOULD warrant attention) AND for
// "idle 60+ seconds waiting for input" (which is just informational).
// The benign case is the common one — firing attention every time would
// flip a green pane red right after Stop. Real attention state will need
// a more specific signal (parsed notification payload, OSC 777 subtype,
// or a dedicated permission hook if we wire one in).
func (p *Pane) RecordEvent(e events.Event) {
	if p.eventLog != nil {
		p.eventLog.Append(e)
	}
	var next proto.AgentState
	switch e.Kind {
	case events.KindUserPrompt, events.KindPreTool, events.KindPostTool:
		next = proto.AgentStateWorking
	case events.KindPostToolFailure:
		if isInterruptPayload(e.Data) {
			next = proto.AgentStateUnknown
		} else {
			next = proto.AgentStateWorking
		}
	case events.KindUserInterrupt:
		next = proto.AgentStateUnknown
	case events.KindPermissionRequest, events.KindPermissionDenied, events.KindElicitation:
		next = proto.AgentStateAttention
	case events.KindStop, events.KindStopFailure:
		next = proto.AgentStateIdle
	default:
		return
	}
	p.mu.Lock()
	p.agentState = next
	p.mu.Unlock()
}

// isInterruptPayload reports whether a PostToolUseFailure payload carries
// is_interrupt=true. Returns false for missing/invalid JSON — genuine tool
// failures without the flag should keep the pane in "working" so Claude's
// follow-up (retry, error recovery, or final Stop) can drive the next
// transition.
func isInterruptPayload(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	var p struct {
		IsInterrupt bool `json:"is_interrupt"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return false
	}
	return p.IsInterrupt
}

func (p *Pane) notifyErr(msg string) {
	p.mu.Lock()
	subs := make([]*Subscriber, 0, len(p.subs))
	for _, s := range p.subs {
		subs = append(subs, s)
	}
	p.mu.Unlock()
	for _, s := range subs {
		select {
		case s.Err <- msg:
		default:
		}
	}
}

// --- replayBuffer ---

type replayBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func newReplayBuffer(limit int) *replayBuffer {
	return &replayBuffer{limit: limit, buf: make([]byte, 0, limit)}
}

func (r *replayBuffer) write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.limit {
		r.buf = r.buf[len(r.buf)-r.limit:]
	}
}

func (r *replayBuffer) snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, len(r.buf))
	copy(out, r.buf)
	return out
}

func (r *replayBuffer) tail(n int) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n >= len(r.buf) {
		out := make([]byte, len(r.buf))
		copy(out, r.buf)
		return out
	}
	out := make([]byte, n)
	copy(out, r.buf[len(r.buf)-n:])
	return out
}
