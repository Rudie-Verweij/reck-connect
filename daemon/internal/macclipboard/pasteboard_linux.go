//go:build linux

package macclipboard

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Linux clipboard backend. Shells out to `xclip` because:
//   - it accepts arbitrary MIME targets via `-t <mime>` (xsel only
//     supports text), which matches NSPasteboard's per-UTI semantics.
//   - it's the de-facto standard tool the Claude Code CLI itself uses
//     to READ image clipboard contents, so a write via xclip and a
//     read via xclip are guaranteed to agree on selection / target.
//   - it's a single Debian/Ubuntu/Raspbian apt package with no daemon.
//
// Requires:
//   - `xclip` on PATH.
//   - A reachable X display ($DISPLAY env). On TTY-only stations the
//     reck install script provisions an Xvfb-backed virtual display
//     so this works without a real GUI session.

// xclipState caches the one-time probe result so the per-pane snapshot
// path (called frequently) doesn't pay an exec.LookPath + DISPLAY check
// on every read. The cache is busted only by daemon restart, which is
// fine — neither xclip's PATH presence nor $DISPLAY changes
// mid-process.
var (
	xclipProbeOnce sync.Once
	xclipPath      string // empty if unavailable
	xclipReady     atomic.Bool
)

func probeXclip() {
	xclipProbeOnce.Do(func() {
		path, err := exec.LookPath("xclip")
		if err != nil {
			return
		}
		if os.Getenv("DISPLAY") == "" {
			// xclip without a display will hang waiting for an X
			// connection. Refuse to claim availability so callers
			// fall back to the /uploads path-typing route.
			return
		}
		xclipPath = path
		xclipReady.Store(true)
	})
}

// Available reports whether WriteImage can succeed on this host.
// True iff xclip is on PATH AND $DISPLAY is set when the daemon
// started. Callers (e.g. pane capability snapshot) get O(1) reads
// after the first call.
func Available() bool {
	probeXclip()
	return xclipReady.Load()
}

// WriteImage places `body` on the X clipboard under MIME `mime`.
//
// Implementation: spawns `xclip -selection clipboard -t <mime> -i`,
// pipes the bytes in via stdin, then waits for xclip to fork into the
// background. xclip's lifecycle is unusual:
//
//  1. Parent reads stdin until EOF.
//  2. Parent forks; the child becomes the X selection owner and
//     services SelectionRequest events from the X server until another
//     process takes the selection.
//  3. Parent exits (rc=0).
//
// Step 3 lets the daemon's HTTP handler return 200, but the
// daemonized child must keep running — when Claude Code reads the
// clipboard via SelectionRequest, the child is what serves the bytes.
// If the child exits early (e.g. we kill the process group), the next
// clipboard read returns "Owner died" and the chip is empty.
//
// Why not `cmd.Run`: stdlib `exec.Cmd` with a non-*os.File `Stderr`
// buffer creates a Go-side pipe that the daemonized child inherits.
// `Run`/`Wait` block until that pipe closes, which it doesn't until
// the child exits — turning a 50 ms write into a multi-minute hang.
// We side-step that by:
//   - using *os.Pipe ourselves so we control the ends explicitly,
//   - calling `Start` + `Process.Wait` instead of `Run` so we can
//     close the read-side after the parent exits, and
//   - dropping the daemonized child to a separate process group via
//     SysProcAttr.Setpgid so the context's Kill on timeout doesn't
//     reach the still-needed selection-owner child.
//
// Concurrency: the HTTP-side `pasteSerializer` mutex guards
// WriteImage + Ctrl+V atomically (see internal/http/clipboard.go).
// We don't serialize again here — two queued writes would just
// produce two short-lived xclip parents, the latter winning the
// X selection.
func WriteImage(mime string, body []byte) error {
	if len(body) == 0 {
		return fmt.Errorf("macclipboard: empty payload (mime=%q)", mime)
	}
	probeXclip()
	if !xclipReady.Load() {
		return fmt.Errorf("%w: xclip not available (install xclip and ensure $DISPLAY is set)", ErrUnsupported)
	}

	// Bound the parent's stdin-read + fork time. 5 s is generous —
	// xclip's normal handoff completes in <50 ms on a Pi 5. The
	// daemonized selection-owner child outlives this context (see
	// Setpgid below) so a timeout here only kills the parent.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, xclipPath, "-selection", "clipboard", "-t", mime, "-i")
	cmd.Stdin = bytes.NewReader(body)

	// New process group for xclip's daemonized child so the context
	// timeout's Kill (which is sent to cmd.Process.Pid only) doesn't
	// chain to the child via getpgid signalling. Without this, every
	// successful write would race the timeout: parent exits, context
	// hits deadline, kill cascades to pgid, child dies, next read
	// fails.
	cmd.SysProcAttr = procAttrForXclip()

	// stderr/stdout ARE captured but via *os.File pipes we own so we
	// can close them after the parent exits — even if the child
	// inherited the write-ends.
	rOut, wOut, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("xclip stdout pipe: %w", err)
	}
	rErr, wErr, err := os.Pipe()
	if err != nil {
		_ = rOut.Close()
		_ = wOut.Close()
		return fmt.Errorf("xclip stderr pipe: %w", err)
	}
	cmd.Stdout = wOut
	cmd.Stderr = wErr

	if err := cmd.Start(); err != nil {
		_ = rOut.Close()
		_ = wOut.Close()
		_ = rErr.Close()
		_ = wErr.Close()
		return fmt.Errorf("xclip start: %w", err)
	}
	// Close OUR copy of the write-ends now — only the child holds
	// them. The reads below return EOF when the *parent* exits if
	// the child already daemonized; we don't actually care about the
	// content for the success path, but we drain so the kernel buffer
	// can recycle.
	_ = wOut.Close()
	_ = wErr.Close()

	waitErr := cmd.Wait()

	// Drain after the parent exits. If the daemonized child still
	// holds the FDs, our reads will block — so we set a short
	// deadline and discard whatever's there. This is best-effort
	// diagnostic capture, NOT part of the success contract.
	stderrBytes := drainWithDeadline(rErr, 200*time.Millisecond)
	_ = drainWithDeadline(rOut, 50*time.Millisecond)
	_ = rOut.Close()
	_ = rErr.Close()

	if waitErr != nil {
		return fmt.Errorf("xclip write failed: %w (stderr: %q)", waitErr, string(stderrBytes))
	}
	return nil
}

// procAttrForXclip returns the SysProcAttr that puts xclip into its own
// process group. Linux-only; calling this on non-linux is a build-time
// error since this file is gated by //go:build linux.
func procAttrForXclip() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// drainWithDeadline reads from f until EOF or the deadline expires.
// Returns whatever was read; never blocks beyond `d`.
func drainWithDeadline(f *os.File, d time.Duration) []byte {
	if err := f.SetReadDeadline(time.Now().Add(d)); err != nil {
		return nil
	}
	buf := make([]byte, 0, 256)
	tmp := make([]byte, 256)
	for {
		n, err := f.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			return buf
		}
	}
}
