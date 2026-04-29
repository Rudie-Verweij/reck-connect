package agent

import (
	"strings"
	"testing"
)

// TestBaseStationPreamble_withSatelliteHint — full-context render. Checked
// as assertions over the returned string rather than a byte-level snapshot
// so a harmless whitespace tweak doesn't require a snapshot update; the
// load-bearing bits are that (a) the satellite hint is embedded, (b) the
// mount-hint sentence appears, (c) the "don't fabricate MCP calls" line
// is present — that's the behaviour-shaping content the model reads.
func TestBaseStationPreamble_withSatelliteHint(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		StationHostname:       "your-station",
		ProjectID:             "reck-connect",
		ProjectName:           "Reck Connect",
		ProjectCwd:            "/Users/reck-connect/projects/reck-connect",
		ManagedProjectsRoot:   "/Users/reck-connect/projects",
		MountHintForSatellite: "~/reck/projects/reck-connect",
		SatelliteHint:         "rudie-laptop",
	}
	out := BaseStationPreamble(ctx)
	if out == "" {
		t.Fatal("expected non-empty preamble")
	}

	mustContain := []string{
		"your-station",
		"rudie-laptop",
		"Reck Connect",
		"id reck-connect",
		"/Users/reck-connect/projects/reck-connect",
		"/Users/reck-connect/projects",
		"~/reck/projects/reck-connect",
		"Do not fabricate calls",
		"$RECK_PANE_ID",
		"$RECK_PROJECT_ID",
		"$RECK_DAEMON_URL",
	}
	for _, want := range mustContain {
		if !strings.Contains(out, want) {
			t.Errorf("preamble missing %q; got:\n%s", want, out)
		}
	}

	// The bracket-template syntax from plan.md must not leak into the
	// rendered text — that'd mean we accidentally shipped a raw
	// template instead of the rendered string.
	for _, mustNot := range []string{"{{", "}}", "{{ .StationHostname }}"} {
		if strings.Contains(out, mustNot) {
			t.Errorf("preamble leaks template syntax %q; got:\n%s", mustNot, out)
		}
	}
}

// TestBaseStationPreamble_withoutSatelliteHint — when RECK_SATELLITE_HINT
// isn't set, the preamble still renders but uses a generic "laptop
// running the Reck Satellite app" fallback instead of a specific hint.
// The mount hint is independent — populated from project config.
func TestBaseStationPreamble_withoutSatelliteHint(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		StationHostname:       "your-station",
		ProjectID:             "reck-connect",
		ProjectName:           "Reck Connect",
		ProjectCwd:            "/Users/reck-connect/projects/reck-connect",
		ManagedProjectsRoot:   "/Users/reck-connect/projects",
		MountHintForSatellite: "~/reck/projects/reck-connect",
		SatelliteHint:         "", // the key difference vs. the prior test
	}
	out := BaseStationPreamble(ctx)
	if out == "" {
		t.Fatal("expected non-empty preamble")
	}

	// With an empty SatelliteHint the generic fallback sentence should
	// render, and the preamble must not mention the (absent) specific hint.
	if !strings.Contains(out, "laptop running the Reck Satellite app") {
		t.Errorf("missing generic satellite fallback; got:\n%s", out)
	}
	// And the mount-hint block should still appear (it's independent of
	// SatelliteHint).
	if !strings.Contains(out, "~/reck/projects/reck-connect") {
		t.Errorf("mount hint should still render without SatelliteHint; got:\n%s", out)
	}
}

// TestBaseStationPreamble_disableSwitch — RECK_DISABLE_BASELINE_PREAMBLE
// set to any non-empty value makes the function return "". This is the
// kill switch for users who want a clean room (only their project
// preamble, nothing else).
func TestBaseStationPreamble_disableSwitch(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1")

	ctx := PreambleCtx{
		StationHostname: "your-station",
		ProjectCwd:      "/Users/reck-connect/projects/foo",
	}
	if out := BaseStationPreamble(ctx); out != "" {
		t.Errorf("disable switch should make preamble empty, got %d bytes:\n%s", len(out), out)
	}
}

// TestBaseStationPreamble_emptyProjectName — degrades gracefully to
// ProjectID. Catches the "uninitialized config.Project" path (test
// fixtures, or a project row with a missing Name field).
func TestBaseStationPreamble_emptyProjectName(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		StationHostname: "your-station",
		ProjectID:       "abc",
		ProjectName:     "",
		ProjectCwd:      "/Users/reck-connect/projects/abc",
	}
	out := BaseStationPreamble(ctx)
	if out == "" {
		t.Fatal("expected non-empty preamble")
	}
	// When Name is empty, the ID is used as the project label. Since
	// label == ID, the disambiguation parenthetical "(id abc)" is
	// suppressed; otherwise we'd render "Project: abc (id abc).".
	if !strings.Contains(out, "Project: abc") {
		t.Errorf("expected 'Project: abc' fallback; got:\n%s", out)
	}
	if strings.Contains(out, "(id abc)") {
		t.Errorf("redundant '(id abc)' disambiguator leaked when label==ID; got:\n%s", out)
	}
}

