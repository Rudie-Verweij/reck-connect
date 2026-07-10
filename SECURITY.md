# Security

## Reporting a vulnerability

Email **rnv@verwey.eu** with the subject line `reck-connect security`. Please report security issues privately by email rather than opening a public issue.

A useful report includes:

- The version or commit you reproduced on (e.g. tag `v0.1.0`).
- The setup: station OS / Mac model, satellite OS, Tailscale on or off, hybrid mode or station-only.
- Reproduction steps. Commands and expected vs. actual.
- The blast radius as you understand it: local-only, on-tailnet, or wider.

Response is best-effort. You will get an acknowledgement within a week.

## What is in scope

- The Go daemon (`daemon/`), specifically: HTTP / WebSocket auth, PTY isolation, hook shim auth, mount path validation.
- The Electron satellite (`satellite/`): IPC surface (preload), bootstrap import path, token storage (safeStorage), URL allow-listing.
- The install scripts (`ops/`): privilege escalation paths, public-key handling, file-permission hygiene.

## What is out of scope

- Tailscale itself. Report tailnet-layer issues to Tailscale.
- Claude Code itself. Report Claude Code issues to Anthropic.
- Issues that require the attacker to already be the local user on the station.

## Disclosure

Once a fix is in `main`, the report is yours to disclose. Coordinated timing on request.
