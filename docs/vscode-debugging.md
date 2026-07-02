# Debugging the Satellite in VSCode

Set breakpoints and step line-by-line through the Satellite's **main**
process and **renderer** process from inside VSCode, instead of relying on
`console.log`.

This is also the most reliable way to run the Satellite interactively:
VSCode launches Electron itself (against the compiled `dist/main/main.js`)
and attaches the debugger, so it sidesteps the flaky bundled `pnpm dev`
electron-launch (see [`development.md`](development.md)).

## What's checked in

| File | Purpose |
|---|---|
| `.vscode/launch.json` | Debug configs: "Electron: main", "Electron: renderer (attach)", a compound that runs both, and a Vitest config for the active file. |
| `.vscode/tasks.json` | `vite-and-tsc-w` background task the main launch runs as `preLaunchTask`. |
| `satellite/package.json` → `dev:bg` | The watch loop (`vite` + `tsc -w`) **without** launching Electron — VSCode launches Electron itself so it can attach the debugger. |

Open the repo in VSCode, hit **F5**, you're debugging — nothing to create
by hand.

## Prerequisites

- VSCode (any recent version).
- `pnpm install` already run in `satellite/`.
- `VITE_RECK_STATION_ROOT` and `RECK_STATION_ROOT` must be set. The launch
  config sets them to `/Users/reck-connect/projects`; if your station path
  differs, edit the `env` blocks in `.vscode/launch.json` (or export them
  from your shell rc — VSCode inherits exported variables).

## The 30-second workflow

1. Open the repo in VSCode (workspace root, not `satellite/`).
2. Click the gutter next to a line to set a breakpoint.
3. Open Run and Debug (`Cmd+Shift+D`).
4. Choose **"Electron: main + renderer (debug)"** from the dropdown.
5. Press **F5**.

What happens:

- VSCode runs the `vite-and-tsc-w` background task (vite dev server +
  `tsc -w` for the main process) and waits until `tsc` reports
  "Watching for file changes".
- VSCode launches Electron from `satellite/node_modules/.bin/electron`
  with `--remote-debugging-port=9223` and the compiled `dist/main/main.js`;
  the Node debugger attaches to the main process.
- The "Electron: renderer (attach)" config attaches a Chrome debugger to
  port 9223 — that's how renderer-side breakpoints work.
- Inspect variables in the side panel; F10 (step over), F11 (step into),
  F5 (continue), Shift+F11 (step out).

## Renderer vs. main — which debugger catches a breakpoint

- Files under `satellite/main/` and `satellite/preload/` run in Electron's
  **main process** (Node) — caught by **"Electron: main"**.
- Files under `satellite/renderer/src/` run in the **renderer** (Chromium)
  — caught by **"Electron: renderer (attach)"** via the remote-debugging
  port.

Good first breakpoint targets: the `file:openInViewer` IPC handler in
`satellite/main/file-viewer.ts` (which branch does main take for a
Cmd+click?), the connection poll loop in
`satellite/renderer/src/daemon/connection.ts`, or boot wiring in
`satellite/renderer/src/boot.ts`.

If a renderer breakpoint shows "set but not yet bound", check that the
main window has actually launched, that the path matches what Vite serves
(`webRoot` points at `satellite/renderer`), and that sourcemaps aren't
stale.

## Conditional breakpoints and logpoints

Right-click a breakpoint → "Edit Breakpoint" to add a condition (e.g.
`sourceHost === undefined`), or "Add Logpoint" to print a message like
`"path=" + arg.path` without stopping — no extra `console.log` line and no
rebuild.

## Debugging Vitest unit tests

The launch config includes **"Vitest: current file"** — open a `*.test.ts`
file, hit F5, choose that config, and breakpoints in the test (and the code
it imports) fire. Useful when a failing test needs more than `console.log`.

## Stopping cleanly

- Stopping the debug session detaches the debugger; VSCode kills the
  `preLaunchTask` group, so the `vite` + `tsc -w` watchers terminate too.
- If a stale watcher or Electron is still alive (port 5173 in use, or an
  Electron window lingering):

  ```bash
  lsof -ti:5173 | xargs -r kill -9
  lsof -ti:9223 | xargs -r kill -9
  pkill -f "electron dist/main/main.js"
  ```

## Troubleshooting

### "Could not find any debuggable target" at localhost:9223

Most common cause: a previous `pnpm dev`/`dev:bg` is still alive holding
port 5173, so the new launch's `vite-and-tsc-w` task can't bind it → main
never starts → renderer-attach finds nothing. Kill the stale processes
(above) and retry F5. The renderer attach has `restart: true` so it keeps
polling while Electron starts; that only helps once main is actually up.

### Other notes

- The first launch after a clean `pnpm install` takes ~10 s extra while
  `tsc -w` does its initial compile — VSCode shows "Waiting for
  preLaunchTask…", which is normal.
- Hot-reload on main edits does **not** happen during a debug session — the
  launch runs plain `electron`. Stop the debugger, edit, restart.
- `stopAll: false` on the compound is intentional: if the renderer attach
  errors out, main keeps running and you can re-attach the renderer config
  from the Run and Debug panel.

## See also

- [`development.md`](development.md) — build commands, test patterns, key
  file locations.
- [`architecture.md`](architecture.md) and [`internals.md`](internals.md) —
  what the pieces are, helpful for picking breakpoint targets.
