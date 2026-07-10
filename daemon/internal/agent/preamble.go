package agent

import (
	"os"
	"strings"
)

// MaxPreambleBytes caps the size of the combined (baseline + project)
// system-prompt string the claude adapter is allowed to pass via
// --append-system-prompt. macOS ARG_MAX is ~1 MiB, so this is a
// conservative ceiling that still leaves room for the rest of argv
// (--session-id UUID, --resume, --name, any user extras) without
// pushing close to the OS limit.
//
// Bumped from 8 KiB to 16 KiB after an earlier release landed — a large
// project preamble (~7.4 KiB) combined with the ~2 KiB Reck-awareness
// baseline blew past the original cap. An early verification step confirmed Claude Code
// accepts up to at least 8 KiB verbatim; 16 KiB is a strict superset
// with the same behavioural evidence from the same CLI version (2.1.x).
//
// Callers that exceed this threshold get a clear error at spawn time
// rather than a mysterious exec failure or silent CLI truncation.
const MaxPreambleBytes = 16 * 1024

// reckDisableBaselineEnv is the kill-switch environment variable:
// setting it to a non-empty value ("1", "true", anything) at daemon
// startup time makes BaseStationPreamble return "". Project-level
// preambles (from projects.toml) are still honored — only the
// daemon-emitted baseline is suppressed. Useful for a "clean room"
// session, or during debugging when the preamble's contents are
// confusing a test.
const reckDisableBaselineEnv = "RECK_DISABLE_BASELINE_PREAMBLE"

// DaemonMode is the host posture the daemon is running in. The Satellite
// spawns a `--mode=local` daemon child on the laptop; the station's
// launchd plist starts `--mode=station` on the Mac Studio. The two
// modes share most code paths but the baseline system prompt diverges
// (station Claude is across an sshfs boundary; local Claude isn't).
//
// Typed string (not bare `string`) so a future third mode is a typecheck
// miss at every call site rather than a silent magic-string fall-through.
type DaemonMode string

const (
	// ModeStation: daemon runs on the Mac Studio; Satellite reaches it
	// over Tailscale; project files live on the station; satellite-side
	// MCPs (browser, hardware, calendar) are NOT reachable.
	ModeStation DaemonMode = "station"
	// ModeLocal: daemon runs on the user's laptop alongside the
	// Satellite; cwd is the sshfs-mounted project folder; satellite-side
	// MCPs and local apps ARE reachable.
	ModeLocal DaemonMode = "local"
)

// PreambleCtx is everything BasePreamble needs to render the baseline
// system prompt. Fields split into three groups:
//
//   - Daemon-scoped (Mode): set by Manager from the `--mode` daemon flag
//     at construction. Drives which baseline-text branch BasePreamble
//     emits. Zero value (empty string) renders as ModeStation for legacy
//     call sites that don't explicitly set it — preserves pre-hybrid
//     behaviour.
//   - Station-scoped (StationHostname, ManagedProjectsRoot, SatelliteHint):
//     built once by Manager at daemon startup — these don't change at
//     runtime and are cheap to recompute, but bundling them avoids a
//     per-spawn call into os.Hostname / os.Getenv. Only consumed by the
//     ModeStation branch.
//   - Project-scoped (ProjectID, ProjectName, ProjectCwd,
//     MountHintForSatellite): resolved by Manager at spawn time from the
//     specific project being opened. MountHintForSatellite is derived
//     from the project name (or ID fallback) so the render matches what
//     ops/install-satellite.sh actually mounts on the laptop
//     (~/reck/projects/<id>). Both modes consume ProjectID/Name/Cwd; only
//     ModeStation consumes the mount hint.
//
// All fields are optional in the sense that the template degrades
// gracefully — an empty SatelliteHint omits the "your laptop at X"
// sentence, an empty ProjectName falls back to ProjectID. The only
// truly required field is ProjectCwd; without it the preamble becomes
// generic text with no filesystem anchor. That's a weird state but not
// a crash.
type PreambleCtx struct {
	Mode                  DaemonMode
	StationHostname       string
	ProjectID             string
	ProjectName           string
	ProjectCwd            string
	ManagedProjectsRoot   string
	MountHintForSatellite string
	SatelliteHint         string
}

