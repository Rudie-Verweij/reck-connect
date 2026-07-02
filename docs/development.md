# Development

## Build commands

### Daemon (Go)

```bash
# Build all packages
cd . && go build ./...

# Run all tests
cd . && go test ./...

# Vet
cd daemon && go vet ./...
```

The daemon entry point is `daemon/cmd/reck-stationd/main.go`. The `go.mod` module root is repo root.

### Satellite (TypeScript / Electron)

```bash
cd satellite

pnpm install           # install dependencies
pnpm build             # compile main + renderer (tsc + vite)
pnpm typecheck         # type-check only, no emit
pnpm test              # vitest unit tests (run once)
pnpm test:watch        # vitest in watch mode
pnpm test:e2e          # Playwright e2e (smoke.spec.ts)
pnpm dev:bg            # vite + tsc -w only (no Electron) — used by the VSCode debug launcher
pnpm dist              # full electron-builder package → release/mac-arm64/Reck Connect Satellite.app
```

**`pnpm dev` is BROKEN — never use it.** The concurrent vite + electron dev-server flow does not work. For manual UI testing, build a real app bundle with `pnpm dist` and launch `release/mac-arm64/Reck Connect Satellite.app` directly. `pnpm typecheck`, `pnpm test`, and `pnpm build` are all fine for static verification.

For an interactive run with **breakpoints** — and a reliable alternative to the broken `pnpm dev` — use the checked-in VSCode debug config: open the repo in VSCode and press F5. VSCode launches Electron itself against `dist/main/main.js` (the `dev:bg` script supplies the vite + `tsc -w` watch loop without launching Electron). See [`vscode-debugging.md`](vscode-debugging.md).

Source: `satellite/package.json`.

## Protocol sync

When editing wire types, update all three artefacts in the same commit:

1. `proto/proto.ts` — TypeScript types for the Satellite renderer
2. `proto/proto.go` — Go types for the daemon
3. `proto/proto.md` — the canonical contract document

There is no codegen; sync is manual. `proto.md` is the source of truth — the TypeScript and Go files must match it field-for-field. See [`proto/proto.md`](../proto/proto.md) for the full schema and endpoint table.

## How to add a new pane kind

1. **Extend enums.** Add the new kind to `PaneKind` in `proto.ts`, `proto.go`, and document it in `proto.md`.

2. **Write an adapter.** Create a new adapter under `daemon/internal/agent/` that implements the `Adapter` interface (`BuildSpawn(req SpawnRequest) (SpawnPlan, error)`). See `daemon/internal/agent/adapter.go` for the interface definition, and `claude.go`, `shell.go`, `codex.go` as reference implementations.

3. **Register the adapter.** Add it to the `adapters` map in `NewRegistry` in `daemon/internal/agent/adapter.go:121`.

4. **Wire into `CreatePaneWith`.** `Manager.CreatePaneWith` in `daemon/internal/pty/manager.go:776` calls `m.adapters.Lookup(kind)` to get the adapter. No code change is needed here unless the new kind requires special lifecycle handling.

5. **Surface in the satellite UI.** Add the kind to the pane-creation picker in the renderer. The `reckAPI` IPC surface is declared inline in `satellite/renderer/src/config.ts` — extend the `Window.reckAPI` type there when adding new IPC calls.

6. **Add tests.** Cover at minimum: adapter `BuildSpawn` happy path and error cases; HTTP handler for `POST /projects/:id/panes` with the new kind.

## How to add a new HTTP endpoint

1. Add the route to the router in `daemon/internal/http/` (find the existing `Router()` method).
2. Write the handler function in the same package.
3. If the response is client-visible, add it to `proto.md`'s endpoint table and, if it has a typed shape, add the response interface to `proto.ts` and `proto.go`.
4. Add tests in the `http` package.

## Test patterns

### Daemon (Go)

- `go test ./...` from repo root runs all packages.
- Tests that exercise `AddProject` or directory creation override `config.ManagedProjectsRoot` (a package-level `var` in `daemon/internal/config/config.go`) to a `t.TempDir()` path and restore it via `t.Cleanup`. Do not make `ManagedProjectsRoot` a `const` — the test override is intentional. See `daemon/internal/pty/manager_test.go:355` for the pattern.
- `Manager.AddProject` and `Manager.RemoveProject` live in `daemon/internal/pty/manager.go`, not in the config package.

### Satellite (TypeScript)

- `pnpm test` runs vitest against `satellite/` (config: `vitest.config.ts`). Excludes `e2e/`, `node_modules/`, `dist/`, `release/`.
- `pnpm test:e2e` runs Playwright (`playwright.config.ts`). The single smoke test is at `satellite/e2e/smoke.spec.ts`.

## IPC surface

The satellite uses Electron's context-bridge IPC. The `Window.reckAPI` type declaration lives inline in `satellite/renderer/src/config.ts` — there is no separate `reckapi.d.ts`. Extend the type there when adding new IPC surfaces.

## Commit and branching policy

Review before committing (agent-assisted code review is the norm here), and use git worktrees for non-trivial work so the main checkout stays on a known state.

## Key file locations

| What | Path |
|---|---|
| Daemon entry point | `daemon/cmd/reck-stationd/main.go` |
| Agent adapter interface | `daemon/internal/agent/adapter.go` |
| PTY manager (pane lifecycle) | `daemon/internal/pty/manager.go` |
| Config / projects.toml loader | `daemon/internal/config/config.go` |
| HTTP router + handlers | `daemon/internal/http/` |
| Wire protocol (canonical) | `proto/proto.md` |
| Wire protocol (TypeScript) | `proto/proto.ts` |
| Wire protocol (Go) | `proto/proto.go` |
| Satellite IPC surface | `satellite/renderer/src/config.ts` |
| rsync copy (project add) | `satellite/main/rsync-copy.ts` |
| Satellite package.json | `satellite/package.json` |
