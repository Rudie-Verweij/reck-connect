package events

import (
	"encoding/json"
	"testing"
	"time"
)

func TestKindValid(t *testing.T) {
	ok := []Kind{KindSessionStart, KindUserPrompt, KindPreTool, KindPostTool, KindStop, KindNotification, KindSessionEnd}
	for _, k := range ok {
		if !KindValid(k) {
			t.Fatalf("%q should be valid", k)
		}
	}
	bad := []Kind{"", "garbage", "UserPromptSubmit" /* Claude's native name, not our canonical */}
	for _, k := range bad {
		if KindValid(k) {
			t.Fatalf("%q should be invalid", k)
		}
	}
}

func TestLog_AppendRing(t *testing.T) {
	l := NewLog(3)
	at := time.Now()
	for i := 0; i < 5; i++ {
		l.Append(Event{ID: string(rune('a' + i)), Kind: KindUserPrompt, At: at})
	}
	if l.Len() != 3 {
		t.Fatalf("len = %d, want 3", l.Len())
	}
	snap := l.Snapshot()
	// Oldest two dropped → IDs c, d, e.
	if snap[0].ID != "c" || snap[1].ID != "d" || snap[2].ID != "e" {
		t.Fatalf("ring order wrong: %+v", snap)
	}
}

func TestLog_RecentN(t *testing.T) {
	l := NewLog(10)
	for i := 0; i < 5; i++ {
		l.Append(Event{ID: string(rune('a' + i)), Kind: KindStop})
	}
	r := l.Recent(3)
	if len(r) != 3 || r[0].ID != "c" || r[2].ID != "e" {
		t.Fatalf("recent(3) wrong: %+v", r)
	}
	// n > len → return all.
	all := l.Recent(100)
	if len(all) != 5 {
		t.Fatalf("recent(100) = %d, want 5", len(all))
	}
}

func TestLog_RecentClampNonPositive(t *testing.T) {
	// Recent must not panic on n <= 0. We treat both 0 and negative
	// as "give me nothing" (defensive — see comment in events.go).
	l := NewLog(10)
	for i := 0; i < 5; i++ {
		l.Append(Event{ID: string(rune('a' + i)), Kind: KindStop})
	}
	cases := []struct {
		name    string
		n       int
		wantLen int
		wantIDs []string // empty means "any" or "skip ID check"
	}{
		{name: "negative_one", n: -1, wantLen: 0},
		{name: "negative_large", n: -10000, wantLen: 0},
		{name: "zero", n: 0, wantLen: 0},
		{name: "one", n: 1, wantLen: 1, wantIDs: []string{"e"}},
		{name: "large_exceeds_len", n: 1 << 20, wantLen: 5, wantIDs: []string{"a", "b", "c", "d", "e"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := l.Recent(tc.n)
			if got == nil {
				t.Fatalf("Recent(%d) returned nil; want non-nil empty slice", tc.n)
			}
			if len(got) != tc.wantLen {
				t.Fatalf("Recent(%d) len = %d, want %d", tc.n, len(got), tc.wantLen)
			}
			for i, want := range tc.wantIDs {
				if got[i].ID != want {
					t.Fatalf("Recent(%d)[%d].ID = %q, want %q", tc.n, i, got[i].ID, want)
				}
			}
		})
	}
}

func TestEvent_JSONRoundTrip(t *testing.T) {
	raw := json.RawMessage(`{"prompt":"hi","tool":"Bash"}`)
	e := Event{
		ID:        NewID(),
		PaneID:    "p_abc",
		ProjectID: "proj",
		Agent:     "claude-code",
		Kind:      KindPreTool,
		At:        time.Now().UTC().Truncate(time.Millisecond),
		Data:      raw,
	}
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var got Event
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != e.ID || got.Kind != e.Kind || got.Agent != e.Agent {
		t.Fatalf("round-trip lost fields: %+v", got)
	}
	if string(got.Data) != string(raw) {
		t.Fatalf("data lost: got %s", got.Data)
	}
}
