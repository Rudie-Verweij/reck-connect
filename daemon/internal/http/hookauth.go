// Audit fix F4 : per-pane HMAC + nonce-replay protection for the
// agent-event endpoint. The old design exempted loopback callers from
// bearer auth so Claude Code lifecycle hook shims (which inherit no
// token) could POST stoplight transitions — but any other local process
// running as the same UID could forge those POSTs and drive any pane's
// stoplight. F4 replaces the loopback exemption with:
//
//   - A per-pane 32-byte secret generated on Pane.Spawn, injected into
//     the PTY child via RECK_HOOK_SECRET.
//   - A bash shim (reck-claude-hook.sh) that signs each POST with
//     HMAC-SHA256 over METHOD + "\n" + path + "\n" + body. Headers
//     X-Reck-Hook-Sig / X-Reck-Hook-Ts / X-Reck-Hook-Nonce carry the
//     proof to the daemon.
//   - This file: server-side verification + a bounded nonce store that
//     rejects replays inside a 60s timestamp window.
//
// Design notes:
//   - Per-pane cap on the nonce store + a global cap together bound
//     memory regardless of how many panes exist or how aggressively a
//     single pane fires events. Cap-hit is a 429 (the request is NOT
//     accepted nor inserted) so a misbehaving caller can't push the
//     daemon over its memory ceiling by exhausting the nonce store.
//   - Pruning is opportunistic on insert (not a background goroutine)
//     to keep the store self-contained: tests don't need to manage
//     timers, and there's no cleanup path that can outlive the
//     daemon's lifetime.
//   - Nonce de-dup is the primary defense — a replayed nonce is
//     rejected regardless of timestamp. The ±60s window is a coarse
//     sanity check (NTP step tolerance + room for hook latency) so
//     the store doesn't have to remember every nonce ever seen.
//
package http

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// HookAuthError is returned by VerifyHookSignature on rejection. The
// HTTP status the handler should map each variant to is documented per
// constant; keeping them as named errors lets the caller use
// errors.Is/As to pick the right status without re-parsing strings.
type HookAuthError struct {
	Code    int    // HTTP status the caller should respond with
	Reason  string // short, log-safe reason (no secrets)
	wrapped error
}

func (e *HookAuthError) Error() string { return e.Reason }
func (e *HookAuthError) Unwrap() error { return e.wrapped }

// Error reasons are stable strings so tests can match against them
// without coupling to the wrapped error's text.
const (
	hookAuthReasonMissingHeaders = "missing hook signature headers"
	hookAuthReasonBadTimestamp   = "invalid timestamp header"
	hookAuthReasonStaleTimestamp = "timestamp outside acceptance window"
	hookAuthReasonBadNonce       = "invalid nonce header"
	hookAuthReasonReplayedNonce  = "nonce already seen"
	hookAuthReasonBadSignature   = "signature mismatch"
	hookAuthReasonNonceCapHit    = "nonce store full"
)

// hookAuthTimestampSkew is the symmetric ±window for accepted
// timestamps. 60s gives NTP step tolerance + room for hook-shim
// latency on a slow box; tighter than that breaks legitimate hooks
// when the wall-clock jumps; looser would let an attacker who
// briefly captured a signed envelope replay it long after the fact
// (the per-pane nonce store still blocks straight replays, but the
// window bounds the memory the store has to dedicate per pane).
const hookAuthTimestampSkew = 60 * time.Second

// hookAuthHeaderSig / Ts / Nonce are the canonical request-header names
// the shim sets and the daemon reads. Pulled into constants so the
// shim, server, and tests can never drift out of sync silently.
const (
	HookAuthHeaderSig   = "X-Reck-Hook-Sig"
	HookAuthHeaderTs    = "X-Reck-Hook-Ts"
	HookAuthHeaderNonce = "X-Reck-Hook-Nonce"
)

// NonceStore caps:
//
//   - perPaneNonceCap (256): a hook running at one event per second can
//     accumulate at most ~60 entries inside the 60s window before the
//     pruner drops the oldest. 256 leaves significant headroom for
//     bursty hooks (a tool with a tight sub-second loop) without
//     letting one pane's misbehaviour starve another.
//   - globalNonceCap (4096): hard ceiling across all panes. With 16
//     active panes signing at the steady-state ~60/window rate, we
//     sit at ~960 entries — well under 4096. Hitting this cap means
//     either a runaway global event rate or a coordinated DoS;
//     either way, returning 429 + refusing to insert is the right
//     fail-closed behaviour.
const (
	perPaneNonceCap = 256
	globalNonceCap  = 4096
)

// nonceEntry is one accepted nonce. paneID lets the per-pane prune
// loop find its own entries quickly without iterating siblings.
type nonceEntry struct {
	paneID string
	nonce  string
	at     time.Time
}

