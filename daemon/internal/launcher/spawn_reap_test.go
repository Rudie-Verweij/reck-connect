//go:build darwin

package launcher

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestReapOrphanIfAlive_RefusesDaemonOwnPgroup is the safety-guard
// regression test for issue #242 review feedback: if the resolved pgid
// would be the daemon's own process group, reapOrphanIfAlive must NOT
// issue kill(-pgid, SIGKILL) — that would SIGKILL the daemon itself —
// AND must NOT fall back to single-pid kill, because the production
// scenario for that branch is pid recycling and the recycled pid may
// be an unrelated process (codex review v3 of #242).
//
// Setup: spawn /bin/sleep WITHOUT Setsid. The child inherits the test
// process's pgrp, so syscall.Getpgid(childPid) == syscall.Getpgrp().
// Call reapOrphanIfAlive. Assert the child is STILL ALIVE (skip path)
// AND the test process itself is still running (group kill avoided).
// If the daemon-pgrp guard regresses, the test process gets SIGKILLed
// and `go test` reports the harness as crashed.
func TestReapOrphanIfAlive_RefusesDaemonOwnPgroup(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "30")
	// Deliberately NO SysProcAttr.Setsid → child inherits our pgrp.
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	pid := cmd.Process.Pid

	// Reap with cmd.Wait in a goroutine so cleanup can observe a
	// zombie-free exit. Closed-channel pattern so the cleanup can
	// observe completion without racing the test body.
	waitDone := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(waitDone)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-waitDone
	})

	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		t.Fatalf("getpgid: %v", err)
	}
	if pgid != syscall.Getpgrp() {
		t.Skipf("test setup invalid: child pgid=%d, want %d (test process pgrp)",
			pgid, syscall.Getpgrp())
	}

	// Guard must skip the kill entirely.
	reapOrphanIfAlive(pid)

	// Child must still be alive — skip path leaves it untouched.
	time.Sleep(200 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Errorf("child pid=%d killed (err=%v); guard should have skipped both group and single-pid kill",
			pid, err)
	}

	// If the daemon-pgrp guard had regressed to kill(-pgid, SIGKILL),
	// this test process would have been SIGKILLed before reaching
	// this line. Reaching it = guard works.
}

// TestReapOrphanIfAlive_KillsGroupWhenLeaderDeadDescendantsAlive covers
// the descendant-orphan case codex review v5 flagged: a Unix process
// group can outlive its leader. If the pane leader exits while a
// grandchild remains in the same pgrp and the helper then dies before
// delivering ExitNotice, the daemon must still reap the group — gating
// on leader liveness alone would silently abandon the grandchild.
//
// Setup: spawn /bin/sh with Setsid (becomes session+pgroup leader),
// have it fork /bin/sleep into the same pgrp, capture the sleep pid via
// stdout, then exit cleanly. cmd.Run reaps the leader. The sleep
// grandchild remains alive in the pgrp (pgid == leader pid).
//
// Assert reapOrphanIfAlive(leaderPid) kills the grandchild — the group
// probe finds it and SIGKILL hits the pgrp.
func TestReapOrphanIfAlive_KillsGroupWhenLeaderDeadDescendantsAlive(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c",
		"/bin/sleep 30 < /dev/null > /dev/null 2>&1 & echo $!; exit 0")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run leader: %v", err)
	}
	leaderPid := cmd.Process.Pid
	grandchildPid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("parse grandchild pid %q: %v", string(out), err)
	}
	t.Cleanup(func() {
		// Belt: ensure grandchild dead even if reap regresses.
		_ = syscall.Kill(grandchildPid, syscall.SIGKILL)
	})

	// Sanity: grandchild's pgrp == leaderPid (Setsid invariant inherited).
	pgid, err := syscall.Getpgid(grandchildPid)
	if err != nil {
		t.Fatalf("getpgid(grandchild=%d): %v", grandchildPid, err)
	}
	if pgid != leaderPid {
		t.Fatalf("grandchild pgid=%d, want leaderPid=%d", pgid, leaderPid)
	}

	// Leader is reaped (cmd.Run did Wait). Group has only the grandchild.
	reapOrphanIfAlive(leaderPid)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(grandchildPid, 0); err != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("grandchild pid=%d still alive 2s after group reap (descendant orphan leak)",
		grandchildPid)
}

// TestReapOrphanIfAlive_NoOpOnInvalidPid documents the early-return
// contract: garbage pids (zero, negative) must not reach syscall.Kill.
// Failure mode if the guard regresses: kill(0, 0) probes the caller's
// own pgrp, kill(-1, …) targets every uid-owned process — either is a
// catastrophic bug, this test catches it cheaply.
func TestReapOrphanIfAlive_NoOpOnInvalidPid(t *testing.T) {
	reapOrphanIfAlive(0)
	reapOrphanIfAlive(-1)
	reapOrphanIfAlive(-99999)
}
