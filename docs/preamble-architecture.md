# Preamble Pipeline Architecture

How Reck Connect builds the `--append-system-prompt` value it passes to
`claude` on every Claude-pane spawn. The pipeline is *layered*: up to three
text blocks are joined by a fixed separator and handed to the CLI as one
opaque prompt. Each layer has a distinct origin, lifetime, and failure
mode — but downstream they look identical to the model.

For the broader station/satellite topology see
[`architecture.md`](architecture.md); for daemon internals see
[`internals.md`](internals.md).

## Why the preamble exists

Of the contextual inputs Claude Code reads at startup — training data, the
project `CLAUDE.md`, `~/.claude/CLAUDE.md`, and the `--append-system-prompt`
argv flag — only the last is under Reck's direct control at spawn time.
Everything Reck wants Claude to know (that it's running inside a Reck pane,
the filesystem layout, path-printing conventions that help the satellite's
Cmd+click resolver) goes through that one flag.

Contract:

- **Deterministic per spawn** — same inputs (mode, project, satellite
  settings) produce the same string.
- **Cheap** — composed synchronously on every `CreatePane`, no I/O beyond
  already-loaded config.
- **Cap-enforced** — the combined output is capped at `MaxPreambleBytes`
  (16 KiB, `daemon/internal/agent/preamble.go`). Over-cap spawns return a
  clean error rather than a truncated argv.
- **Optional in every dimension** — any layer may be empty; when *all* are
  empty the flag is omitted entirely.

## The three layers

| # | Layer | Origin | Lifetime | Toggle |
|---|-------|--------|----------|--------|
| 1 | **Baseline** | Daemon-emitted, mode-aware (`BaseStationPreamble`) | Until daemon restart | `RECK_DISABLE_BASELINE_PREAMBLE` env var on the daemon |
| 2 | **Global** (Reck Connect prompt) | Satellite config (`reckConnectPrompt`) | Per-user, persists across satellite restarts; sent on every `CreatePane` | Settings textarea + "Reset to defaults"; clear the field to opt out |
| 3 | **Project** | Daemon `projects.toml` (`[[project]]` → `preamble`) | Until `projects.toml` rewrite | Add Project dialog |

The layers compose in that order — baseline, global, project — joined by
`preambleSeparator` (`"\n\n---\n\n"`) between each adjacent non-empty pair.

### 1 — Baseline

Daemon-emitted and mode-aware (`daemon/internal/agent/preamble.go`):

- **`ModeStation`** (`renderStationPreamble`) — the daemon runs on the
  station Mac and the satellite reaches it across the mount / Tailscale
  boundary. Describes the cross-host topology, the satellite mount path,
  which MCP capabilities are not reachable, and the Reck env vars to
  consult.
- **`ModeLocal`** (`renderLocalPreamble`) — the daemon runs on the user's
  laptop alongside the satellite; drops the cross-host caveats.

Setting `RECK_DISABLE_BASELINE_PREAMBLE` makes `BaseStationPreamble` return
`""`, dropping the layer entirely.

### 2 — Global (the new layer)

App-wide text the user edits once in Satellite Settings and that applies to
*every* Claude pane regardless of project — for global hints that would
otherwise be copy-pasted into each project's `CLAUDE.md`.

- Stored in the satellite's Electron config under `reckConnectPrompt`
  (`satellite/renderer/src/config.ts`). It is the single source of truth;
  the daemon keeps no copy.
- Sent on every `CreatePane` as `global_preamble`
  (`client-core/src/api/client.ts`), dropped from the wire when empty so an
  empty string is an explicit opt-out.
- On a fresh install the textarea is prefilled with
  `DEFAULT_RECK_CONNECT_PROMPT` (path conventions + rendering hints). The
  loader returns `null` when never written, which is how the renderer
  distinguishes "fresh install → seed the default" from "user cleared it →
  no global layer".

### 3 — Project

Per-project preamble from `projects.toml`, edited in the Add Project
dialog. Unchanged by this feature.

## Composition

`claudeAdapter.BuildSpawn` (`daemon/internal/agent/claude.go`) collects the
non-empty layers in order and `strings.Join`s them with
`preambleSeparator`, so the separator only ever appears *between* layers
(never leading or trailing). The combined string is length-checked against
`MaxPreambleBytes`; if at least one layer is non-empty it becomes the
`--append-system-prompt` argument, otherwise the flag is omitted.

## The wire path

```
Settings textarea (reckConnectPrompt)
  → resolveEffectiveReckConnectPrompt()        satellite/renderer/src/config.ts
  → createPane({ globalPreamble })             client-core/src/api/client.ts
  → CreatePaneRequest.global_preamble          proto/proto.{ts,go,md}
  → handleCreatePane                           daemon/internal/http/router.go
  → CreatePaneOptions.GlobalPreamble           daemon/internal/pty/manager.go
  → SpawnRequest.GlobalPreamble                daemon/internal/agent/adapter.go
  → BuildSpawn composition                     daemon/internal/agent/claude.go
```

The daemon is stateless with respect to the global layer: if the satellite
restarts mid-pane, the running pane is unaffected; the next `CreatePane`
carries whatever the satellite currently holds. Non-Claude (shell) panes
ignore the field.
