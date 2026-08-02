// Package mountprobe watches local-daemon panes for cwd disappearance
// (hybrid mode plan rev 3.1, phase 10a). The phase-10 characterization
// test (daemon/internal/pty/mount_loss_characterization_test.go)
// confirmed the rev-3 Codex warning: when a Claude / shell process's
// cwd vanishes — the sshfs mount drops, Tailscale goes down, the
// station rsync-deletes the folder — the child process survives
// silently. Its state stays `running`, the stoplight stays gray, the
// terminal prints an ENOENT error into the pty but no signal reaches
// the renderer, so the user keeps seeing a "green" pane that actually
// can't do anything useful with the filesystem.
//
// The probe plugs that observability gap. Every tick, it stats each
// local-daemon pane's cwd and drives `pane.SetCwdAvailable(bool)`.
// The Pane type folds that signal into its effective stoplight
// (`cwdAvailable == false` → stoplight forced to red), so the probe
// doesn't race the 1 Hz stoplight runner or agent hook events — the
// cwd signal is evaluated at every subscriber fan-out rather than
// racing SetStoplight writes against each other (codex round-4 fix).
//
// Design choices:
//
//   - Local mode only. Station panes live in native-filesystem cwds
//     on the station host — no sshfs, no remote mount. Probing them
//     would trigger false positives on any transient fs glitch without
//     meaningful upside. Main wires the Watcher only when the daemon
//     was started with --mode=local.
//
//   - Edge-logged, level-driven. The probe logs once on each
//     transition (reachable → unreachable, back again) and otherwise
//     stays quiet. The effective-stoplight computation in Pane is the
//     authoritative level-triggered signal; the probe just keeps the
//     Pane's `cwdAvailable` bit in sync with the filesystem.
//
//   - Best-effort stat. We treat any stat error (ENOENT, ESTALE,
//     permission denied, I/O) as "unreachable". That's slightly
//     over-eager for e.g. permission-denied edge cases, but the
//     pragmatic truth is that if the daemon can't see the cwd, any
//     pane operation against it will fail too. Telling the user
//     matches reality better than hiding the error.
package mountprobe

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
)

// DefaultInterval is what main.go passes when it doesn't override.
// 5 s is short enough that a mount drop becomes visible to the user
// within ~one thought, and long enough that the syscall overhead is
// unmeasurable even with dozens of panes. Tests override to a much
// smaller interval + drive ticks manually via Tick().
const DefaultInterval = 5 * time.Second

// DefaultStatTimeout bounds a single os.Stat call per pane. Codex
// round-7 finding 14: a dead sshfs mount can make `stat` block
// indefinitely, which would wedge the watcher for every subsequent
// pane and never observe recovery. Treating a slow stat as
// "unavailable" is the correct UX anyway — a mount too slow to
// respond within 2 s is effectively gone from the user's
// perspective even if the kernel is still waiting on the network.
const DefaultStatTimeout = 2 * time.Second

// DefaultProbeConcurrency caps how many per-pane stats run in
// parallel in a single tick. Codex round-8 finding 16: the original
// serial loop meant N bad panes × statTimeout worst-case tick
// latency, which starves later panes (and their recovery
// observability) under a multi-mount outage.
//
// Latency contract: with B bad/stuck panes (the rest complete
// quickly), a tick takes about `ceil(B / DefaultProbeConcurrency) ×
// statTimeout`. For B ≤ 16 that's one timeout; for realistic
// deployments (a handful of panes per user) the one-timeout bound
// holds. Under pathological outages where B >> 16, tick latency
// scales linearly with B/16 — still bounded, but not constant
// (codex round-9 finding 17 surfaced the honest contract; kept 16
// as a defensive cap vs. "spawn N goroutines at once" and documented
// explicitly). Bump if you routinely have >16 panes AND regularly
// see multi-mount outages large enough to batch.
const DefaultProbeConcurrency = 16

// probeResult discriminates "the probe finished and the mount is
// available", "the probe finished and the mount is NOT available
// (stat error, timeout)", and "the probe was aborted before it could
// give an answer (context cancelled / shutdown)". The third case is
// a no-op for `apply` so shutdown doesn't trigger red transitions
// on healthy panes (codex round-8 finding 15).
type probeResult int

const (
	probeAborted probeResult = iota
	probeAvailable
	probeUnavailable
)

