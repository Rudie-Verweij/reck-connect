package agent

import (
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

// findAppendSystemPrompt scans argv for "--append-system-prompt" and
// returns its value (the next argv entry) along with a bool indicating
// presence. Flag packing style ("--append-system-prompt=X") is not used
// by this adapter — it always emits the two-argv form — so this helper
// deliberately doesn't handle that case.
func findAppendSystemPrompt(t *testing.T, argv []string) (string, bool) {
	t.Helper()
	for i, a := range argv {
		if a == "--append-system-prompt" {
			if i+1 >= len(argv) {
				t.Fatalf("--append-system-prompt without value in argv: %v", argv)
			}
			return argv[i+1], true
		}
	}
	return "", false
}

// TestClaudeAdapter_baselineOnly — a project with no Preamble still gets
// the baseline system prompt injected. Regression guard against someone
// "simplifying" the combine logic back to project-only.
func TestClaudeAdapter_baselineOnly(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:          config.Project{ID: "p", Name: "P", Cwd: "/tmp", Preamble: ""},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		Preamble: PreambleCtx{
			StationHostname: "test-station",
			ProjectID:       "p",
			ProjectName:     "P",
			ProjectCwd:      "/tmp",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if !strings.Contains(prompt, "test-station") {
		t.Errorf("baseline didn't render hostname; got:\n%s", prompt)
	}
	if strings.Contains(prompt, preambleSeparator) {
		t.Errorf("no project preamble to combine — separator should be absent; got:\n%s", prompt)
	}
}

// TestClaudeAdapter_projectOnly — disable switch on: the baseline is
// suppressed, but the project preamble (if any) still flows through.
// This preserves the pre-change behaviour for users who opt out.
func TestClaudeAdapter_projectOnly(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project: config.Project{
			ID:       "p",
			Name:     "P",
			Cwd:      "/tmp",
			Preamble: "Be terse. Project rule.",
		},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		Preamble:         PreambleCtx{StationHostname: "test-station"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if strings.Contains(prompt, "test-station") {
		t.Errorf("disable switch set but baseline leaked; got:\n%s", prompt)
	}
	if prompt != "Be terse. Project rule." {
		t.Errorf("project preamble not passed through verbatim; got %q", prompt)
	}
}

// TestClaudeAdapter_combined — happy path. Both baseline and project
// preamble exist; they're joined by the exact separator Step 0 verified
// with the Claude CLI and passed as a single --append-system-prompt.
func TestClaudeAdapter_combined(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project: config.Project{
			ID:       "p",
			Name:     "P",
			Cwd:      "/tmp",
			Preamble: "Be terse. Project rule.",
		},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		Preamble: PreambleCtx{
			StationHostname: "test-station",
			ProjectID:       "p",
			ProjectName:     "P",
			ProjectCwd:      "/tmp",
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if !strings.Contains(prompt, "test-station") {
		t.Errorf("baseline missing from combined prompt; got:\n%s", prompt)
	}
	if !strings.Contains(prompt, "Be terse. Project rule.") {
		t.Errorf("project preamble missing from combined prompt; got:\n%s", prompt)
	}
	if !strings.Contains(prompt, preambleSeparator) {
		t.Errorf("expected separator %q between sections; got:\n%s", preambleSeparator, prompt)
	}
	// Structural check: baseline first, then separator, then project.
	// Any other order would mean the adapter's combine switch is wrong.
	sepIdx := strings.Index(prompt, preambleSeparator)
	baseIdx := strings.Index(prompt, "test-station")
	projIdx := strings.Index(prompt, "Be terse. Project rule.")
	if !(baseIdx < sepIdx && sepIdx < projIdx) {
		t.Errorf("expected order baseline -> separator -> project; got indices base=%d sep=%d proj=%d\n%s", baseIdx, sepIdx, projIdx, prompt)
	}
}

// TestClaudeAdapter_rejectsOversizedPreamble — combined size > 8 KiB
// errors at spawn time rather than reaching the CLI (where the failure
// mode would be opaque and user-unfriendly).
func TestClaudeAdapter_rejectsOversizedPreamble(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1") // keep baseline out; test a big project preamble alone
	a := &claudeAdapter{}
	huge := strings.Repeat("x", MaxPreambleBytes+1)
	_, err := a.BuildSpawn(SpawnRequest{
		Project: config.Project{
			ID:       "p",
			Name:     "P",
			Cwd:      "/tmp",
			Preamble: huge,
		},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
	})
	if err == nil {
		t.Fatal("expected error on oversized preamble, got nil")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Errorf("error should mention size; got %v", err)
	}
}

// TestClaudeAdapter_noPreambleAtAll — disable switch on AND no project
// preamble. Argv must not contain --append-system-prompt at all (we
// don't want a stray empty-string flag polluting argv).
func TestClaudeAdapter_noPreambleAtAll(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1")
	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:          config.Project{ID: "p", Name: "P", Cwd: "/tmp"},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := findAppendSystemPrompt(t, plan.Argv); ok {
		t.Errorf("expected no --append-system-prompt in argv; got %v", plan.Argv)
	}
}

// TestClaudeAdapter_resumePreservesPreamble — resume path still threads
// the baseline preamble in. The previously-persisted session picks up
// whatever baseline the current daemon emits, which is what we want if
// the user migrated to a station with a different hostname between
// sessions.
func TestClaudeAdapter_resumePreservesPreamble(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")
	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:          config.Project{ID: "p", Name: "P", Cwd: "/tmp"},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		ResumeEntry:      &sessions.Entry{SessionID: "11111111-2222-3333-4444-555555555555", Name: "p/abcdefgh"},
		Preamble:         PreambleCtx{StationHostname: "test-station"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok || !strings.Contains(prompt, "test-station") {
		t.Errorf("baseline missing on resume path; argv=%v", plan.Argv)
	}
	// --resume must still appear.
	sawResume := false
	for _, a := range plan.Argv {
		if a == "--resume" {
			sawResume = true
			break
		}
	}
	if !sawResume {
		t.Errorf("--resume missing from argv: %v", plan.Argv)
	}
	if plan.ResumedSessionID != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("ResumedSessionID = %q, want the fixture uuid", plan.ResumedSessionID)
	}
}

// TestClaudeAdapter_globalOnly — only the global layer is set (baseline
// disabled, no project preamble). Argv carries the global text verbatim
// as the only preamble content (no separators).
func TestClaudeAdapter_globalOnly(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:          config.Project{ID: "p", Name: "P", Cwd: "/tmp"},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		Preamble:         PreambleCtx{StationHostname: "test-station"},
		GlobalPreamble:   "RECK_GLOBAL_MARKER use absolute paths.",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if prompt != "RECK_GLOBAL_MARKER use absolute paths." {
		t.Errorf("global preamble not passed through verbatim; got %q", prompt)
	}
	if strings.Contains(prompt, preambleSeparator) {
		t.Errorf("no other layers present — separator should be absent; got:\n%s", prompt)
	}
}

// TestClaudeAdapter_baselinePlusGlobal — baseline + global, no project
// preamble. Two layers joined by exactly one separator, baseline first.
func TestClaudeAdapter_baselinePlusGlobal(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project:          config.Project{ID: "p", Name: "P", Cwd: "/tmp"},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		Preamble: PreambleCtx{
			StationHostname: "test-station",
			ProjectID:       "p",
			ProjectName:     "P",
			ProjectCwd:      "/tmp",
		},
		GlobalPreamble: "RECK_GLOBAL_MARKER",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if !strings.Contains(prompt, "test-station") {
		t.Errorf("baseline missing; got:\n%s", prompt)
	}
	if !strings.Contains(prompt, "RECK_GLOBAL_MARKER") {
		t.Errorf("global preamble missing; got:\n%s", prompt)
	}
	if strings.Count(prompt, preambleSeparator) != 1 {
		t.Errorf("expected exactly one separator (baseline|global), got %d in:\n%s",
			strings.Count(prompt, preambleSeparator), prompt)
	}
	baseIdx := strings.Index(prompt, "test-station")
	sepIdx := strings.Index(prompt, preambleSeparator)
	globIdx := strings.Index(prompt, "RECK_GLOBAL_MARKER")
	if !(baseIdx < sepIdx && sepIdx < globIdx) {
		t.Errorf("expected order baseline -> sep -> global; indices base=%d sep=%d glob=%d\n%s",
			baseIdx, sepIdx, globIdx, prompt)
	}
}

// TestClaudeAdapter_globalPlusProject — global + project, baseline
// disabled. Two layers joined by exactly one separator, global first.
func TestClaudeAdapter_globalPlusProject(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project: config.Project{
			ID:       "p",
			Name:     "P",
			Cwd:      "/tmp",
			Preamble: "PROJECT_RULE",
		},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		GlobalPreamble:   "RECK_GLOBAL_MARKER",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if strings.Count(prompt, preambleSeparator) != 1 {
		t.Errorf("expected exactly one separator (global|project), got %d in:\n%s",
			strings.Count(prompt, preambleSeparator), prompt)
	}
	globIdx := strings.Index(prompt, "RECK_GLOBAL_MARKER")
	sepIdx := strings.Index(prompt, preambleSeparator)
	projIdx := strings.Index(prompt, "PROJECT_RULE")
	if !(globIdx < sepIdx && sepIdx < projIdx) {
		t.Errorf("expected order global -> sep -> project; indices glob=%d sep=%d proj=%d\n%s",
			globIdx, sepIdx, projIdx, prompt)
	}
}

// TestClaudeAdapter_allThreeLayers — baseline + global + project. Three
// layers, two separators, order baseline -> global -> project. The
// happy path post-feature: the satellite sends a global, the daemon
// emits a baseline, the project usually has its own preamble.
func TestClaudeAdapter_allThreeLayers(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	a := &claudeAdapter{}
	plan, err := a.BuildSpawn(SpawnRequest{
		Project: config.Project{
			ID:       "p",
			Name:     "P",
			Cwd:      "/tmp",
			Preamble: "PROJECT_RULE",
		},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		Preamble: PreambleCtx{
			StationHostname: "test-station",
			ProjectID:       "p",
			ProjectName:     "P",
			ProjectCwd:      "/tmp",
		},
		GlobalPreamble: "RECK_GLOBAL_MARKER",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	prompt, ok := findAppendSystemPrompt(t, plan.Argv)
	if !ok {
		t.Fatalf("expected --append-system-prompt in argv: %v", plan.Argv)
	}
	if strings.Count(prompt, preambleSeparator) != 2 {
		t.Errorf("expected exactly two separators (baseline|global|project), got %d in:\n%s",
			strings.Count(prompt, preambleSeparator), prompt)
	}
	baseIdx := strings.Index(prompt, "test-station")
	globIdx := strings.Index(prompt, "RECK_GLOBAL_MARKER")
	projIdx := strings.Index(prompt, "PROJECT_RULE")
	if !(baseIdx >= 0 && globIdx >= 0 && projIdx >= 0) {
		t.Fatalf("one or more layers missing: base=%d glob=%d proj=%d\n%s",
			baseIdx, globIdx, projIdx, prompt)
	}
	if !(baseIdx < globIdx && globIdx < projIdx) {
		t.Errorf("expected order baseline -> global -> project; indices base=%d glob=%d proj=%d\n%s",
			baseIdx, globIdx, projIdx, prompt)
	}
}

// TestClaudeAdapter_rejectsOversizedGlobal — combined size > cap driven
// by a big global layer alone errors at spawn time. Mirrors the
// oversized-project test but exercises the new layer.
func TestClaudeAdapter_rejectsOversizedGlobal(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1") // baseline out
	a := &claudeAdapter{}
	huge := strings.Repeat("g", MaxPreambleBytes+1)
	_, err := a.BuildSpawn(SpawnRequest{
		Project:          config.Project{ID: "p", Name: "P", Cwd: "/tmp"},
		DefaultClaudeCmd: []string{"/opt/homebrew/bin/claude"},
		GlobalPreamble:   huge,
	})
	if err == nil {
		t.Fatal("expected error on oversized global preamble, got nil")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Errorf("error should mention size; got %v", err)
	}
}
