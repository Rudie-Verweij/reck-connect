package pty

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/events"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newTestPane builds a Pane with its event log wired up but WITHOUT
// spawning a PTY child — enough to exercise RecordEvent / AgentState.
func newTestPane() *Pane {
	return &Pane{
		ID:         "p_test",
		ProjectID:  "proj",
		Kind:       proto.PaneKindClaude,
		eventLog:   events.NewLog(64),
		agentState: proto.AgentStateUnknown,
	}
}

func TestPane_RecordEvent_StateTransitions(t *testing.T) {
	p := newTestPane()

	cases := []struct {
		kind events.Kind
		want proto.AgentState
	}{
		{events.KindUserPrompt, proto.AgentStateWorking},
		{events.KindPreTool, proto.AgentStateWorking},
		{events.KindPostTool, proto.AgentStateWorking},
		{events.KindStop, proto.AgentStateIdle},
	}
	for _, c := range cases {
		p.RecordEvent(events.Event{ID: events.NewID(), Kind: c.kind})
		if got := p.AgentState(); got != c.want {
			t.Fatalf("kind=%s: want %s, got %s", c.kind, c.want, got)
		}
	}
}

func TestPane_RecordEvent_PostToolFailureInterruptGoesUnknown(t *testing.T) {
	p := newTestPane()
	// Start a turn: user prompt → pre/post tool → Working.
	p.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	p.RecordEvent(events.Event{Kind: events.KindPreTool})
	if p.AgentState() != proto.AgentStateWorking {
		t.Fatal("precondition: should be working after pre_tool")
	}
	// User hits Escape mid-tool — Claude fires PostToolUseFailure with
	// is_interrupt:true. Abandoned turn → Unknown (gray), NOT Idle (green,
	// which signals "task completed — notice me").
	p.RecordEvent(events.Event{
		Kind: events.KindPostToolFailure,
		Data: []byte(`{"is_interrupt":true,"error":"user interrupt"}`),
	})
	if got := p.AgentState(); got != proto.AgentStateUnknown {
		t.Fatalf("interrupt should → unknown, got %s", got)
	}
}

func TestPane_RecordEvent_UserInterruptGoesUnknown(t *testing.T) {
	p := newTestPane()
	p.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	if p.AgentState() != proto.AgentStateWorking {
		t.Fatal("precondition: should be working")
	}
	// User hits Escape between tools (WS handler synthesizes this
	// event when it sees a lone ESC keystroke on a working Claude pane).
	p.RecordEvent(events.Event{Kind: events.KindUserInterrupt})
	if got := p.AgentState(); got != proto.AgentStateUnknown {
		t.Fatalf("user_interrupt should → unknown, got %s", got)
	}
}

func TestPane_RecordEvent_PostToolFailureRegularStaysWorking(t *testing.T) {
	p := newTestPane()
	p.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	p.RecordEvent(events.Event{Kind: events.KindPreTool})
	// Tool failed for a non-interrupt reason (e.g. file not found). Claude
	// will typically retry or respond to the user, so we stay "working"
	// and let the next event drive the transition.
	p.RecordEvent(events.Event{
		Kind: events.KindPostToolFailure,
		Data: []byte(`{"is_interrupt":false,"error":"ENOENT"}`),
	})
	if got := p.AgentState(); got != proto.AgentStateWorking {
		t.Fatalf("non-interrupt tool failure should keep working, got %s", got)
	}
	// Missing is_interrupt field (legacy payload) also stays working.
	p.RecordEvent(events.Event{
		Kind: events.KindPostToolFailure,
		Data: []byte(`{"error":"something else"}`),
	})
	if got := p.AgentState(); got != proto.AgentStateWorking {
		t.Fatalf("missing is_interrupt should default to working, got %s", got)
	}
}

