package launcher

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// Launcher manages the reck-pane-launcher helper process and dispenses pane
// spawn services to the daemon. The helper is spawned once at daemon startup
// via posix_spawn with responsibility_spawnattrs_setdisclaim — this makes
// the helper its own responsible process for TCC, which in turn means every
// pane child the helper exec()s is attributed to the helper (not to
// reck-stationd) for Accessibility / AppleEvents permission checks.
type Launcher struct {
	helperPath string
	socketPath string

	mu      sync.Mutex
	pid     int
	started bool
	stopped bool
}

// New constructs an unstarted Launcher. helperPath must point to an
// executable reck-pane-launcher binary. The Unix socket is created under
// /tmp directly (not $TMPDIR) so the resulting sun_path stays under the
// 104-byte macOS limit even when $TMPDIR is the default
// /var/folders/.../T/ wrapper.
func New(helperPath string) (*Launcher, error) {
	if helperPath == "" {
		return nil, errors.New("launcher: helperPath required")
	}
	if _, err := os.Stat(helperPath); err != nil {
		return nil, fmt.Errorf("launcher: helper binary missing at %s: %w", helperPath, err)
	}
	var nonce [4]byte
	_, _ = rand.Read(nonce[:])
	sockPath := filepath.Join("/tmp", fmt.Sprintf("reck-pane-launcher-%s.sock", hex.EncodeToString(nonce[:])))
	if len(sockPath) > 100 {
		return nil, fmt.Errorf("launcher: socket path too long (%d): %s", len(sockPath), sockPath)
	}
	_ = os.Remove(sockPath)
	return &Launcher{helperPath: helperPath, socketPath: sockPath}, nil
}

// Start spawns the helper process with responsibility disclaim. The helper
// binds the per-launcher Unix socket and accepts connections. Start blocks
// until the socket is listenable or the deadline expires.
func (l *Launcher) Start() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.started {
		return errors.New("launcher: already started")
	}
	// Minimal env passed to the helper — explicitly NOT os.Environ(), so
	// the daemon's DAEMON_TOKEN (set via os.Setenv in cmd/reck-stationd
	// main) does not leak into the helper process. The daemon already
	// filters per-pane env via pty.paneBaseEnv before sending it over the
	// wire as SpawnRequest.Env; the helper passes that filtered env
	// straight to exec.Command, so children never see DAEMON_TOKEN
	// either. The helper's own process needs almost nothing here:
	// RECK_LAUNCHER_SOCK to know where to bind, and a couple of standard
	// vars (PATH, HOME, USER, TMPDIR) the Go runtime + macOS frameworks
	// occasionally consult.
	env := []string{"RECK_LAUNCHER_SOCK=" + l.socketPath}
	for _, k := range []string{"PATH", "HOME", "USER", "TMPDIR", "LANG"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	pid, err := spawnDisclaimed(l.helperPath, []string{l.helperPath}, env)
	if err != nil {
		return fmt.Errorf("launcher: spawn helper: %w", err)
	}
	l.pid = pid
	l.started = true

	// Wait for socket to appear.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(l.socketPath); err == nil {
			// Verify it's listenable.
			c, derr := net.Dial("unix", l.socketPath)
			if derr == nil {
				c.Close()
				return nil
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	return fmt.Errorf("launcher: helper did not bind %s within deadline", l.socketPath)
}

// Stop sends SIGTERM, waits briefly, then SIGKILL. Idempotent.
func (l *Launcher) Stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.started || l.stopped {
		return
	}
	l.stopped = true
	if l.pid > 0 {
		_ = syscall.Kill(l.pid, syscall.SIGTERM)
		// Brief grace.
		done := make(chan struct{})
		go func() {
			var ws syscall.WaitStatus
			_, _ = syscall.Wait4(l.pid, &ws, 0, nil)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = syscall.Kill(l.pid, syscall.SIGKILL)
			<-done
		}
	}
	_ = os.Remove(l.socketPath)
}

// HelperPID returns the helper process PID. 0 if not started.
func (l *Launcher) HelperPID() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.pid
}

// HelperPath returns the absolute path the launcher was constructed with.
// Surfaced via /health so operators can confirm the TCC grant target.
func (l *Launcher) HelperPath() string { return l.helperPath }

// SocketPath returns the per-launcher Unix socket path. Useful for diagnostics.
func (l *Launcher) SocketPath() string { return l.socketPath }
