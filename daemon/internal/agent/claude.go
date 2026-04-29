package agent

import (
	"errors"
	"fmt"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

// preambleSeparator joins the daemon-emitted baseline preamble and the
// per-project preamble (from projects.toml) into a single
// --append-system-prompt value.
//
// Step 0 verification for an earlier release confirmed Claude Code treats the
// combined string as one opaque prompt: it does not parse "---" as a
// structural separator, and both sections influence the model's
// behaviour simultaneously. Keeping the separator visible helps humans
// debugging `--debug-file` output, but isn't load-bearing on the CLI
// side.
const preambleSeparator = "\n\n---\n\n"

// claudeAdapter builds argv for a Claude Code pane. It handles:
//   - the shared --claude binary path
//   - --append-system-prompt with the baseline Reck-awareness preamble,
//     optionally combined with the project's own preamble
//   - --resume <uuid> when resuming, or --session-id/--name when spawning fresh
//   - user-supplied --flag args, gated by a validator injected at construction
//     time (so this package doesn't import internal/pty).
type claudeAdapter struct {
	validateExtraArgs func(args []string, cwd string) error
}

func (a *claudeAdapter) BuildSpawn(req SpawnRequest) (SpawnPlan, error) {
	if len(req.DefaultClaudeCmd) == 0 {
		return SpawnPlan{}, errors.New("claude command not configured")
	}
	if a.validateExtraArgs != nil {
		if err := a.validateExtraArgs(req.ExtraArgs, req.Project.Cwd); err != nil {
			return SpawnPlan{}, err
		}
	}
	argv := append([]string(nil), req.DefaultClaudeCmd...)

	// Compose the --append-system-prompt value: baseline first, project
	// preamble second, joined by preambleSeparator. Either side may be
	// empty (baseline when RECK_DISABLE_BASELINE_PREAMBLE is set;
	// project when projects.toml omits `preamble`). Only emit the flag
	// at all when at least one side is non-empty, otherwise we'd pass a
	// literal "" which does nothing on the CLI side but still inflates
	// argv and muddies logs.
	baseline := BaseStationPreamble(req.Preamble)
	project := req.Project.Preamble
	var combined string
	switch {
	case baseline != "" && project != "":
		combined = baseline + preambleSeparator + project
	case baseline != "":
		combined = baseline
	case project != "":
		combined = project
	}
	if combined != "" {
		if len(combined) > MaxPreambleBytes {
			return SpawnPlan{}, fmt.Errorf("claude preamble too large: %d bytes > %d", len(combined), MaxPreambleBytes)
		}
		argv = append(argv, "--append-system-prompt", combined)
	}

	// Cwd always comes from the project itself — Claude's --resume
	// rehydrates the transcript but the process still runs in the
	// project's working copy; transcripts can be resumed across cwd
	// moves without re-anchoring the process.
	plan := SpawnPlan{AgentName: "claude-code", Cwd: req.Project.Cwd}

	switch {
	case req.ResumeEntry != nil:
		argv = append(argv, "--resume", req.ResumeEntry.SessionID)
		plan.ResumedSessionID = req.ResumeEntry.SessionID
		plan.SessionName = req.ResumeEntry.Name
	case req.Sessions != nil:
		// Fresh pane + session index available → pre-generate a UUID
		// so the daemon can record the mapping before the child exits.
		newID := sessions.NewUUID()
		short := newID
		if len(short) > 8 {
			short = short[:8]
		}
		name := fmt.Sprintf("%s/%s", req.Project.ID, short)
		argv = append(argv, "--session-id", newID, "--name", name)
		plan.NewSessionID = newID
		plan.SessionName = name
	}

	argv = append(argv, req.ExtraArgs...)
	plan.Argv = argv
	return plan, nil
}