func TestPane_RecordEvent_PermissionDeniedGoesAttention(t *testing.T) {
	p := newTestPane()
	p.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	// Auto-mode classifier denied a tool — user has to manually approve.
	p.RecordEvent(events.Event{Kind: events.KindPermissionDenied})
	if got := p.AgentState(); got != proto.AgentStateAttention {
		t.Fatalf("permission_denied should → attention (red), got %s", got)
	}
	// PermissionRequest (interactive prompt) has the same semantics.
	p2 := newTestPane()
	p2.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	p2.RecordEvent(events.Event{Kind: events.KindPermissionRequest})
	if got := p2.AgentState(); got != proto.AgentStateAttention {
		t.Fatalf("permission_request should → attention (red), got %s", got)
	}
	// Elicitation (MCP asking for user input mid-tool) → same.
	p3 := newTestPane()
	p3.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	p3.RecordEvent(events.Event{Kind: events.KindElicitation})
	if got := p3.AgentState(); got != proto.AgentStateAttention {
		t.Fatalf("elicitation should → attention (red), got %s", got)
	}
}

func TestPane_RecordEvent_StopFailureGoesIdle(t *testing.T) {
	p := newTestPane()
	p.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	// API error ends the turn. Still a terminal state, so go Idle.
	p.RecordEvent(events.Event{Kind: events.KindStopFailure})
	if got := p.AgentState(); got != proto.AgentStateIdle {
		t.Fatalf("stop_failure should → idle, got %s", got)
	}
}

func TestPane_RecordEvent_IgnoredKindsDontMoveState(t *testing.T) {
	p := newTestPane()
	// Move to idle via Stop first.
	p.RecordEvent(events.Event{Kind: events.KindUserPrompt})
	p.RecordEvent(events.Event{Kind: events.KindStop})
	if p.AgentState() != proto.AgentStateIdle {
		t.Fatal("precondition failed")
	}
	// session_start / session_end / notification are all logged but do NOT
	// transition state. Notification specifically is ambiguous in Claude
	// (fires on 60s idle AND on permission prompts), so we don't use it
	// for attention — a subsequent Stop should still be the last word.
	p.RecordEvent(events.Event{Kind: events.KindSessionStart})
	p.RecordEvent(events.Event{Kind: events.KindSessionEnd})
	p.RecordEvent(events.Event{Kind: events.KindNotification})
	if p.AgentState() != proto.AgentStateIdle {
		t.Fatalf("non-transitioning events should not alter state, got %s", p.AgentState())
	}
}

func TestPane_RecordEvent_AppendsToLog(t *testing.T) {
	p := newTestPane()
	p.RecordEvent(events.Event{ID: "a", Kind: events.KindSessionStart})
	p.RecordEvent(events.Event{ID: "b", Kind: events.KindUserPrompt})
	p.RecordEvent(events.Event{ID: "c", Kind: events.KindStop})
	snap := p.EventLog().Snapshot()
	if len(snap) != 3 {
		t.Fatalf("want 3 events logged, got %d", len(snap))
	}
	if snap[0].ID != "a" || snap[1].ID != "b" || snap[2].ID != "c" {
		t.Fatalf("order wrong: %+v", snap)
	}
}

// Phase 10a (codex round 5 finding 11): the effective-stoplight
// contract must reach Subscribe's initial snapshot, not just Info.
// A reconnecting WS client sees the 5th return value of Subscribe;
// if that value were the raw stoplight, the user would see a stale
// green/gray on reconnect while cwd was still gone.
func newSubscribeTestPane() *Pane {
	return &Pane{
		ID:           "p_sub_test",
		ProjectID:    "proj",
		Kind:         proto.PaneKindShell,
		subs:         make(map[int]*Subscriber),
		replay:       newReplayBuffer(64),
		stoplight:    proto.StoplightGray,
		cwdAvailable: true,
		eventLog:     events.NewLog(16),
	}
}

