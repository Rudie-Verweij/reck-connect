# Non-obvious Runtime Behaviors

Index of behaviors that surprise newcomers. If something in the daemon acts in a way that isn't obvious from a quick read, it should be documented here.

---

### GET /projects/:id auto-spawns default pane

When a client fetches project detail and the project has no live panes, the daemon automatically spawns one using the project's `default_pane` kind (defaults to `claude`). The newly spawned pane appears in the response.

**Source:** `daemon/internal/http/router.go:handleProjectDetail`

**Why it matters:** Satellite connects, calls `GET /projects/:id`, and a pane appears without an explicit create call. Unexpected in tests; deliberate in the UI flow so the project is always ready to use.

---

### Asymmetric project delete

`DELETE /projects/:id` behaves differently depending on whether the project's `cwd` is under the daemon-managed root (`/Users/reck-connect/projects` by default):

- **Managed root project** (`cwd` is under `ManagedProjectsRoot`): all panes are killed, the daemon waits up to 5 seconds for each child to exit, then `os.RemoveAll(cwd)` deletes the directory.
- **External project** (`cwd` is outside `ManagedProjectsRoot`): the project is unregistered and panes are killed, but the on-disk directory is left alone.

**Source:** `daemon/internal/pty/manager.go:RemoveProject`

**Why it matters:** deleting a managed project is destructive and permanent. Deleting an external project is safe — only the registration is removed.

---

### Shell restore replays stored argv and cwd, not current projects.toml

When a shell pane is restored via `restore_slot_id`, the daemon re-executes the exact `argv` and `cwd` that were captured when the slot was first created. It does NOT re-read the project's current `shell` field from `projects.toml`. If the project's shell configuration has changed since the slot was created, the restored pane uses the old argv.

**Source:** `daemon/internal/pty/manager.go:CreatePaneWith` (restore path via `restoreEntry.ShellArgv`)

**Why it matters:** a restore that seems to "use the wrong shell" is probably using the shell that was configured when the session was started, not what's in the current config.

---

### Quitting the Satellite stops the local daemon (after confirmation)

In local mode, the Satellite spawns `reck-stationd` as a child process. Quitting the Satellite (Cmd-Q or closing the last window) with the local daemon running prompts a confirmation dialog; confirming stops the daemon (SIGTERM, escalating to SIGKILL after 3 s) and terminates all running Claude/shell sessions on it. The station daemon is launchd-managed on a remote host and is unaffected.

**Source:** `satellite/main/main.ts` (`confirmQuitWithLocalDaemon`), `satellite/main/daemon-spawn.ts` (`stopDaemon`, `will-quit` SIGTERM fallback, next-launch orphan sweep)

**Why it matters:** the quit dialog is the only warning before live sessions die. Cancel keeps everything running. Paths that bypass the dialog (force-quit, system shutdown) are backstopped by the orphan sweep on next launch.

---

### projects.toml silent skip

At startup, `config.Load` reads `projects.toml` and silently skips any entry with:

- An invalid or duplicate project ID
- An empty or non-existent `cwd`
- An invalid `default_pane` value (not `claude`, `shell`, or `codex`)
- A shell binary that cannot be resolved to an absolute path

Skipped entries generate warnings (logged as `slog.Warn`) but do not prevent the daemon from starting. There is no UI feedback — the Satellite simply won't show projects that were silently dropped.

**Source:** `daemon/internal/config/config.go:Load`

**Why it matters:** a typo in `projects.toml` causes a project to vanish without any error in the UI. Check daemon logs for warning messages if a project doesn't appear.

---

### Hook installer ownership uses structured exact-match, not substring scan

The hook installer identifies Reck-owned entries by exact canonical command match and a sidecar lookup file (`~/.claude/.reck-hooks.json`), NOT by scanning for the `reck-hook-v1` substring anywhere in the command. A user hook whose command happens to contain "reck-hook-v1" in a comment will NOT be stripped by the installer.

Conversely, if the sidecar is missing and the legacy migration regex doesn't match (e.g. the shim path is in an unusual location), the installer may leave stale entries from a prior Reck install. Running `EnsureInstalled` again after correcting the install path regenerates the sidecar and cleans up stale entries.

An OS-level flock on `~/.claude/.reck-hook.lock` serializes concurrent installs (e.g. two daemons starting simultaneously).

**Source:** `daemon/internal/hooks/install.go:isReckOwnedCommand`, `withInstallLock`

**Why it matters:** concurrent daemon restarts are safe. Understanding the ownership model matters when debugging "why does my hook keep getting stripped" or "why is there a duplicate hook entry".

See [hook-shims.md](./hook-shims.md).

---

### /panes/:id/events is a debug endpoint not in proto.md

`GET /panes/:pane_id/events` returns the in-memory event log for a pane (last 256 events). It is not documented in `proto/proto.md`. It is useful for diagnosing hook wiring — you can confirm that the daemon is receiving lifecycle events and what agent_state they produced.

**Source:** `daemon/internal/http/router.go:handlePaneEvents`

**Why it matters:** when a pane's stoplight never updates from gray, check this endpoint first. If events appear, the state machine is running. If no events appear, the shim is not reaching the daemon (check `RECK_PANE_ID`/`RECK_DAEMON_URL` env vars in the pane).

See [protocol.md](./protocol.md).

---

### handlePaneOutput uses ?bytes=, not ?lines=

`GET /panes/:pane_id/output` accepts `?bytes=N` (default 8192, max 131072). It does **not** accept `?lines=N`.

**Source:** `daemon/internal/http/router.go:handlePaneOutput` (implements `?bytes=`)

**Why it matters:** if you are scripting against the output endpoint, use `?bytes=N` — `?lines=` is silently ignored.

See [protocol.md](./protocol.md).

---

### Preamble composition order and kill switch

When spawning a Claude pane, the daemon composes the system prompt in this order:

1. **Baseline preamble** — station-awareness boilerplate generated by `agent.BaseStationPreamble`. Describes the station hostname, project filesystem layout, satellite mirror path, and which MCPs are/aren't available.
2. **Satellite hint** — short string from `RECK_SATELLITE_HINT` env var (set in launchd plist), embedded inside the baseline.
3. **Project preamble** — the `preamble` field from `projects.toml` for that project (if set), appended after the baseline.

The total combined preamble is capped at 16 KiB and passed to Claude via `--append-system-prompt`.

**Kill switch:** setting `RECK_DISABLE_BASELINE_PREAMBLE=1` at daemon startup causes `BaseStationPreamble` to return `""`. Only the baseline is suppressed; the project preamble (from `projects.toml`) is still applied if present.

**Source:** `daemon/internal/agent/preamble.go:BaseStationPreamble`, `reckDisableBaselineEnv`

**Why it matters:** if Claude panes are receiving unexpected system prompt content, check whether the baseline is being composed. If the preamble is interfering with a test or debug session, set `RECK_DISABLE_BASELINE_PREAMBLE=1` and restart the daemon.

See [../concepts/preamble.md](./preamble.md) for the full preamble system documentation.
