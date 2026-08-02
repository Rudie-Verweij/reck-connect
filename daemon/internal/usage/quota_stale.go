package usage

import "time"

// Staleness guard for quota windows.
//
// WHY THIS EXISTS: a rate-limit bucket names the instant its window
// resets. Once that instant has passed, the utilization it carries
// describes a window that no longer exists — it is history, not a
// reading. Writing it with ts=now turns it into a present-tense claim
// about a dead window, and because the histogram bins quota with
// MAX(pct) a single such row owns its whole bin.
//
// The rows are real and they are not rare. On one station, 37 of 267
// statusline-sourced quota rows carried a five_hour window that had
// already reset when written — the worst by 69.8 hours. One wrote 72%
// against a window 23.8h dead while the live window sat at 17%; that is
// the tallest spike in the series.
//
// Two upstream behaviours produce them:
//
//   - Claude Code fills the statusline payload's `rate_limits` from the
//     last API response that session received and keeps serving that
//     cached block on every later render. A pane that goes idle — but
//     still redraws, on attach, resize or repaint — re-emits the same
//     frozen snapshot indefinitely. Correlating the stale rows against
//     turn_usage shows exactly this: most came from sessions with no API
//     turn for hours to days (one at 453h), and the staleness of the
//     window tracks the idleness of the session.
//   - Around a window rollover the endpoint itself can briefly answer
//     with the window that just closed, so the poller sees it too.
//
// Neither is ours to fix upstream, and neither needs to be: a window
// past its reset is self-evidently unusable whoever reported it, so the
// guard is applied on both paths rather than by discriminating on
// source. Dropping the sample costs nothing — the poller writes a fresh
// row within one interval.
//
// dropExpiredWindows returns a copy of qs with every bucket whose window
// has already reset replaced by the zero Bucket, which the store
// persists as SQL NULL. It does not mutate qs: callers keep the observed
// sample for the live glance, which should still show what was actually
// reported.
//
// Buckets are judged independently because their windows expire
// independently — a payload can carry a dead 5h bucket and a live 7d
// one, and the live half is worth keeping. When nothing survives, the
// callers' existing "no usable bucket" check drops the row entirely.
func dropExpiredWindows(qs QuotaSample, now time.Time) QuotaSample {
	out := qs
	at := now.Unix()
	out.FiveHour = liveBucket(qs.FiveHour, at)
	out.SevenDay = liveBucket(qs.SevenDay, at)
	out.SevenDayOpus = liveBucket(qs.SevenDayOpus, at)
	out.SevenDaySonnet = liveBucket(qs.SevenDaySonnet, at)
	return out
}

// liveBucket returns b unless its window has already reset.
//
// A bucket with no resets_at is kept: absent an expiry there is nothing
// to call stale, and the poll path legitimately reports utilization with
// no window attached (an account sitting at 0% on a window that has not
// opened yet). The comparison is inclusive — a window resetting exactly
// now has reset, and its utilization belongs to the window just closed.
func liveBucket(b Bucket, now int64) Bucket {
	if b.ResetsAt != nil && *b.ResetsAt <= now {
		return Bucket{}
	}
	return b
}

// ResetsAtGranularity is the resolution stored resets_at values are snapped
// to. Rate-limit windows begin and end on whole minutes, so anything finer
// is noise.
const ResetsAtGranularity = 60

// NormalizeResetsAt snaps a window expiry to the nearest minute.
//
// Upstream reports the expiry as an RFC3339 string with sub-second
// precision, and truncating it to whole seconds turns a sub-second wobble
// around the boundary into a one-second integer flip. Observed on a real
// export: the same 18:00:00 window stored as both 1785175199 and
// 1785175200, alternating every few minutes across 3.6k rows.
//
// That matters because resets_at is the IDENTITY of a window — the forecast
// refuses to measure a burn rate across a reset, so a flickering value
// shattered one window into hundreds of fragments and left the weekly
// forecast with nothing long enough to measure. Readers are defensive about
// it anyway (see windowID in quota_forecast.go, which must stay for rows
// already written), but there is no reason to keep recording the noise.
func NormalizeResetsAt(b Bucket) Bucket {
	if b.ResetsAt == nil {
		return b
	}
	snapped := ((*b.ResetsAt + ResetsAtGranularity/2) / ResetsAtGranularity) * ResetsAtGranularity
	return Bucket{Pct: b.Pct, ResetsAt: &snapped}
}