func TestPane_Subscribe_initialSnapshotReturnsEffectiveStoplight(t *testing.T) {
	p := newSubscribeTestPane()

	// Start: cwdAvailable=true, raw stoplight=gray; effective = gray.
	outCh := make(chan []byte, 1)
	statusCh := make(chan proto.Stoplight, 4)
	exitCh := make(chan int, 1)
	errCh := make(chan string, 1)
	_, _, _, _, sl1 := p.Subscribe(outCh, statusCh, exitCh, errCh)
	if sl1 != proto.StoplightGray {
		t.Fatalf("baseline subscribe snapshot: want gray, got %v", sl1)
	}

	// Flip cwd unavailable; a NEW subscription's initial snapshot
	// must be red (the effective value) — not gray (the raw value).
	p.SetCwdAvailable(false)
	statusCh2 := make(chan proto.Stoplight, 4)
	_, _, _, _, sl2 := p.Subscribe(make(chan []byte, 1), statusCh2, make(chan int, 1), make(chan string, 1))
	if sl2 != proto.StoplightRed {
		t.Fatalf("subscribe while cwd unavailable: want red, got %v", sl2)
	}

	// Meanwhile the stoplight runner keeps writing to the raw field.
	// A new subscription still sees red because effective is computed.
	p.SetStoplight(proto.StoplightGreen)
	statusCh3 := make(chan proto.Stoplight, 4)
	_, _, _, _, sl3 := p.Subscribe(make(chan []byte, 1), statusCh3, make(chan int, 1), make(chan string, 1))
	if sl3 != proto.StoplightRed {
		t.Fatalf("subscribe after SetStoplight(green) with cwd unavailable: want red, got %v", sl3)
	}

	// Recovery: cwd comes back. Effective falls back to whatever the
	// raw was last set to (green in this test). New subscribers see
	// that raw value, and the existing subscribers get a status
	// update on the recovery transition.
	p.SetCwdAvailable(true)
	statusCh4 := make(chan proto.Stoplight, 4)
	_, _, _, _, sl4 := p.Subscribe(make(chan []byte, 1), statusCh4, make(chan int, 1), make(chan string, 1))
	if sl4 != proto.StoplightGreen {
		t.Fatalf("subscribe after cwd recovery: want green (raw fallback), got %v", sl4)
	}
}

// Codex round-6 finding 13: a client that subscribed BEFORE the
// outage, then saw the raw stoplight change while forced-red was
// active, must on recovery receive a frame for the FINAL raw value
// (not the pre-outage value). A regression where recovery emits
// the stale baseline would keep a long-lived subscriber out of sync.
func TestPane_SetCwdAvailable_recoveryFrameReflectsRawChangesDuringOutage(t *testing.T) {
	p := newSubscribeTestPane()

	// Subscribe FIRST, before any outage. Baseline effective = gray.
	statusCh := make(chan proto.Stoplight, 8)
	p.Subscribe(make(chan []byte, 1), statusCh, make(chan int, 1), make(chan string, 1))

	// Outage: effective gray → red.
	p.SetCwdAvailable(false)
	drainStatus(t, statusCh, proto.StoplightRed, "outage onset")

	// While forced-red is active, the stoplight runner writes a
	// bunch of different raw values. Since effective stays red,
	// the subscriber must NOT receive any frames for these.
	p.SetStoplight(proto.StoplightOrange)
	p.SetStoplight(proto.StoplightGray)
	p.SetStoplight(proto.StoplightGreen)
	select {
	case got := <-statusCh:
		t.Fatalf("unexpected status frame during forced-red outage: %v", got)
	default:
		// ok — no frame fired
	}

	// Recovery: cwd comes back. The subscriber MUST receive a
	// frame, and that frame MUST carry the FINAL raw value
	// (green) — not the pre-outage baseline (gray), not any of
	// the in-outage intermediates (orange).
	p.SetCwdAvailable(true)
	drainStatus(t, statusCh, proto.StoplightGreen, "recovery frame matches final raw")
}

// drainStatus helper: assert the next frame on `ch` equals `want`.
func drainStatus(t *testing.T, ch chan proto.Stoplight, want proto.Stoplight, label string) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("%s: want %v, got %v", label, want, got)
		}
	default:
		t.Fatalf("%s: expected a status frame, got none", label)
	}
}

