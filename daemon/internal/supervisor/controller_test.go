package supervisor

import (
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newTestController builds a Controller backed by a real Manager but with
// /bin/echo as the "claude" binary — the pane exits cheaply and the race
// harness can exercise the StartSupervisor gate without spawning real
// Claude Code instances.
func newTestController(t *testing.T) *Controller {
	t.Helper()
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := pty.NewManager(nil, []string{"/bin/echo"}, configPath, nil)
	scratch := filepath.Join(tmp, "scratch")
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	ctrl, err := New(Config{
		Manager:        mgr,
		DaemonURL:      "http://127.0.0.1:7315",
		AuthRequired:   false,
		ScratchDirRoot: tmp,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ctrl
}

// TestStartSupervisor_singleflight_concurrentCallersSpawnOnePane is the
// regression test for the Older.2 race: when ten goroutines all call
// StartSupervisor from a cold state they must end up with exactly one
// pane under the controller, not N orphans. Before the singleflight
// gate, multiple callers could observe "no pane" under the lock, drop
// it, and each call CreatePaneWith — leaving one tracked pane and the
// rest leaked (still running but untracked).
func TestStartSupervisor_singleflight_concurrentCallersSpawnOnePane(t *testing.T) {
	ctrl := newTestController(t)

	const N = 10
	var wg sync.WaitGroup
	ids := make([]string, N)
	errs := make([]error, N)
	start := make(chan struct{})
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func(idx int) {
			defer wg.Done()
			<-start
			id, err := ctrl.StartSupervisor()
			ids[idx] = id
			errs[idx] = err
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d failed: %v", i, err)
		}
	}
	// All callers must see the same pane ID.
	first := ids[0]
	if first == "" {
		t.Fatal("first pane ID is empty")
	}
	for i, id := range ids {
		if id != first {
			t.Errorf("caller %d got pane %q, want %q (singleflight broken)", i, id, first)
		}
	}

	// And the manager must only have one live pane under the meta-project.
	panes := ctrl.mgr.PanesInProject(SupervisorProjectID)
	if len(panes) != 1 {
		t.Errorf("manager holds %d panes, want 1 (leaked supervisor pane)", len(panes))
	}
}

// TestStartSupervisor_respawnsAfterExit — a fresh spawn after the pane
// has exited should produce a new ID, not deadlock on stale state.
func TestStartSupervisor_respawnsAfterExit(t *testing.T) {
	ctrl := newTestController(t)

	id1, err := ctrl.StartSupervisor()
	if err != nil {
		t.Fatal(err)
	}

	// /bin/echo exits immediately; wait until the pane transitions.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p, ok := ctrl.mgr.PaneByID(id1)
		if !ok || p.State() == proto.PaneStateExited {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	id2, err := ctrl.StartSupervisor()
	if err != nil {
		t.Fatalf("respawn: %v", err)
	}
	if id2 == "" {
		t.Fatal("respawn returned empty ID")
	}
	if id2 == id1 {
		t.Errorf("respawn returned same ID %q; expected fresh pane", id1)
	}
}

// TestStartSupervisor_stopDuringSpawn_tearsDownCleanly — the an earlier release
// followup regression for a Codex finding. Deterministic: forces
// Stop to land DURING Start's in-flight spawn using testSpawnMidFn
// (called after CreatePaneWith returns but before the paneID publish).
// Pre-fix, Stop would observe paneID=="" in that window and return
// success while Start went on to install a live supervisor pane.
// Post-fix, the stopGeneration check at publish time detects the
// race and tears the freshly-created pane down rather than leaking it.
//
// Invariants:
//   - Start returns ErrSupervisorStopRequested (Stop won).
//   - SupervisorPaneID() is "".
//   - Zero live panes under the meta-project.
//   - Stop returned success.
func TestStartSupervisor_stopDuringSpawn_tearsDownCleanly(t *testing.T) {
	ctrl := newTestController(t)

	// Wire a synchronisation hook so Stop fires exactly during the
	// window between CreatePaneWith and the paneID publish — the
	// narrow timing window where the pre-fix bug leaks a pane.
	stopDone := make(chan struct{})
	ctrl.testSpawnMidFn = func() {
		// Clear the hook so the eventual teardown-path CreatePaneWith
		// (if any) doesn't re-enter the race.
		ctrl.testSpawnMidFn = nil
		if err := ctrl.StopSupervisor(); err != nil {
			t.Errorf("StopSupervisor during spawn window: %v", err)
		}
		close(stopDone)
	}

	startID, startErr := ctrl.StartSupervisor()
	<-stopDone

	if !errors.Is(startErr, ErrSupervisorStopRequested) {
		t.Fatalf("expected ErrSupervisorStopRequested, got startID=%q err=%v", startID, startErr)
	}
	if startID != "" {
		t.Errorf("startID should be empty when Stop won, got %q", startID)
	}
	if published := ctrl.SupervisorPaneID(); published != "" {
		t.Errorf("SupervisorPaneID() = %q, want \"\" after Stop", published)
	}
	// No live panes leaked. The spawn got as far as creating a pane;
	// the stop-race path in doStartSupervisor must have killed it.
	for _, p := range ctrl.mgr.PanesInProject(SupervisorProjectID) {
		if p.State() != proto.PaneStateExited {
			t.Errorf("leaked live pane %q after Stop-during-spawn", p.ID)
		}
	}
}

// TestStartSupervisor_stopRace_doesNotLeakPane stress-tests the start/
// stop coordination under random timings. Pairs with the deterministic
// TestStartSupervisor_stopDuringSpawn_tearsDownCleanly above: the
// deterministic test pins the exact bug-window timing, this one runs
// 100 rounds under -race to catch orderings the deterministic case
// doesn't cover (e.g. Stop-just-after-publish where Start's pane is
// briefly live before Stop kills it).
//
// Invariant: after both return, every live pane under the meta-project
// must equal the currently-published paneID. A live pane with a
// different ID is a leaked spawn that Stop thought it had cleaned up.
func TestStartSupervisor_stopRace_doesNotLeakPane(t *testing.T) {
	const rounds = 100
	rng := rand.New(rand.NewSource(1))

	for round := 0; round < rounds; round++ {
		ctrl := newTestController(t)

		// Random 0-3ms delay so Stop fires around the time Start's
		// goroutine is mid-spawn. /bin/echo CreatePaneWith takes
		// ~1-2ms; this range straddles the pre-publish and post-
		// publish windows.
		stopDelay := time.Duration(rng.Intn(4)) * time.Millisecond

		var wg sync.WaitGroup
		wg.Add(2)
		var startID string
		var startErr error
		var stopErr error

		go func() {
			defer wg.Done()
			startID, startErr = ctrl.StartSupervisor()
		}()
		go func() {
			defer wg.Done()
			time.Sleep(stopDelay)
			stopErr = ctrl.StopSupervisor()
		}()
		wg.Wait()

		if stopErr != nil {
			t.Fatalf("round %d: StopSupervisor error: %v", round, stopErr)
		}
		if startErr != nil && !errors.Is(startErr, ErrSupervisorStopRequested) {
			t.Fatalf("round %d: unexpected StartSupervisor error: %v", round, startErr)
		}

		published := ctrl.SupervisorPaneID()
		panes := ctrl.mgr.PanesInProject(SupervisorProjectID)
		for _, p := range panes {
			if p.State() == proto.PaneStateExited {
				continue
			}
			if p.ID != published {
				t.Fatalf("round %d: leaked live pane %q not equal to published paneID %q (startID=%q, startErr=%v, stopDelay=%v)",
					round, p.ID, published, startID, startErr, stopDelay)
			}
		}

		if startErr == nil && startID != "" {
			if published != "" && published != startID {
				t.Fatalf("round %d: startID=%q but published=%q; Start's pane was silently replaced",
					round, startID, published)
			}
		}
	}
}
