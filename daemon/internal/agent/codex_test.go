package agent

import (
	"errors"
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
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

// Resume produces `codex resume [-c …] [extra…] <UUID>`. The subcommand
// leads and the positional UUID closes argv, because codex reads anything
// after it as PROMPT text.
func TestCodexAdapter_resumeArgvShape(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/opt/homebrew/bin/codex"}}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:         config.Project{ID: "p", Cwd: "/tmp", Preamble: "PROJECT-PROMPT"},
		ResumeSessionID: "abc-123",
		ExtraArgs:       []string{"--verbose"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Argv[0] != "/opt/homebrew/bin/codex" {
		t.Errorf("argv[0] = %q, want the codex binary", plan.Argv[0])
	}
	if plan.Argv[1] != "resume" {
		t.Errorf("argv[1] = %q, want the resume subcommand immediately after the binary", plan.Argv[1])
	}
	if last := plan.Argv[len(plan.Argv)-1]; last != "abc-123" {
		t.Errorf("argv ends with %q, want the thread UUID last", last)
	}
	if got := findDeveloperInstructions(plan.Argv); got != "PROJECT-PROMPT" {
		t.Errorf("developer_instructions = %q, want the preamble to survive resume", got)
	}
	if plan.ResumedSessionID != "abc-123" {
		t.Errorf("ResumedSessionID = %q, want abc-123", plan.ResumedSessionID)
	}
	// ExtraArgs must land before the UUID, or codex reads the UUID as a
	// value for the trailing flag.
	extraAt, uuidAt := -1, -1
	for i, s := range plan.Argv {
		switch s {
		case "--verbose":
			extraAt = i
		case "abc-123":
			uuidAt = i
		}
	}
	if extraAt == -1 || uuidAt == -1 || extraAt > uuidAt {
		t.Errorf("extra args must precede the UUID; argv = %v", plan.Argv)
	}
}

// Resuming prefers the cwd the thread actually ran in, so the project files
// codex reads (AGENTS.md and friends) resolve the same way they did before.
func TestCodexAdapter_resumeUsesStoredCwd(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/c/codex"}}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:         config.Project{ID: "p", Cwd: "/project/root"},
		ResumeSessionID: "thread-1",
		RestoreEntry:    &sessions.Entry{Kind: proto.PaneKindCodex, SlotID: "slot-1", Cwd: "/project/root/worktree"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Cwd != "/project/root/worktree" {
		t.Errorf("Cwd = %q, want the stored cwd", plan.Cwd)
	}
}

// A codex row whose pane died before reporting a thread has nothing to
// resume, so restore falls back to replaying the captured argv — the pane
// comes back in the right place, just without its conversation.
func TestCodexAdapter_restoreWithoutThreadReplaysArgv(t *testing.T) {
	a := &codexAdapter{codexCmd: []string{"/c/codex"}}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project: config.Project{ID: "p", Cwd: "/project/root"},
		RestoreEntry: &sessions.Entry{
			Kind:      proto.PaneKindCodex,
			SlotID:    "slot-1",
			Cwd:       "/original/cwd",
			ShellArgv: []string{"/old/path/codex", "--model", "gpt-5-codex"},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"/old/path/codex", "--model", "gpt-5-codex"}
	if len(plan.Argv) != len(want) {
		t.Fatalf("argv = %v, want %v", plan.Argv, want)
	}
	for i := range want {
		if plan.Argv[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q", i, plan.Argv[i], want[i])
		}
	}
	if plan.Cwd != "/original/cwd" {
		t.Errorf("Cwd = %q, want the captured cwd", plan.Cwd)
	}
	if plan.ResumedSessionID != "" {
		t.Errorf("ResumedSessionID = %q, want empty (nothing was resumed)", plan.ResumedSessionID)
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
