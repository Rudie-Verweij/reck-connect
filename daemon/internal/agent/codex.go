package agent

import "errors"

// codexAdapter is a minimal stub for OpenAI's Codex CLI. Session
// persistence and per-agent state-hook wiring are future work — keep
// this adapter thin so the interface shape is demonstrated without
// biting off the full Codex integration prematurely.
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
	if req.ResumeSessionID != "" {
		return SpawnPlan{}, ErrResumeUnsupported
	}
	// Restore path (mirrors shell): replay the exact argv + cwd captured
	// when the slot was first created, so a codex pane comes back running
	// the same command in the same directory after a daemon restart —
	// project config / cwd may have drifted since. Slot-identity
	// continuity is what lets the Satellite rebind the saved codex tab.
	// This intentionally ignores a.codexCmd: the captured argv already
	// holds the resolved binary path from the original spawn.
	if req.RestoreEntry != nil {
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
	argv = append(argv, req.ExtraArgs...)
	return SpawnPlan{
		Argv:      argv,
		Cwd:       req.Project.Cwd,
		AgentName: "codex",
	}, nil
}
