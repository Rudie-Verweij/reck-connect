package launcher

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"syscall"
)

// PaneHandle is what the daemon receives back from SpawnPane. The daemon
// owns the pty master fd directly and reads the exit code off ExitCh when
// the helper notifies it.
type PaneHandle struct {
	Pid    int
	Tty    *os.File
	ExitCh <-chan int

	conn   *net.UnixConn
	mu     sync.Mutex
	closed bool
}

// Kill sends a signal to the pane's process group via the helper. The
// daemon could syscall.Kill(-pgid) directly because reck-stationd has uid
// permission to signal any of its user's processes — but routing through
// the helper keeps the helper's bookkeeping (waitpid + ExitNotice fan-out)
// in sync with reality. The helper reaps the leader and forwards the exit
// code; without this hop the daemon would race against helper.Wait.
func (h *PaneHandle) Kill(signal int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errors.New("launcher: pane handle closed")
	}
	body, err := encodeJSON(KillRequest{Signal: signal})
	if err != nil {
		return err
	}
	return WriteFrame(h.conn, FrameKillRequest, body)
}

// Close shuts the per-pane control connection. The helper notices conn EOF
// and treats it as "no more kill requests"; the child is still waited on
// independently. ExitCh may still fire after Close.
func (h *PaneHandle) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	_ = h.conn.Close()
}

// wasClosedByUs reports whether Close has already been invoked locally.
// The exit-reader goroutine uses this to distinguish "we closed the
// conn" (Pane.Kill teardown — child is being killed by Pane.Kill itself
// via its own SIGTERM-grace path; reap would short-circuit that grace)
// from "remote helper went away" (issue #242 — orphan reap is the
// whole point). Acquires the same mutex Close uses, so the flag write
// in Close is happens-before any read here.
func (h *PaneHandle) wasClosedByUs() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.closed
}

// SpawnPane dials the helper and asks it to fork+exec a pane child. The
// helper executes the spawn under its own responsibility-process scope, then
// hands the pty master fd back via SCM_RIGHTS. The returned PaneHandle owns
// the pty fd; the caller (pty.Pane) drives I/O through it directly.
func (l *Launcher) SpawnPane(req SpawnRequest) (*PaneHandle, error) {
	l.mu.Lock()
	if !l.started || l.stopped {
		l.mu.Unlock()
		return nil, errors.New("launcher: not running")
	}
	sock := l.socketPath
	l.mu.Unlock()

	raw, err := net.Dial("unix", sock)
	if err != nil {
		return nil, fmt.Errorf("launcher: dial %s: %w", sock, err)
	}
	uc, ok := raw.(*net.UnixConn)
	if !ok {
		raw.Close()
		return nil, errors.New("launcher: expected *net.UnixConn")
	}

	// Step 1: send SpawnRequest
	body, err := encodeJSON(req)
	if err != nil {
		uc.Close()
		return nil, err
	}
	if err := WriteFrame(uc, FrameSpawnRequest, body); err != nil {
		uc.Close()
		return nil, fmt.Errorf("launcher: write SpawnRequest: %w", err)
	}

	// Step 2: receive pty master fd via SCM_RIGHTS
	fd, err := RecvFD(uc)
	if err != nil {
		uc.Close()
		return nil, fmt.Errorf("launcher: recv pty fd: %w", err)
	}
	tty := os.NewFile(uintptr(fd), "pane-pty")
	if tty == nil {
		_ = syscall.Close(fd)
		uc.Close()
		return nil, errors.New("launcher: os.NewFile returned nil")
	}

	// Step 3: receive SpawnResponse with PID
	kind, payload, err := ReadFrame(uc)
	if err != nil {
		tty.Close()
		uc.Close()
		return nil, fmt.Errorf("launcher: read SpawnResponse: %w", err)
	}
	if kind != FrameSpawnResponse {
		tty.Close()
		uc.Close()
		return nil, fmt.Errorf("launcher: expected SpawnResponse, got kind %d", kind)
	}
	var resp SpawnResponse
	if err := decodeJSON(payload, &resp); err != nil {
		tty.Close()
		uc.Close()
		return nil, fmt.Errorf("launcher: decode SpawnResponse: %w", err)
	}
	if resp.Err != "" {
		tty.Close()
		uc.Close()
		return nil, fmt.Errorf("launcher: helper reported: %s", resp.Err)
	}

	exitCh := make(chan int, 1)
	h := &PaneHandle{
		Pid:    resp.Pid,
		Tty:    tty,
		ExitCh: exitCh,
		conn:   uc,
	}
	pid := resp.Pid

	// Step 4: background reader for ExitNotice (and silent drain of any
	// other helper-side noise). Closes exitCh when notice arrives or conn
	// EOFs without one.
	go func() {
		defer close(exitCh)
		// Release the fd when we're done — Pane.Kill no longer closes
		// the conn explicitly (it would short-circuit killGroupAsync's
		// SIGTERM grace; see pty/pane.go's Kill comment), so the
		// goroutine owns conn lifetime: helper closes its end after
		// cmd.Wait reaps the leader → ReadFrame returns EOF → we
		// drop here and Close releases the daemon-side fd.
		defer uc.Close()
		for {
			kind, payload, err := ReadFrame(uc)
			if err != nil {
				// Conn closed without an ExitNotice. Three cases:
				//   (a) child died and helper's cmd.Wait reaped it but the
				//       notice frame was lost (helper crashed mid-write,
				//       daemon-side socket teardown raced the read) — child
				//       is already gone, just surface -1.
				//   (b) helper itself died with the child still alive
				//       (issue #242 — SIGKILL, panic, OOM). pty.StartWithSize
				//       made the child a session/pgroup leader with a
				//       controlling tty, so it survives parent death and
				//       gets reparented to launchd. Without intervention the
				//       daemon would mark the pane Exited while ps shows a
				//       phantom holding cwd / mount points / RAM.
				//   (c) the daemon itself called PaneHandle.Close locally
				//       (Pane.Kill teardown). The pane child is being
				//       killed by Pane.Kill's own SIGTERM-grace path which
				//       waits 2s before SIGKILL escalation; reaping here
				//       would short-circuit that grace. Skip reap.
				//
				// Probe + reap on (a)/(b); (c) is identified by h.closed
				// (only Close sets it).
				if !h.wasClosedByUs() {
					reapOrphanIfAlive(pid)
				}
				exitCh <- -1
				return
			}
			if kind == FrameExitNotice {
				var n ExitNotice
				if err := decodeJSON(payload, &n); err != nil {
					exitCh <- -1
				} else {
					exitCh <- n.Code
				}
				return
			}
			// Ignore unknown frame kinds; helpers in newer versions may add types.
		}
	}()

	return h, nil
}