// BaseStationPreamble renders the daemon-emitted system prompt that
// tells Claude Code where it's running, what filesystem layout to
// expect, and which capabilities it should NOT pretend to have.
//
// Despite the historical "Station" in the name, this is the entry point
// for both modes: ctx.Mode selects the branch. ModeStation (or zero
// value, for back-compat with legacy callers) renders the cross-host
// "satellite MCPs aren't reachable" text. ModeLocal renders the
// laptop-local "browser + hardware + MCPs are reachable" text.
//
// Returns "" when the kill-switch env var RECK_DISABLE_BASELINE_PREAMBLE
// is set — the claude adapter treats "" as "skip the baseline, use only
// the project preamble if any". No template values are user-controlled
// (they come from daemon config / os.Hostname()), so there's no
// interpolation / escaping concern.
//
// Keep these strings tight (<350 tokens target each). Every byte here
// is prompt tax on every single pane spawn, so fluff has a real cost.
// Reference docs/internals.md's "Escape hatch" section for the local-mount
// workflow phrasing — the station-mode preamble mentions it briefly so
// station Claude can suggest it when the user actually needs a browser
// MCP.
func BaseStationPreamble(ctx PreambleCtx) string {
	if os.Getenv(reckDisableBaselineEnv) != "" {
		return ""
	}
	if ctx.Mode == ModeLocal {
		return renderLocalPreamble(ctx)
	}
	return renderStationPreamble(ctx)
}

// renderStationPreamble is the original pre-hybrid baseline text. It
// assumes the daemon runs on the station and the user's satellite is
// across an sshfs / Tailscale boundary. Kept verbatim from the
// pre-hybrid implementation so the test suite for that branch still
// passes byte-for-byte; the only structural change vs. pre-hybrid is
// that this is now reached via a Mode switch rather than as the only
// code path.
func renderStationPreamble(ctx PreambleCtx) string {
	projectLabel := ctx.ProjectName
	if projectLabel == "" {
		projectLabel = ctx.ProjectID
	}
	if projectLabel == "" {
		projectLabel = "(unnamed)"
	}

	var b strings.Builder
	b.WriteString("You are running inside a Reck Connect Claude Code pane on the station host")
	if ctx.StationHostname != "" {
		b.WriteString(" (")
		b.WriteString(ctx.StationHostname)
		b.WriteString(")")
	}
	b.WriteString(".")
	if ctx.SatelliteHint != "" {
		b.WriteString(" The user is operating you remotely from their satellite (")
		b.WriteString(ctx.SatelliteHint)
		b.WriteString(").")
	} else {
		b.WriteString(" The user is operating you remotely from their satellite (laptop running the Reck Satellite app).")
	}
	b.WriteString("\n\n")

	b.WriteString("Project: ")
	b.WriteString(projectLabel)
	if ctx.ProjectID != "" && ctx.ProjectID != projectLabel {
		b.WriteString(" (id ")
		b.WriteString(ctx.ProjectID)
		b.WriteString(")")
	}
	b.WriteString(".\n\n")

	b.WriteString("Filesystem layout:\n")
	if ctx.ProjectCwd != "" {
		b.WriteString("  - This project on the station (here): ")
		b.WriteString(ctx.ProjectCwd)
		b.WriteString("\n")
	}
	if ctx.ManagedProjectsRoot != "" {
		b.WriteString("  - Daemon-managed projects root on the station: ")
		b.WriteString(ctx.ManagedProjectsRoot)
		b.WriteString("\n")
	}
	if ctx.MountHintForSatellite != "" {
		b.WriteString("  - Same project mirrored on the user's satellite at: ")
		b.WriteString(ctx.MountHintForSatellite)
		b.WriteString("\n")
		b.WriteString("    (sshfs mount; excludes node_modules, dist, build, .venv, target,\n")
		b.WriteString("    .next, .cache — those exist only on the station.)\n")
	}
	b.WriteString("\n")

	b.WriteString("What lives where:\n")
	b.WriteString("  - Files, builds, tests, processes, toolchains, git, network → station (here). Fast.\n")
	b.WriteString("  - The user's browser (Chrome), local apps, calendar, Apple Events, hardware,\n")
	b.WriteString("    USB devices, microphone → satellite (their laptop). NOT reachable from here.\n\n")

	b.WriteString("MCPs:\n")
	b.WriteString("  - The MCPs registered in this environment are the station's MCPs\n")
	b.WriteString("    (~/.claude/mcp.json on the station). Anything browser- or\n")
	b.WriteString("    laptop-hardware-bound (e.g. \"Claude in Chrome\", calendar, screen capture)\n")
	b.WriteString("    is NOT registered here and cannot be invoked. Do not fabricate calls to\n")
	b.WriteString("    MCPs that aren't in your tools list.\n")
	b.WriteString("  - If a task requires the user's local browser or hardware, write a\n")
	b.WriteString("    self-contained snippet (Playwright, AppleScript, shell) and ask the user\n")
	b.WriteString("    to run it on their satellite. As a last resort, the user can open a\n")
	b.WriteString("    separate local Claude on the satellite at the mount path above for that\n")
	b.WriteString("    one task — note that session won't share state with this one.\n\n")

	b.WriteString("Reck-specific environment:\n")
	b.WriteString("  - $RECK_PANE_ID — your pane identifier.\n")
	b.WriteString("  - $RECK_PROJECT_ID — current project key in projects.toml.\n")
	b.WriteString("  - $RECK_DAEMON_URL — local daemon HTTP base URL on this host.\n")
	b.WriteString("  - Lifecycle hooks (SessionStart, PreToolUse, Stop, …) already post to\n")
	b.WriteString("    $RECK_DAEMON_URL/panes/$RECK_PANE_ID/agent-event automatically; you do\n")
	b.WriteString("    not need to manage stoplight state by hand.\n\n")

	b.WriteString("You may rely on this preamble being accurate for the duration of this session.")

	return b.String()
}

