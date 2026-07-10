# Projects

A project is a named directory on the station that the daemon manages panes for. Projects are the top-level organizational unit in Reck Connect: every pane belongs to exactly one project.

Source: `daemon/internal/config/config.go`, `daemon/internal/pty/manager.go`, `daemon/internal/http/router.go`.

## Definition

A project entry in `projects.toml` maps to `config.Project`:

```go
type Project struct {
    ID          string   // URL-safe slug; required
    Name        string   // display label
    Cwd         string   // absolute path to the project root on the station
    DefaultPane string   // "claude" | "shell" | "codex"; defaults to "claude"
    Shell       []string // argv for shell panes; defaults to [$SHELL, "-l"]
    Preamble    string   // optional; injected as --append-system-prompt on claude panes
    DisplayName string   // user-given label override; empty = use Name
}
```

## `projects.toml` Location

Default path (from `daemon/cmd/reck-stationd/main.go`):

```
~/.config/reck/projects.toml
```

Override with the `--config` flag at daemon startup. The launchd plist template (`ops/eu.verwey.reck-stationd.plist.tmpl`) passes `--config /Users/reck-connect/.config/reck/projects.toml` explicitly.

## Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Yes | URL-safe slug. Rules: `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}` (max 64 chars). Must be unique. |
| `name` | string | Yes | Human-readable display label. |
| `cwd` | string | Yes | Absolute path. Must be an existing directory at load time. |
| `default_pane` | string | No | `"claude"` (default) \| `"shell"` \| `"codex"`. |
| `shell` | string array | No | Shell argv for shell panes (e.g. `["/bin/zsh", "-l"]`). Defaults to `[$SHELL, "-l"]` resolved at daemon startup. `shell[0]` must be an absolute path. |
| `preamble` | string | No | Text injected as `--append-system-prompt` on every Claude pane in this project. Combined with the daemon baseline. |
| `display_name` | string | No | Written by the daemon on rename. Overrides `name` in the UI. |

### Example

See `ops/examples/projects.toml` for the full reference file.

```toml
[[project]]
id    = "reck-connect"
name  = "Reck Connect"
cwd   = "/Users/reck-connect/claude-code/reck-connect"
default_pane = "claude"

[[project]]
id    = "my-app"
name  = "My App"
cwd   = "/Users/reck-connect/projects/my-app"
preamble = "Always run tests before committing."
```

## Project ID Rules

The ID is a URL-safe slug:
- Pattern: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` — must start with alphanumeric, then alphanumeric/underscore/hyphen, total 1–64 bytes.
- Must be unique across all projects in the registry.
- The daemon's `config.ValidateProjectID` is the single source of truth; creation and load both call it so an ID accepted at runtime can never be silently dropped on restart.

When adding a project via the UI (POST `/projects`) without specifying an ID, the daemon derives one from `name` by slugifying: lowercase, non-alphanumeric runs replaced with `-`, trimmed, collision-suffixed with `-2`, `-3`, … as needed.

## Silent Skip of Invalid Entries

`config.Load` skips (with a warning log, not a fatal error) any project entry that fails validation. Reasons a project is silently dropped:

- `id` is empty, too long, or contains invalid characters.
- `id` is a duplicate.
- `cwd` is empty.
- `cwd` does not exist or is not a directory at load time.
- `default_pane` is not `claude`, `shell`, or `codex`.
- `shell[0]` is not an absolute path or cannot be resolved via `exec.LookPath`.

There is no UI feedback when an entry is dropped. Check daemon logs (`/var/log/reck-stationd.log`) for `config warning` entries.

This is a critical operational gotcha. See [`concepts/behaviors.md`](./behaviors.md) for a summary.

## Adding a Project

Two paths:

1. **UI dialog** in the Satellite: triggers `POST /projects` with `AddProjectRequest`. If `cwd` is empty, the daemon creates a new directory at `ManagedProjectsRoot/<slug>`.

2. **Edit `projects.toml` manually**, then restart the daemon:
   ```bash
   launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd
   ```

The daemon re-reads `projects.toml` only at startup. In-process edits to the file (while the daemon is running) are not picked up until kickstart.

## Auto-Spawn on `GET /projects/:id`

When the Satellite fetches `GET /projects/:id` and the project exists but has no live panes, the handler auto-spawns one pane using the project's `default_pane` kind.

Implementation in `daemon/internal/http/router.go` `handleProjectDetail`:

```go
if len(s.Manager.PanesInProject(id)) == 0 && s.Manager.ProjectExists(id) {
    kind := s.Manager.DefaultPaneKind(id)
    s.Manager.CreatePane(id, kind, 120, 40)
}
```

This happens on every `GET /projects/:id` call when no panes are running, including after daemon restart. See [`concepts/behaviors.md`](./behaviors.md).

## Asymmetric Delete

`DELETE /projects/:id` (`Manager.RemoveProject`) behavior depends on whether the project's `cwd` is under `ManagedProjectsRoot` (`/Users/reck-connect/projects`):

- **Under `ManagedProjectsRoot`**: after killing all child panes and waiting up to 5 seconds for them to exit, the daemon calls `os.RemoveAll(cwd)`. The directory is deleted.
- **Outside `ManagedProjectsRoot`**: only unregistered from the daemon. The on-disk directory is left alone.

This lets `POST /projects` with an empty `cwd` create a fully daemon-managed project (create-on-add, delete-on-remove), while projects registered with an explicit `cwd` outside the managed root are never deleted by the daemon.

See `daemon/internal/pty/manager.go` `RemoveProject` for the transactional ordering (persist disk → mutate memory → kill panes → wait → delete).

Cross-link: [`concepts/behaviors.md`](./behaviors.md).

## `ManagedProjectsRoot` Is a `var`

```go
// daemon/internal/config/config.go
var ManagedProjectsRoot = "/Users/reck-connect/projects"
```

Declared as `var`, not `const`, so tests can override it to a temp directory. Do not "fix" this by making it `const` — it will break the test suite.
