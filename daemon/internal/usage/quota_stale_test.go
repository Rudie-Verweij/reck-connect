package usage

import (
	"strconv"
	"testing"
	"time"
)

func pctPtr(v float64) *float64 { return &v }
func unixPtr(v int64) *int64    { return &v }

func TestDropExpiredWindows(t *testing.T) {
	now := time.Unix(1_000_000, 0).UTC()

	tests := []struct {
		name string
		in   QuotaSample
		want QuotaSample
	}{
		{
			name: "window still open is kept",
			in: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(42), ResetsAt: unixPtr(now.Unix() + 1)},
			},
			want: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(42), ResetsAt: unixPtr(now.Unix() + 1)},
			},
		},
		{
			name: "window that already reset is dropped",
			in: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(72), ResetsAt: unixPtr(now.Unix() - 1)},
			},
			want: QuotaSample{FiveHour: Bucket{}},
		},
		{
			name: "window resetting exactly now is dropped",
			in: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(72), ResetsAt: unixPtr(now.Unix())},
			},
			want: QuotaSample{FiveHour: Bucket{}},
		},
		{
			name: "bucket with no resets_at is kept — absent an expiry it cannot be called stale",
			in: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(0)},
			},
			want: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(0)},
			},
		},
		{
			name: "buckets expire independently: dead 5h, live 7d",
			in: QuotaSample{
				FiveHour: Bucket{Pct: pctPtr(72), ResetsAt: unixPtr(now.Unix() - 3600)},
				SevenDay: Bucket{Pct: pctPtr(11), ResetsAt: unixPtr(now.Unix() + 3600)},
			},
			want: QuotaSample{
				FiveHour: Bucket{},
				SevenDay: Bucket{Pct: pctPtr(11), ResetsAt: unixPtr(now.Unix() + 3600)},
			},
		},
		{
			name: "every window covered",
			in: QuotaSample{
				FiveHour:       Bucket{Pct: pctPtr(1), ResetsAt: unixPtr(now.Unix() - 1)},
				SevenDay:       Bucket{Pct: pctPtr(2), ResetsAt: unixPtr(now.Unix() - 1)},
				SevenDayOpus:   Bucket{Pct: pctPtr(3), ResetsAt: unixPtr(now.Unix() - 1)},
				SevenDaySonnet: Bucket{Pct: pctPtr(4), ResetsAt: unixPtr(now.Unix() - 1)},
			},
			want: QuotaSample{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Identifying fields must survive untouched.
			tc.in.Source = "statusline"
			tc.want.Source = "statusline"

			got := dropExpiredWindows(tc.in, now)

			for _, b := range []struct {
				name      string
				got, want Bucket
			}{
				{"five_hour", got.FiveHour, tc.want.FiveHour},
				{"seven_day", got.SevenDay, tc.want.SevenDay},
				{"seven_day_opus", got.SevenDayOpus, tc.want.SevenDayOpus},
				{"seven_day_sonnet", got.SevenDaySonnet, tc.want.SevenDaySonnet},
			} {
				if !bucketEqual(b.got, b.want) {
					t.Errorf("%s = %s, want %s", b.name, fmtBucket(b.got), fmtBucket(b.want))
				}
			}
			if got.Source != tc.want.Source {
				t.Errorf("Source = %q, want %q", got.Source, tc.want.Source)
			}
		})
	}
}

// The guard must not mutate its input — callers keep the observed sample
// for the live glance, which must still show what was actually reported.
func TestDropExpiredWindowsDoesNotMutateInput(t *testing.T) {
	now := time.Unix(1_000_000, 0).UTC()
	in := QuotaSample{
		FiveHour: Bucket{Pct: pctPtr(72), ResetsAt: unixPtr(now.Unix() - 1)},
	}

	_ = dropExpiredWindows(in, now)

	if in.FiveHour.Pct == nil || *in.FiveHour.Pct != 72 {
		t.Fatalf("input FiveHour.Pct was mutated: %s", fmtBucket(in.FiveHour))
	}
	if in.FiveHour.ResetsAt == nil {
		t.Fatal("input FiveHour.ResetsAt was mutated")
	}
}

// fmtBucket renders a Bucket for failure messages. bucketEqual (ingest.go)
// already provides the comparison.
func fmtBucket(b Bucket) string {
	p, r := "nil", "nil"
	if b.Pct != nil {
		p = strconv.FormatFloat(*b.Pct, 'g', -1, 64)
	}
	if b.ResetsAt != nil {
		r = time.Unix(*b.ResetsAt, 0).UTC().Format(time.RFC3339)
	}
	return "{pct=" + p + " resets=" + r + "}"
}

func TestNormalizeResetsAtSnapsTheJitter(t *testing.T) {
	// The values seen in a real export: one 18:00:00 window recorded as
	// both of these, alternating, because the poller truncated a timestamp
	// carrying sub-second precision.
	const boundary = 1785175200 // 2026-07-27T18:00:00Z
	for _, raw := range []int64{1785175199, 1785175200, 1785175170, 1785175229} {
		got := NormalizeResetsAt(Bucket{ResetsAt: &raw})
		if got.ResetsAt == nil || *got.ResetsAt != boundary {
			t.Errorf("NormalizeResetsAt(%d) = %v, want %d", raw, got.ResetsAt, boundary)
		}
	}

	// Two readings of one window must become byte-identical — that is the
	// whole point, since resets_at is a window's identity.
	a, b := int64(1785175199), int64(1785175200)
	if *NormalizeResetsAt(Bucket{ResetsAt: &a}).ResetsAt !=
		*NormalizeResetsAt(Bucket{ResetsAt: &b}).ResetsAt {
		t.Error("the two jittered forms did not converge")
	}

	// A nil expiry stays nil rather than becoming a misleading zero.
	if got := NormalizeResetsAt(Bucket{}); got.ResetsAt != nil {
		t.Errorf("nil resets_at became %v", *got.ResetsAt)
	}

	// Pct rides through untouched.
	pct := 42.5
	if got := NormalizeResetsAt(Bucket{Pct: &pct, ResetsAt: &a}); got.Pct == nil || *got.Pct != 42.5 {
		t.Errorf("Pct was disturbed: %v", got.Pct)
	}
}
