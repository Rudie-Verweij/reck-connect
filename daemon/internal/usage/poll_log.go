package usage

import "sync"

// Logging for the background pollers.
//
// Both the quota poller and the plan probe run on a timer forever, so
// logging every outcome would drown the daemon log, and logging nothing
// hides a poller that has never once succeeded. Neither is acceptable:
// "no rows are being written and nothing says why" is exactly the failure
// that is hardest to notice, because the symptom is an absence.
//
// So they log on TRANSITIONS. The first time a condition appears it is
// reported at a visible level; while it persists it stays silent; when it
// clears, the recovery is reported too. A daemon that cannot read
// credentials says so once, loudly, instead of once every five minutes or
// never at all.

// changeLogger tracks the last reported state so a caller can log only
// when it changes. Safe for concurrent use.
type changeLogger struct {
	mu   sync.Mutex
	last string
	seen bool
}

// changed reports whether state differs from the previously reported one,
// recording it as the new state. The first call always reports true, so
// an initial success is announced as well as an initial failure.
func (c *changeLogger) changed(state string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen && c.last == state {
		return false
	}
	c.last = state
	c.seen = true
	return true
}
