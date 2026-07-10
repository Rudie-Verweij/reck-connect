package mountprobe

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

// Helper: stand up a Manager with a single shell pane inside a temp
// directory. The cwd we return is the one the watcher will stat.
func newManagerWithShellPane(t *testing.T, cwd string) (*pty.Manager, *pty.Pane) {
	t.Helper()
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(cwd, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	projects := []config.Project{{
		ID:    "p1",
		Name:  "P1",
		Cwd:   cwd,
		Shell: []string{"/bin/sh"},
	}}
	m := pty.NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)
	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	return m, pane
}

// Phase 10a core contract: delete the cwd → the pane's effective
// stoplight becomes red. Recreate → effective stoplight falls back
// to the raw (agent-driven) value.
func TestWatcher_cwdDisappearanceDrivesEffectiveRed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fake-mount")
	m, pane := newManagerWithShellPane(t, dir)
	defer func() { _ = m.DeletePane("p1", pane.ID) }()

	w := New(m, 10*time.Millisecond, nil)

	// Baseline: cwd exists, effective stoplight is gray (no agent
	// events, cwd available).
	w.Tick()
	if !pane.CwdAvailable() {
		t.Fatalf("expected cwdAvailable=true before cwd deletion")
	}
	if got := pane.Info().Stoplight; got == proto.StoplightRed {
		t.Fatalf("pane prematurely red: %v", got)
	}

	// Drop the cwd (portable stand-in for sshfs unmount — process
	// keeps the old inode via its open fd, shell stays alive).
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}

	w.Tick()
	if pane.CwdAvailable() {
		t.Fatalf("expected cwdAvailable=false after cwd deletion")
	}
	if got := pane.Info().Stoplight; got != proto.StoplightRed {
		t.Fatalf("expected effective stoplight red after cwd deletion, got %v", got)
	}

	// Recreate the cwd — simulates sshfs reconnect.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll (recovery): %v", err)
	}
	w.Tick()
	if !pane.CwdAvailable() {
		t.Fatalf("expected cwdAvailable=true after cwd recovery")
	}
	if got := pane.Info().Stoplight; got == proto.StoplightRed {
		t.Fatalf("expected effective stoplight cleared after cwd recovery, got %v", got)
	}
}

// Codex round-4 fix: a 1 Hz stoplight runner writing green every tick
// must NOT clobber the probe's red while cwd is still unreachable.
// The effective stoplight is computed, not a race.
func TestWatcher_mountLossRedSurvivesStoplightRunnerWrites(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fake-mount")
	m, pane := newManagerWithShellPane(t, dir)
	defer func() { _ = m.DeletePane("p1", pane.ID) }()

	w := New(m, 10*time.Millisecond, nil)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	w.Tick()
	if got := pane.Info().Stoplight; got != proto.StoplightRed {
		t.Fatalf("expected red after cwd deletion, got %v", got)
	}

	// Now simulate the stoplight runner writing green (agent went
	// idle / byte flow stopped / whatever). In the edge-triggered
	// implementation this would clobber the probe's red; in the
	// effective-stoplight implementation the raw value goes green
	// but effective stays red because cwdAvailable=false.
	pane.SetStoplight(proto.StoplightGreen)
	if got := pane.Info().Stoplight; got != proto.StoplightRed {
		t.Fatalf("mount-loss red was clobbered by stoplight runner write: got %v", got)
	}
	// Orange / gray likewise shouldn't matter.
	pane.SetStoplight(proto.StoplightOrange)
	if got := pane.Info().Stoplight; got != proto.StoplightRed {
		t.Fatalf("mount-loss red was clobbered by stoplight=orange: got %v", got)
	}

	// Recovery: cwd comes back, effective stoplight falls back to
	// whatever the raw was last set to (orange in this test).
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	w.Tick()
	if got := pane.Info().Stoplight; got != proto.StoplightOrange {
		t.Fatalf("expected recovery to expose the raw orange, got %v", got)
	}
}

