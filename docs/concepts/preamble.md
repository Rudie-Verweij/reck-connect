# Preamble

The preamble is a system-prompt extension injected into every Claude pane at spawn time via `--append-system-prompt`. It orients Claude Code to the station environment: hostname, project layout, satellite identity, filesystem constraints, and what it must not pretend to do (satellite-local MCPs).

Only Claude panes receive a preamble. Shell and codex panes do not.

Source: `daemon/internal/agent/preamble.go`, `daemon/internal/agent/claude.go`, `ops/eu.verwey.reck-stationd.plist.tmpl`.

## Three Layers

The combined preamble has three independent layers, assembled by the claude adapter at spawn time:

| Layer | Content | Origin |
|-------|---------|--------|
| **Baseline** | Generic Reck-awareness: hostname, filesystem layout, managed-projects root, satellite identity, what MCPs are/aren't available, env var glossary | `agent.BaseStationPreamble(ctx)` — generated at spawn from `PreambleCtx` |
| **Satellite hint** | Optional name of the connecting satellite (e.g. `"my-laptop"`) embedded inside the baseline sentence | `RECK_SATELLITE_HINT` env var on the daemon |
| **Project-level** | Per-project custom text, e.g. coding standards or task instructions | `preamble` field in `projects.toml` |

Composition in `daemon/internal/agent/claude.go`:

```go
const preambleSeparator = "\n\n---\n\n"

baseline := BaseStationPreamble(req.Preamble)
project := req.Project.Preamble
switch {
case baseline != "" && project != "":
    combined = baseline + preambleSeparator + project
case baseline != "":
    combined = baseline
case project != "":
    combined = project
}
// combined is passed as --append-system-prompt <combined>
```

Order: **baseline first, project preamble second**, separated by `\n\n---\n\n`. Claude Code treats the combined string as one opaque prompt.

## Baseline Content

`BaseStationPreamble` renders text that tells Claude:

- It is running on a station (hostname in parentheses if known).
- Who is connecting remotely (satellite hint, or generic fallback).
- The project name, ID, and cwd on the station.
- The managed-projects root and, if the project's cwd is under it, the satellite mount hint (`~/reck/projects/<project_id>`).
- What is on the station (files, builds, git, network) vs on the satellite (browser, apps, hardware, MCPs).
- Which MCPs are in scope (station's `~/.claude/mcp.json`) and which are not.
- The Reck env vars available to Claude: `$RECK_PANE_ID`, `$RECK_PROJECT_ID`, `$RECK_DAEMON_URL`.

Soft cap: the baseline alone should stay under 4 KB (tested in `preamble_test.go`). The hard cap for the combined preamble is 16 KB (`MaxPreambleBytes`). Exceeding it returns an error at spawn time.

## `RECK_SATELLITE_HINT`

Optional daemon env var. When set, the baseline includes a specific satellite name:

```
The user is operating you remotely from their satellite (my-laptop).
```

When unset or empty, it falls back to:

```
The user is operating you remotely from their satellite (laptop running the Reck Satellite app).
```

Set in the launchd plist template at `ops/eu.verwey.reck-stationd.plist.tmpl`:

```xml
<key>RECK_SATELLITE_HINT</key>
<string></string>   <!-- fill in e.g. "my-laptop" -->
```

The hint is captured once at `Manager` construction time (`resolvePreambleDefaults`). A change to the plist requires a daemon restart to take effect.

## Kill Switch: `RECK_DISABLE_BASELINE_PREAMBLE`

Setting `RECK_DISABLE_BASELINE_PREAMBLE` to any non-empty value (`"1"`, `"true"`, anything) makes `BaseStationPreamble` return `""`. The baseline is suppressed entirely.

Project-level preambles from `projects.toml` are still honored when the kill switch is active.

Set in the plist:

```xml
<key>RECK_DISABLE_BASELINE_PREAMBLE</key>
<string></string>   <!-- set to "1" to disable -->
```

Intended for debugging or "clean room" sessions. In normal operation the baseline is what prevents Claude from fabricating calls to browser MCPs that are not reachable from the station.

## Project-Level Preamble

Add custom text via the `preamble` field in `projects.toml`:

```toml
[[project]]
id       = "my-app"
name     = "My App"
cwd      = "/Users/reck-connect/projects/my-app"
preamble = "Always run tests before committing. The main branch is 'main'."
```

Multi-line preambles use TOML triple-quoted strings:

```toml
preamble = """
Always run tests before committing.
The main branch is 'main'.
"""
```

The project preamble can also be set via the UI (future feature) or via `Manager.SetProjectPreamble` (not persisted to disk).

## Only for Claude Panes

The preamble mechanism is exclusive to `PaneKindClaude`. The shell and codex adapters do not call `BaseStationPreamble` or read `req.Project.Preamble`. Passing `--append-system-prompt` via `extra_args` on a Claude pane is rejected by `ValidateClaudeExtraArgs` — use the `projects.toml` `preamble` field instead.

See also: [`concepts/behaviors.md`](./behaviors.md) for preamble composition in the context of other spawn behaviors.
