package usage

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"
)

// Default gating parameters. "per minute" here is a ceiling during
// activity, not a heartbeat: at most one row per session per RateCap
// unless the value jumps, in which case we write immediately.
const (
	DefaultRateCap    = time.Minute
	DefaultJumpPct    = 2.0  // used_percentage points
	DefaultJumpTokens = 5000 // context input tokens
)

// IngestMeta carries the trusted per-pane attribution the daemon knows
// from the authenticated request (NOT from the untrusted payload body).
type IngestMeta struct {
	PaneID    string
	ProjectID string
	Agent     string
}

// IngestResult reports what the gate decided, for logging and tests.
type IngestResult struct {
	ContextWritten bool
	QuotaWritten   bool
	SessionSeen    bool
}

// wire mirrors only the statusline fields we consume. Everything is a
// pointer/optional so a payload from an older or newer CLI that omits a
// block degrades to "no data for that dimension" rather than an error.
// cwd and transcript_path are deliberately absent — we never read or
// store them.
type wire struct {
	SessionID string `json:"session_id"`
	Model     struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"model"`
	ContextWindow *struct {
		TotalInputTokens  *int64   `json:"total_input_tokens"`
		ContextWindowSize *int64   `json:"context_window_size"`
		UsedPercentage    *float64 `json:"used_percentage"`
		CurrentUsage      *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"current_usage"`
	} `json:"context_window"`
	RateLimits *struct {
		FiveHour       *wireBucket `json:"five_hour"`
		SevenDay       *wireBucket `json:"seven_day"`
		SevenDayOpus   *wireBucket `json:"seven_day_opus"`
		SevenDaySonnet *wireBucket `json:"seven_day_sonnet"`
	} `json:"rate_limits"`
}

type wireBucket struct {
	UsedPercentage *float64 `json:"used_percentage"`
	ResetsAt       *int64   `json:"resets_at"`
}

type ctxState struct {
	written   ContextSample // last row actually persisted
	hasWrite  bool
	lastWrite time.Time
	pending   *ContextSample // changed but withheld by the rate cap
	lastSeen  time.Time      // last agent_sessions.last_seen upsert
	seen      *ContextSample // most recent observation (for the live glance)
}

type quotaState struct {
	written   QuotaSample
	hasWrite  bool
	lastWrite time.Time
	pending   *QuotaSample
	seen      *QuotaSample // most recent observation (for the live glance)
}

// sampleStore is the subset of *Store the ingester writes through. Kept as
// an interface so tests can inject a failure-injecting fake (accept
// interfaces, return structs). *Store satisfies it.
type sampleStore interface {
	InsertContextSample(ContextSample) error
	InsertQuotaSample(QuotaSample) error
	UpsertSession(sessionID, projectID, agent, model, displayName string, seen time.Time) error
}

// Ingester applies the change gate + rate cap to statusline payloads and
// writes surviving samples to the store. Safe for concurrent use across
// panes.
type Ingester struct {
	store sampleStore

	RateCap    time.Duration
	JumpPct    float64
	JumpTokens int64

	now    func() time.Time
	logger *slog.Logger

	mu    sync.Mutex
	ctx   map[string]*ctxState // keyed by session_id
	quota quotaState
}

// NewIngester constructs an Ingester with default gating parameters.
func NewIngester(store *Store) *Ingester {
	return &Ingester{
		store:      store,
		RateCap:    DefaultRateCap,
		JumpPct:    DefaultJumpPct,
		JumpTokens: DefaultJumpTokens,
		now:        func() time.Time { return time.Now().UTC() },
		logger:     slog.Default(),
		ctx:        make(map[string]*ctxState),
	}
}

// Ingest parses one statusline payload and writes any surviving context /
// quota samples. A malformed body is an error (the caller should 400);
// missing individual blocks are not.
func (i *Ingester) Ingest(meta IngestMeta, raw []byte) (IngestResult, error) {
	var p wire
	if err := json.Unmarshal(raw, &p); err != nil {
		return IngestResult{}, errors.New("usage: malformed statusline payload")
	}

	now := i.now()
	var res IngestResult

	i.mu.Lock()
	defer i.mu.Unlock()

	// Liveness: record the session was alive now, rate-limited so a burst
	// of renders doesn't hammer the row. Bounded — one row per session.
	if p.SessionID != "" {
		st := i.ctxStateLocked(p.SessionID)
		if st.lastSeen.IsZero() || now.Sub(st.lastSeen) >= i.RateCap {
			if err := i.store.UpsertSession(p.SessionID, meta.ProjectID, meta.Agent, p.Model.ID, "", now); err == nil {
				st.lastSeen = now
			}
		}
		res.SessionSeen = true
	}

	// Context dimension.
	if cand, ok := i.contextCandidate(meta, &p, now); ok {
		c := cand
		i.ctxStateLocked(p.SessionID).seen = &c
		res.ContextWritten = i.gateContext(p.SessionID, cand, now)
	}

	// Quota dimension (account-level, coalesced into one series).
	if cand, ok := i.quotaCandidate(&p, now); ok {
		c := cand
		i.quota.seen = &c
		res.QuotaWritten = i.gateQuota(cand, now)
	}

	return res, nil
}