// Injected statFn exercises the unreachable path without having to
// actually RemoveAll — keeps the test honest about the stat-error
// contract (any error → unreachable, not just ENOENT).
func TestWatcher_anyStatErrorMarksUnreachable(t *testing.T) {
	dir := t.TempDir()
	m, pane := newManagerWithShellPane(t, dir)
	defer func() { _ = m.DeletePane("p1", pane.ID) }()

	w := New(m, 10*time.Millisecond, nil)
	w.SetStatFn(func(path string) error {
		return &fs.PathError{Op: "stat", Path: path, Err: errors.New("permission denied")}
	})
	w.Tick()
	if pane.CwdAvailable() {
		t.Fatalf("expected stat-error to flag pane unavailable")
	}
	if got := pane.Info().Stoplight; got != proto.StoplightRed {
		t.Fatalf("expected effective stoplight red under stat-error, got %v", got)
	}

	w.SetStatFn(func(path string) error { return nil })
	w.Tick()
	if !pane.CwdAvailable() {
		t.Fatalf("expected pane to clear after stat recovers")
	}
}

// Codex round-7 finding 14: a single hung stat on pane N must not
// blind the watcher for pane N+1..end. This test stands up two
// panes with different cwds; statFn blocks forever when asked
// about the first pane's cwd, returns ENOENT for the second. After
// a tick with a short stat timeout, pane 1 is marked unavailable
// (treated as "mount too slow to respond" — same UX as gone) and
// pane 2 is ALSO correctly marked unavailable. Without the per-
// pane timeout, pane 2's probe would have been blocked behind
// pane 1's stat forever.
func TestWatcher_stuckStatDoesNotBlockLaterPanes(t *testing.T) {
	root := t.TempDir()
	dir1 := filepath.Join(root, "pane1")
	dir2 := filepath.Join(root, "pane2")
	if err := os.MkdirAll(dir1, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir2, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	projects := []config.Project{
		{ID: "p1", Name: "P1", Cwd: dir1, Shell: []string{"/bin/sh"}},
		{ID: "p2", Name: "P2", Cwd: dir2, Shell: []string{"/bin/sh"}},
	}
	m := pty.NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)
	pane1, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	pane2, err := m.CreatePane("p2", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = m.DeletePane("p1", pane1.ID) }()
	defer func() { _ = m.DeletePane("p2", pane2.ID) }()

	w := New(m, 10*time.Millisecond, nil)
	// Short timeout so the test completes quickly — production
	// uses DefaultStatTimeout (2s).
	w.SetStatTimeout(20 * time.Millisecond)
	// Channel used to release the first stat once we're done —
	// avoids leaking the goroutine past test completion.
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	w.SetStatFn(func(path string) error {
		if path == dir1 {
			<-release // block forever from the watcher's POV
			return nil
		}
		return &fs.PathError{Op: "stat", Path: path, Err: errors.New("ENOENT")}
	})

	w.Tick()

	// Pane 1: stat timed out → unavailable → red.
	if pane1.CwdAvailable() {
		t.Fatalf("pane1: expected unavailable after stuck stat timed out")
	}
	if got := pane1.Info().Stoplight; got != proto.StoplightRed {
		t.Fatalf("pane1: expected red after stuck stat timed out, got %v", got)
	}
	// Pane 2: stat completed with ENOENT → also unavailable → red.
	// The critical assertion is that pane2 was REACHED — a
	// regression where pane1's stat blocked the loop would leave
	// pane2 at cwdAvailable=true (the default).
	if pane2.CwdAvailable() {
		t.Fatalf("pane2: was not probed — the stuck pane1 stat blocked the loop")
	}
}

// Codex round-8 finding 15: cancellation mid-probe must NOT drive
// apply(false), which would emit a red transition on healthy panes
// during shutdown. This test spawns a probe
// whose statFn blocks; cancels the context; asserts the pane's
// cwdAvailable is unchanged (still true).
func TestWatcher_ctxCancelDuringProbeDoesNotMutatePane(t *testing.T) {
	dir := t.TempDir()
	m, pane := newManagerWithShellPane(t, dir)
	defer func() { _ = m.DeletePane("p1", pane.ID) }()

	w := New(m, 10*time.Millisecond, nil)
	w.SetStatTimeout(2 * time.Second) // long enough to be clearly > cancel
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	w.SetStatFn(func(path string) error {
		<-release // block until test ends
		return nil
	})

	// Baseline: pane is available.
	if !pane.CwdAvailable() {
		t.Fatalf("pane should start available")
	}

	// Run tickCtx with a context we cancel mid-probe. The blocking
	// stat holds the worker goroutine; we cancel the ctx; the
	// worker sees probeAborted and skips apply(); pane stays true.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.tickCtx(ctx)
		close(done)
	}()
	// Give the tick a moment to launch the worker and enter statFn.
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
		// ok
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("tickCtx did not return within 500ms of ctx cancel")
	}
	if !pane.CwdAvailable() {
		t.Fatalf("cancel during probe wrongly flipped pane to unavailable")
	}
	if got := pane.Info().Stoplight; got == proto.StoplightRed {
		t.Fatalf("cancel during probe wrongly flipped stoplight to red: %v", got)
	}
}

