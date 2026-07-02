# Building & installing the Reck Connect Satellite (macOS)

The **Satellite** is the Mac desktop app that connects to your **station** (a Pi
or a Mac). This builds it from source and installs it. It pairs with
[`INSTALL-LINUX.md`](INSTALL-LINUX.md) (the station side).

> The station must already be running and reachable (see `INSTALL-LINUX.md` for a
> Pi station). You'll need its **host**, **port** (`7315`), and **token**.

---

## 0. What you need (on the Mac)

- macOS on Apple Silicon.
- **Node 20+** and **pnpm 11**. If you don't have pnpm: `corepack enable` (ships
  with Node), or `npm install -g pnpm`.
- Your **station's projects-root path** — this gets baked into the app so GUI
  launches know where the station keeps projects. It must match the station:
  - Pi / Linux station → `/home/<user>/projects` (e.g. `/home/strijders/projects`)
  - macOS station → `/Users/reck-connect/projects`

---

## 1. Get the code

```bash
git clone https://github.com/mehdigreefhorst/reck-connect.git ~/src/reck-connect
cd ~/src/reck-connect/satellite
```

> **While this is still a PR (not merged to `main`):**
> `git -C ~/src/reck-connect checkout feat/daemon-linux-platform`

---

## 2. Build the app

The build bakes `RECK_STATION_ROOT` into the packaged app (via the `afterPack`
hook) and inlines `VITE_RECK_STATION_ROOT` into the renderer, so **export both
first**, set to your station's projects root:

```bash
export RECK_STATION_ROOT=/home/<user>/projects
export VITE_RECK_STATION_ROOT=/home/<user>/projects

pnpm install     # first time only; runs native builds (electron/esbuild/sharp)
pnpm package     # builds the .app (no DMG) → release/mac-arm64/
```

`pnpm package` is the fast, `.app`-only path. Use `pnpm dist` instead if you also
want a `.dmg` / `.zip` installer.

Confirm the station root got baked in:

```bash
/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:RECK_STATION_ROOT' \
  "release/mac-arm64/Reck Connect Satellite.app/Contents/Info.plist"
# → should print your station root, e.g. /home/<user>/projects
```

---

## 3. Install it

macOS Launch Services routes by bundle id, so a stale copy in `/Applications`
masks a fresh build — replace it explicitly:

```bash
pkill -9 -f "Reck Connect Satellite" 2>/dev/null || true
rm -rf "/Applications/Reck Connect Satellite.app"
cp -R "release/mac-arm64/Reck Connect Satellite.app" "/Applications/"
open "/Applications/Reck Connect Satellite.app"
```

---

## 4. Connect to your station

In the app, **Add station** and enter:

- **Host** — the station's tailnet name or IP.
- **Port** — `7315`.
- **Token** — the contents of `~/.config/reck/token` on the station.

Your panes should appear. Open a Claude pane to confirm it spawns end-to-end.

---

## Dev mode (no install, hot reload)

For iterating without touching `/Applications`:

```bash
export RECK_STATION_ROOT=/home/<user>/projects
export VITE_RECK_STATION_ROOT=/home/<user>/projects
pnpm dev
```

This runs a separate dev build with live reload; your installed app is untouched.

## Updating

```bash
cd ~/src/reck-connect && git pull
cd satellite && pnpm install && pnpm package
# then re-run the install step (3)
```

## Notes

- **Ad-hoc signed.** The app is ad-hoc signed (no Apple Developer ID needed).
  TCC grants (microphone for Dictation, Accessibility) persist for a given
  installed build; a rebuild may re-prompt.
- **Feature parity:** until the satellite feature set (file-viewer / Cmd+click
  linkifier, suffix-search, TTS) is ported, this is the base build — it connects
  and runs panes, but those extras aren't present yet.
