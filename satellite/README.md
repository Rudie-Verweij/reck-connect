# Reck Connect Satellite

by **Reckon Labs**

Electron desktop app — the laptop-side control surface for Reck Connect.
Pairs with the `reck-stationd` daemon.

## Build

```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest
pnpm build          # tsc + vite build → dist/
pnpm dist           # electron-builder → release/mac-arm64/Reck Connect Satellite.app
```

## Run from source (dev mode)

`pnpm dev` starts Vite + Electron against the live source. Two env vars are
**required in the shell that runs the command** — a packaged install gets
them baked in at build time and injected by the launcher, so this only bites
when running from source:

```bash
# Both are the station's projects root (the same value the station uses),
# e.g. /Users/reck-connect/projects — see INSTALL.md Stage 5.
export RECK_STATION_ROOT=/Users/reck-connect/projects       # read by the Electron main process at launch
export VITE_RECK_STATION_ROOT=/Users/reck-connect/projects  # inlined by Vite when the dev server starts

pnpm dev
```

Without `RECK_STATION_ROOT` the main process crashes at load
(`Error: RECK_STATION_ROOT is required`); without `VITE_RECK_STATION_ROOT`
the renderer fails. Putting them in `~/.zshrc` works, but only for
terminals opened **after** the edit. Note that `~/.config/reck/satellite.env`
is only sourced by the *packaging* wrapper (`ops/build-app.sh`) — nothing
reads it at runtime or in `pnpm dev`, so having it is not enough; the
variables must be in the shell's environment (you can `source` it yourself:
`set -a; . ~/.config/reck/satellite.env; set +a`).

Also quit any installed `/Applications/Reck Connect Satellite.app` before
running dev: two satellites fight over the local `reck-stationd` — the dev
instance restarts the daemon with a fresh auth token and the packaged app
then spams `auth rejected` polls against it.

## First launch

1. Drag `Reck Connect Satellite.app` to `/Applications`.
2. Right-click → **Open** → acknowledge Gatekeeper warning (locally compiled, ad-hoc signed).
3. The Claude-driven install (`INSTALL.md` Stage 4) writes a `bootstrap.json` so the app picks up the daemon URL + bearer token automatically on first launch. If you installed manually, paste the URL + token into the first-launch dialog.

## macOS Dictation (voice-to-text)

The app is built with the `audio-input` entitlement + an `NSMicrophoneUsageDescription` so macOS Dictation (fn-fn / globe key) works in terminal panes. First time you trigger Dictation, macOS prompts for microphone access — grant it. The grant is keyed to the app's code-signature hash, so a fresh `pnpm dist` rebuild = re-grant once. (Stable signing identity would avoid that; ad-hoc is fine for alpha.)

## Shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` | New pane at the active leaf (prompts for Claude / Shell) |
| `⌘D` | Split active pane right (vertical) |
| `⌘⇧D` | Split active pane down (horizontal) |
| `⌘W` | Close active pane |
| `⌥⌘←` / `⌥⌘→` / `⌥⌘↑` / `⌥⌘↓` | Focus pane directionally |
| `⌘B` | Toggle project rail |
| `⌘K` | Clear active terminal |
| `⌘1` – `⌘8` | Jump to project at that rail position |

## UI

- **Rail** (left): minimal cards — project name + single stoplight dot. Nothing else.
- **Pane area** (right): tmux-style nested splits, each leaf an xterm.js terminal.
- **Focused pane**: subtle blue outline.
- **Split divider**: 1px line; hover lightens it; drag to resize.

## Config location

`~/Library/Application Support/Reck Connect Satellite/config/settings.json`
(encrypted via `safeStorage`).
