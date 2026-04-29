package agent

import "errors"

// shellAdapter wraps the project's configured shell command. an earlier release
// Scope B added per-pane slot identities + persisted argv so a shell
// restore can respawn with the exact argv captured at create time
// rather than whatever the project default resolves to today — project
// config drifts, stored argv is the invariant.
//
// ExtraArgs are silently ignored — the existing contract (predates the
// adapter refactor) lets clients pass the same per-project claude flags
// to a shell pane without special-casing.
type shellAdapter struct{}

func (a *shellAdapter) BuildSpawn(req SpawnRequest) (SpawnPlan, error) {
	if req.ResumeSessionID != "" {
		return SpawnPlan{}, ErrResumeUnsupported
	}
	// Restore path: use the argv AND cwd we captured when the slot was
	// first created. Project config can drift (user edited shell field
	// OR moved the project directory between create and restore), so
	// falling back to req.Project here would break the "restart
	// preserves what was running" promise — the spawned shell would
	// land in the wrong checkout with the wrong argv.
	if req.RestoreEntry != nil {
		if len(req.RestoreEntry.ShellArgv) == 0 {
			return SpawnPlan{}, errors.New("shell restore: stored argv is empty")
		}
		if req.RestoreEntry.Cwd == "" {
			return SpawnPlan{}, errors.New("shell restore: stored cwd is empty")
		}
		return SpawnPlan{
			Argv:      append([]string(nil), req.RestoreEntry.ShellArgv...),
			Cwd:       req.RestoreEntry.Cwd,
			AgentName: "shell",
		}, nil
	}
	if len(req.Project.Shell) == 0 {
		return SpawnPlan{}, errors.New("project shell not configured")
	}
	return SpawnPlan{
		Argv:      append([]string(nil), req.Project.Shell...),
		Cwd:       req.Project.Cwd,
		AgentName: "shell",
	}, nil
}