// Proves SetCwdAvailable fires fan-out status updates to live
// subscribers — not just the snapshot path. A client that was
// already subscribed when the mount dropped must see a red status
// frame, and a matching recovery frame.
func TestPane_SetCwdAvailable_firesSubscriberStatusOnEffectiveTransition(t *testing.T) {
	p := newSubscribeTestPane()

	statusCh := make(chan proto.Stoplight, 8)
	p.Subscribe(make(chan []byte, 1), statusCh, make(chan int, 1), make(chan string, 1))

	// cwd goes away → effective transitions gray → red.
	p.SetCwdAvailable(false)
	select {
	case got := <-statusCh:
		if got != proto.StoplightRed {
			t.Fatalf("expected red status frame after SetCwdAvailable(false), got %v", got)
		}
	default:
		t.Fatalf("expected a status frame after SetCwdAvailable(false), got none")
	}

	// Runner writes gray while cwd is still gone → no effective
	// change → NO status frame should reach the subscriber.
	p.SetStoplight(proto.StoplightGray)
	select {
	case got := <-statusCh:
		t.Fatalf("unexpected status frame during cwd-gone state: %v", got)
	default:
		// ok
	}

	// cwd recovers → effective transitions red → gray.
	p.SetCwdAvailable(true)
	select {
	case got := <-statusCh:
		if got != proto.StoplightGray {
			t.Fatalf("expected gray (raw) frame after cwd recovery, got %v", got)
		}
	default:
		t.Fatalf("expected a status frame on cwd recovery, got none")
	}
}

// TestPane_AddCleanup_firesOnKill pins the contract used by the
// image-paste upload tmpdir cleanup : cleanup callbacks
// registered via AddCleanup fire when the pane is torn down via Kill.
// Idempotency matters because DeletePane calls Kill AND the waitLoop
// also triggers cleanup once the child reaps.
func TestPane_AddCleanup_firesOnKill(t *testing.T) {
	// Fresh pane with a zeroed mu — fields the runtime sets in Spawn
	// aren't touched here, but runCleanup only needs mu + cleanup state.
	p := &Pane{
		ID:       "p_cleanup_kill",
		exited:   make(chan struct{}),
	}

	calls := 0
	p.AddCleanup(func() { calls++ })
	p.AddCleanup(func() { calls += 10 })

	// Kill with nil Cmd + Tty is safe — Kill nil-guards both. This
	// exercises runCleanup without needing to spawn a real child.
	p.Kill()

	if calls != 11 {
		t.Fatalf("cleanup callbacks: got %d (want 11 = 1 + 10)", calls)
	}

	// Kill is re-entrant-safe — cleanupDone guards against double-fire.
	// DeletePane + waitLoop both trigger cleanup in production; second
	// call must be a no-op, not double-run.
	p.Kill()
	if calls != 11 {
		t.Fatalf("cleanup fired twice (got %d, want 11 — idempotent contract broken)", calls)
	}
}

// TestPane_AddCleanup_lateRegistrationRunsSynchronously — AddCleanup
// called AFTER the pane has already torn down must still run the
// callback (synchronously, before returning). Without this the
// upload handler's ensurePaneUploadDir could race against a
// just-deleted pane and leak its tmpdir.
func TestPane_AddCleanup_lateRegistrationRunsSynchronously(t *testing.T) {
	p := &Pane{
		ID:     "p_cleanup_late",
		exited: make(chan struct{}),
	}
	p.Kill() // fires runCleanup with zero callbacks, sets cleanupDone

	ran := false
	p.AddCleanup(func() { ran = true })
	if !ran {
		t.Fatal("late AddCleanup on a torn-down pane should run the callback synchronously")
	}
}