// Flush writes any samples withheld by the rate cap whose cap window has
// since elapsed. Called by the minute ticker so a value that changed once
// and then went quiet still lands within ~one cap interval.
func (i *Ingester) Flush() {
	now := i.now()
	i.mu.Lock()
	defer i.mu.Unlock()

	for _, st := range i.ctx {
		if st.pending == nil {
			continue
		}
		if !st.hasWrite || now.Sub(st.lastWrite) >= i.RateCap {
			if err := i.store.InsertContextSample(*st.pending); err != nil {
				// Keep pending so the next tick retries; don't advance state.
				i.logger.Warn("usage: context flush insert failed; will retry", "err", err)
				continue
			}
			st.written = *st.pending
			st.hasWrite = true
			st.lastWrite = now
			st.pending = nil
		}
	}
	if i.quota.pending != nil {
		if !i.quota.hasWrite || now.Sub(i.quota.lastWrite) >= i.RateCap {
			if err := i.store.InsertQuotaSample(*i.quota.pending); err != nil {
				i.logger.Warn("usage: quota flush insert failed; will retry", "err", err)
			} else {
				i.quota.written = *i.quota.pending
				i.quota.hasWrite = true
				i.quota.lastWrite = now
				i.quota.pending = nil
			}
		}
	}
}

// Snapshot returns the latest observed context-fill % for a session and
// the latest account-level 5h / weekly quota %, for the live rail glance.
// Any value with no observation yet is returned as nil. Returned pointers
// are fresh copies, safe for the caller to retain.
func (i *Ingester) Snapshot(sessionID string) (contextPct, fiveHourPct, sevenDayPct *float64) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if st := i.ctx[sessionID]; st != nil && st.seen != nil {
		v := st.seen.UsedPct
		contextPct = &v
	}
	if i.quota.seen != nil {
		fiveHourPct = copyF(i.quota.seen.FiveHour.Pct)
		sevenDayPct = copyF(i.quota.seen.SevenDay.Pct)
	}
	return
}

