package pty

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/proto"
)

// TestRemoveProject_persistsBeforeKillingPanes locks in the an earlier release
// transactional invariant: the on-disk registry removal MUST succeed
// before the Manager mutates in-memory state or kills pane children.
//
// The test injects a custom persister that records the pane's state at
// the moment of the disk-write call. If we write to disk AFTER killing
// the panes, the pane state at that moment would be Exited; this
// assertion fails if someone reverts the ordering fix.
func TestRemoveProject_persistsBeforeKillingPanes(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	proj, err := m.AddProject(proto.AddProjectRequest{Name: "OrderTest", Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	pane, err := m.CreatePane(proj.ID, proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}

	var stateAtWrite proto.PaneState
	var persistCalled bool
	m.removeProjectPersist = func(path, id string) error {
		persistCalled = true
		stateAtWrite = pane.State()
		// Delegate to the real writer so the rest of the flow sees
		// disk state that matches what the Manager expects.
		return config.RemoveProject(path, id)
	}

	if err := m.RemoveProject(proj.ID); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	if !persistCalled {
		t.Fatal("removeProjectPersist was never called")
	}
	if stateAtWrite != proto.PaneStateRunning {
		t.Fatalf("pane state at disk-write time = %s; expected %s (panes must not be killed before disk write)",
			stateAtWrite, proto.PaneStateRunning)
	}
}

// TestRemoveProject_persistFailureLeavesInMemoryStateIntact — the
// rollback guarantee: if the disk write fails, the Manager's in-memory
// project + pane records should still be present so callers can retry.
func TestRemoveProject_persistFailureLeavesInMemoryStateIntact(t *testing.T) {
	m := newManager(t)
	dir := t.TempDir()
	proj, err := m.AddProject(proto.AddProjectRequest{Name: "RollbackTest", Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	pane, err := m.CreatePane(proj.ID, proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer m.DeletePane(proj.ID, pane.ID)

	wantErr := errors.New("simulated disk full")
	m.removeProjectPersist = func(string, string) error { return wantErr }

	if err := m.RemoveProject(proj.ID); err != wantErr {
		t.Fatalf("RemoveProject error: got %v want %v", err, wantErr)
	}
	// Project should still be registered.
	if _, ok := m.ProjectDetail(proj.ID); !ok {
		t.Error("ProjectDetail should still resolve after persist failure")
	}
	// Pane should still be alive.
	if pane.State() != proto.PaneStateRunning {
		t.Errorf("pane state = %s, want running (should not have been killed after persist failure)", pane.State())
	}
	// Lookup by ID should still work.
	if _, ok := m.GetPane(proj.ID, pane.ID); !ok {
		t.Error("GetPane should still resolve after persist failure")
	}
}

// TestRemoveProject_waitsForChildBeforeDirDelete — the child-exit race
// fix from an earlier release. After pane.Kill() the Manager waits up to the
// configured timeout for Cmd.Wait to reap, then deletes the cwd.
//
// We probe by starting a shell pane whose project cwd is managed, then
// calling RemoveProject and asserting that (a) the directory is gone
// after the call, and (b) the pane state is Exited — i.e. we actually
// waited rather than racing past Kill.
func TestRemoveProject_waitsForChildBeforeDirDelete(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)

	proj, err := mgr.AddProject(proto.AddProjectRequest{Name: "WaitTest"})
	if err != nil {
		t.Fatal(err)
	}
	pane, err := mgr.CreatePane(proj.ID, proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}

	if err := mgr.RemoveProject(proj.ID); err != nil {
		t.Fatal(err)
	}
	if pane.State() != proto.PaneStateExited {
		t.Errorf("pane state after RemoveProject = %s, want exited (RemoveProject should wait for child)", pane.State())
	}
	if _, err := os.Stat(proj.Cwd); !os.IsNotExist(err) {
		t.Errorf("project cwd still present after RemoveProject: stat err=%v", err)
	}
}

// TestRemoveProject_timeoutSkipsDirDelete — security ordering: when a
// child fails to exit within the bounded wait, the Manager must SKIP
// the directory delete and log rather than rm-rf'ing under live fds.
//
// Simulating a child that actually refuses to die is fragile (SIGKILL
// can't be caught on Unix). Instead we register a stub Pane directly
// into the Manager's maps with a never-signalled `exited` channel,
// which forces WaitForExit to hit its timer deadline. Pane.Kill is
// nil-safe so the stub doesn't need a real Cmd / Tty.
func TestRemoveProject_timeoutSkipsDirDelete(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)
	mgr.removeProjectChildWaitTimeout = 50 * time.Millisecond

	proj, err := mgr.AddProject(proto.AddProjectRequest{Name: "TimeoutTest"})
	if err != nil {
		t.Fatal(err)
	}

	// Stub Pane: state=Running, exited chan NEVER closed. Kill is
	// nil-safe on nil Cmd/Tty, so the stub is safe to wire through
	// RemoveProject without spawning a real child.
	stuck := &Pane{
		ID:        "p_stuck",
		ProjectID: proj.ID,
		Kind:      proto.PaneKindShell,
		Cwd:       proj.Cwd,
		state:     proto.PaneStateRunning,
		exited:    make(chan struct{}),
	}
	mgr.mu.Lock()
	mgr.byProj[proj.ID] = append(mgr.byProj[proj.ID], stuck)
	mgr.byID[stuck.ID] = stuck
	mgr.mu.Unlock()

	start := time.Now()
	if err := mgr.RemoveProject(proj.ID); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed < 45*time.Millisecond {
		t.Errorf("RemoveProject returned in %v; expected at least 50ms (timeout path not exercised?)", elapsed)
	}
	// The project directory under the managed root must SURVIVE the
	// timeout so operators can manually clean up a child that hung.
	if _, err := os.Stat(proj.Cwd); err != nil {
		t.Errorf("project cwd should survive timeout path; got stat err=%v", err)
	}
}

// TestRemoveProject_multiPaneTimeoutIsBoundedByTotalTimeout — an earlier release
// review fix: the per-pane wait must NOT serialise. With N panes of
// which any one is stuck, total teardown must be bounded by the
// single shared timeout, not N × timeout. Otherwise launchd's 20s
// SIGKILL clock fires before the daemon finishes its teardown at 4+
// hung panes.
//
// We register TWO stub panes: one with an exited channel that's
// closed immediately (healthy), one with a channel that's never
// closed (stuck). Expected behaviour: RemoveProject returns in
// roughly one timeout period (the stuck pane's deadline), not two.
func TestRemoveProject_multiPaneTimeoutIsBoundedByTotalTimeout(t *testing.T) {
	tmp := t.TempDir()
	origRoot := config.ManagedProjectsRoot
	config.ManagedProjectsRoot = filepath.Join(tmp, "projects")
	t.Cleanup(func() { config.ManagedProjectsRoot = origRoot })

	configPath := filepath.Join(tmp, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(nil, []string{"/bin/echo"}, configPath, nil)
	// 200ms is long enough that test-machine scheduling jitter doesn't
	// fire a false-positive "returned too fast" assertion, short enough
	// that the whole test finishes in well under a second.
	mgr.removeProjectChildWaitTimeout = 200 * time.Millisecond

	proj, err := mgr.AddProject(proto.AddProjectRequest{Name: "MultiPane"})
	if err != nil {
		t.Fatal(err)
	}

	healthyCh := make(chan struct{})
	close(healthyCh) // already "exited"
	healthy := &Pane{
		ID: "p_healthy", ProjectID: proj.ID, Kind: proto.PaneKindShell,
		Cwd: proj.Cwd, state: proto.PaneStateExited, exited: healthyCh,
	}
	stuck := &Pane{
		ID: "p_stuck", ProjectID: proj.ID, Kind: proto.PaneKindShell,
		Cwd: proj.Cwd, state: proto.PaneStateRunning, exited: make(chan struct{}),
	}
	mgr.mu.Lock()
	mgr.byProj[proj.ID] = append(mgr.byProj[proj.ID], healthy, stuck)
	mgr.byID[healthy.ID] = healthy
	mgr.byID[stuck.ID] = stuck
	mgr.mu.Unlock()

	start := time.Now()
	if err := mgr.RemoveProject(proj.ID); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	elapsed := time.Since(start)
	// Upper bound: total teardown should be ~1× timeout (the stuck
	// pane's deadline), not 2× (which would mean serialised waits).
	// 350ms gives 150ms of headroom on top of 200ms for scheduling
	// noise on busy CI hardware.
	if elapsed > 350*time.Millisecond {
		t.Errorf("RemoveProject took %v with 1 healthy + 1 stuck pane; expected ~200ms. Serialised wait regression?", elapsed)
	}
	// Lower bound: stuck pane forces at least the timeout.
	if elapsed < 180*time.Millisecond {
		t.Errorf("RemoveProject returned in %v; expected at least 200ms (stuck pane should have blocked)", elapsed)
	}
	// Directory must survive because the stuck pane timed out.
	if _, err := os.Stat(proj.Cwd); err != nil {
		t.Errorf("project cwd should survive timeout path; got stat err=%v", err)
	}
}

// TestPane_WaitForExitCtx_returnsFalseWhenCtxCancelled — the ctx-aware
// variant must honour an already-cancelled context.
func TestPane_WaitForExitCtx_returnsFalseWhenCtxCancelled(t *testing.T) {
	p := &Pane{exited: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if p.WaitForExitCtx(ctx) {
		t.Fatal("WaitForExitCtx returned true with already-cancelled ctx")
	}
}

// TestPane_WaitForExitCtx_returnsTrueOnExitBeforeCancel — normal happy
// path: ctx still alive, channel closed → return true.
func TestPane_WaitForExitCtx_returnsTrueOnExitBeforeCancel(t *testing.T) {
	ch := make(chan struct{})
	close(ch)
	p := &Pane{exited: ch}
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	if !p.WaitForExitCtx(ctx) {
		t.Fatal("WaitForExitCtx returned false on closed channel")
	}
}

// TestPane_WaitForExitCtx_prefersExitOnCtxRace — the small nicety in
// the implementation: when ctx is already cancelled AND the child has
// already exited, prefer the exit truth over the timeout. Iterates
// many times to exercise the non-deterministic select.
func TestPane_WaitForExitCtx_prefersExitOnCtxRace(t *testing.T) {
	ch := make(chan struct{})
	close(ch)
	p := &Pane{exited: ch}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 200; i++ {
		if !p.WaitForExitCtx(ctx) {
			t.Fatalf("iteration %d: expected true (exit bias), got false", i)
		}
	}
}

// TestPane_WaitForExit_returnsFalseOnTimeout covers the low-level
// primitive used by RemoveProject. When the child hasn't exited within
// the timeout, WaitForExit returns false.
func TestPane_WaitForExit_returnsFalseOnTimeout(t *testing.T) {
	// Construct a pane stub without Spawn so the exited chan is never
	// closed.
	p := &Pane{exited: make(chan struct{})}
	start := time.Now()
	if p.WaitForExit(30 * time.Millisecond) {
		t.Fatal("WaitForExit returned true when child never exited")
	}
	if elapsed := time.Since(start); elapsed < 25*time.Millisecond {
		t.Errorf("returned too early: %v", elapsed)
	}
}

// TestPane_WaitForExit_returnsTrueOnExit — closed channel → immediate
// true. Covers the normal teardown path.
func TestPane_WaitForExit_returnsTrueOnExit(t *testing.T) {
	ch := make(chan struct{})
	close(ch)
	p := &Pane{exited: ch}
	if !p.WaitForExit(1 * time.Second) {
		t.Fatal("WaitForExit returned false on closed channel")
	}
}
