# Learnings

Append per feature/phase: **What we learned**, **Surprises**, **Decisions**.

---

## Codex preamble via `developer_instructions` (follow-up to #33, 2026-07-01)

Undeferred the #32 preamble for codex after web-researching the actual `codex` CLI.

**What we learned**
- The `codex` CLI has **no** `--append-system-prompt` flag (feature request openai/codex#11117 was closed unimplemented), but its generic `-c`/`--config` override sets **`developer_instructions`**, documented in `codex-rs/config/src/config_toml.rs` as *"inserted as a `developer` role message."* It's per-launch, non-invasive (no repo write / no `AGENTS.md` clobber), append-not-replace, and works for the interactive TUI — the clean analog to Claude's `--append-system-prompt`.
- The per-project preamble the user edits in the UI (project dialog / right-click) persists as `Project.Preamble` — the exact field the adapter injects, so codex honours it with zero extra plumbing.

**Surprises**
- The alternatives are all worse: `model_instructions_file` **replaces** the base prompt (officially discouraged), project `AGENTS.md` mutates the repo, `CODEX_HOME`/`--profile` are global user state, and there's **no** instruction-carrying env var. So the single `-c developer_instructions=` override is *the* mechanism.
- `argv_redact.go` didn't cover `-c key=value` (its equals-branch requires a `--` prefix), so the multi-KiB preamble would have flooded logs — extended it.

**Decisions**
- Inject **global + project** layers only; **exclude** the daemon baseline (`BaseStationPreamble`) because it's Claude-shaped ("Claude Code pane" + Claude hooks). Revisit if the baseline is generalised.
- Shipped as a **separate PR stacked on the first-class-codex branch**, grounded in the primary-source config key. **Not yet empirically verified** against a real codex binary (none installed on the Mac or Pi) — a one-line `codex -c developer_instructions=TESTMARKER` smoke-test on the station should confirm the key before relying on it in production.

## Codex first-class pane (issue #33, 2026-07-01)

Made the `codex` pane kind first-class: creatable from the New-pane dialog,
correctly labelled, and restart-durable — deferring only what depends on the
external `codex` CLI's (unverifiable) capabilities.

**What we learned**
- The audit of the 10 merged reck-connect PRs found **none** break a codex
  pane — every merged feature is agent-agnostic terminal/UI/connection
  machinery. The real gap was foundational: `codex` was a half-wired kind.
- The daemon spawn stack was already codex-complete (adapter registered,
  binary resolved, `default_pane="codex"` accepted). The *only* hard blocker
  to interactive create was a single allowlist line in `router.go`.
- **Shell is the template.** A shell pane — like codex — has no Claude
  session yet is creatable, labelled, and restart-durable via a disk-backed
  `SlotID` (`sessions.go` is file-backed; the renderer rekeys the saved tab
  by `slot_id`). Codex reuses the same `slot_id` field, so durability needed
  **no new proto field** — just codex arms alongside the existing shell arms.

**Surprises**
- There was **no** per-station capability signal at all (`/health` carried
  only status/version/uptime; `SupportedKinds()` lists codex unconditionally
  regardless of whether a binary exists). Advertising `codex_available` was
  the bulk of the "create" work — one boolean threaded proto → daemon →
  per-host renderer store → dialog.
- `defaultTabTitle` had only a `claude`/else arm, so every codex pane
  rendered as **"Shell"** in the tab bar and close dialogs.
- The codex adapter never read `ExtraArgs` validation like claude does; the
  dialog sends none, but admitting `kind=codex` to the HTTP API means a raw
  client could pass arbitrary codex flags (noted, not gated).

**Decisions**
- **Path A** (make codex first-class), not Path B (fence it off).
- Codex restore **replays the captured argv+cwd** (mirrors shell) rather than
  re-running the adapter fresh — keeps the "captured argv is the invariant"
  contract uniform across shell/codex.
- **Deferred** (no repo evidence the codex CLI supports them, so building
  blind would be speculative): the #32 preamble (`--append-system-prompt` is
  Claude-only; codex's convention is a filesystem `AGENTS.md`), `--resume`,
  the lifecycle-hook shim + rich stoplight (daemon side is already generic;
  only a `reck-codex-hook.sh` + installer are missing), and clipboard-image.
