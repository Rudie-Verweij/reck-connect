package agent

import (
	"errors"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
)

// TestCodexAdapter_errorsWhenUnconfigured covers the an earlier release invariant:
// when the daemon was started without a resolvable codex binary, the
// adapter must refuse to spawn instead of exec'ing a bare `codex` that
// would let a poisoned PATH run arbitrary code.
func TestCodexAdapter_errorsWhenUnconfigured(t *testing.T) {
	a := &codexAdapter{} // codexCmd: nil
	_, err := a.BuildSpawn(SpawnRequest{Project: config.Project{ID: "p", Cwd: "/tmp"}})
	if !errors.Is(err, ErrCodexNotAvailable) {
		t.Fatalf("want ErrCodexNotAvailable, got %v", err)
	}
}

// TestCodexAdapter_usesResolvedAbsolutePath — happy path: when the
// registry was constructed with an absolute codex path, that's what
// shows up in argv[0], with ExtraArgs appended.
func TestCodexAdapter_usesResolvedAbsolutePath(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/opt/homebrew/bin/codex"}}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:   config.Project{ID: "p", Cwd: "/tmp"},
		ExtraArgs: []string{"--verbose"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.AgentName != "codex" {
		t.Errorf("AgentName = %q, want codex", plan.AgentName)
	}
	want := []string{"/opt/homebrew/bin/codex", "--verbose"}
	if len(plan.Argv) != len(want) {
		t.Fatalf("argv length: got %d want %d (%v)", len(plan.Argv), len(want), plan.Argv)
	}
	for i := range want {
		if plan.Argv[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q", i, plan.Argv[i], want[i])
		}
	}
}

// TestCodexAdapter_rejectsResume — resuming a codex session isn't
// supported; the adapter must still signal this clearly rather than
// silently losing the flag.
func TestCodexAdapter_rejectsResume(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/opt/homebrew/bin/codex"}}
	_, err := a.BuildSpawn(SpawnRequest{
		Project:         config.Project{ID: "p", Cwd: "/tmp"},
		ResumeSessionID: "abc-123",
	})
	if !errors.Is(err, ErrResumeUnsupported) {
		t.Fatalf("want ErrResumeUnsupported, got %v", err)
	}
}
