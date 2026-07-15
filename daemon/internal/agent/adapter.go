// Package agent defines the multi-system adapter layer that lets the PTY
// manager spawn different AI-agent CLIs (Claude Code, Codex, etc.) plus
// plain shells behind a uniform interface. Per an earlier release §Multi-system
// adapter.
//
// The PTY manager holds a map of PaneKind → Adapter and calls BuildSpawn
// once per pane create. Adapters own their argv, per-agent flags, and any
// metadata that should be persisted alongside the pane (session name,
// session UUID for claude, none for shell or codex today).
//
// Today's adapters:
//   - claude — full-featured; handles preamble, session persistence, and
//     user-supplied extra args.
//   - shell  — spawns the project's configured shell.
//   - codex  — stub that spawns `codex` from $PATH. Session persistence
//     and state-hook wiring are future work (codex ≠ claude-code); the
//     adapter is in place so the UI (pane kind picker) has something to
//     reference.
package agent

import (
	"errors"
	"fmt"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
)

// SpawnRequest captures everything an adapter needs to produce an argv.
// Zero-valued fields are all safe to pass through (except Project).
type SpawnRequest struct {
	Project config.Project
	// ResumeSessionID, when non-empty, asks the adapter to resume a
	// previously recorded session. Adapters that don't support it must
	// return ErrResumeUnsupported.
	ResumeSessionID string
	// ResumeEntry is the resolved session record for ResumeSessionID.
	// Nil when not resuming.
	ResumeEntry *sessions.Entry
	// RestoreEntry, when non-nil, asks a non-Claude adapter to rebuild
	// argv from a persisted shell entry (Scope B). The
	// adapter uses Entry.ShellArgv verbatim — the project's current
	// default shell is NOT consulted on restore because project config
	// can drift between create-time and restore-time.
	RestoreEntry *sessions.Entry
	// ExtraArgs are user-supplied CLI flags. Adapters validate and
	// append them; unsupported flags surface as errors.
	ExtraArgs []string
	// DefaultClaudeCmd is the top-level `--claude` daemon flag; only
	// the claude adapter consults it. Non-claude adapters ignore it.
	DefaultClaudeCmd []string
	// Sessions is the session index store. When non-nil, the claude
	// adapter generates a UUID + `--session-id` and the caller is
	// expected to record the upsert after a successful spawn.
	Sessions *sessions.Store
	// Preamble is the context the claude adapter feeds to
	// BaseStationPreamble. Only the claude adapter consults it; other
	// adapters ignore it. Built once by Manager at construction (station-
	// scoped fields like StationHostname + SatelliteHint) and populated
	// per-spawn with the current project's ID/Name/Cwd/mount hint.
	//
	// Zero-value is safe — the baseline render degrades gracefully when
	// fields are empty (see PreambleCtx doc). In particular a test that
	// doesn't care about the preamble can leave this unset and the
	// adapter will still render a baseline from the empty ctx unless
	// RECK_DISABLE_BASELINE_PREAMBLE is set in the test env.
	Preamble PreambleCtx
	// GlobalPreamble is the satellite-stored "Reck Connect prompt" —
	// app-wide text the user configures in Satellite Settings and that
	// the satellite includes verbatim on every CreatePane request. The
	// claude adapter composes it as a middle layer between the daemon-
	// emitted baseline and the per-project preamble, joined by
	// preambleSeparator. Empty string ⇒ no global layer (no extra
	// separator emitted). Only the claude adapter consults this field.
	GlobalPreamble string
}

// SpawnPlan is the adapter's answer: the argv to exec, plus per-agent
// metadata for the manager to stash on the Pane.
type SpawnPlan struct {
	Argv []string
	// Cwd is the working directory the Manager should pass to Spawn.
	// Populated by BuildSpawn rather than read off Project.Cwd at the
	// call site because a restore path (shell RestoreEntry, future codex
	// resume) wants the cwd captured at the *original* create, not the
	// project's current cwd — project config can drift between create
	// and restore. Empty ⇒ Manager falls back to Project.Cwd.
	Cwd string
	// NewSessionID is non-empty for claude panes spawned fresh when the
	// session index is enabled. The caller records it in the index.
	NewSessionID string
	// SessionName is the human label; mirrored onto Pane.SessionName so
	// the Satellite can show it in tab bars.
	SessionName string
	// ResumedSessionID is set when ResumeSessionID was honored.
	ResumedSessionID string
	// AgentName identifies the agent for lifecycle-hook event attribution
	// (e.g. "claude-code", "codex", "shell").
	AgentName string
}

// Adapter is the per-PaneKind interface. BuildSpawn is the only method.
// Keep it small: every adapter lives inside this package and exports
// nothing else the manager needs.
type Adapter interface {
	BuildSpawn(req SpawnRequest) (SpawnPlan, error)
}

// ErrResumeUnsupported is returned by adapters whose agent has no
// equivalent to `--resume`. The HTTP layer maps this to a 400.
var ErrResumeUnsupported = errors.New("resume not supported for this pane kind")

// Registry is a PaneKind → Adapter lookup. Constructed by NewRegistry; the
// Manager calls Lookup(kind) per spawn.
type Registry struct {
	adapters map[proto.PaneKind]Adapter
}

// NewRegistry wires the built-in adapters. Pass `claudeValidator` so the
// claude adapter can reject out-of-sandbox extra args without reaching
// across the internal/pty boundary.
//
// `codexCmd` is the resolved absolute path (+ optional fixed args) for
// the `codex` binary, from the daemon's startup resolution. Pass nil /
// empty when codex isn't installed or can't be resolved — the codex
// adapter will cleanly reject spawns instead of exec'ing a bare name
// (which would be vulnerable to PATH-shadow attacks).
func NewRegistry(claudeValidator func(args []string, cwd string) error, codexCmd []string) *Registry {
	return &Registry{
		adapters: map[proto.PaneKind]Adapter{
			proto.PaneKindClaude: &claudeAdapter{validateExtraArgs: claudeValidator},
			proto.PaneKindShell:  &shellAdapter{},
			proto.PaneKindCodex:  &codexAdapter{codexCmd: append([]string(nil), codexCmd...)},
		},
	}
}

// Lookup returns the adapter for a kind, or an error.
func (r *Registry) Lookup(kind proto.PaneKind) (Adapter, error) {
	a, ok := r.adapters[kind]
	if !ok {
		return nil, fmt.Errorf("unknown pane kind %q", kind)
	}
	return a, nil
}

// SupportedKinds returns the kinds registered in this registry, in a
// stable order. Used by the Satellite's pane picker.
func (r *Registry) SupportedKinds() []proto.PaneKind {
	// Stable, UI-friendly order: agents first, then shell.
	out := make([]proto.PaneKind, 0, len(r.adapters))
	for _, k := range []proto.PaneKind{proto.PaneKindClaude, proto.PaneKindCodex, proto.PaneKindShell} {
		if _, ok := r.adapters[k]; ok {
			out = append(out, k)
		}
	}
	return out
}
