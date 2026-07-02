package agent

import (
	"errors"
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
)

// findDeveloperInstructions returns the text codex was told to inject via
// `-c developer_instructions=<...>`, or "" if the pair isn't present.
func findDeveloperInstructions(argv []string) string {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "-c" && strings.HasPrefix(argv[i+1], "developer_instructions=") {
			return strings.TrimPrefix(argv[i+1], "developer_instructions=")
		}
	}
	return ""
}

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

// Codex honours the app-wide "Reck Connect prompt" (GlobalPreamble) and the
// per-project prompt (Project.Preamble) by injecting them as a developer-role
// message via codex's `-c developer_instructions=` config override — the
// closest analog to Claude's --append-system-prompt. Layers are joined by the
// same preambleSeparator the claude adapter uses.
func TestCodexAdapter_injectsGlobalAndProjectPreamble(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/opt/homebrew/bin/codex"}}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:        config.Project{ID: "p", Cwd: "/tmp", Preamble: "PROJECT-PROMPT"},
		GlobalPreamble: "GLOBAL-PROMPT",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Argv[0] != "/opt/homebrew/bin/codex" {
		t.Errorf("argv[0] = %q, want the codex binary", plan.Argv[0])
	}
	got := findDeveloperInstructions(plan.Argv)
	want := "GLOBAL-PROMPT" + preambleSeparator + "PROJECT-PROMPT"
	if got != want {
		t.Errorf("developer_instructions = %q, want %q", got, want)
	}
}

func TestCodexAdapter_globalPreambleOnly(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/c/codex"}}
	plan, _ := a.BuildSpawn(SpawnRequest{
		Project:        config.Project{ID: "p", Cwd: "/tmp"},
		GlobalPreamble: "ONLY-GLOBAL",
	})
	if got := findDeveloperInstructions(plan.Argv); got != "ONLY-GLOBAL" {
		t.Errorf("developer_instructions = %q, want ONLY-GLOBAL", got)
	}
}

func TestCodexAdapter_noPreambleInjectsNoConfigFlag(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/c/codex"}}
	plan, _ := a.BuildSpawn(SpawnRequest{
		Project:   config.Project{ID: "p", Cwd: "/tmp"},
		ExtraArgs: []string{"--verbose"},
	})
	if got := findDeveloperInstructions(plan.Argv); got != "" {
		t.Errorf("expected no developer_instructions, got %q", got)
	}
	want := []string{"/c/codex", "--verbose"}
	if len(plan.Argv) != len(want) {
		t.Fatalf("argv = %v, want %v", plan.Argv, want)
	}
}

// The Claude-shaped baseline preamble (which names "Claude Code" and Claude's
// lifecycle hooks) must NOT be injected into codex — only the agent-agnostic
// global + project layers.
func TestCodexAdapter_excludesClaudeBaselinePreamble(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/c/codex"}}
	plan, _ := a.BuildSpawn(SpawnRequest{
		Project:  config.Project{ID: "p", Cwd: "/tmp"},
		Preamble: PreambleCtx{Mode: ModeStation, ProjectName: "Demo", StationHostname: "pi"},
	})
	if got := findDeveloperInstructions(plan.Argv); got != "" {
		t.Errorf("codex injected a baseline preamble (%q); it should inject only global+project", got)
	}
}

func TestCodexAdapter_preambleTooLargeErrors(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/c/codex"}}
	big := strings.Repeat("x", MaxPreambleBytes+1)
	if _, err := a.BuildSpawn(SpawnRequest{
		Project:        config.Project{ID: "p", Cwd: "/tmp"},
		GlobalPreamble: big,
	}); err == nil {
		t.Fatal("expected an error for an oversized codex preamble")
	}
}
