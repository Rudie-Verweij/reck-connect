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

> **Note:** `pnpm dev` is currently broken; the dev-mode wiring relies on a path that doesn't exist after the renderer split. Use `pnpm dist` for any UI testing — it produces a real `.app` bundle that's fast to rebuild and behaves identically to the shipped artefact. `pnpm typecheck` / `pnpm test` / `pnpm build` are all fine for static verification.

## First launch

1. Drag `Reck Connect Satellite.app` to `/Applications`.
2. Right-click → **Open** → acknowledge Gatekeeper warning (locally compiled, unsigned).
3. The Claude-driven install (`INSTALL.md` Stage 4) writes a `bootstrap.json` so the app picks up the daemon URL + bearer token automatically on first launch. If you installed manually, paste the URL + token into the first-launch dialog.

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