// TestPane_UploadsCtxCancelsBeforeCleanup pins the invariant the
// upload handler relies on (an earlier release 4b): pane teardown must cancel
// UploadsCtx BEFORE any registered cleanup callback fires. If the
// tmpdir rm-rf cleanup ran first, an in-flight io.Copy would still be
// writing into a just-unlinked directory.
//
// We observe this by registering a cleanup that records whether the
// ctx was already cancelled by the time the cleanup ran. The record
// must be true.
func TestPane_UploadsCtxCancelsBeforeCleanup(t *testing.T) {
	uploadsCtx, uploadsCancel := context.WithCancel(context.Background())
	p := &Pane{
		ID:            "p_uploadsctx",
		exited:        make(chan struct{}),
		uploadsCtx:    uploadsCtx,
		uploadsCancel: uploadsCancel,
	}

	if p.UploadsCtx().Err() != nil {
		t.Fatal("UploadsCtx cancelled before Kill")
	}

	var ctxWasCancelled bool
	p.AddCleanup(func() {
		ctxWasCancelled = p.UploadsCtx().Err() != nil
	})

	p.Kill()

	if !ctxWasCancelled {
		t.Fatal("UploadsCtx must be cancelled BEFORE cleanup callbacks fire")
	}
	if p.UploadsCtx().Err() == nil {
		t.Fatal("UploadsCtx still active after Kill returned")
	}
}

// TestPane_UploadsCtx_nilFallbackToBackground: panes constructed
// outside Spawn (test harnesses that bypass exec) return a never-
// cancelling context. Upload handlers must not panic on those.
func TestPane_UploadsCtx_nilFallbackToBackground(t *testing.T) {
	p := &Pane{ID: "p_nilctx"}
	ctx := p.UploadsCtx()
	if ctx == nil {
		t.Fatal("UploadsCtx returned nil for partially-constructed pane")
	}
	select {
	case <-ctx.Done():
		t.Fatal("fallback ctx unexpectedly cancelled")
	case <-time.After(10 * time.Millisecond):
	}
}

// TestPane_OnExit_replaysForAlreadyExitedPane covers audit F9 :
// a fast-exiting child (e.g. /bin/false) can finalize before
// CreatePaneWith has finished wiring its OnExit callbacks. Pre-fix the
// callback would be silently lost because finalizeExit had already
// drained p.onExit; post-fix, OnExit on an already-exited pane runs
// the callback synchronously.
//
// We simulate the race by spawning a fast-exit shell and waiting for
// the pane's exited channel to close (ensuring finalizeExit ran), then
// registering the callback after the fact. The callback must fire
// with the pane ID. No sleeps for the synchronisation — we use the
// pane's WaitForExit and a result channel with a generous bound.
func TestPane_OnExit_replaysForAlreadyExitedPane(t *testing.T) {
	// /bin/false doesn't exist on macOS; /bin/sh -c "exit 0" exits
	// immediately and is portable across darwin/linux.
	pane, err := Spawn("p_test", proto.PaneKindShell, []string{"/bin/sh", "-c", "exit 0"}, t.TempDir(), 80, 24, nil)
	if err != nil {
		t.Fatalf("Spawn fast-exit shell: %v", err)
	}
	// Wait for the wait goroutine to run finalizeExit. The exited
	// channel is closed AT the start of finalizeExit's post-lock
	// section, before the onExit callbacks are drained. The mutex
	// inside OnExit synchronises us against the rest of finalizeExit,
	// so observing exit-state under the lock is sufficient — but we
	// need to also wait long enough for finalizeExit to have actually
	// emptied p.onExit (i.e. its post-close work). WaitForExit blocks
	// on the channel close (start of post-lock work) — by the time it
	// returns, the lock is briefly contended by finalizeExit's drain
	// loop. Acquiring p.mu via OnExit serialises us safely.
	if !pane.WaitForExit(2 * time.Second) {
		t.Fatal("/bin/false did not finalize within 2s — wait loop wedged?")
	}
	// finalizeExit closes `exited` BEFORE running drained callbacks
	// (they run outside the lock). To guarantee we hit the
	// already-exited branch, give finalizeExit a moment to drop the
	// lock and complete any post-close fanout. A short bounded wait
	// using the State() check is deterministic — once State() returns
	// Exited under the lock, finalizeExit has finished its critical
	// section.
	deadline := time.Now().Add(2 * time.Second)
	for pane.State() != proto.PaneStateExited && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if pane.State() != proto.PaneStateExited {
		t.Fatal("pane state never reached Exited after WaitForExit")
	}

	got := make(chan string, 1)
	pane.OnExit(func(id string) { got <- id })
	select {
	case id := <-got:
		if id != pane.ID {
			t.Fatalf("OnExit callback received id=%q, want %q", id, pane.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnExit callback did not fire on already-exited pane (audit F9 race)")
	}
}

// TestPane_OnExit_nilCallbackIsNoop guards against a nil dereference
// in the replay branch. nil callbacks are silently dropped just like
// they were in the queueing branch (an append of nil would have been
// invoked from finalizeExit's drain loop and panicked).
func TestPane_OnExit_nilCallbackIsNoop(t *testing.T) {
	p := &Pane{ID: "p_nil_cb", state: proto.PaneStateExited}
	// Should not panic.
	p.OnExit(nil)
}

// processAlive returns true iff the pid is currently a live process
// owned by this user. signal 0 is the canonical "ping": permission
// errors mean the process exists but isn't ours; ESRCH means gone.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	if errors.Is(err, syscall.ESRCH) {
		return false
	}
	// EPERM => process exists but owned by someone else. In our test
	// the child runs as us, so EPERM shouldn't happen — surface as
	// "alive" to fail loud rather than swallow.
	return true
}

