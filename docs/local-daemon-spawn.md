# Local-Daemon Spawn Resilience & Cold-Start Diagnostics

How the Satellite spawns `reck-stationd` in **Local mode** and how a
failed or slow spawn is turned into an actionable, typed error instead
of a blind timeout. Station mode is unaffected — the station daemon is
launchd-managed and the Satellite never spawns it.

For the broader topology see [`architecture.md`](./architecture.md); for
local-vs-station semantics see [`concepts/modes.md`](./concepts/modes.md);
for the bearer-token model see [`concepts/auth.md`](./concepts/auth.md).

Implementation: `satellite/main/daemon-spawn.ts` (spawn + classification),
`daemon/cmd/reck-stationd/main.go` (token resolution, the `listening`
log), `daemon/internal/config/token.go` (`PreferEnvToken`),
`ops/install-local.sh` (codesign + pre-warm).

## The spawn path

`startDaemon("local", port)` sweeps orphan listeners, resolves the
binary, mints a fresh per-spawn `DAEMON_TOKEN`, spawns
`reck-stationd --mode=local`, then **polls TCP** until the daemon binds
the port or a budget elapses. The outcome is a typed `StartDaemonResult`
so the renderer's connection rail can show a precise reason rather than
"it didn't come up".

## Typed failure codes

| `code` | Meaning | Surfaced from |
|---|---|---|
| `ENOENT` | `reck-stationd` binary not found on any candidate path | `findDaemonBinary()` returns null before spawn |
| `EADDRINUSE` | Port already bound by another process | the daemon's `listen failed … address already in use` log |
| `ESPAWN` | `posix_spawn` itself failed (EACCES, exec-format, Gatekeeper kill before `main`) | a child `'error'` event |
| `EUNKNOWN` | Spawned but never bound within the budget | the daemon's own last `ERROR`-level log line, else a tail |

### Why classification reads stdout

The daemon's `slog` `JSONHandler` writes to **`os.Stdout`**
(`main.go:49`), so its actionable failure lines — the `listen failed`
bind error (`main.go:402`) and `resolve claude binary failed` +
`os.Exit(1)` (`main.go:220`) — arrive on **stdout, not stderr**. The
spawn path therefore buffers *both* streams into one diagnostic buffer
and classifies across it; `EUNKNOWN` carries the last `"level":"ERROR"`
line so the rail shows the real cause instead of a bare timeout.

### Why `ESPAWN` is separate

A `posix_spawn`-level failure emits a child `'error'` event with **no
exit and no output**. Without a listener the `EventEmitter` throw would
crash the main process, and the poll loop would burn its whole budget on
a child that never existed. The spawn path captures the error, breaks
the loop immediately, and returns `ESPAWN` carrying the errno — typically
in well under a second.

## The cold-start race (macOS)

A freshly built, ad-hoc-signed binary pays a one-time macOS Gatekeeper
(`syspolicyd`) assessment on its **first** exec — seconds between
`posix_spawn` and Go's `main()`. A warm bind takes ~100 ms, so two
mitigations keep the spawn honest:

1. **8 s wait-for-listen budget** (was 3 s) — enough headroom for the
   first-run assessment; still injectable for tests.
2. **Install-time pre-warm** — `ops/install-local.sh` ad-hoc codesigns
   the binary (`codesign --force --sign -`) and runs it once on a
   throwaway port, polling its log for `"msg":"listening"`, so the
   assessment is cached **before** the app ever spawns it. Darwin-gated;
   a no-op elsewhere.

## PATH resolution for the spawned daemon

A Finder-launched Satellite inherits a minimal PATH. The daemon's PATH
is resolved from a **non-interactive** login shell (`zsh -l -c`), which
reads `~/.zprofile` but **not** `~/.zshrc` — where the native `claude`
installer puts its `~/.local/bin` export. `ensureSpawnPath` appends the
well-known per-user bin dirs (`~/.local/bin`, `/opt/homebrew/bin`)
append-only and de-duped, so the daemon can always resolve `claude`.

## Token precedence in local mode

The Satellite mints a fresh `DAEMON_TOKEN` per spawn and its renderer
authenticates with exactly that value. The daemon's default token chain
is file-first (for the station's plist→file migration), which in local
mode let a stale `~/.config/reck/token` win and **401 every renderer
request**. `PreferEnvToken(mode, envToken)` scopes a new precedence to
`--mode=local` with a non-empty env token; an explicit `--token-file`
still beats everything; station mode is unchanged.

## Diagnosing a greyed-out "Local" chip

The New-pane dialog greys a host on its ready flag. `setHostReady` logs
every real transition (`[ready] host=local ready=…`), so the console
tells the whole story. The three independent layers, in order of how
often they bite:

1. **Timeout** — cold-start assessment lost the budget → `EUNKNOWN`
   "failed to listen within 8000 ms". Fix: re-run `install-local.sh`
   (pre-warms the binary).
2. **PATH** — daemon exits on `resolve claude binary failed` → `EUNKNOWN`
   carrying that line. Fix: ensure `claude` is under `~/.local/bin`.
3. **Token** — daemon up but every request 401s. Fix: `PreferEnvToken`
   makes the per-spawn env token authoritative in local mode.

See [`troubleshooting.md`](./troubleshooting.md) for the operator-facing
recovery steps.
