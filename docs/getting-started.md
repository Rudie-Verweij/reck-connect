# Getting Started

This walkthrough takes you from zero to your first Claude pane open in the satellite.

## Prerequisites

- A macOS machine to use as the **station** (Mac Studio or any always-on Mac). macOS 14 or later recommended.
- A macOS **laptop** to run the satellite app.
- [Homebrew](https://brew.sh) installed on both machines.
- [Tailscale](https://tailscale.com) installed and on the same tailnet on both machines (required for Station mode; not needed for Local mode on a single machine).
- Go toolchain on the station (for building the daemon).
- Node.js + pnpm on the laptop (for building the satellite).

---

## 1. Install the station daemon

On the **station**, as the `reck-connect` user:

```bash
cd /Users/reck-connect/claude-code/reck-connect/ops
./install-station.sh
```

This single command builds `reck-stationd`, installs the binary to `/usr/local/bin/`, drops a launchd plist, generates a random `DAEMON_TOKEN` stored at `/etc/reck-stationd/token` (mode 0600), bootstraps the service, and prints the `Station URL` + `Daemon Token` you will paste into the satellite.

For the full manual — including the dedicated `reck-connect` user creation, FileVault caveats, and binary-only redeploy workflow — see [`../ops/README.md`](../ops/README.md).

---

## 2. Install the satellite on your laptop

### Local mode (single machine, no Tailscale needed)

Local mode is the simplest way to start. The satellite spawns `reck-stationd` as a child process bound to `127.0.0.1:7315`. No bearer token is required.

1. Build the daemon binary and install it where the satellite can find it:

   ```bash
   cd .
   go build -o ~/.local/bin/reck-stationd ./daemon/cmd/reck-stationd
   ```

   Alternatively run `ops/install-local.sh` if it exists, or install to `/opt/homebrew/bin/reck-stationd`.

   The satellite searches these paths in order (source: `satellite/main/daemon-spawn.ts:candidatePaths`):
   - `$RECK_STATIONDCMD` (env override)
   - `~/.local/bin/reck-stationd`
   - `/opt/homebrew/bin/reck-stationd`
   - `/usr/local/bin/reck-stationd`
   - `~/go/bin/reck-stationd`

2. Build the satellite app:

   ```bash
   cd satellite && pnpm install && pnpm dist
   ```

   The output is `satellite/release/mac-arm64/Reck Connect Satellite.app`.

   > Note: `pnpm dev` is broken — always use `pnpm dist` and launch the built `.app`. See `CLAUDE.md`.

3. Launch `Reck Connect Satellite.app`. On first launch you'll see the welcome flow — leave **Local** enabled (it's the default), and add a **Station** if you have one. You can run with just Local on a single Mac.

---

## 3. Add a station (remote daemon over Tailscale)

When you have a dedicated station Mac running `reck-stationd`:

1. Open the satellite.
2. Open **File → Preferences…** and enable the **Station** block.
3. Enter the station URL printed by `install-station.sh` (format: `http://<tailnet-hostname>:7315`).
4. Paste the `Daemon Token` from the same output.

The satellite runs in hybrid mode — both local and station daemons are available at the same time, and each project's panes run on whichever host owns it.

To update the token later: **File → Update Station Token…**.

To rotate the token on the station: edit `~/.config/reck/token`, then:

```bash
launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd
```

---

## 4. Add a project

Projects are registered in `~/.config/reck/projects.toml` on the station. You can add one in two ways:

**Via the UI**: press `Cmd+N` (or **File → Add Project…**) in the satellite. The dialog copies the folder to the station's managed root (`/Users/reck-connect/projects/`) via rsync and registers it.

**Via `projects.toml`** directly on the station:

```bash
$EDITOR ~/.config/reck/projects.toml
```

Each entry needs at minimum an `id`, `name`, and `cwd`. Example:

```toml
[[project]]
id   = "my-project"
name = "My Project"
cwd  = "/Users/reck-connect/projects/my-project"
```

After editing `projects.toml` only (no plist changes), restart the daemon:

```bash
launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd
```

---

## 5. Mount the station's projects on your laptop (optional)

`ops/install-satellite.sh` installs FUSE-T + sshfs and registers a LaunchAgent (`eu.verwey.reck-mount`) that keeps `~/reck/projects/` mounted from the station's `/Users/reck-connect/projects/` via Tailscale. This lets you browse files in Finder and run local tools against station code.

See [`../ops/README.md`](../ops/README.md) §4 for the full steps.

---

## 6. Open a pane

Click a project in the left rail. The satellite requests a pane from the daemon:

- `GET /projects/:id` — if the project has no live panes, the daemon auto-creates one using `default_pane` from `projects.toml` (defaults to `claude`).
- The terminal renders via xterm.js over a WebSocket at `ws://<station>:7315/ws/<project_id>/<pane_id>`.

To create additional panes: `Cmd+T` (new pane), `Cmd+D` (split right), `Cmd+Shift+D` (split down). To close: `Cmd+W`.

Pane kinds: `claude` (Claude Code), `shell` (login shell), `codex` (Codex CLI).

---

## Where next

- [concepts/panes.md](./concepts/panes.md) — pane lifecycle, kinds, stoplight
- [concepts/modes.md](./concepts/modes.md) — Local vs Station mode in detail
- [concepts/projects.md](./concepts/projects.md) — projects.toml structure and managed root
- [architecture.md](./architecture.md) — full system architecture
