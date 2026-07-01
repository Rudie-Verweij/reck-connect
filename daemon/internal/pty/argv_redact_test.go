package pty

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// TestRedactArgv_separatedForm verifies that `--flag value` shape gets
// the value replaced with <redacted> while the flag name survives
// unchanged.
func TestRedactArgv_separatedForm(t *testing.T) {
	uuid := "f63e0176-1ea6-4fbc-aa28-caf41bb573e5"
	in := []string{"/usr/local/bin/claude", "--session-id", uuid, "--name", "demo/foo"}
	got := redactArgv(in)

	want := []string{"/usr/local/bin/claude", "--session-id", "<redacted>", "--name", "demo/foo"}
	if len(got) != len(want) {
		t.Fatalf("length: got %d want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %q want %q", i, got[i], want[i])
		}
	}
	// The input slice must not have been mutated.
	if in[2] != uuid {
		t.Errorf("input mutated: in[2] = %q, want %q", in[2], uuid)
	}
}

// TestRedactArgv_equalsForm covers `--flag=value` shape. Name stays,
// value is masked.
func TestRedactArgv_equalsForm(t *testing.T) {
	in := []string{"claude", "--resume=abc-123-def", "--api-key=sk-xxx"}
	got := redactArgv(in)
	want := []string{"claude", "--resume=<redacted>", "--api-key=<redacted>"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %q want %q", i, got[i], want[i])
		}
	}
}

// TestRedactArgv_leavesNonSensitiveAlone confirms the redactor is a
// narrow allowlist. Arbitrary flags and positional args are untouched
// — only flags in sensitiveArgvFlags have their values masked.
func TestRedactArgv_leavesNonSensitiveAlone(t *testing.T) {
	in := []string{
		"/bin/claude",
		"--dangerously-skip-permissions",
		"--model", "claude-opus-4-7",
	}
	got := redactArgv(in)
	for i, v := range in {
		if got[i] != v {
			t.Errorf("index %d mutated unexpectedly: got %q want %q", i, got[i], v)
		}
	}
}

// TestRedactArgv_appendSystemPromptIsRedacted locks in the log-volume
// fix from an earlier release: the daemon-emitted baseline preamble (several KiB) must
// not be logged verbatim on every pane spawn. It's not a secret, but
// logging it floods /var/log/reck-stationd.log and hides the actually
// useful argv context.
func TestRedactArgv_appendSystemPromptIsRedacted(t *testing.T) {
	in := []string{
		"/bin/claude",
		"--append-system-prompt", "You are running inside a Reck Connect Claude Code pane ...",
		"--model", "claude-opus-4-7",
	}
	got := redactArgv(in)
	want := []string{
		"/bin/claude",
		"--append-system-prompt", redactedPlaceholder,
		"--model", "claude-opus-4-7",
	}
	if len(got) != len(want) {
		t.Fatalf("length mismatch: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %q want %q", i, got[i], want[i])
		}
	}

	// Equals form too.
	inEq := []string{"claude", "--append-system-prompt=Hello baseline"}
	gotEq := redactArgv(inEq)
	if gotEq[1] != "--append-system-prompt=<redacted>" {
		t.Errorf("equals-form: got %q, want --append-system-prompt=<redacted>", gotEq[1])
	}
}

// TestRedactArgv_codexDeveloperInstructions locks in that codex's
// `-c developer_instructions=<preamble>` override — which carries the
// multi-KiB Reck preamble on every codex spawn — is masked, keeping the
// key visible so operators still see the argv shape. A non-sensitive `-c`
// override (e.g. `-c model=...`) must be left intact.
func TestRedactArgv_codexDeveloperInstructions(t *testing.T) {
	in := []string{
		"/opt/homebrew/bin/codex",
		"-c", "developer_instructions=GLOBAL\n\n---\n\nPROJECT prompt text",
		"--verbose",
	}
	got := redactArgv(in)
	want := []string{
		"/opt/homebrew/bin/codex",
		"-c", "developer_instructions=<redacted>",
		"--verbose",
	}
	if len(got) != len(want) {
		t.Fatalf("length: got %d want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %q want %q", i, got[i], want[i])
		}
	}
	keep := redactArgv([]string{"codex", "-c", "model=gpt-5"})
	if keep[2] != "model=gpt-5" {
		t.Errorf("non-sensitive -c override was redacted: got %q", keep[2])
	}
}

// TestRedactArgv_trailingFlagNoValue guards the edge case where a
// sensitive flag sits at the end of argv with no value to mask. We
// should leave it as-is rather than panic or invent a placeholder.
func TestRedactArgv_trailingFlagNoValue(t *testing.T) {
	in := []string{"claude", "--session-id"}
	got := redactArgv(in)
	if len(got) != 2 || got[0] != "claude" || got[1] != "--session-id" {
		t.Errorf("trailing flag handling wrong: got %v", got)
	}
}

// TestRedactArgv_empty covers the empty slice path.
func TestRedactArgv_empty(t *testing.T) {
	if got := redactArgv(nil); got != nil {
		t.Errorf("nil argv: got %v, want nil", got)
	}
	if got := redactArgv([]string{}); len(got) != 0 {
		t.Errorf("empty argv: got %v, want empty", got)
	}
}

// TestLoggedSpawnArgv_containsRedactedNotUUID is the round-trip check
// the security scope calls out: real sensitive values must never appear
// in the logged argv. We feed a typical Claude spawn argv through
// slog.Info with redactArgv applied, then assert:
//
//   - the real UUID / key string is NOT in the log output
//   - <redacted> IS in the log output
//   - flag names themselves DO appear (they're useful for debugging)
func TestLoggedSpawnArgv_containsRedactedNotUUID(t *testing.T) {
	uuid := "f63e0176-1ea6-4fbc-aa28-caf41bb573e5"
	apiKey := "sk-super-secret-never-log-me"
	resumeUUID := "c5afab58-a122-4725-bce3-60a866198584"
	preambleMarker := "BASELINE_PREAMBLE_MARKER_SHOULD_BE_HIDDEN"
	argv := []string{
		"/usr/local/bin/claude",
		"--append-system-prompt", preambleMarker,
		"--session-id", uuid,
		"--name", "p1/abc",
		"--resume=" + resumeUUID,
		"--api-key", apiKey,
		"--dangerously-skip-permissions",
	}

	var buf bytes.Buffer
	h := slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	logger := slog.New(h)
	logger.Info("spawn pane",
		"project", "p1",
		"kind", "claude",
		"argv", redactArgv(argv),
	)

	out := buf.String()

	for _, secret := range []string{uuid, resumeUUID, apiKey, preambleMarker} {
		if strings.Contains(out, secret) {
			t.Errorf("log contained sensitive or noisy value %q; output:\n%s", secret, out)
		}
	}
	if !strings.Contains(out, redactedPlaceholder) {
		t.Errorf("log missing %q placeholder; output:\n%s", redactedPlaceholder, out)
	}
	// Flag names should still show so operators can debug argv shape.
	for _, flag := range []string{"--session-id", "--resume", "--api-key", "--append-system-prompt"} {
		if !strings.Contains(out, flag) {
			t.Errorf("log missing flag name %q (should be preserved); output:\n%s", flag, out)
		}
	}
}