func copyF(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func (i *Ingester) ctxStateLocked(sid string) *ctxState {
	st := i.ctx[sid]
	if st == nil {
		st = &ctxState{}
		i.ctx[sid] = st
	}
	return st
}

// contextCandidate builds a ContextSample from the payload, or ok=false
// when the payload carried no context_window block.
func (i *Ingester) contextCandidate(meta IngestMeta, p *wire, now time.Time) (ContextSample, bool) {
	cw := p.ContextWindow
	if cw == nil {
		return ContextSample{}, false
	}
	cs := ContextSample{
		TS:        now,
		SessionID: p.SessionID,
		PaneID:    meta.PaneID,
		ProjectID: meta.ProjectID,
		Agent:     meta.Agent,
		Model:     p.Model.ID,
		Source:    "statusline",
	}
	if cw.TotalInputTokens != nil {
		cs.ContextInputTokens = *cw.TotalInputTokens
	}
	if cw.ContextWindowSize != nil {
		cs.ContextWindowSize = *cw.ContextWindowSize
	}
	if cw.UsedPercentage != nil {
		cs.UsedPct = *cw.UsedPercentage
	} else if cs.ContextWindowSize > 0 {
		cs.UsedPct = float64(cs.ContextInputTokens) / float64(cs.ContextWindowSize) * 100
	}
	if u := cw.CurrentUsage; u != nil {
		cs.CurInput = u.InputTokens
		cs.CurOutput = u.OutputTokens
		cs.CacheCreation = u.CacheCreationInputTokens
		cs.CacheRead = u.CacheReadInputTokens
	}
	return cs, true
}

func (i *Ingester) gateContext(sid string, cand ContextSample, now time.Time) bool {
	st := i.ctxStateLocked(sid)
	if st.hasWrite && !contextAnyChange(st.written, cand) {
		// Idle re-render with identical numbers: write nothing.
		return false
	}
	// Something changed (or first sample). Decide write-now vs withhold.
	firstOrJump := !st.hasWrite || contextIsJump(st.written, cand, i.JumpTokens, i.JumpPct)
	capElapsed := st.hasWrite && now.Sub(st.lastWrite) >= i.RateCap
	if firstOrJump || capElapsed {
		if err := i.store.InsertContextSample(cand); err != nil {
			// Don't advance written/lastWrite on failure — that would both
			// lose this sample and gate out the next identical reading.
			// Stash as pending so the next Flush retries.
			i.logger.Warn("usage: context sample insert failed; will retry", "err", err, "session", sid)
			c := cand
			st.pending = &c
			return false
		}
		st.written = cand
		st.hasWrite = true
		st.lastWrite = now
		st.pending = nil
		return true
	}
	// Within the cap and not a jump: stash for the next Flush.
	c := cand
	st.pending = &c
	return false
}

func (i *Ingester) quotaCandidate(p *wire, now time.Time) (QuotaSample, bool) {
	rl := p.RateLimits
	if rl == nil {
		return QuotaSample{}, false
	}
	qs := QuotaSample{
		TS:                now,
		ReportedBySession: p.SessionID,
		ModelFamily:       modelFamily(p.Model.ID),
		Source:            "statusline",
		FiveHour:          bucketOf(rl.FiveHour),
		SevenDay:          bucketOf(rl.SevenDay),
		SevenDayOpus:      bucketOf(rl.SevenDayOpus),
		SevenDaySonnet:    bucketOf(rl.SevenDaySonnet),
	}
	// A rate_limits block with no usable bucket is not worth a row.
	if qs.FiveHour.Pct == nil && qs.SevenDay.Pct == nil &&
		qs.SevenDayOpus.Pct == nil && qs.SevenDaySonnet.Pct == nil {
		return QuotaSample{}, false
	}
	return qs, true
}

func (i *Ingester) gateQuota(cand QuotaSample, now time.Time) bool {
	q := &i.quota
	if q.hasWrite && !quotaAnyChange(q.written, cand) {
		return false
	}
	firstOrJump := !q.hasWrite || quotaIsJump(q.written, cand, i.JumpPct)
	capElapsed := q.hasWrite && now.Sub(q.lastWrite) >= i.RateCap
	if firstOrJump || capElapsed {
		if err := i.store.InsertQuotaSample(cand); err != nil {
			i.logger.Warn("usage: quota sample insert failed; will retry", "err", err)
			c := cand
			q.pending = &c
			return false
		}
		q.written = cand
		q.hasWrite = true
		q.lastWrite = now
		q.pending = nil
		return true
	}
	c := cand
	q.pending = &c
	return false
}

// --- change/jump predicates ---

func contextAnyChange(a, b ContextSample) bool {
	return a.ContextInputTokens != b.ContextInputTokens ||
		a.ContextWindowSize != b.ContextWindowSize ||
		a.UsedPct != b.UsedPct ||
		a.CurInput != b.CurInput || a.CurOutput != b.CurOutput ||
		a.CacheCreation != b.CacheCreation || a.CacheRead != b.CacheRead
}

func contextIsJump(a, b ContextSample, jumpTokens int64, jumpPct float64) bool {
	if absI(a.ContextInputTokens-b.ContextInputTokens) >= jumpTokens {
		return true
	}
	if math.Abs(a.UsedPct-b.UsedPct) >= jumpPct {
		return true
	}
	return false
}

func quotaAnyChange(a, b QuotaSample) bool {
	return !bucketEqual(a.FiveHour, b.FiveHour) ||
		!bucketEqual(a.SevenDay, b.SevenDay) ||
		!bucketEqual(a.SevenDayOpus, b.SevenDayOpus) ||
		!bucketEqual(a.SevenDaySonnet, b.SevenDaySonnet)
}

func quotaIsJump(a, b QuotaSample, jumpPct float64) bool {
	return bucketJump(a.FiveHour, b.FiveHour, jumpPct) ||
		bucketJump(a.SevenDay, b.SevenDay, jumpPct) ||
		bucketJump(a.SevenDayOpus, b.SevenDayOpus, jumpPct) ||
		bucketJump(a.SevenDaySonnet, b.SevenDaySonnet, jumpPct)
}

func bucketEqual(a, b Bucket) bool {
	return eqF(a.Pct, b.Pct) && eqI(a.ResetsAt, b.ResetsAt)
}

func bucketJump(a, b Bucket, jumpPct float64) bool {
	if a.Pct == nil || b.Pct == nil {
		return a.Pct != b.Pct // appearance/disappearance is worth a row
	}
	return math.Abs(*a.Pct-*b.Pct) >= jumpPct
}

func bucketOf(b *wireBucket) Bucket {
	if b == nil {
		return Bucket{}
	}
	return Bucket{Pct: b.UsedPercentage, ResetsAt: b.ResetsAt}
}

func modelFamily(id string) string {
	l := strings.ToLower(id)
	switch {
	case strings.Contains(l, "opus"):
		return "opus"
	case strings.Contains(l, "sonnet"):
		return "sonnet"
	case strings.Contains(l, "haiku"):
		return "haiku"
	default:
		return ""
	}
}

func absI(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func eqF(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func eqI(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