// Watcher iterates the Manager's panes on a tick and keeps the
// per-pane `cwdAvailable` bit in sync with the filesystem. Zero
// value is not useful — call New.
type Watcher struct {
	mgr         *pty.Manager
	interval    time.Duration
	statTimeout time.Duration
	concurrency int
	logger      *slog.Logger

	// Test-only override. Production uses `os.Stat`; tests stub this
	// to simulate a stale sshfs mount without actually unmounting
	// anything in CI.
	statFn func(path string) error

	// Active-worker counters. Incremented the moment a worker
	// acquires its semaphore slot (not when statFn runs inside
	// the inner goroutine — that's a different event). Codex
	// round-14 finding 22: the timeout-branch batching contract
	// needed a deterministic slot-acquisition signal so tests
	// could verify the cap holds on that path without depending
	// on goroutine schedule order. Also cheap production
	// telemetry for a future "how many probes are in flight" log.
	activeWorkers atomic.Int32
	peakWorkers   atomic.Int32
}

// New builds a Watcher bound to `mgr`. `interval` defaults to
// DefaultInterval when <= 0. `logger` may be nil (falls back to
// slog.Default). `statTimeout` bounds a single probe via
// `DefaultStatTimeout` (see below).
func New(mgr *pty.Manager, interval time.Duration, logger *slog.Logger) *Watcher {
	if mgr == nil {
		panic("mountprobe.New: mgr must not be nil")
	}
	if interval <= 0 {
		interval = DefaultInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Watcher{
		mgr:         mgr,
		interval:    interval,
		statTimeout: DefaultStatTimeout,
		concurrency: DefaultProbeConcurrency,
		logger:      logger,
		statFn: func(path string) error {
			_, err := os.Stat(path)
			return err
		},
	}
}

// SetStatTimeout overrides the per-pane stat timeout. Tests use a
// much smaller value to drive timeout behaviour deterministically.
func (w *Watcher) SetStatTimeout(d time.Duration) {
	w.statTimeout = d
}

// SetConcurrency overrides how many per-pane probes run in parallel
// in a single tick. Tests use this to prove the serial-vs-parallel
// behaviour deterministically; production uses DefaultProbeConcurrency.
func (w *Watcher) SetConcurrency(n int) {
	if n < 1 {
		n = 1
	}
	w.concurrency = n
}

// Run blocks until ctx is cancelled. Intended to be invoked in its own
// goroutine from main.go. A single pane-iteration tick fires every
// `interval`; cancellation is observed on the next tick boundary OR
// between pane iterations inside a tick (codex round-6 finding 12 —
// a stuck os.Stat on a dead sshfs mount can't pin the runner past a
// single pane).
func (w *Watcher) Run(ctx context.Context) {
	t := time.NewTicker(w.interval)
	defer t.Stop()
	w.logger.Info("mountprobe: started", "interval", w.interval.String())
	for {
		select {
		case <-ctx.Done():
			w.logger.Info("mountprobe: stopping")
			return
		case <-t.C:
			// Belt-and-braces re-check: select may legally
			// service the ticker case even when ctx.Done() was
			// already closed (Go's select is non-deterministic
			// when multiple cases are ready). Short-circuit.
			if ctx.Err() != nil {
				return
			}
			w.tickCtx(ctx)
		}
	}
}

// Tick fires one iteration of the probe with a background context.
// Exposed so tests can drive the watcher deterministically without
// racing the time.Ticker.
func (w *Watcher) Tick() {
	w.tickCtx(context.Background())
}

// tickCtx runs the pane loop with bounded per-pane latency and
// cancellation observability. Production path comes from Run; tests
// typically use Tick.
//
// Design:
//   - Each pane's stat runs inside `statWithTimeout` so a single
//     stuck mount can't wedge the whole watcher (codex round-7).
//   - Probes run concurrently with a bounded worker semaphore
//     (codex round-8 finding 16). Tick latency: ~one statTimeout
//     when bad-pane count ≤ concurrency; scales as
//     ceil(badPanes / concurrency) × statTimeout beyond that.
//     Bound, not constant (codex round-9 finding 17 — honest
//     contract). For the realistic pane counts Reck Connect
//     targets (handful per user) this is effectively one timeout.
//   - Cancellation mid-probe does NOT mutate pane state — a
//     probeAborted result short-circuits without calling `apply`
//     so shutdown can't drive false red transitions on healthy
//     panes (codex round-8 finding 15).
//   - The spawned stat goroutine leaks if the kernel keeps blocking,
//     but that's bounded to one leaked goroutine per bad pane per
//     tick; the pane stays pinned on repeat ticks if the mount
//     stays bad, but the watcher as a whole stays live and recovery
//     of OTHER panes is observed promptly.
func (w *Watcher) tickCtx(ctx context.Context) {
	panes := w.mgr.AllPanes()
	if len(panes) == 0 {
		return
	}
	workers := w.concurrency
	if workers < 1 {
		workers = 1
	}
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for _, p := range panes {
		if ctx.Err() != nil {
			break
		}
		cwd := p.Cwd
		if cwd == "" {
			// Defensive — a pane without a cwd can't be probed.
			// Shouldn't happen (every spawn sets cwd to the
			// project dir) but the check keeps the tick a no-op
			// in that hypothetical rather than emitting noise.
			continue
		}
		// Acquire a worker slot or observe cancellation.
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			// Cancel before launching: break out cleanly. Any
			// already-dispatched workers will see ctx.Done()
			// inside statWithTimeout and return probeAborted.
			break
		}
		if ctx.Err() != nil {
			// Lost the race: don't launch another worker.
			break
		}
		wg.Add(1)
		go func(p *pty.Pane, cwd string) {
			defer wg.Done()
			defer func() { <-sem }()
			// Instrument dispatch. Increment AFTER semaphore
			// acquisition and BEFORE statWithTimeout so the
			// active count reflects live workers, not inner
			// stat goroutines (which can leak past the
			// timeout). Tests use this to verify the cap is
			// honored even on the timeout path.
			now := w.activeWorkers.Add(1)
			for {
				prev := w.peakWorkers.Load()
				if now <= prev || w.peakWorkers.CompareAndSwap(prev, now) {
					break
				}
			}
			defer w.activeWorkers.Add(-1)
			res := w.statWithTimeout(ctx, cwd)
			if res == probeAborted {
				return
			}
			w.apply(p, res == probeAvailable)
		}(p, cwd)
	}
	wg.Wait()
}

