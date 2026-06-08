//go:build darwin

package launcher_test

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/launcher"
)

// TestLauncher_SpawnPane_RoundTrip builds the reck-pane-launcher helper
// from source, starts it via the disclaim-spawn path, then drives a real
// /bin/sh child through it. Validates that:
//
//   - posix_spawn + responsibility_spawnattrs_setdisclaim succeeds
//   - the helper accepts a connection + decodes SpawnRequest
//   - the pty master fd survives SCM_RIGHTS transfer (we read the child's
//     stdout off the daemon-side fd)
//   - the helper sends ExitNotice with the correct code on cmd.Wait
//   - Launcher.Stop teardown is clean
//
// Skips when GOOS isn't darwin (the disclaim SPI is darwin-only). Skips when
// `go build` of the helper fails so CI on a stripped builder doesn't
// red-light the package — the production build path covers that case.
func TestLauncher_SpawnPane_RoundTrip(t *testing.T) {
	helperPath := buildHelper(t)

	l, err := launcher.New(helperPath)
	if err != nil {
		t.Fatalf("launcher.New: %v", err)
	}
	if err := l.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(l.Stop)

	if l.HelperPID() == 0 {
		t.Fatal("HelperPID == 0 after Start")
	}

	// Spawn /bin/sh -c "printf hello; exit 7" — short-lived, deterministic
	// stdout, distinct exit code so we can assert all three signals come
	// back through the wire correctly.
	h, err := l.SpawnPane(launcher.SpawnRequest{
		Argv: []string{"/bin/sh", "-c", "printf hello; exit 7"},
		Env:  []string{"PATH=/usr/bin:/bin", "TERM=dumb"},
		Dir:  "/tmp",
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatalf("SpawnPane: %v", err)
	}
	defer h.Close()

	if h.Pid <= 0 {
		t.Errorf("Pid %d <= 0", h.Pid)
	}
	if h.Tty == nil {
		t.Fatal("Tty nil")
	}

	// Read until the pty closes (child exits → kernel closes its tty side
	// → daemon-side master sees EOF after a brief drain). 2s timeout is
	// far enough above the round-trip for a tiny printf+exit child.
	doneRead := make(chan []byte, 1)
	go func() {
		buf, _ := io.ReadAll(h.Tty)
		doneRead <- buf
	}()

	var output []byte
	select {
	case output = <-doneRead:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout reading pty output")
	}

	// PTY is line-disciplined by default; "hello" comes back as-is on a
	// terminal that doesn't echo (printf doesn't add newline → no carriage-
	// return translation).
	if got := string(output); got != "hello" {
		t.Errorf("pty output = %q, want %q", got, "hello")
	}

	select {
	case code := <-h.ExitCh:
		if code != 7 {
			t.Errorf("exit code = %d, want 7", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for ExitNotice")
	}
}

// TestLauncher_SpawnPane_HelperDeath_ReapsOrphan covers issue #242: when
// the reck-pane-launcher helper is SIGKILLed mid-session with a pane
// child still alive, the daemon's exit-reader goroutine probes the
// child pid and SIGKILLs the orphaned process group instead of silently
// reporting -1 while a phantom keeps running under launchd.
//
// Setup: spawn the helper, ask it to launch a long-running sleep
// child, then SIGKILL the helper. Assert ExitCh fires (-1) AND the
// child pid is gone (kill(pid, 0) → ESRCH) within a short timeout —
// the reap is best-effort but happens before -1 is sent, so once the
// daemon-side observer sees the channel close, the kill has run.
func TestLauncher_SpawnPane_HelperDeath_ReapsOrphan(t *testing.T) {
	helperPath := buildHelper(t)

	l, err := launcher.New(helperPath)
	if err != nil {
		t.Fatalf("launcher.New: %v", err)
	}
	if err := l.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(l.Stop)

	// 60s sleep — comfortably longer than the test's reap+assert window.
	// /bin/sleep doesn't trap signals so SIGKILL to the pgroup reaps it
	// instantly.
	h, err := l.SpawnPane(launcher.SpawnRequest{
		Argv: []string{"/bin/sleep", "60"},
		Env:  []string{"PATH=/usr/bin:/bin", "TERM=dumb"},
		Dir:  "/tmp",
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatalf("SpawnPane: %v", err)
	}
	defer h.Close()

	childPid := h.Pid
	if childPid <= 0 {
		t.Fatalf("child pid invalid: %d", childPid)
	}

	// Sanity: child is alive.
	if err := syscall.Kill(childPid, 0); err != nil {
		t.Fatalf("child not alive after spawn (pid=%d): %v", childPid, err)
	}

	// SIGKILL the helper — bypass Launcher.Stop's orderly SIGTERM path,
	// which would let the helper's cmd.Wait reap the child cleanly. We
	// want the abrupt-death case the bug describes.
	helperPID := l.HelperPID()
	if helperPID <= 0 {
		t.Fatalf("helper pid invalid: %d", helperPID)
	}
	if err := syscall.Kill(helperPID, syscall.SIGKILL); err != nil {
		t.Fatalf("kill helper pid=%d: %v", helperPID, err)
	}

	// Daemon-side: ExitCh should fire (the conn EOFs once the kernel
	// tears down the helper's socket).
	select {
	case code := <-h.ExitCh:
		if code != -1 {
			t.Errorf("exit code = %d, want -1 (helper died, no notice)", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for ExitCh after helper SIGKILL")
	}

	// Phantom check: child pid must be reaped. The reap runs before
	// ExitCh is sent on, so by the time we observed the channel above
	// the SIGKILL has been delivered. Allow a brief poll for the
	// kernel to actually finish reaping (zombie → gone) — kill(pid, 0)
	// on a zombie still returns nil because the entry is in the proc
	// table, so we want the parent (launchd, post-reparent) to have
	// waitpid'd. Poll up to 2s.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(childPid, 0); err != nil {
			// ESRCH (or any error) → child is gone. Done.
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("child pid=%d still alive 2s after helper SIGKILL — orphan reap failed", childPid)
}

// TestLauncher_SpawnPane_LocalClose_DoesNotReapChild covers the
// Close-vs-reap distinction (codex review feedback on the issue #242
// fix): when the daemon calls PaneHandle.Close locally, the exit-reader
// goroutine sees conn EOF — but this is the daemon's own teardown
// (Pane.Kill drives its own SIGTERM-grace path), not a helper crash.
// Reaping here would short-circuit Pane.Kill's 2s SIGTERM grace.
//
// Setup: spawn /bin/sleep 30, call h.Close(), assert ExitCh fires (-1)
// AND the child is still alive (pid valid). Tear down by SIGKILLing
// the child manually so the helper's cmd.Wait can exit cleanly.
func TestLauncher_SpawnPane_LocalClose_DoesNotReapChild(t *testing.T) {
	helperPath := buildHelper(t)

	l, err := launcher.New(helperPath)
	if err != nil {
		t.Fatalf("launcher.New: %v", err)
	}
	if err := l.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(l.Stop)

	h, err := l.SpawnPane(launcher.SpawnRequest{
		Argv: []string{"/bin/sleep", "30"},
		Env:  []string{"PATH=/usr/bin:/bin", "TERM=dumb"},
		Dir:  "/tmp",
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatalf("SpawnPane: %v", err)
	}
	childPid := h.Pid

	// Local close — must NOT trigger reap.
	h.Close()

	select {
	case code := <-h.ExitCh:
		if code != -1 {
			t.Errorf("exit code = %d, want -1 after local Close", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for ExitCh after Close")
	}

	// Child must still be alive — Close is the daemon's own
	// teardown signal, the actual kill belongs to Pane.Kill (which
	// the test does not invoke). Brief settle window in case the
	// reap path raced.
	time.Sleep(200 * time.Millisecond)
	if err := syscall.Kill(childPid, 0); err != nil {
		t.Errorf("child pid=%d killed by Close (err=%v); reap should have been skipped",
			childPid, err)
	}

	// Manual cleanup: SIGKILL child so the helper's cmd.Wait exits
	// and Launcher.Stop's grace doesn't escalate.
	_ = syscall.Kill(childPid, syscall.SIGKILL)
}

// TestLauncher_Start_MissingHelper verifies the launcher fails fast when
// the helper binary doesn't exist, instead of silently letting the daemon
// fall through to an unusable state.
func TestLauncher_Start_MissingHelper(t *testing.T) {
	tmp := t.TempDir()
	_, err := launcher.New(filepath.Join(tmp, "nonexistent"))
	if err == nil {
		t.Fatal("New with missing helper: want error, got nil")
	}
}

func buildHelper(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "reck-pane-launcher")
	repoRoot := repoRoot(t)
	cmd := exec.Command("go", "build", "-o", out, "./daemon/cmd/reck-pane-launcher")
	cmd.Dir = repoRoot
	if buildOut, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("go build helper failed (skipping integration test): %v\n%s", err, buildOut)
	}
	return out
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	// pwd at test time is daemon/internal/launcher; repo root is two up.
	return filepath.Join(wd, "..", "..", "..")
}
