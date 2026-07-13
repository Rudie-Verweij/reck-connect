package usage

import (
	"context"
	"time"
)

// RunSampler periodically flushes samples the change-gate withheld under
// the per-session rate cap, so a value that changed once and then went
// quiet still lands within ~one cap interval.
//
// It deliberately writes NO heartbeat rows of its own: an idle session
// (no changed candidate pending) produces nothing, keeping DB growth
// proportional to activity rather than to how long panes stay open.
//
// Blocks until ctx is cancelled. Safe to call with a nil ingester (no-op
// until cancellation) so the daemon can start it unconditionally.
func RunSampler(ctx context.Context, ing *Ingester, interval time.Duration) {
	if ing == nil {
		<-ctx.Done()
		return
	}
	if interval <= 0 {
		interval = time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ing.Flush()
		}
	}
}
