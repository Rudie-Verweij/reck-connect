package usage

import (
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// failStore wraps a real Store but can be toggled to fail context inserts,
// so we can prove the gate doesn't lose a sample on write error (G1).
type failStore struct {
	inner    *Store
	failCtx  bool
	ctxCalls int
}

func (f *failStore) InsertContextSample(cs ContextSample) error {
	f.ctxCalls++
	if f.failCtx {
		return errors.New("injected insert failure")
	}
	return f.inner.InsertContextSample(cs)
}
func (f *failStore) InsertQuotaSample(qs QuotaSample) error { return f.inner.InsertQuotaSample(qs) }
func (f *failStore) UpsertSession(a, b, c, d, e string, t time.Time) error {
	return f.inner.UpsertSession(a, b, c, d, e, t)
}

func TestIngest_InsertError_KeepsSampleForRetry(t *testing.T) {
	real := openTestStore(t)
	fs := &failStore{inner: real, failCtx: true}
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0).UTC()}
	ing := &Ingester{
		store:      fs,
		RateCap:    DefaultRateCap,
		JumpPct:    DefaultJumpPct,
		JumpTokens: DefaultJumpTokens,
		now:        clk.now,
		logger:     testLogger(),
		ctx:        make(map[string]*ctxState),
	}

	// First ingest: insert fails. The gate must NOT claim it written.
	res, err := ing.Ingest(meta(), []byte(fullPayload))
	if err != nil {
		t.Fatal(err)
	}
	if res.ContextWritten {
		t.Fatal("ContextWritten should be false when the insert errored")
	}
	if n, _ := real.CountContextSamples("sess-1"); n != 0 {
		t.Fatalf("expected 0 stored rows after failed insert, got %d", n)
	}

	// Recover the store and flush past the cap: the withheld sample must
	// now land (it was kept pending, state never advanced).
	fs.failCtx = false
	clk.add(2 * time.Minute)
	ing.Flush()
	if n, _ := real.CountContextSamples("sess-1"); n != 1 {
		t.Fatalf("expected the retried sample to land, got %d rows", n)
	}
}