// TestBaseStationPreamble_emptyEverything — the most permissive degradation
// case: zero-value PreambleCtx. The function must not panic or return a
// string that crashes the claude adapter's size check; it's fine for the
// content to be mostly unanchored placeholder-free prose.
func TestBaseStationPreamble_emptyEverything(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	out := BaseStationPreamble(PreambleCtx{})
	if out == "" {
		t.Fatal("expected non-empty preamble even with zero ctx")
	}
	if len(out) > MaxPreambleBytes {
		t.Errorf("zero-ctx preamble is %d bytes, exceeds MaxPreambleBytes %d", len(out), MaxPreambleBytes)
	}
	// Labeled with the unnamed fallback rather than crashing on an
	// empty key.
	if !strings.Contains(out, "(unnamed)") {
		t.Errorf("expected '(unnamed)' project fallback; got:\n%s", out)
	}
}

// TestBaseStationPreamble_sizeBudget — the baseline alone with a typical
// context must leave plenty of headroom under MaxPreambleBytes for the
// per-project preamble to be appended. 4 KiB is the design target (half
// the cap); anything more means we should tighten the template before
// the combined prompt starts failing size checks on real projects.
func TestBaseStationPreamble_sizeBudget(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		StationHostname:       "your-station",
		ProjectID:             "reck-connect",
		ProjectName:           "Reck Connect",
		ProjectCwd:            "/Users/reck-connect/projects/reck-connect",
		ManagedProjectsRoot:   "/Users/reck-connect/projects",
		MountHintForSatellite: "~/reck/projects/reck-connect",
		SatelliteHint:         "rudie-laptop",
	}
	out := BaseStationPreamble(ctx)
	const softCap = 4 * 1024
	if len(out) > softCap {
		t.Errorf("baseline preamble is %d bytes, > soft cap %d — tighten the template before shipping", len(out), softCap)
	}
}

// TestBasePreamble_modeSwitch_localBranch — the ModeLocal branch of
// BaseStationPreamble must emit the canonical local-mode opening
// sentence verbatim (Phase 6 of the rev 3.1 hybrid-mode plan defines
// the wording; renderer/spawn paths trust it). The sentence is asserted
// as a contains-substring rather than exact equality so the surrounding
// project-label / cwd sections can evolve without dragging this test.
//
// Also asserts the local branch does NOT leak station-only phrases
// ("station host", "sshfs mount", "NOT reachable from here", etc.) —
// a regression there means we'd be telling Claude the wrong story
// about its environment.
func TestBasePreamble_modeSwitch_localBranch(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		Mode:                  ModeLocal,
		StationHostname:       "your-station", // ignored in local mode
		ProjectID:             "reck-connect",
		ProjectName:           "Reck Connect",
		ProjectCwd:            "/Users/reck-connect/reck/projects/reck-connect",
		ManagedProjectsRoot:   "/Users/reck-connect/projects", // ignored in local mode
		MountHintForSatellite: "~/reck/projects/reck-connect", // ignored in local mode
		SatelliteHint:         "rudie-laptop",                 // ignored in local mode
	}
	out := BaseStationPreamble(ctx)
	if out == "" {
		t.Fatal("expected non-empty local-mode preamble")
	}

	// The plan-canonical opening sentence, byte-for-byte. If you're
	// updating this string, update notes/2026-04-23-hybrid-mode-plan/
	// README.md (Phase 6 scope) in the same commit.
	const localOpening = "You are running on the user's laptop; browser, MCPs, local apps, and hardware are reachable; no sshfs indirection — your cwd is the mounted project folder."
	if !strings.Contains(out, localOpening) {
		t.Errorf("local-mode preamble missing canonical opening sentence.\nwant substring:\n%s\ngot:\n%s", localOpening, out)
	}

	// Project label + cwd should still render so Claude has something
	// to anchor its self-description to.
	for _, want := range []string{"Reck Connect", "id reck-connect", "/Users/reck-connect/reck/projects/reck-connect"} {
		if !strings.Contains(out, want) {
			t.Errorf("local-mode preamble missing %q; got:\n%s", want, out)
		}
	}

	// Local mode must NOT emit station-only phrasing — that would
	// describe the wrong environment to Claude. These are the exact
	// load-bearing sentences from the station branch; if any leaks
	// into local-mode output we've cross-wired the templates.
	for _, mustNot := range []string{
		"on the station host",
		"sshfs mount",
		"NOT reachable from here",
		"the station's MCPs",
		"your-station", // station hostname leak
		"~/reck/projects/reck-connect", // mount-hint leak
	} {
		if strings.Contains(out, mustNot) {
			t.Errorf("local-mode preamble leaks station-only phrase %q; got:\n%s", mustNot, out)
		}
	}
}

