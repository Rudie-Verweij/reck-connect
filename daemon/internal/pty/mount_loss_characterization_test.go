package pty

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/proto"
)

// Mount-loss characterization (hybrid mode plan rev 3.1, phase 10).
//
// Rev 3 claimed "pane goes red when the sshfs mount drops on the
// laptop"; Codex's rev 3.1 review pushed back that the stoplight is
// event-driven (Claude Code hooks), not filesystem-driven, so the
// behaviour needed to be *observed* instead of asserted. This test
// records what the daemon sees when a local pane's cwd disappears
// mid-session — the renderer's stoplight is a function of the daemon's
// state transitions and agent events, so characterising the daemon
// side tells us whether a Phase 10a mount-stat probe is required.
//
// Scenario approximated:
//   1. Spawn a shell pane in a temp dir acting as the laptop-side
//      mount path for a station-owned project.
//   2. Delete the cwd directory (cheapest stand-in for an sshfs
//      unmount — from the process's perspective both yield ENOENT on
//      subsequent filesystem access).
//   3. Drive a command that reads the cwd (`pwd` + an `ls`) and
//      observe what the pane reports back and whether the shell
//      remains `PaneStateRunning`.
//
// The t.Logf lines are deliberate — the test is a *characterisation*,
// not an assertion of desired behaviour. The recorded output becomes
// input to the Phase 10a decision: if the pane remains "running" with
// no stoplight transition and no obvious user-visible signal, we need
// a mount probe; if the shell exits or the stoplight flips, we don't.
//
// Expected on macOS + Linux: the process keeps its original working
// directory inode via fd-held reference, so it doesn't crash; `pwd`
// may report the original path or a " (deleted)" suffix; `ls` fails
// with ENOENT; `PaneStateRunning` is unchanged; no stoplight
// transition. That's the worst-case scenario the rev 3.1 plan flagged.

func TestMountLossCharacterization_shellPaneSurvivesCwdDeletion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("cwd deletion semantics differ on Windows; characterisation targets darwin/linux")
	}

	dir := t.TempDir()
	// A nested dir acts as the pretend "mount" — removing only this
	// subdir keeps the parent TempDir intact so t.TempDir's cleanup
	// doesn't race the test body.
	mountDir := filepath.Join(dir, "fake-mount")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	projects := []config.Project{{
		ID:    "p1",
		Name:  "P1",
		Cwd:   mountDir,
		Shell: []string{"/bin/sh"},
	}}
	m := NewManager(projects, []string{"/bin/echo", "claude-placeholder"}, configPath, nil)

	pane, err := m.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	defer func() {
		_ = m.DeletePane("p1", pane.ID)
	}()

	// Wait briefly for the shell to settle, then capture a baseline
	// reading for the cwd.
	if err := pane.Write([]byte("pwd\n")); err != nil {
		t.Fatalf("write pwd (pre): %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	preMount := string(pane.ReplayTail(4096))
	t.Logf("[characterise] pre-deletion replay tail:\n%s", preMount)
	if pane.State() != proto.PaneStateRunning {
		t.Fatalf("expected running before deletion, got %s", pane.State())
	}

	// Simulate the mount loss. On a real sshfs drop the kernel would
	// start returning ENOENT/ESTALE for any file operation under the
	// mount point; `os.RemoveAll` is the closest portable analog.
	if err := os.RemoveAll(mountDir); err != nil {
		t.Fatalf("RemoveAll(mount): %v", err)
	}

	// Drive commands that touch the now-missing cwd.
	if err := pane.Write([]byte("pwd; ls\n")); err != nil {
		t.Fatalf("write post-pwd: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	postMount := string(pane.ReplayTail(8192))
	t.Logf("[characterise] post-deletion replay tail:\n%s", postMount)

	postState := pane.State()
	postStoplight := pane.Info().Stoplight
	t.Logf("[characterise] post-deletion pane state=%s stoplight=%s exitCode=%v",
		postState, postStoplight, pane.ExitCode())

	// Observations — these are NOT strict assertions of desired
	// behaviour; they document the actual reality for the PR body.
	// If any of these break, re-read the characterisation before
	// "fixing" the test — the new behaviour may be the right answer
	// and the plan's mount-probe decision should re-open.
	if postState != proto.PaneStateRunning {
		t.Logf("[characterise] NOTE: shell exited after cwd deletion (state=%s) — " +
			"good news, no mount-probe needed in Phase 10a", postState)
	} else {
		t.Logf("[characterise] NOTE: shell stayed running after cwd deletion — " +
			"confirms Codex's rev 3.1 warning; Phase 10a mount-probe is justified " +
			"if users need a red-state signal")
	}
	if postStoplight != proto.StoplightGray {
		t.Logf("[characterise] unexpected stoplight transition to %s — " +
			"may indicate an accidental event-driven path that didn't exist before",
			postStoplight)
	}
	// Sanity: the captured output should mention either /fake-mount
	// or an ls error indicating the filesystem saw the change. If not,
	// the shell may have buffered the output and the test timing
	// needs tuning.
	if !strings.Contains(postMount, "fake-mount") && !strings.Contains(postMount, "No such") {
		t.Logf("[characterise] WARN: post-deletion output didn't reference the " +
			"mount path or an ENOENT error — timing may have missed the echo. " +
			"Raise the sleep duration if this becomes flaky.")
	}
}