// NonceStore is a bounded in-memory replay-defense store keyed by
// (paneID, nonce). Safe for concurrent use. A single store instance
// per Server is plenty — there's no contention path worth sharding.
type NonceStore struct {
	mu sync.Mutex
	// byPane indexes per-pane nonce-set membership for O(1) replay
	// detection without a global scan. Each value is the set of
	// nonces still inside the acceptance window for that pane.
	byPane map[string]map[string]struct{}
	// counts caches len(byPane[paneID]) so per-pane cap checks don't
	// have to take the slow map-len path. Kept in sync on every
	// insert/prune operation.
	counts map[string]int
	// global is a doubly-purpose ring: dimension for the global cap,
	// and the source of truth for the "oldest first" prune order.
	// Stored as a slice — the access pattern is "scan from head,
	// drop expired" which slice-as-FIFO handles cheapest.
	global []nonceEntry
	// nowFn is time.Now by default; tests override it to drive
	// timestamp acceptance and prune behaviour deterministically.
	nowFn func() time.Time
}

// NewNonceStore returns an empty store ready for use.
func NewNonceStore() *NonceStore {
	return &NonceStore{
		byPane: make(map[string]map[string]struct{}),
		counts: make(map[string]int),
		nowFn:  time.Now,
	}
}

// SetClock overrides the store's clock; intended for tests. Production
// code should never call this — leaving the default time.Now keeps the
// store correct under wall-clock changes.
func (s *NonceStore) SetClock(now func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nowFn = now
}

// Len returns the current global entry count. Test-only seam — handlers
// don't need it.
func (s *NonceStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.global)
}

// CheckAndStore atomically tests whether (paneID, nonce) has been seen
// inside the acceptance window. On a fresh nonce it inserts and returns
// nil. On a replay it returns a *HookAuthError with code 401. On a
// per-pane or global cap hit (after pruning) it returns a *HookAuthError
// with code 429 and does NOT insert — the caller must respond and the
// shim will retry with a fresh nonce.
//
// Pruning runs inline before each insert: every entry older than the
// configured skew window is removed. Keeping the prune in-band means
// the store's footprint never grows unboundedly even under a hostile
// caller, without needing a background goroutine that could outlive
// the daemon's lifetime in tests.
func (s *NonceStore) CheckAndStore(paneID, nonce string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.nowFn()
	s.pruneLocked(now)

	if perPane, ok := s.byPane[paneID]; ok {
		if _, replay := perPane[nonce]; replay {
			return &HookAuthError{Code: 401, Reason: hookAuthReasonReplayedNonce}
		}
	}

	// Cap checks AFTER prune so legitimate retries on a previously-full
	// store can succeed once the window slides. Per-pane cap fires
	// first so one runaway pane can't starve well-behaved siblings.
	if s.counts[paneID] >= perPaneNonceCap {
		return &HookAuthError{Code: 429, Reason: hookAuthReasonNonceCapHit}
	}
	if len(s.global) >= globalNonceCap {
		return &HookAuthError{Code: 429, Reason: hookAuthReasonNonceCapHit}
	}

	if s.byPane[paneID] == nil {
		s.byPane[paneID] = make(map[string]struct{})
	}
	s.byPane[paneID][nonce] = struct{}{}
	s.counts[paneID]++
	s.global = append(s.global, nonceEntry{paneID: paneID, nonce: nonce, at: now})
	return nil
}

// pruneLocked drops entries older than now - 2*skew. We use 2× the
// timestamp-acceptance skew so a nonce that was accepted at the very
// edge of the window is still remembered long enough to block its
// replay at the opposite edge — without this, a nonce captured at
// (now - skew) could be replayed at (now + skew) once it had aged out
// of the store. Caller MUST hold s.mu.
func (s *NonceStore) pruneLocked(now time.Time) {
	cutoff := now.Add(-2 * hookAuthTimestampSkew)
	// Walk from the head until we find the first entry inside the
	// window. Slice append keeps the global list ordered by insertion
	// time, which is the same as ordering by `at` because nowFn is
	// monotonic in production. Tests that drive the clock backwards
	// for one step still see correct prune behaviour because we re-
	// scan the whole prefix every call.
	dropTo := 0
	for ; dropTo < len(s.global); dropTo++ {
		if !s.global[dropTo].at.Before(cutoff) {
			break
		}
		ent := s.global[dropTo]
		if perPane, ok := s.byPane[ent.paneID]; ok {
			delete(perPane, ent.nonce)
			s.counts[ent.paneID]--
			if s.counts[ent.paneID] <= 0 {
				delete(s.byPane, ent.paneID)
				delete(s.counts, ent.paneID)
			}
		}
	}
	if dropTo > 0 {
		// Compact: drop the expired prefix. Allocate a new backing
		// array when we'd otherwise pin a large one — the typical
		// steady-state size is small.
		s.global = append(s.global[:0], s.global[dropTo:]...)
	}
}

