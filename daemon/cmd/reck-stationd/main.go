package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	nethttp "net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/hooks"
	httpsrv "github.com/rudie-verweij/reck-connect/daemon/internal/http"
	"github.com/rudie-verweij/reck-connect/daemon/internal/launcher"
	"github.com/rudie-verweij/reck-connect/daemon/internal/mountprobe"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/daemon/internal/stoplight"
	"github.com/rudie-verweij/reck-connect/daemon/internal/ws"
)

const Version = "0.1.0"

func main() {
	var (
		configPath     = flag.String("config", defaultConfigPath(), "path to projects.toml")
		addr           = flag.String("addr", ":7315", "listen address")
		claudeBin      = flag.String("claude", "claude", "command to spawn for claude panes")
		tokenFile      = flag.String("token-file", "", "explicit path to a 0600 bearer token file; empty = walk default chain ($RECK_TOKEN_FILE → ~/.config/reck/token → /etc/reck-stationd/token)")
		installHooks   = flag.Bool("install-hooks", false, "install Claude Code hooks and exit")
		uninstallHooks = flag.Bool("uninstall-hooks", false, "remove Claude Code hooks and exit")
		noInstallHooks = flag.Bool("no-install-hooks", false, "skip auto-installing Claude Code hooks at startup")
		modeFlag       = flag.String("mode", string(agent.ModeStation), "host posture: station (default; daemon runs on the always-on station Mac) or local (daemon runs on the user's laptop alongside Satellite)")
		launcherPath   = flag.String("pane-launcher", defaultPaneLauncherPath(), "absolute path to the reck-pane-launcher helper binary; empty disables the helper and reverts to in-process pane spawn (issue #225)")
	)
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	// Validate --mode early so a typo never reaches Manager construction
	// (where it would silently fall through to the station-mode preamble
	// — exactly the skew window Phase 6 atomicity is meant to prevent).
	mode, err := parseDaemonMode(*modeFlag)
	if err != nil {
		// fmt.Fprintf to stderr + exit 2 mirrors the convention `flag`
		// itself uses for unknown flags, so shell wrappers / launchd
		// already treat 2 as "argv problem; don't auto-restart".
		fmt.Fprintf(os.Stderr, "reck-stationd: %v\n", err)
		os.Exit(2)
	}
	logger.Info("daemon mode", "mode", string(mode))

	// Wire RECK_STATION_ROOT into config.ManagedProjectsRoot.
	//
	// Station mode: the env var is REQUIRED. Fail-fast keeps the
	// satellite/daemon contract symmetric — if the satellite is built
	// or installed with a non-default RECK_STATION_ROOT but the station
	// daemon ran without it, projects created via the "new" add-project
	// flow land at the package default and vanish from the rail (the
	// satellite translates them against the env-var path). Surfacing
	// the missing var here, before Manager construction, makes the
	// misconfiguration debuggable. Exit 2 matches the --mode validator
	// above; launchd's KeepAlive + ThrottleInterval=30 still respawns
	// but the operator sees repeated startup failures in the log
	// instead of a daemon "running" against the wrong path.
	//
	// Local mode: the env var is OPTIONAL. The local daemon is spawned
	// as a child of Satellite (`satellite/main/daemon-spawn.ts`),
	// inheriting `process.env`. After a fresh login (before the user
	// re-runs install-satellite.sh) `launchctl setenv RECK_STATION_ROOT`
	// has evaporated and the env var is unset. Fail-fast here would
	// regress every Satellite launch in that window. We keep the
	// historical package default in that case — local mode's project
	// root has different semantics anyway (it's a laptop-side default
	// for projects without an explicit cwd, not the station's mount
	// source-of-truth).
	if v := os.Getenv("RECK_STATION_ROOT"); v != "" {
		config.ManagedProjectsRoot = v
	} else if mode == agent.ModeStation {
		fmt.Fprintln(os.Stderr, "reck-stationd: RECK_STATION_ROOT must be set in --mode=station.")
		fmt.Fprintln(os.Stderr, "  Recovery (one of):")
		fmt.Fprintln(os.Stderr, "    1. Re-run install-station.sh (renders the plist with the env var):")
		fmt.Fprintln(os.Stderr, "         RECK_STATION_USER=<user> RECK_STATION_ROOT=<absolute-path> ./ops/install-station.sh")
		fmt.Fprintln(os.Stderr, "    2. Patch the existing plist in place:")
		fmt.Fprintln(os.Stderr, "         plutil -insert EnvironmentVariables.RECK_STATION_ROOT \\")
		fmt.Fprintln(os.Stderr, "           -string <absolute-path> ~/Library/LaunchAgents/eu.verwey.reck-stationd.plist")
		fmt.Fprintln(os.Stderr, "         launchctl kickstart -k gui/$(id -u)/eu.verwey.reck-stationd")
		os.Exit(2)
	}

	// Resolve the bearer token. The router reads it via
	// os.Getenv("DAEMON_TOKEN"), so we publish the resolved value into
	// the env after loading — single source of truth without
	// threading the token through every auth call site.
	//
	// Phase 1: prefer ~/.config/reck/token (LaunchAgent
	// path), fall through to /etc/reck-stationd/token (legacy
	// LaunchDaemon path) for in-flight migration. Explicit
	// --token-file=<path> bypasses the chain.
	//
	// Why this lives in main (not config.Load): projects registry
	// and bearer have orthogonal lifecycles; rotating the token
	// (edit file, kickstart service) shouldn't require a registry
	// round-trip.
	{
		var (
			tok, src string
			err      error
		)
		if *tokenFile != "" {
			// Explicit flag is the operator's most explicit intent —
			// it beats both the env var and the default chain.
			tok, src, err = config.ResolveToken(*tokenFile)
			if err != nil {
				logger.Error("token load failed", "err", err, "path", *tokenFile)
				os.Exit(1)
			}
		} else if config.PreferEnvToken(string(mode), os.Getenv("DAEMON_TOKEN")) {
			// Local mode under a supervising Satellite: the per-spawn
			// env token is authoritative (a stale ~/.config/reck/token
			// winning the chain 401'd every renderer request).
			// DAEMON_TOKEN is already in the env; nothing to publish.
			logger.Info("daemon token loaded", "source", "env:DAEMON_TOKEN (supervising Satellite)")
		} else {
			cands := config.DefaultTokenCandidates()
			tok, src, err = config.ResolveTokenChain(cands)
			if err != nil {
				logger.Error("token load failed", "err", err, "candidates", cands)
				os.Exit(1)
			}
		}
		if tok != "" {
			os.Setenv("DAEMON_TOKEN", tok)
			logger.Info("daemon token loaded", "source", src)
		}
	}

	// One-shot management commands: install or uninstall hooks, then exit.
	// These run BEFORE the DAEMON_TOKEN fail-closed check below so an
	// operator can install hooks on a fresh box that hasn't had its
	// token file written yet.
	if *installHooks || *uninstallHooks {
		home, err := os.UserHomeDir()
		if err != nil {
			logger.Error("cannot resolve $HOME", "err", err)
			os.Exit(1)
		}
		if *uninstallHooks {
			if err := hooks.Uninstall(home); err != nil {
				logger.Error("uninstall hooks failed", "err", err)
				os.Exit(1)
			}
			logger.Info("hooks uninstalled", "home", home)
		} else {
			if err := hooks.EnsureInstalled(home); err != nil {
				logger.Error("install hooks failed", "err", err)
				os.Exit(1)
			}
			logger.Info("hooks installed", "home", home)
		}
		return
	}

	// Audit fix F3 : fail closed at startup if no DAEMON_TOKEN
	// was resolved (neither token-file nor env var). Combined with the
	// router-wide CORS allow-* and the previous "warn and disable
	// auth" behaviour, an unconfigured daemon could be driven from any
	// webpage in the user's browser. Refuse to come up at all so the
	// operator notices immediately rather than running a silently open
	// daemon. The router's authMiddleware also fail-closes for
	// belt-and-braces against any future code path that bypasses this
	// check. Placed AFTER the one-shot --install-hooks / --uninstall-hooks
	// branch so those management commands still work on a fresh box
	// before the token file has been written.
	if os.Getenv("DAEMON_TOKEN") == "" {
		logger.Error("DAEMON_TOKEN not configured; refusing to start. Set the env var or place a 0600 token file at one of the candidate paths.",
			"token_file_flag", *tokenFile,
			"default_candidates", config.DefaultTokenCandidates())
		os.Exit(1)
	}

	// an earlier release binary resolution: resolve every agent / shell binary to
	// an absolute path once, at startup, so pane-spawn argv never
	// depends on $PATH at exec time. This closes the PATH-shadow
	// attack class where a writable earlier-PATH directory could
	// swap in a malicious `claude` / `codex` / shell binary.
	//
	// Startup-time resolution is a one-shot using the daemon's OWN
	// $PATH (set by the launchd plist / operator's shell), which is
	// trusted — a pane child later getting a poisoned PATH via any
	// means still cannot influence what the daemon execs.
	//
	// ORDERING (an earlier release review fix #3): the default shell MUST be
	// resolved BEFORE config.Load. Otherwise Load would see a bare
	// $SHELL (e.g. "zsh" on hosts where /etc/passwd stores the bare
	// name) and drop any persisted project that omits its `shell`
	// field as "bare binary name rejected". That would silently lose
	// user projects across a daemon restart. Resolve here, install
	// into config via SetDefaultShell, then Load — persisted projects
	// inherit the resolved absolute path.
	//
	// Policy:
	//   - --claude: must resolve. Fatal on failure — the daemon has
	//     no useful function without it.
	//   - default $SHELL: must resolve. Fatal on failure — the
	//     fallback for any project that registers without its own
	//     Shell field.
	//   - codex: best-effort. Not every station ships codex; when
	//     it's missing we log a warning and pass nil through to the
	//     adapter, which returns ErrCodexNotAvailable at spawn time
	//     instead of fork/exec'ing a bare name.
	//
	// Persisted projects.toml paths go through the stricter
	// config.ResolveBinary (rejects bare names) — see config.Load.
	resolvedClaude, err := exec.LookPath(*claudeBin)
	if err != nil {
		logger.Error("resolve claude binary failed", "err", err, "candidate", *claudeBin)
		os.Exit(1)
	}
	if !filepath.IsAbs(resolvedClaude) {
		if abs, absErr := filepath.Abs(resolvedClaude); absErr == nil {
			resolvedClaude = abs
		}
	}
	logger.Info("claude binary resolved", "path", resolvedClaude)

	defaultShellCandidate := os.Getenv("SHELL")
	if defaultShellCandidate == "" {
		defaultShellCandidate = "/bin/zsh"
	}
	resolvedShell, err := exec.LookPath(defaultShellCandidate)
	if err != nil {
		logger.Error("resolve default shell failed", "err", err, "candidate", defaultShellCandidate)
		os.Exit(1)
	}
	if !filepath.IsAbs(resolvedShell) {
		if abs, absErr := filepath.Abs(resolvedShell); absErr == nil {
			resolvedShell = abs
		}
	}
	logger.Info("default shell resolved", "path", resolvedShell)
	defaultShellArgv := []string{resolvedShell, "-l"}
	// Publish the resolved default into config so Load() uses it for
	// projects that omit their `shell` field. MUST precede Load.
	config.SetDefaultShell(defaultShellArgv)

	var codexCmd []string
	if rc, err := exec.LookPath("codex"); err == nil {
		if !filepath.IsAbs(rc) {
			if abs, absErr := filepath.Abs(rc); absErr == nil {
				rc = abs
			}
		}
		codexCmd = []string{rc}
		logger.Info("codex binary resolved", "path", rc)
	} else {
		logger.Warn("codex unavailable on this station; codex panes will return an error at spawn", "err", err)
	}

	// reck-pane-launcher (issue #225). The helper exists solely to be the
	// TCC responsible-process for pane children — reck-stationd spawns it
	// once at startup with responsibility_spawnattrs_setdisclaim, and
	// every subsequent pane spawn fork+exec runs inside the helper. This
	// means macOS attributes Accessibility / AppleEvents API calls from
	// claude / MCP servers / sub-shells back to the helper binary path,
	// not to reck-stationd. The helper is restartable without killing
	// panes (its children get reparented to launchd and keep running) and
	// the AX grant on the helper survives daemon restarts.
	//
	// An empty --pane-launcher flag falls through to the legacy in-process
	// spawn path so dev rebuilds without `make install` still work.
	var paneLauncher *launcher.Launcher
	if *launcherPath != "" {
		if !filepath.IsAbs(*launcherPath) {
			if abs, absErr := filepath.Abs(*launcherPath); absErr == nil {
				*launcherPath = abs
			}
		}
		l, err := launcher.New(*launcherPath)
		if err != nil {
			logger.Warn("pane-launcher unavailable; falling back to in-process spawn (panes will need AX grant on reck-stationd, see issue #225)", "err", err, "path", *launcherPath)
		} else if err := l.Start(); err != nil {
			logger.Warn("pane-launcher failed to start; falling back to in-process spawn", "err", err, "path", *launcherPath)
		} else {
			paneLauncher = l
			pty.SetPaneLauncher(l)
			logger.Info("pane-launcher ready", "path", *launcherPath, "pid", l.HelperPID(), "sock", l.SocketPath())
		}
	} else {
		logger.Info("pane-launcher disabled by flag; using in-process spawn")
	}

	reg, warns, err := config.Load(*configPath)
	if err != nil {
		logger.Error("config load failed", "err", err, "path", *configPath)
		os.Exit(1)
	}
	for _, w := range warns {
		logger.Warn("config warning", "err", w.Error())
	}
	logger.Info("loaded config", "projects", len(reg.Projects), "path", *configPath)

	// Auto-install Claude Code lifecycle hooks on every startup. Idempotent
	// via the reck-hook-v1 marker — repeated daemon restarts do no new work
	// once hooks are in place, but a fresh station or a wiped settings.json
	// self-heals without manual intervention. Failures degrade gracefully:
	// the stoplight just falls back to the byte-flow heuristic for panes
	// where hook events never arrive.
	if !*noInstallHooks {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			if err := hooks.EnsureInstalled(home); err != nil {
				logger.Warn("auto-install hooks failed; continuing without them", "err", err)
			} else {
				logger.Info("Reck Claude Code hooks ready", "settings", filepath.Join(home, ".claude", "settings.json"))
			}
		}
	}

	// Session index: lets us surface a "Resume…" picker after a pane
	// exits / daemon restarts. Opening the store is best-effort — if
	// $HOME is unset or the dir isn't writable we continue without it
	// and claude panes run exactly as before.
	var sessStore *sessions.Store
	if sessDir := sessions.DefaultDir(); sessDir != "" {
		if s, err := sessions.NewStore(sessDir); err != nil {
			logger.Warn("session index unavailable; resume flows disabled", "err", err, "dir", sessDir)
		} else {
			sessStore = s
			logger.Info("session index ready", "dir", sessDir)
		}
	}

	mgr := pty.NewManagerFromConfig(pty.ManagerConfig{
		Projects:     reg.Projects,
		ClaudeCmd:    []string{resolvedClaude},
		CodexCmd:     codexCmd,
		DefaultShell: defaultShellArgv,
		ConfigPath:   *configPath,
		Sessions:     sessStore,
		Mode:         mode,
	})
	wsH := &ws.Handler{Manager: mgr, Logger: logger}
	srv := &httpsrv.Server{
		Manager:        mgr,
		WS:             wsH,
		StartedAt:      time.Now(),
		Version:        Version,
		CodexAvailable: len(codexCmd) > 0,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Track every ctx-bound background goroutine so shutdown can
	// wait for them to exit before HTTP/WS teardown + pane kills
	// begin. Codex round-5 finding 10: `cancel()` alone isn't
	// enough — Go's select may legally service a ready ticker
	// before noticing `ctx.Done()`, so a last probe/stoplight tick
	// could still walk `AllPanes()` and race pane deletion. The
	// WaitGroup closes that race by blocking teardown until every
	// runner has returned.
	var bgWg sync.WaitGroup
	startBackground := func(fn func(ctx context.Context)) {
		bgWg.Add(1)
		go func() {
			defer bgWg.Done()
			fn(ctx)
		}()
	}
	startBackground(func(ctx context.Context) { stoplight.NewRunner(mgr).Run(ctx) })
	// Refresh was_live entries every 15s so the restore-on-reconnect
	// prompt has an accurate "running X seconds ago" label when the
	// daemon subsequently crashes.
	startBackground(func(ctx context.Context) { mgr.RunLivenessTicker(ctx, 15*time.Second) })

	// Phase 10a (an earlier release, plan rev 3.1): the phase-10 mount-loss
	// characterization confirmed a local pane whose cwd vanishes
	// (sshfs dropped, station folder removed, tailnet gone) keeps
	// its process alive with no visible signal. The mountprobe
	// watcher fills that gap by flipping the pane's effective
	// stoplight to red via SetCwdAvailable when os.Stat of its cwd
	// starts failing, and resetting on recovery. Only runs in
	// local mode — station panes live in native-filesystem cwds
	// where a probe would be noise, not signal.
	if mode == agent.ModeLocal {
		startBackground(func(ctx context.Context) {
			mountprobe.New(mgr, mountprobe.DefaultInterval, logger).Run(ctx)
		})
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		logger.Error("listen failed", "err", err, "addr", *addr)
		os.Exit(1)
	}
	logger.Info("listening", "addr", ln.Addr().String(), "version", Version)

	// phase 2: the daemon pidfile  is no
	// longer written. It existed solely so the reck-clipboard
	// sidecar could verify inbound UDS connections via
	// LOCAL_PEEREPID — with the sidecar retired, the file has no
	// readers.

	// Publish the daemon URL so panes we spawn — and the agent hook shims
	// running in those children — can POST lifecycle events back to us.
	// Bound to the actual listening address so it works even when --addr=:0.
	daemonURL := daemonURLFromAddr(ln.Addr().String())
	os.Setenv("RECK_DAEMON_URL", daemonURL)

	// Auto-restore orphaned panes from the previous daemon run (issue
	// #228). Walks the sessions store for entries the prior daemon
	// last observed alive but that aren't bound to any pane in this
	// fresh process, and respawns each via the existing resume/restore
	// path. Drops the satellite-side "Restore?" prompt — by the time
	// the HTTP server starts serving, /restore-candidates returns empty.
	//
	// Ordering matters: this MUST run after RECK_DAEMON_URL is set
	// in the daemon's env, because Spawn forwards that var into the
	// child (paneBaseEnv allowlist) and the lifecycle-hook shim in
	// reck-claude-hook.sh exits silently when it's missing — meaning
	// auto-restored panes would have no stoplight signal otherwise.
	// Still runs before HTTP serve, so /restore-candidates is empty
	// from the satellite's perspective.
	//
	// CreatePaneWith is goroutine-safe; the call is fast (no per-pane
	// wait beyond the spawn syscall).
	if r := mgr.RestoreOrphans(0, 0); r.Restored+r.Failed+r.ReadOnly > 0 {
		logger.Info("restore-orphans complete",
			"restored", r.Restored,
			"failed", r.Failed,
			"skipped", r.Skipped,
			"read_only", r.ReadOnly,
		)
	}

	// HTTP server hardening: timeouts + header cap. Justification for
	// each value lives on httpsrv.ApplyTimeouts so it's documented once
	// next to the defaults the test suite exercises.
	httpServer := &nethttp.Server{
		Handler: srv.Router(),
	}
	httpsrv.ApplyTimeouts(httpServer)

	// Sweep image-paste upload tmpdirs left over from a previous daemon
	// run (phase 1). The daemon has just started — no panes
	// registered yet — so every `$TMPDIR/reck-pane-*` we find is
	// orphaned and safe to remove. Best-effort; failures are logged.
	httpsrv.SweepStalePaneUploadDirs(map[string]bool{})

	// phase 2: the reck-clipboard sidecar has been retired.
	// The daemon writes images to NSPasteboard directly via cgo
	// (internal/macclipboard) and spawns claude panes through the
	// direct PTY path. No probe, no dispatch switch, no env-signal
	// gate — the LaunchAgent install is the only supported deployment.
	go func() {
		if err := httpServer.Serve(ln); err != nil && err != nethttp.ErrServerClosed {
			logger.Error("http serve", "err", err)
		}
	}()

	// Capture start time for uptime-on-shutdown attribution. Using ln's
	// bind time (rather than process start) keeps the number meaningful
	// even if startup itself stalls — "how long were we actually
	// serving" is what helps diagnose repeat-kill cycles.
	startedAt := time.Now()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	received := <-sig
	// Best-effort attribution for the shutdown: log the signal name, our
	// parent pid + comm, and how long we ran. On a healthy LaunchDaemon
	// the parent is always launchd (pid 1), so this is a noisy-but-
	// cheap breadcrumb — when a rogue `launchctl kickstart -k` or
	// manual `kill` is responsible for repeat bounces, the log line
	// still shows the signal name and the uptime, which is usually
	// enough to reconstruct the blast radius from a single grep.
	//
	// macOS has no portable "who sent this signal" API (Darwin's
	// `si_pid` plumbing isn't reliable across LaunchDaemon / kernel
	// paths), so we don't try. Ppid is a reference point, not a
	// culprit.
	ppid := os.Getppid()
	logger.Info("shutting down",
		"signal", received.String(),
		"ppid", ppid,
		"ppid_comm", resolveProcComm(ppid),
		"uptime_s", int(time.Since(startedAt).Seconds()),
	)
	// Stop every background goroutine we started against `ctx`
	// (stoplight runner, liveness ticker, mountprobe in local
	// mode) BEFORE the rest of shutdown runs. Cancel + wait:
	// `cancel()` signals the runners; `bgWg.Wait()` blocks until
	// every runner's `for select` observes the cancellation and
	// returns. Without the Wait, Go's select could service a
	// ready ticker in-flight (codex round-5 finding 10) and
	// produce a last probe/stoplight tick that walks `AllPanes()`
	// during the HTTP + WS + pane-kill teardown below — which
	// would race pane deletion and emit bogus recovery log lines
	// as children die and files disappear.
	//
	// The Wait is BOUNDED. Codex round-6 finding 12 pointed out
	// that mountprobe's `os.Stat` can block indefinitely on the
	// exact failure this feature targets (a dead sshfs mount), so
	// an unbounded Wait would turn shutdown into a hang. If the
	// bounded wait times out we proceed with HTTP/WS/pane teardown
	// anyway; the stuck goroutine will die when the process exits.
	// 2 s matches shutdownCtx's budget and is long enough for a
	// normal tick to drain but short enough to stay inside launchd's
	// SIGKILL timeout.
	cancel()
	const bgWaitBudget = 2 * time.Second
	bgDone := make(chan struct{})
	go func() { bgWg.Wait(); close(bgDone) }()
	select {
	case <-bgDone:
		// all background runners returned
	case <-time.After(bgWaitBudget):
		logger.Warn("shutdown: background goroutines did not exit within budget; proceeding",
			"budget", bgWaitBudget.String())
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	// Stop accepting new HTTP and WS upgrades first. Existing HTTP
	// handlers get to finish; existing WS sessions keep running —
	// httpServer.Shutdown only waits for non-hijacked handlers to
	// return, and nhooyr.Accept hijacks the conn out of the server's
	// tracking immediately.
	_ = httpServer.Shutdown(shutdownCtx)
	// Now coordinate with live per-pane WebSocket sessions: broadcast
	// a StatusGoingAway close frame so every client sees a clean
	// "daemon is shutting down" event instead of a bare TCP reset when
	// we subsequently kill panes. Bounded by ws.ShutdownCloseWait so a
	// stuck client can't delay pane teardown past launchd's kill
	// timeout.
	closeCtx, closeCancel := context.WithTimeout(context.Background(), ws.ShutdownCloseWait)
	wsH.Shutdown(closeCtx)
	closeCancel()
	for _, p := range mgr.AllPanes() {
		p.Kill()
	}
	// Stop the reck-pane-launcher helper after panes are killed so any
	// final ExitNotice / fd close races resolve cleanly. Helper exit also
	// removes its socket file; nothing else needs to happen here. Order
	// matters: stopping the helper before pane kills would race the
	// per-pane control conn close against the helper's listener teardown.
	if paneLauncher != nil {
		paneLauncher.Stop()
		logger.Info("pane-launcher stopped")
	}
	logger.Info("bye")
}

func defaultConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "reck", "projects.toml")
}