// renderLocalPreamble is the ModeLocal baseline. The daemon runs on the
// user's laptop alongside the Satellite, so the cross-host caveats from
// the station preamble (sshfs indirection, browser/MCP unreachability)
// don't apply: cwd is the locally-mounted project folder, the user's
// browser and hardware are reachable, and the MCPs registered with this
// laptop's Claude Code install ARE the right ones to call.
//
// Phrasing is canonical: the wording was agreed on in review and the
// test asserts on it verbatim. Don't paraphrase without updating the
// test in lockstep.
func renderLocalPreamble(ctx PreambleCtx) string {
	projectLabel := ctx.ProjectName
	if projectLabel == "" {
		projectLabel = ctx.ProjectID
	}
	if projectLabel == "" {
		projectLabel = "(unnamed)"
	}

	var b strings.Builder
	b.WriteString("You are running on the user's laptop; browser, MCPs, local apps, and hardware are reachable; no sshfs indirection — your cwd is the mounted project folder.")
	b.WriteString("\n\n")

	b.WriteString("Project: ")
	b.WriteString(projectLabel)
	if ctx.ProjectID != "" && ctx.ProjectID != projectLabel {
		b.WriteString(" (id ")
		b.WriteString(ctx.ProjectID)
		b.WriteString(")")
	}
	b.WriteString(".\n")
	if ctx.ProjectCwd != "" {
		b.WriteString("Cwd: ")
		b.WriteString(ctx.ProjectCwd)
		b.WriteString("\n")
	}
	b.WriteString("\n")

	b.WriteString("Reck-specific environment:\n")
	b.WriteString("  - $RECK_PANE_ID — your pane identifier.\n")
	b.WriteString("  - $RECK_PROJECT_ID — current project key.\n")
	b.WriteString("  - $RECK_DAEMON_URL — local daemon HTTP base URL on this host.\n")
	b.WriteString("  - Lifecycle hooks (SessionStart, PreToolUse, Stop, …) already post to\n")
	b.WriteString("    $RECK_DAEMON_URL/panes/$RECK_PANE_ID/agent-event automatically; you do\n")
	b.WriteString("    not need to manage stoplight state by hand.\n\n")

	b.WriteString("You may rely on this preamble being accurate for the duration of this session.")

	return b.String()
}