// Codex round-8 finding 16: concurrent probes. Without a worker
// pool, N stuck panes serialize into N×statTimeout tick latency,
// starving later panes. This test drives the concurrent path: two
// panes with stuck statFn, one with a fast statFn; concurrency=3
// workers; asserts total tick duration stays bounded to ~one
// timeout (not 2× or 3×).
func TestWatcher_concurrentProbesBoundTickLatency(t *testing.T) {
	root := t.TempDir()
	dirs := []string{
		filepath.Join(root, "stuck1"),
		filepath.Join(root, "stuck2"),
		filepath.Join(root, "fast"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	configPath := filepath.Join(root, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	projects := []config.Project{
		{ID: "p1", Name: "P1", Cwd: dirs[0], Shell: []string{"/bin/sh"}},
		{ID: "p2", Name: "P2", Cwd: dirs[1], Shell: []string{"/bin/sh"}},
		{ID: "p3", Name: "P3", Cwd: dirs[2], Shell: []string{"/bin/sh"}},
	}
	m := pty.NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)
	pane1, _ := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	pane2, _ := m.CreatePane("p2", proto.PaneKindShell, 80, 24)
	pane3, _ := m.CreatePane("p3", proto.PaneKindShell, 80, 24)
	defer func() { _ = m.DeletePane("p1", pane1.ID) }()
	defer func() { _ = m.DeletePane("p2", pane2.ID) }()
	defer func() { _ = m.DeletePane("p3", pane3.ID) }()

	w := New(m, 10*time.Millisecond, nil)
	statTimeout := 60 * time.Millisecond
	w.SetStatTimeout(statTimeout)
	w.SetConcurrency(3)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	w.SetStatFn(func(path string) error {
		if path == dirs[0] || path == dirs[1] {
			<-release // blocked forever
			return nil
		}
		return nil // fast path: immediate success
	})

	start := time.Now()
	w.Tick()
	elapsed := time.Since(start)

	// With concurrency=3 all three probes run in parallel. Total
	// tick latency must be bounded to ~one statTimeout (the
	// timeout the two stuck panes share), NOT 2× or 3× that. A
	// generous upper bound of 2× the timeout accounts for
	// scheduling jitter; a regression reintroducing serial
	// behaviour would hit 2× or more.
	upperBound := statTimeout * 2
	if elapsed > upperBound {
		t.Fatalf("tick took %v, expected <= %v (serial-vs-parallel regression?)",
			elapsed, upperBound)
	}
	// Pane 1 and 2 should be red (stuck → timeout → unavailable).
	if pane1.CwdAvailable() {
		t.Fatalf("pane1 should be unavailable after stuck timeout")
	}
	if pane2.CwdAvailable() {
		t.Fatalf("pane2 should be unavailable after stuck timeout")
	}
	// Pane 3 should be available (fast statFn succeeded).
	if !pane3.CwdAvailable() {
		t.Fatalf("pane3 should be available after fast successful probe")
	}
}

// Codex round-9 finding 17: when bad-pane count exceeds the
// concurrency cap, the pool processes in batches and tick latency
// scales as ceil(badPanes/concurrency) × statTimeout. This test
// locks in the honest contract — NOT "one timeout regardless" (the
// earlier claim) but "ceil(badPanes/concurrency) timeouts". Five
// stuck panes with concurrency=2 + timeout=30ms should take
// ~ceil(5/2) × 30ms = ~90ms, bounded well under the serial
// alternative of 5 × 30ms = 150ms.
func TestWatcher_concurrentProbesBatchWhenBadPanesExceedConcurrency(t *testing.T) {
	root := t.TempDir()
	const stuckCount = 5
	dirs := make([]string, stuckCount)
	projects := make([]config.Project, stuckCount)
	for i := 0; i < stuckCount; i++ {
		d := filepath.Join(root, "stuck")
		d = filepath.Join(d, t.Name()[:0]) // just a unique per-iter seed
		d = filepath.Join(root, "stuck"+string(rune('a'+i)))
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		dirs[i] = d
		projects[i] = config.Project{
			ID: "p" + string(rune('1'+i)), Name: "P", Cwd: d, Shell: []string{"/bin/sh"},
		}
	}
	configPath := filepath.Join(root, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	m := pty.NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)
	panes := make([]*pty.Pane, stuckCount)
	for i, proj := range projects {
		p, err := m.CreatePane(proj.ID, proto.PaneKindShell, 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		panes[i] = p
		defer func(pid, paneID string) { _ = m.DeletePane(pid, paneID) }(proj.ID, p.ID)
	}

	const concurrency = 2
	const statTimeout = 50 * time.Millisecond
	w := New(m, 10*time.Millisecond, nil)
	w.SetConcurrency(concurrency)
	w.SetStatTimeout(statTimeout)

	// Instrument statFn to count in-flight probes and track the
	// peak concurrently. Codex round-10 finding 18: time-based
	// lower bound alone doesn't distinguish "cap honored" from
	// "cap bypassed" — a buggy pool allowing 3-4 probes in
	// parallel would still satisfy elapsed >= 2*timeout. Peak
	// in-flight count is the authoritative check.
	//
	// statFn completes in ~statHold < statTimeout so each worker
	// finishes cleanly (no timeout leak from the test itself) and
	// the next batch can dispatch. Without that, every statFn
	// would leak past the timeout, accumulating unbounded inner
	// goroutines (which is the real architectural limit we're
	// also documenting — see statWithTimeout's comment about
	// leaked goroutines). This test is specifically about the
	// batched worker-dispatch bound, NOT about the leak ceiling.
	const statHold = 40 * time.Millisecond
	var inflight atomic.Int32
	var peak atomic.Int32
	bumpPeak := func(now int32) {
		for {
			prev := peak.Load()
			if now <= prev || peak.CompareAndSwap(prev, now) {
				return
			}
		}
	}
	w.SetStatFn(func(path string) error {
		n := inflight.Add(1)
		bumpPeak(n)
		defer inflight.Add(-1)
		time.Sleep(statHold)
		return errors.New("stat failed") // simulate ENOENT
	})

	start := time.Now()
	w.Tick()
	elapsed := time.Since(start)

	// ceil(5/2) = 3 batches × ~statHold = ~120ms. Upper bound
	// protects against serial regression (5 × 40ms = 200ms); lower
	// bound enforces that at least 2 batches happened.
	upperBound := 5 * statHold           // serial path would be 5 × 40ms = 200ms
	lowerBound := 2 * statHold           // all-parallel would be 1 × 40ms
	if elapsed >= upperBound {
		t.Fatalf("tick took %v, expected < %v (serial regression?)",
			elapsed, upperBound)
	}
	if elapsed < lowerBound {
		t.Fatalf("tick took %v, expected >= %v (concurrency bound not enforced?)",
			elapsed, lowerBound)
	}
	// The authoritative check: peak in-flight probes must NEVER
	// exceed `concurrency`. A pool that let 3+ probes run at once
	// would violate the documented contract even if elapsed
	// happened to fall in the time window.
	if got := peak.Load(); got > concurrency {
		t.Fatalf("peak in-flight probes = %d, exceeds concurrency cap of %d", got, concurrency)
	}
	// And the peak SHOULD reach concurrency — if it stayed at 1,
	// the pool was effectively serial. Locks in that parallelism
	// actually happens.
	if got := peak.Load(); got < concurrency {
		t.Fatalf("peak in-flight probes = %d, expected to reach concurrency cap of %d", got, concurrency)
	}
	// All 5 panes should end unavailable.
	for i, p := range panes {
		if p.CwdAvailable() {
			t.Fatalf("pane %d expected unavailable after stuck timeout", i)
		}
	}
}

// Covers the TIMEOUT branch of statWithTimeout under a multi-pane
// outage (broken-mount scenario). The peak-inflight test above
// authoritatively enforces the concurrency cap on the
// clean-completion path via atomic counting; this test's job is
// complementary: prove the timeout exit path actually flows into
// apply(false) for every pane when the worker pool has to process
// badPanes > concurrency panes.
//
// Codex reviews round 11-13 surfaced the following division of
// labor:
//   - peak-inflight test enforces the strict cap via a concurrent
//     atomic counter on the clean path.
//   - this test proves the timeout path reaches all panes (every
//     statFn invocation counted; every pane unavailable) and that
//     total latency is bounded (not serial). Dispatch-ordering
//     assertions were removed because they depend on goroutine
//     scheduling rather than true slot-acquisition order, and can
//     flake under load without adding coverage the peak-inflight
//     test already gives.
func TestWatcher_timeoutBranchBatchesUnderBadPaneExcess(t *testing.T) {
	root := t.TempDir()
	const stuckCount = 5
	dirs := make([]string, stuckCount)
	projects := make([]config.Project, stuckCount)
	for i := 0; i < stuckCount; i++ {
		d := filepath.Join(root, "stuck"+string(rune('a'+i)))
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		dirs[i] = d
		projects[i] = config.Project{
			ID: "p" + string(rune('1'+i)), Name: "P", Cwd: d, Shell: []string{"/bin/sh"},
		}
	}
	configPath := filepath.Join(root, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	m := pty.NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)
	panes := make([]*pty.Pane, stuckCount)
	for i, proj := range projects {
		p, err := m.CreatePane(proj.ID, proto.PaneKindShell, 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		panes[i] = p
		defer func(pid, paneID string) { _ = m.DeletePane(pid, paneID) }(proj.ID, p.ID)
	}

	const concurrency = 2
	const statTimeout = 40 * time.Millisecond
	w := New(m, 10*time.Millisecond, nil)
	w.SetConcurrency(concurrency)
	w.SetStatTimeout(statTimeout)

	// All stats block past the timeout. Count invocations so we
	// can assert every pane was dispatched through the timeout
	// branch.
	var invocations atomic.Int32
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	w.SetStatFn(func(path string) error {
		invocations.Add(1)
		<-release // blocks; each leaks until test cleanup
		return nil
	})

	w.ResetPeakWorkers()
	start := time.Now()
	w.Tick()
	elapsed := time.Since(start)

	// Total-latency bound: serial would be 5 × 40ms = 200ms;
	// anything meaningfully less proves batching occurred.
	if elapsed >= 5*statTimeout {
		t.Fatalf("tick took %v, expected < %v (serial regression?)",
			elapsed, 5*statTimeout)
	}
	// Codex round-14 finding 22: authoritative concurrency-cap
	// check on the timeout path. PeakWorkers counts SLOT-acquired
	// workers (not statFn invocations — those can leak inner
	// goroutines past the timeout). A cap-bypass regression that
	// dispatched 3+ workers in parallel would move PeakWorkers
	// above `concurrency`; this assertion is deterministic
	// because the counter is updated inside the semaphore-hold
	// region.
	if peak := w.PeakWorkers(); peak > concurrency {
		t.Fatalf("peak active workers = %d, exceeds concurrency cap of %d (cap bypass on timeout path)",
			peak, concurrency)
	}
	// Peak should actually REACH concurrency — if it stayed at 1,
	// the pool was effectively serial.
	if peak := w.PeakWorkers(); peak < concurrency {
		t.Fatalf("peak active workers = %d, expected to reach concurrency cap of %d (no parallelism)",
			peak, concurrency)
	}
	// All panes must have been dispatched through the timeout
	// branch — invocations count == pane count — and all panes
	// must now be unavailable (apply(false) fired for each).
	if got := invocations.Load(); int(got) != stuckCount {
		t.Fatalf("statFn invoked %d times, expected %d (some panes not dispatched through timeout branch)",
			got, stuckCount)
	}
	for i, p := range panes {
		if p.CwdAvailable() {
			t.Fatalf("pane %d expected unavailable after timeout branch", i)
		}
	}
}

// Run(ctx) drives periodic ticks and respects context cancellation.
// Kept separate from the Tick()-based tests so race-sensitive
// behaviour doesn't pollute the deterministic ones.
func TestWatcher_Run_stopsOnCtxCancel(t *testing.T) {
	dir := t.TempDir()
	m, pane := newManagerWithShellPane(t, dir)
	defer func() { _ = m.DeletePane("p1", pane.ID) }()

	w := New(m, 2*time.Millisecond, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()
	// Let at least one tick happen.
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-done:
		// ok
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("Run did not return within 500ms of ctx cancel")
	}
}