// defaultPaneLauncherPath returns the canonical install path for the
// reck-pane-launcher helper binary. install-station.sh installs it to
// /usr/local/bin/reck-pane-launcher; if that's missing (dev rebuild without
// `make install`), we fall back to a sibling binary next to reck-stationd
// itself so `go run ./daemon/cmd/reck-stationd` from a freshly-built tree
// still resolves a usable helper.
func defaultPaneLauncherPath() string {
	const installed = "/usr/local/bin/reck-pane-launcher"
	if _, err := os.Stat(installed); err == nil {
		return installed
	}
	if exe, err := os.Executable(); err == nil {
		sibling := filepath.Join(filepath.Dir(exe), "reck-pane-launcher")
		if _, err := os.Stat(sibling); err == nil {
			return sibling
		}
	}
	return installed // surface the canonical path even if missing — the launcher.New stat will produce a clear error
}

// parseDaemonMode normalises the --mode flag string to a typed
// agent.DaemonMode. Anything outside the closed set
// {"station","local"} is rejected with a clear error so a typo (e.g.
// "stations") fails fast at startup instead of silently falling
// through to the station preamble — the failure mode the Phase 6
// atomic-commit guidance is designed to avoid. Empty string is
// rejected too; the flag has a default of "station", so reaching this
// helper with "" means a caller deliberately overrode the default to
// the empty string and that's a misconfiguration, not a "use default".
func parseDaemonMode(s string) (agent.DaemonMode, error) {
	switch s {
	case string(agent.ModeStation):
		return agent.ModeStation, nil
	case string(agent.ModeLocal):
		return agent.ModeLocal, nil
	default:
		return "", fmt.Errorf("invalid --mode %q: must be %q or %q", s, agent.ModeStation, agent.ModeLocal)
	}
}

