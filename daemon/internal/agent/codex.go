package agent

import (
	"errors"
	"fmt"
	"strings"
)

// codexAdapter builds spawn plans for OpenAI's Codex CLI.
//
// Resume: when ResumeSessionID is set it holds a codex *thread* UUID,
// captured from the pane's SessionStart hook payload and stored on the
// session-index row as ThreadID. Codex owns the thread metadata in its own
// state store; the daemon only round-trips the UUID and lets codex rehydrate
// the conversation.
//
// Per an earlier release.1 (argv redaction & binary resolution): the codex binary path
// is resolved once at daemon startup (main.go → config.ResolveBinary)
// and injected here. Empty `codexCmd` means the station has no usable
// codex on PATH and BuildSpawn returns a clean error instead of
// fork/exec'ing a bare name — that blocks the PATH-shadow attack class.
type codexAdapter struct {
	// codexCmd is the resolved absolute path (+ optional fixed args) for
	// the Codex CLI. Set by NewRegistry; empty means "codex unavailable
	// on this station" and the adapter errors out at BuildSpawn.
	codexCmd []string
}

// ErrCodexNotAvailable is returned by BuildSpawn when the daemon was
// started without a usable codex binary. The HTTP layer maps this to a
// 400 so the Satellite can surface a helpful error.
var ErrCodexNotAvailable = errors.New("codex is not configured on this station")

func (a *codexAdapter) BuildSpawn(req SpawnRequest) (SpawnPlan, error) {
	// Restore with no thread to resume: the pane died before its
	// SessionStart hook reported one, so there's no conversation to bring
	// back. Replay the exact argv + cwd captured when the slot was first
	// created, so the pane at least returns to the same command in the same
	// directory even though project config / cwd may have drifted. This
	// intentionally ignores a.codexCmd — the captured argv already holds the
	// binary path resolved at the original spawn.
	if req.ResumeSessionID == "" && req.RestoreEntry != nil {
		if len(req.RestoreEntry.ShellArgv) == 0 {
			return SpawnPlan{}, errors.New("codex restore: stored argv is empty")
		}
		if req.RestoreEntry.Cwd == "" {
			return SpawnPlan{}, errors.New("codex restore: stored cwd is empty")
		}
		return SpawnPlan{
			Argv:      append([]string(nil), req.RestoreEntry.ShellArgv...),
			Cwd:       req.RestoreEntry.Cwd,
			AgentName: "codex",
		}, nil
	}
	if len(a.codexCmd) == 0 {
		return SpawnPlan{}, ErrCodexNotAvailable
	}
	argv := append([]string(nil), a.codexCmd...)

	// `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`. The subcommand goes
	// first so the `-c` below is parsed as one of its options rather than
	// relying on top-level option forwarding, which has shifted between
	// codex versions. The positional UUID is appended last, after ExtraArgs,
	// because anything following it would be read as PROMPT text.
	resuming := req.ResumeSessionID != ""
	if resuming {
		argv = append(argv, "resume")
	}

	// Inject Reck's preamble as a codex `developer` role message via the
	// `-c developer_instructions=` config override — the closest analog to
	// Claude's --append-system-prompt (codex has no such flag; verified
	// against codex-rs/config/src/config_toml.rs). Per-launch and
	// non-invasive: nothing is written to the repo and no AGENTS.md is
	// touched. We compose only the two AGENT-AGNOSTIC layers — the global
	// "Reck Connect prompt" and the per-project preamble — and deliberately
	// SKIP the daemon baseline, which is Claude-shaped (it names "Claude
	// Code" and Claude's lifecycle hooks) and would be inaccurate here.
	// codex parses the value as TOML with a literal-string fallback, so a
	// prose preamble (which fails TOML parse) passes through verbatim,
	// separators and newlines intact.
	layers := make([]string, 0, 2)
	if req.GlobalPreamble != "" {
		layers = append(layers, req.GlobalPreamble)
	}
	if req.Project.Preamble != "" {
		layers = append(layers, req.Project.Preamble)
	}
	if len(layers) > 0 {
		combined := strings.Join(layers, preambleSeparator)
		if len(combined) > MaxPreambleBytes {
			return SpawnPlan{}, fmt.Errorf("codex preamble too large: %d bytes > %d", len(combined), MaxPreambleBytes)
		}
		argv = append(argv, "-c", "developer_instructions="+combined)
	}

	argv = append(argv, req.ExtraArgs...)

	// Resume in the directory the thread actually ran in when we know it,
	// matching the shell restore contract; AGENTS.md and other project files
	// codex reads are cwd-relative.
	cwd := req.Project.Cwd
	plan := SpawnPlan{AgentName: "codex"}
	if resuming {
		if req.RestoreEntry != nil && req.RestoreEntry.Cwd != "" {
			cwd = req.RestoreEntry.Cwd
		}
		// Must close argv: a later flag would be parsed as PROMPT text.
		argv = append(argv, req.ResumeSessionID)
		plan.ResumedSessionID = req.ResumeSessionID
	}
	plan.Argv = argv
	plan.Cwd = cwd
	return plan, nil
}