// readNumbersFromReplay polls the pane's replay buffer until at least
// `want` numeric-only lines have been emitted, then returns them in
// order. Used to extract pids the bash child echoes via
// `echo $$` / `echo $!`.
func readNumbersFromReplay(t *testing.T, p *Pane, want int, deadline time.Duration) []int {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		snap := string(p.ReplayTail(8192))
		// bash echoes lines with \r\n on a PTY.
		lines := strings.Split(snap, "\n")
		var nums []int
		for _, ln := range lines {
			if n, err := strconv.Atoi(strings.TrimSpace(ln)); err == nil {
				nums = append(nums, n)
			}
		}
		if len(nums) >= want {
			return nums
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("only saw %d numeric lines (wanted %d); tail was: %q",
		-1, want, string(p.ReplayTail(512)))
	return nil
}

// TestPane_Kill_killsBackgroundedChildren is the F6 audit regression:
// a pane that spawns a backgrounded child (sleep) must, on Kill,
// take that child down too. Pre-fix, SIGTERM/SIGKILL only landed on
// the leader pid; the backgrounded `sleep` would be reparented to
// init and survive. After the fix the entire process group dies.
//
// The bash one-liner: print our pid, fork a long sleep in the
// background, print its pid, then wait so the leader stays alive
// until we kill it.
func TestPane_Kill_killsBackgroundedChildren(t *testing.T) {
	cmd := []string{"/bin/bash", "-c", `echo $$; sleep 60 & echo $!; wait`}
	p, err := Spawn("proj-test", proto.PaneKindShell, cmd, t.TempDir(), 80, 24, nil)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	// Read leader pid + sleep pid in order. The bash one-liner echoes
	// $$ first then $! after the &, so they always arrive in that
	// sequence in the replay buffer.
	pids := readNumbersFromReplay(t, p, 2, 2*time.Second)
	leaderPid := pids[0]
	sleepPid := pids[1]
	if sleepPid == leaderPid {
		t.Fatalf("leader pid == sleep pid (%d) — bash didn't background the sleep", leaderPid)
	}

	// Both pids must be alive before Kill.
	if !processAlive(leaderPid) {
		t.Fatalf("leader pid %d not alive pre-Kill", leaderPid)
	}
	if !processAlive(sleepPid) {
		t.Fatalf("sleep pid %d not alive pre-Kill", sleepPid)
	}

	p.Kill()
	if !p.WaitForExit(3 * time.Second) {
		t.Fatal("pane leader did not exit within 3s of Kill")
	}

	// Group SIGTERM should have taken the sleep down too. Give the
	// kernel a brief window to deliver the signal and let the
	// process table update.
	gone := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(sleepPid) {
			gone = true
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !gone {
		// Force-kill so we don't leak a sleep across test runs.
		_ = syscall.Kill(sleepPid, syscall.SIGKILL)
		t.Fatalf("sleep pid %d survived pane Kill — process group not addressed", sleepPid)
	}
}

// TestPane_Kill_sigkillsAfterSigtermGrace is the second half of F6:
// a child that traps SIGTERM must STILL die — group-Kill escalates to
// SIGKILL after the 2s grace. Without escalation, a misbehaving claude
// subprocess could keep the pane (and its claude session) wedged
// across pane delete.
func TestPane_Kill_sigkillsAfterSigtermGrace(t *testing.T) {
	// Trap TERM + INT and sleep forever. Bash `wait` is interruptible
	// and would return on a trapped signal; using a `sleep` loop keeps
	// the leader alive until SIGKILL lands.
	cmd := []string{"/bin/bash", "-c", `trap "" TERM INT; echo $$; while :; do sleep 5; done`}
	p, err := Spawn("proj-test-sigkill", proto.PaneKindShell, cmd, t.TempDir(), 80, 24, nil)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	leaderPid := readNumbersFromReplay(t, p, 1, 2*time.Second)[0]
	if !processAlive(leaderPid) {
		t.Fatalf("leader pid %d not alive pre-Kill", leaderPid)
	}

	start := time.Now()
	p.Kill()
	// 2s SIGTERM grace + ~0.5s headroom for SIGKILL delivery & reap.
	if !p.WaitForExit(3 * time.Second) {
		// Force-cleanup so we don't leak.
		_ = syscall.Kill(leaderPid, syscall.SIGKILL)
		t.Fatal("TERM-trapping leader did not exit within SIGTERM-grace + SIGKILL window")
	}
	elapsed := time.Since(start)
	// The child traps TERM so it should NOT exit before the 2s grace.
	// If it exits much earlier, the test isn't actually exercising
	// the SIGKILL escalation path.
	if elapsed < 1900*time.Millisecond {
		t.Errorf("pane exited in %v; expected at least ~2s SIGTERM grace before SIGKILL — escalation path may not be exercised", elapsed)
	}
	if processAlive(leaderPid) {
		_ = syscall.Kill(leaderPid, syscall.SIGKILL)
		t.Fatalf("leader pid %d still alive after Kill+grace — SIGKILL escalation broken", leaderPid)
	}
}

// TestPane_Spawn_setsControllingTerminal verifies the pty library
// still grants the child its PTY as a controlling terminal even with
// our process-group teardown changes. We probe via `tty -s` which
// returns 0 only when stdin is a terminal — and the child runs with
// stdin = the PTY slave, so success = controlling-tty path intact.
//
// Originally a guard against accidentally setting Setsid ourselves
// in a way that conflicted with the library's own Setsid+Setctty
// (creack/pty v1.1.24's StartWithSize already sets both). We don't
// override SysProcAttr in Spawn so this should pass; if a future
// change tweaks Spawn's SysProcAttr handling this test catches the
// regression.
func TestPane_Spawn_setsControllingTerminal(t *testing.T) {
	// `tty -s` exits 0 if stdin is a tty, 1 otherwise. Echo a marker
	// then exit with the tty -s status. The marker proves we got
	// past spawn; the exit code proves the controlling tty contract.
	cmd := []string{"/bin/bash", "-c", `echo READY; tty -s; exit $?`}
	p, err := Spawn("proj-tty", proto.PaneKindShell, cmd, t.TempDir(), 80, 24, nil)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer p.Kill()
	if !p.WaitForExit(3 * time.Second) {
		t.Fatal("controlling-tty probe never exited")
	}
	if got := p.ExitCode(); got == nil || *got != 0 {
		t.Fatalf("tty -s exited %v; expected 0 (stdin must be a tty for the child)", got)
	}
}