// daemonURLFromAddr converts a net.Listener Addr string (e.g. "[::]:7315",
// "0.0.0.0:7315", "127.0.0.1:7315", or a Tailscale/VPN IP like
// "100.64.0.1:7315") into an http:// URL the hook shims can reach.
//
// Hosts are mapped per-case:
//   - empty / "0.0.0.0" / "::" / "[::]" (wildcard listeners) → "127.0.0.1"
//     (loopback always works when the daemon binds to all interfaces).
//   - any other explicit host (e.g. a Tailscale IP a station is bound to)
//     → preserved as-is, because loopback would NOT be listening in that
//     case and the hook shim's curl would get connection-refused. A Linux
//     station bound to its Tailscale interface would otherwise silently
//     drop every agent-event POST, leaving the stoplight stuck on gray.
func daemonURLFromAddr(a string) string {
	host, port, err := net.SplitHostPort(a)
	if err != nil {
		return "http://127.0.0.1" + a
	}
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// resolveProcComm returns the `comm` (command name) for the given pid via
// `/bin/ps`, or "" on failure / invalid pid. Bounded by a 500 ms context
// timeout so a stuck fork can't stall the shutdown log line — the whole
// shutdown sequence is time-boxed (httpServer.Shutdown has a 5 s budget,
// launchd SIGKILLs at 20 s) and a blocking ps would eat into that.
// Used for SIGTERM attribution in the shutdown log; see the call site
// for why we don't try harder than this on macOS.
func resolveProcComm(pid int) string {
	if pid <= 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
