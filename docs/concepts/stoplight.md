# Stoplight

Each pane has a stoplight color and an agent state. These are two separate signals that are sometimes confused. This page keeps them distinct.

## Two signals, one UI element

| Signal | Type | Source | Applies to |
|--------|------|--------|-----------|
| `stoplight` | `"gray" \| "green" \| "orange" \| "red"` | PTY activity heuristic OR agent state (depends on pane kind) | All panes |
| `agent_state` | `"" \| "working" \| "idle" \| "attention"` | Claude Code lifecycle hook events | Claude panes only |

For Claude panes, `agent_state` is the **authoritative source** for the stoplight. The PTY activity heuristic is only used for shell and other non-hooked panes.

## Stoplight colors

### For Claude panes (agent-hooked)

The stoplight is derived directly from `agent_state`:

| agent_state | stoplight | Meaning |
|-------------|-----------|---------|
| `""` (unknown) | `gray` | No hook event received yet |
| `working` | `orange` | Claude is actively running (prompt submitted, tool in use) |
| `idle` | `green` | Claude returned a final answer (Stop event received) |
| `attention` | `red` | Waiting for human input (permission request, elicitation) |

Exit conditions override all of the above (regardless of pane kind):

- Exited with non-zero code → `red` (crash/error)
- Exited with zero code → `green` (task finished)

### For shell / unhooked panes (byte-flow heuristic)

| Condition | stoplight |
|-----------|-----------|
| No output ever produced | `gray` |
| OSC 777 approval pending (see below) | `red` |
| Output bytes received within last 3 seconds | `orange` |
| No output for ≥ 3 seconds | `green` |

The idle threshold is **3 seconds** (not 5s or 30s as earlier documentation suggested). Source: `daemon/internal/stoplight/stoplight.go:IdleThreshold = 3 * time.Second`.

The stoplight runner ticks at 1 Hz (`TickInterval = 1 * time.Second`).

## agent_state transitions (Claude panes)

Driven by lifecycle hook events forwarded by the shim. State machine in `daemon/internal/pty/pane.go:RecordEvent`:

| Hook event | New agent_state | Notes |
|------------|----------------|-------|
| `user_prompt` | `working` | |
| `pre_tool` | `working` | |
| `post_tool` | `working` | |
| `post_tool_failure` (is_interrupt=true) | `""` (unknown/gray) | User hit Escape during tool |
| `post_tool_failure` (other) | `working` | Claude likely retrying |
| `user_interrupt` | `""` (unknown/gray) | User hit Escape between tools (synthesized by WS handler on lone ESC keystroke) |
| `permission_request` | `attention` | |
| `permission_denied` | `attention` | |
| `elicitation` | `attention` | MCP needs input |
| `stop` | `idle` | Claude returned final answer |
| `stop_failure` | `idle` | |
| `notification` | no change | Too noisy to be authoritative |
| `session_start`, `session_end` | no change | Log only |

**Interrupt → gray (not green):** An abandoned turn is neither completed nor attention-worthy. `idle`/green is reserved for natural `Stop` events where Claude returned an answer.

**Notification does not set attention:** Claude Code fires `notification` both for real permission prompts AND for "idle 60+ seconds" pings. Using it to drive attention would flip a green pane red after every Stop. A future OSC 777 subtype or dedicated permission hook is needed for reliable notification-based attention.

## Red triggers for shell panes

Shell panes go `red` on an **OSC 777** sequence (`\x1b]777;notify;Claude Code;...\x07`). This is Claude Code's "needs approval" notification rendered via the terminal. The daemon watches for this sequence in the PTY output stream.

Source: `daemon/internal/pty/pane.go:osc777Re`.

## Project-level stoplight

Each project's stoplight in `/projects` list responses is the **maximum severity** across all its panes. Severity order: `red > orange > green > gray`. Zero panes → `gray`.

Source: `proto/proto.md` "Stoplight semantics".

## Persistence

Stoplight and agent_state are **in-memory only**. They are not written to disk and are lost on daemon restart. The Satellite will see all panes start as `gray` on reconnect and their states will be re-derived from PTY activity / the next hook event.