// reapOrphanIfAlive is invoked from the exit-reader goroutine when the
// per-pane control conn EOFs without a normal ExitNotice. SIGKILLs the
// pane's whole process group so the orphan leader + its grandchildren
// (claude's MCP servers, sub-shells, etc.) don't keep running invisibly
// after the daemon flips the pane to Exited. See issue #242.
//
// Argument is the leader pid the helper returned at spawn — by the
// helper's Setsid invariant (see reck-pane-launcher) leader pid == pgid,
// so we use the same value to address the group via kill(-pgid, …).
// Don't gate on leader-pid liveness: a Unix process group can outlive
// its leader (codex review v5), so kill(pid, 0) returning ESRCH does
// NOT mean the group is empty — descendants like a still-running MCP
// server stay in the leader's pgrp after the leader exits. Probe the
// group instead.
//
// Safety guards (all skip + log; no single-pid fallback):
//   - pid <= 0:            invalid input (silent skip)
//   - pid == 1:            launchd's group, never ours
//   - pid == daemon-pgrp:  would SIGKILL the daemon
//   - kill(-pid, 0) ESRCH: pgroup empty, nothing to reap
//   - Getpgid(pid) returns a different pgid: leader pid still in proc
//     table but moved to another pgroup → pid was recycled into an
//     unrelated process; original group identity is uncertain, skip.
//
// Trade-off: when guards fire we leave a possible phantom running
// rather than send SIGKILL based on stale state. The daemon will
// still surface the pane as Exited via the -1 path; a real orphan
// will be cleaned up on next daemon restart.
func reapOrphanIfAlive(pid int) {
	if pid <= 0 {
		return
	}
	daemonPgrp := syscall.Getpgrp()
	if pid == 1 || pid == daemonPgrp {
		slog.Warn("orphan-reap: refusing — unsafe pgid target",
			"pid", pid, "daemon_pgrp", daemonPgrp)
		return
	}
	// Group existence probe. ESRCH → no processes in pgrp, nothing to do.
	if err := syscall.Kill(-pid, 0); err != nil {
		if !errors.Is(err, syscall.ESRCH) {
			slog.Warn("orphan-reap: group probe error, skipping kill",
				"pid", pid, "err", err)
		}
		return
	}
	// Recycle detection: if the leader pid still exists AND its current
	// pgid no longer matches the value we're using, the pid was likely
	// recycled into an unrelated process whose pgroup happens to share
	// our number. Skip rather than SIGKILL strangers. Getpgid returning
	// ESRCH is fine — leader is dead but its pgrp can still hold
	// descendants which the kill(-pid) above just confirmed.
	if curPgid, err := syscall.Getpgid(pid); err == nil && curPgid != pid {
		slog.Warn("orphan-reap: leader pid no longer in original pgroup — likely recycled",
			"pid", pid, "current_pgid", curPgid)
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}
