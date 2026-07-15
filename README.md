<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pitch/banner-dark.svg">
  <img src="docs/assets/pitch/banner-light.svg" alt="Reck Connect: a satellite / station workbench for your coding agent" width="100%">
</picture>

<br>

<sub><i>Two machines. Connected as one.</i></sub>

<br><br>

<p>
  <a href="INSTALL.md"><img alt="Install" src="https://img.shields.io/badge/install-runbook-d4683a?style=flat-square&labelColor=141413"></a>
  <a href="docs/architecture.md"><img alt="Architecture" src="https://img.shields.io/badge/architecture-station%20%2F%20satellite-141413?style=flat-square&labelColor=f7f4ed&color=141413"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%2014%2B-7a9c6d?style=flat-square&labelColor=141413">
  <img alt="Status" src="https://img.shields.io/badge/status-public%20beta-7a9c6d?style=flat-square&labelColor=141413">
  <img alt="License" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0-8a877d?style=flat-square&labelColor=141413">
</p>

</div>

---

<sub>// 01 &nbsp;·&nbsp; the problem</sub>

## A laptop is a fragile place to run an agent.

You found Claude Code, and Codex. You moved the work into the terminal. It is faster than you expected. The agent is good company. So you give it more, three things at once, then five.

Then the lid closes on the train and the build dies. The cooling fan starts pleading. Then you alt-tab between six terminal windows trying to remember which agent is waiting for you and which one quietly errored out forty minutes ago.

The terminal is the right shape. The laptop is the wrong place.

---

<sub>// 02 &nbsp;·&nbsp; the idea</sub>

## Two machines. Connected as one.

The **station** is your always-on Mac at home or in the office. A Studio, a Mini, a spare MacBook on a shelf. It runs the daemon, owns the terminals, holds the code, hosts the agents. It does not move.

The **satellite** is a thin desktop app on your laptop. It connects over your tailnet and renders every pane live. It carries no state. Close it on a train. Open it in a hotel. Open it on a different laptop entirely. Every project is exactly where you left it because it never left the station.

For the user, it feels exactly like normal. Just nicely organised. And if an agent needs your attention, it notifies you via a simple stoplight system.

---

<sub>// 03 &nbsp;·&nbsp; what it looks like</sub>

## Every project. One glance.

<p align="center">
  <img src="docs/assets/pitch/satellite-ui.gif" alt="The Reck Satellite: a rail of projects on the left, multiple Claude Code panes tiled across the workspace, with a New Pane modal asking whether to host on the Station or Local" width="100%">
</p>

A **rail** of projects on the left. Each project a stack of **panes**: Claude Code sessions, shells, codex CLIs, anything that wants a terminal. Each pane carries a **stoplight**: green when the agent is done, orange when it's running, red when it is asking you something.

---

<sub>// 04 &nbsp;·&nbsp; features</sub>

## Features, at a glance.

- **Private connection over Tailscale.** Code never leaves the station. No public endpoint, no middleman.
- **Automatic folder sync.** Station files appear on the satellite as if they were local. No `rsync`, no `scp`.
- **Crash-proof.** Close the laptop and nothing stops. Reopen it and every pane is right where it was.
- **Stoplight status.** Every pane signals green (done), orange (running), or red (waiting on you).
- **Voice dictation.** Talk to your agent from the satellite — on-device Whisper or Deepgram — with live text typed straight into the pane.
- **Text-to-speech.** The satellite reads agent replies aloud and highlights the text as it goes.
- **Drag & drop files.** Drop images, PDFs, and other allowlisted files onto a pane; they reach the agent via a prompt template you control.
- **Clickable links.** URLs and file paths are linkified in terminals, transcripts, and rendered docs, with hover tooltips telling them apart.
- **Token-usage telemetry.** The station records per-turn token and quota usage locally and serves it over `/usage` routes.
- **Collapsible project rail.** Squeeze-drag the rail into a mini rail when you want the pixels back.

---

<sub>// 05 &nbsp;·&nbsp; install</sub>

## Install

Open Claude Code or Codex in any directory and tell it:

> install Reck Connect from github

It clones the repo, reads [`INSTALL.md`](INSTALL.md), and drives both halves of the install end to end. Satellite first, then the station over Tailscale SSH. Prefer to read the runbook by hand? It is right there.

---

<sub>// 06 &nbsp;·&nbsp; under the hood</sub>

## Architecture, for the curious

| Component | Path | Role |
|---|---|---|
| **`reck-stationd`** | [`daemon/`](daemon/) | Go HTTP + WebSocket server. Spawns and owns every PTY pane. Installs Claude Code lifecycle hook shims. |
| **Reck Satellite** | [`satellite/`](satellite/) | Electron desktop app. Renders panes via xterm.js. |
| **client-core** | [`client-core/`](client-core/) | Platform-neutral browser plumbing shared by the satellite renderer. |
| **proto** | [`proto/`](proto/) | Hand-maintained TypeScript and Go wire types. |
| **ops** | [`ops/`](ops/) | Station and satellite install scripts, LaunchAgent plists, mount watchdog. |

Tech stack: Go + [`creack/pty`](https://github.com/creack/pty) + [`go-chi/chi`](https://github.com/go-chi/chi) on the station. Electron + TypeScript + xterm.js + vitest on the satellite. Tailscale on the wire, FUSE-T plus sshfs for project mounts, `rsync` for project copies, launchd to keep it all alive.

Full walk-through in [`docs/architecture.md`](docs/architecture.md).

---

<sub>// 07 &nbsp;·&nbsp; license</sub>

## License and contributing

Source under **[PolyForm Noncommercial 1.0.0](LICENSE)**. Free to read, run, and modify for noncommercial purposes. Commercial use is not granted.

Issues and pull requests are welcome. Before filing, check [`INSTALL.md`](INSTALL.md) — it lists the recovery paths for most setup snags. This is a side project maintained on a best-effort basis, so triage may be slow. Security disclosures go through [`SECURITY.md`](SECURITY.md), not the public issue tracker.

---

<sub>// 08 &nbsp;·&nbsp; docs</sub>

## Docs

- [`docs/overview.md`](docs/overview.md) · what Reck Connect is and isn't
- [`docs/architecture.md`](docs/architecture.md) · components, process model, data flow
- [`docs/getting-started.md`](docs/getting-started.md) · install station and satellite, add a project, open a pane
- [`docs/concepts/`](docs/concepts/) · projects, panes, modes, behaviors, stoplight
- [`docs/concepts/linux-station.md`](docs/concepts/linux-station.md) · run the station on Linux / Raspberry Pi
- [`docs/operations.md`](docs/operations.md) · running the station day to day
- [`docs/troubleshooting.md`](docs/troubleshooting.md) · when things go sideways
- [`docs/internals.md`](docs/internals.md) · daemon internals, image-paste design

---

<div align="center">

<sub><i>Reck Connect is a <a href="https://reckon.works">Reckon</a> project. We help teams reckon with AI.</i></sub>

</div>