// VerifyHookSignature is the full server-side check for one inbound
// agent-event POST. Returns nil iff the signature, timestamp, and
// nonce are all good (and the nonce has been recorded for replay
// defense). On any failure returns a *HookAuthError carrying the HTTP
// status and a log-safe reason.
//
// Inputs are the request context — method, request-target path, raw
// body — and the per-pane secret loaded by the handler. Headers are
// passed in via individual params rather than nethttp.Request so this
// function stays trivially testable without an HTTP fixture.
//
// The signed string format is:
//
//	METHOD + "\n" + PATH + "\n" + BODY
//
// where PATH is the request URI's path component (no query string —
// agent-event has no required query params after F4). Method binding
// stops a captured GET signature from being replayed against POST,
// path binding stops cross-endpoint replay if the daemon ever grows
// other HMAC-protected routes that share a secret class.
func VerifyHookSignature(
	store *NonceStore,
	paneSecret string,
	method, path string,
	body []byte,
	sigHex, tsStr, nonce string,
) error {
	if sigHex == "" || tsStr == "" || nonce == "" {
		return &HookAuthError{Code: 401, Reason: hookAuthReasonMissingHeaders}
	}
	// Bound the nonce length so a malicious shim can't fill the per-pane
	// cap with one giant string. 64 hex chars is twice the shim's 16-byte
	// nonce — generous headroom without an unbounded memory footprint.
	if len(nonce) == 0 || len(nonce) > 64 {
		return &HookAuthError{Code: 401, Reason: hookAuthReasonBadNonce}
	}

	// Parse + window-check the timestamp before doing any HMAC work so
	// stale envelopes can't burn CPU. The 401 is intentional: stale
	// timestamp is auth-class failure, not a "fix your config" 400.
	tsInt, err := parseUnixSeconds(tsStr)
	if err != nil {
		return &HookAuthError{Code: 401, Reason: hookAuthReasonBadTimestamp, wrapped: err}
	}
	now := store.nowFn()
	ts := time.Unix(tsInt, 0)
	if delta := now.Sub(ts); delta > hookAuthTimestampSkew || -delta > hookAuthTimestampSkew {
		return &HookAuthError{Code: 401, Reason: hookAuthReasonStaleTimestamp}
	}

	// Recompute the canonical string and HMAC. Use the per-pane secret
	// as the HMAC key; constant-time compare so a length-extension or
	// timing probe is no help to an attacker.
	canonical := method + "\n" + path + "\n" + string(body)
	mac := hmac.New(sha256.New, []byte(paneSecret))
	mac.Write([]byte(canonical))
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sigHex), []byte(expected)) != 1 {
		return &HookAuthError{Code: 401, Reason: hookAuthReasonBadSignature}
	}

	// Signature is good — record the nonce so a replay would now fail.
	// Cap-hit returns 429 without inserting; the shim retries on the
	// next event with a fresh nonce.
	return store.CheckAndStore(paneID(path), nonce)
}

// paneID extracts the pane id from "/panes/<id>/agent-event". Returns
// the full path on a non-matching shape so the nonce store still keys
// on something deterministic — the HMAC check would have already failed
// upstream of any code that would store under an unexpected key.
func paneID(path string) string {
	const prefix = "/panes/"
	const suffix = "/agent-event"
	if len(path) < len(prefix)+len(suffix) {
		return path
	}
	if path[:len(prefix)] != prefix {
		return path
	}
	if path[len(path)-len(suffix):] != suffix {
		return path
	}
	return path[len(prefix) : len(path)-len(suffix)]
}

// parseUnixSeconds is a strict integer parser. We don't use strconv
// directly so the error wrapping carries a stable message in tests.
func parseUnixSeconds(s string) (int64, error) {
	if s == "" {
		return 0, errors.New("empty timestamp")
	}
	var n int64
	var sign int64 = 1
	i := 0
	if s[0] == '-' {
		sign = -1
		i++
	}
	if i == len(s) {
		return 0, errors.New("timestamp has no digits")
	}
	for ; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, errors.New("timestamp contains non-digit")
		}
		// Bound at int64 / 10 - 9 to avoid overflow on the multiply.
		// This caps the timestamp at ~year 292 billion AD — adequate.
		if n > (1<<62)/10 {
			return 0, errors.New("timestamp too large")
		}
		n = n*10 + int64(c-'0')
	}
	return n * sign, nil
}