// statWithTimeout runs statFn in a child goroutine so a synchronous
// stat that blocks on a broken mount can't pin the probe. Returns
// `probeAvailable` when stat succeeds before the timeout,
// `probeUnavailable` when stat errors OR the timeout fires, and
// `probeAborted` when ctx cancels before either of those. The
// aborted case is distinct so callers can skip the pane-state
// mutation during shutdown.
func (w *Watcher) statWithTimeout(ctx context.Context, path string) probeResult {
	resCh := make(chan error, 1)
	go func() { resCh <- w.statFn(path) }()
	timer := time.NewTimer(w.statTimeout)
	defer timer.Stop()
	select {
	case err := <-resCh:
		if err == nil {
			return probeAvailable
		}
		return probeUnavailable
	case <-timer.C:
		return probeUnavailable
	case <-ctx.Done():
		return probeAborted
	}
}

// apply updates a single pane's `cwdAvailable` bit and logs on
// transitions. The effective stoplight change is handled inside
// `Pane.SetCwdAvailable` (no-ops when the bit doesn't change;
// fans out subscribers only on a real effective-stoplight
// transition).
func (w *Watcher) apply(p *pty.Pane, available bool) {
	was := p.CwdAvailable()
	p.SetCwdAvailable(available)
	if was && !available {
		w.logger.Warn("mountprobe: cwd unreachable — pane effective stoplight is red",
			"pane", p.ID, "project", p.ProjectID, "cwd", p.Cwd)
	} else if !was && available {
		w.logger.Info("mountprobe: cwd recovered — pane effective stoplight restored",
			"pane", p.ID, "project", p.ProjectID, "cwd", p.Cwd)
	}
}

// SetStatFn overrides the stat implementation for tests. Production
// callers should never call this — the default uses os.Stat.
func (w *Watcher) SetStatFn(fn func(path string) error) {
	w.statFn = fn
}

// PeakWorkers returns the highest concurrent active-worker count
// observed since construction. Workers are counted from semaphore
// acquisition to function exit, so a stuck inner stat goroutine
// past the timeout does NOT keep its slot counted — the peak
// reflects the actual worker-pool dispatch, which is what the
// concurrency cap bounds. Exposed for test assertions.
func (w *Watcher) PeakWorkers() int32 {
	return w.peakWorkers.Load()
}

// ResetPeakWorkers zeroes the peak counter. Useful for tests that
// want to sample a specific tick.
func (w *Watcher) ResetPeakWorkers() {
	w.peakWorkers.Store(0)
}
