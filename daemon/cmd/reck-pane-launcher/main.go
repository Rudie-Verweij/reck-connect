// reck-pane-launcher is the responsibility-process root for all pane
// children spawned by reck-stationd. It exists solely to give macOS TCC a
// stable binary path to attribute Accessibility / AppleEvents grants to —
// granting AX to this binary lets every pane (and every MCP child of every
// pane) make AX-gated calls without the daemon itself needing the grant.
// See issue #225.
//
// Lifecycle: spawned by the daemon at startup via posix_spawn with
// responsibility_spawnattrs_setdisclaim. Listens on the Unix socket path
// passed via $RECK_LAUNCHER_SOCK. Per accept = one pane: receive
// SpawnRequest, fork+exec the child via creack/pty, send the master fd
// back to the daemon via SCM_RIGHTS, then wait on the child and notify the
// daemon when it exits.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"

	"github.com/creack/pty"

	"github.com/rudie-verweij/reck-connect/daemon/internal/launcher"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("[reck-pane-launcher] ")

	sockPath := os.Getenv("RECK_LAUNCHER_SOCK")
	if sockPath == "" {
		log.Fatal("RECK_LAUNCHER_SOCK not set")
	}

	// Best-effort cleanup of stale socket from a prior crashed instance.
	_ = os.Remove(sockPath)

	// Tighten umask before bind so the kernel creates the socket with
	// 0700 directly — closes the TOCTOU window between net.Listen and a
	// subsequent os.Chmod where another local UID could connect to the
	// world-accessible socket and inject a SpawnRequest. The chmod after
	// listen stays as a belt-and-braces guard in case the umask call
	// fails or future Go runtime changes affect bind() perms.
	prevUmask := syscall.Umask(0o077)
	ln, err := net.Listen("unix", sockPath)
	syscall.Umask(prevUmask)
	if err != nil {
		log.Fatalf("listen %s: %v", sockPath, err)
	}
	defer ln.Close()
	if err := os.Chmod(sockPath, 0o600); err != nil {
		log.Fatalf("chmod sock: %v", err)
	}

	// On SIGTERM/SIGINT: stop accepting new panes and exit. In-flight panes
	// keep running — the helper detaches, the kernel reparents them to
	// launchd. cmd.Wait goroutines die with the process; the daemon's
	// readLoop on the pty fd will see EOF when the child eventually exits.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Print("signal received, closing listener")
		_ = ln.Close()
	}()

	log.Printf("listening on %s pid=%d", sockPath, os.Getpid())

	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		uc, ok := conn.(*net.UnixConn)
		if !ok {
			conn.Close()
			continue
		}
		go handlePane(uc)
	}
}

func handlePane(c *net.UnixConn) {
	defer c.Close()

	kind, payload, err := launcher.ReadFrame(c)
	if err != nil {
		log.Printf("read SpawnRequest: %v", err)
		return
	}
	if kind != launcher.FrameSpawnRequest {
		log.Printf("expected SpawnRequest, got kind %d", kind)
		return
	}
	var req launcher.SpawnRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		log.Printf("decode SpawnRequest: %v", err)
		_ = sendSpawnResponseErr(c, err.Error())
		return
	}
	if len(req.Argv) == 0 {
		_ = sendSpawnResponseErr(c, "empty argv")
		return
	}

	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Dir = req.Dir
	cmd.Env = req.Env

	// Mirror the existing direct-spawn behaviour from daemon/internal/pty:
	// pty.StartWithSize sets Setsid + Setctty so the child becomes its own
	// session leader + process-group leader with the pty as controlling tty.
	// We reproduce that here via creack/pty.StartWithSize.
	winsize := &pty.Winsize{Cols: uint16(req.Cols), Rows: uint16(req.Rows)}
	master, err := pty.StartWithSize(cmd, winsize)
	if err != nil {
		_ = sendSpawnResponseErr(c, fmt.Sprintf("pty.StartWithSize: %v", err))
		return
	}

	// Hand the master fd to the daemon via SCM_RIGHTS. The kernel dups the
	// fd into the receiving process's table, so we close our copy right after.
	if err := launcher.SendFD(c, int(master.Fd())); err != nil {
		log.Printf("sendFD: %v", err)
		_ = master.Close()
		_ = cmd.Process.Kill()
		return
	}
	resp := launcher.SpawnResponse{Pid: cmd.Process.Pid}
	body, _ := json.Marshal(resp)
	if err := launcher.WriteFrame(c, launcher.FrameSpawnResponse, body); err != nil {
		log.Printf("write SpawnResponse: %v", err)
		_ = master.Close()
		_ = cmd.Process.Kill()
		return
	}

	// We can close our copy of the master now — daemon owns the live fd.
	_ = master.Close()

	// Two goroutines: one waits on the child and posts ExitNotice; the
	// other reads inbound KillRequests until conn EOF.
	var (
		wg       sync.WaitGroup
		writeMu  sync.Mutex
		exitDone = make(chan struct{})
	)

	wg.Add(1)
	go func() {
		defer wg.Done()
		err := cmd.Wait()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if err != nil {
			code = -1
		}
		writeMu.Lock()
		body, _ := json.Marshal(launcher.ExitNotice{Code: code})
		_ = launcher.WriteFrame(c, launcher.FrameExitNotice, body)
		writeMu.Unlock()
		close(exitDone)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			kind, payload, err := launcher.ReadFrame(c)
			if err != nil {
				if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
					log.Printf("conn read pid=%d: %v", cmd.Process.Pid, err)
				}
				return
			}
			if kind != launcher.FrameKillRequest {
				log.Printf("unknown frame kind %d on pid=%d", kind, cmd.Process.Pid)
				continue
			}
			var k launcher.KillRequest
			if err := json.Unmarshal(payload, &k); err != nil {
				log.Printf("decode KillRequest: %v", err)
				continue
			}
			// Process-group kill so children of the leader (claude's MCP
			// servers, sub-shells) die together. Mirrors pty/pane.go's
			// killGroupAsync logic; see the comment block there.
			pgid, err := syscall.Getpgid(cmd.Process.Pid)
			if err != nil {
				_ = syscall.Kill(cmd.Process.Pid, syscall.Signal(k.Signal))
				continue
			}
			_ = syscall.Kill(-pgid, syscall.Signal(k.Signal))
		}
	}()

	// Wait until the child reaps before tearing down. The KillRequest
	// goroutine exits naturally when the daemon closes the conn, which it
	// does after seeing the ExitNotice (or after Pane.Kill triggers
	// PaneHandle.Close).
	<-exitDone
	wg.Wait()
}

func sendSpawnResponseErr(c *net.UnixConn, msg string) error {
	body, _ := json.Marshal(launcher.SpawnResponse{Err: msg})
	return launcher.WriteFrame(c, launcher.FrameSpawnResponse, body)
}