// TestBasePreamble_modeSwitch_stationBranch — explicit ModeStation must
// produce the same text as the (legacy) zero-Mode default, and must
// preserve the station-specific phrasing. Existing pre-hybrid tests
// already exercise the zero-Mode path; this one specifically asserts
// that setting Mode=ModeStation doesn't accidentally pick up the local
// branch.
func TestBasePreamble_modeSwitch_stationBranch(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		Mode:                  ModeStation,
		StationHostname:       "your-station",
		ProjectID:             "reck-connect",
		ProjectName:           "Reck Connect",
		ProjectCwd:            "/Users/reck-connect/projects/reck-connect",
		ManagedProjectsRoot:   "/Users/reck-connect/projects",
		MountHintForSatellite: "~/reck/projects/reck-connect",
		SatelliteHint:         "rudie-laptop",
	}
	out := BaseStationPreamble(ctx)
	if out == "" {
		t.Fatal("expected non-empty station-mode preamble")
	}

	// Station-specific phrasing — these are the lines that distinguish
	// the station preamble from the local one. Keep this list aligned
	// with renderStationPreamble's load-bearing content.
	for _, want := range []string{
		"on the station host",
		"sshfs mount",
		"NOT reachable from here",
		"~/reck/projects/reck-connect",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("station-mode preamble missing %q; got:\n%s", want, out)
		}
	}

	// Local opening sentence must NOT appear in station mode.
	const localOpening = "You are running on the user's laptop"
	if strings.Contains(out, localOpening) {
		t.Errorf("station-mode preamble leaks local opening %q; got:\n%s", localOpening, out)
	}
}

// TestBasePreamble_modeSwitch_zeroValueDefaultsToStation — back-compat:
// every legacy call site (and every test in this file that pre-dates
// the Mode field) constructs PreambleCtx with no Mode set. The empty
// string must render the station branch so old behaviour is preserved
// without a sweeping test rewrite.
func TestBasePreamble_modeSwitch_zeroValueDefaultsToStation(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		// Mode deliberately omitted — zero value.
		StationHostname: "test-station",
		ProjectID:       "p",
		ProjectName:     "P",
		ProjectCwd:      "/tmp/p",
	}
	out := BaseStationPreamble(ctx)
	if out == "" {
		t.Fatal("expected non-empty preamble for zero-Mode ctx")
	}
	if !strings.Contains(out, "on the station host") {
		t.Errorf("zero-Mode ctx should default to station branch; got:\n%s", out)
	}
}

// TestBasePreamble_modeSwitch_disableSwitchOverridesMode — the kill
// switch RECK_DISABLE_BASELINE_PREAMBLE must short-circuit BOTH branches.
// Without this, a user who disabled the baseline pre-hybrid would
// suddenly see local-mode preambles appear after upgrading.
func TestBasePreamble_modeSwitch_disableSwitchOverridesMode(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "1")

	for _, m := range []DaemonMode{ModeStation, ModeLocal, ""} {
		out := BaseStationPreamble(PreambleCtx{Mode: m, ProjectID: "p"})
		if out != "" {
			t.Errorf("disable switch should suppress mode=%q preamble; got %d bytes", m, len(out))
		}
	}
}

// TestBasePreamble_modeSwitch_localSizeBudget — local-mode preamble
// should be even smaller than the station one (less to explain when the
// daemon and laptop are co-located). 2 KiB is comfortable headroom; if
// the local template grows past that we should tighten before adding
// more.
func TestBasePreamble_modeSwitch_localSizeBudget(t *testing.T) {
	t.Setenv(reckDisableBaselineEnv, "")

	ctx := PreambleCtx{
		Mode:        ModeLocal,
		ProjectID:   "reck-connect",
		ProjectName: "Reck Connect",
		ProjectCwd:  "/Users/reck-connect/reck/projects/reck-connect",
	}
	out := BaseStationPreamble(ctx)
	const softCap = 2 * 1024
	if len(out) > softCap {
		t.Errorf("local-mode preamble is %d bytes, > soft cap %d", len(out), softCap)
	}
	if len(out) > MaxPreambleBytes {
		t.Errorf("local-mode preamble is %d bytes, > MaxPreambleBytes %d", len(out), MaxPreambleBytes)
	}
}
