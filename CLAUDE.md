# CLAUDE.md

Project instructions for AI coding agents working in **reck-connect**.

## Pull Requests

- **Always reference the issue(s) a PR resolves with a GitHub closing keyword**, in the PR **body**, so the issues close automatically when the PR merges.
- **One keyword per issue.** A bare comma list does NOT work — `Closes #42, #43` only closes #42. Write each out:
  - Single issue: `Closes #123`
  - Multiple issues: `Closes #42` and `Closes #43` (each on its own line, or each with its own keyword).
- Accepted keywords: `Closes` / `Fixes` / `Resolves` (case-insensitive).
- Also state the issue numbers in the PR description prose for reviewer context.
- When work is split into per-phase issues, prefer one PR per phase, each closing its own issue; if multiple phases ship in one PR, include a closing keyword for every issue it completes.

## Git / branches

- Do work on a feature branch, never directly on `main`.
- When multiple agents/sessions may run concurrently, isolate work in a dedicated `git worktree` so a shared working tree can't be switched under you mid-task.
