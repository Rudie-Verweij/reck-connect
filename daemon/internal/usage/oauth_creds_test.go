package usage

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseCredentials(t *testing.T) {
	// expiresAt is unix MILLIseconds in the real blob; getting this wrong
	// by 1000x is the obvious bug, so assert the decoded instant exactly.
	const ms = int64(1784823143492)
	want := time.UnixMilli(ms).UTC()

	tests := []struct {
		name    string
		raw     string
		wantErr error
		check   func(t *testing.T, c Credentials)
	}{
		{
			name: "full blob",
			raw: `{"claudeAiOauth":{"accessToken":"tok-abc","refreshToken":"nope",
			       "expiresAt":1784823143492,"subscriptionType":"max",
			       "rateLimitTier":"default_claude_max_20x"}}`,
			check: func(t *testing.T, c Credentials) {
				if c.Token != "tok-abc" {
					t.Errorf("Token = %q, want tok-abc", c.Token)
				}
				if !c.ExpiresAt.Equal(want) {
					t.Errorf("ExpiresAt = %v, want %v (millisecond epoch)", c.ExpiresAt, want)
				}
				if c.Subscription != "max" {
					t.Errorf("Subscription = %q, want max", c.Subscription)
				}
				if c.RateLimitTier != "default_claude_max_20x" {
					t.Errorf("RateLimitTier = %q", c.RateLimitTier)
				}
			},
		},
		{
			name: "subscription normalised to lowercase and trimmed",
			raw:  `{"claudeAiOauth":{"accessToken":"t","subscriptionType":"  Max  "}}`,
			check: func(t *testing.T, c Credentials) {
				if c.Subscription != "max" {
					t.Errorf("Subscription = %q, want max", c.Subscription)
				}
			},
		},
		{
			name: "no rateLimitTier is not an error",
			raw:  `{"claudeAiOauth":{"accessToken":"t","subscriptionType":"pro"}}`,
			check: func(t *testing.T, c Credentials) {
				if c.RateLimitTier != "" {
					t.Errorf("RateLimitTier = %q, want empty", c.RateLimitTier)
				}
			},
		},
		{
			name: "no expiresAt leaves a zero instant (treated as non-expiring)",
			raw:  `{"claudeAiOauth":{"accessToken":"t"}}`,
			check: func(t *testing.T, c Credentials) {
				if !c.ExpiresAt.IsZero() {
					t.Errorf("ExpiresAt = %v, want zero", c.ExpiresAt)
				}
				if !c.Valid(time.Now()) {
					t.Error("Valid() = false, want true for a token with no expiry")
				}
			},
		},
		{
			name:    "missing accessToken",
			raw:     `{"claudeAiOauth":{"subscriptionType":"max"}}`,
			wantErr: ErrNoCredentials,
		},
		{
			name:    "no claudeAiOauth section (MCP-only blob)",
			raw:     `{"mcpOAuth":{"some-server":{"accessToken":"x"}}}`,
			wantErr: ErrNoCredentials,
		},
		{
			name:    "empty",
			raw:     ``,
			wantErr: nil, // malformed-JSON error, matched below by non-nil
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := parseCredentials([]byte(tc.raw))
			switch {
			case tc.wantErr != nil:
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			case tc.check == nil:
				if err == nil {
					t.Fatal("expected an error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			tc.check(t, c)
		})
	}
}

func TestCredentialsValid(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	tests := []struct {
		name string
		c    Credentials
		want bool
	}{
		{"valid", Credentials{Token: "t", ExpiresAt: now.Add(time.Hour)}, true},
		{"expired", Credentials{Token: "t", ExpiresAt: now.Add(-time.Hour)}, false},
		{"no token", Credentials{ExpiresAt: now.Add(time.Hour)}, false},
		{"no expiry", Credentials{Token: "t"}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.c.Valid(now); got != tc.want {
				t.Errorf("Valid() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestReadCredentialFile(t *testing.T) {
	home := t.TempDir()

	if _, err := readCredentialFile(home); !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("absent file: err = %v, want ErrNoCredentials", err)
	}

	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	want := `{"claudeAiOauth":{"accessToken":"tok"}}`
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(want), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readCredentialFile(home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != want {
		t.Errorf("blob = %q, want %q", got, want)
	}
}

func TestCachedCredentialSource(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	clock := func() time.Time { return now }

	t.Run("reuses a live token instead of re-reading", func(t *testing.T) {
		calls := 0
		src := NewCachedCredentialSource(func() (Credentials, error) {
			calls++
			return Credentials{Token: "tok", ExpiresAt: now.Add(4 * time.Hour)}, nil
		}, clock)

		for range 100 {
			if _, err := src(); err != nil {
				t.Fatal(err)
			}
		}
		// This is the point of the cache: on macOS each miss spawns
		// `security` to hit the login keychain.
		if calls != 1 {
			t.Errorf("underlying reads = %d, want 1", calls)
		}
	})

	t.Run("re-reads once the token nears expiry", func(t *testing.T) {
		calls := 0
		src := NewCachedCredentialSource(func() (Credentials, error) {
			calls++
			return Credentials{Token: "tok", ExpiresAt: now.Add(30 * time.Second)}, nil
		}, clock)

		// Expires inside the refresh skew, so every call must re-read
		// rather than hand out a token that lapses mid-flight.
		src()
		src()
		if calls != 2 {
			t.Errorf("underlying reads = %d, want 2", calls)
		}
	})

	t.Run("never caches a failure", func(t *testing.T) {
		calls := 0
		fail := true
		src := NewCachedCredentialSource(func() (Credentials, error) {
			calls++
			if fail {
				return Credentials{}, ErrNoCredentials
			}
			return Credentials{Token: "tok", ExpiresAt: now.Add(time.Hour)}, nil
		}, clock)

		if _, err := src(); !errors.Is(err, ErrNoCredentials) {
			t.Fatalf("err = %v", err)
		}
		// A station authenticated just now must start working on the next
		// tick, not wait out a cache entry.
		fail = false
		got, err := src()
		if err != nil || got.Token != "tok" {
			t.Fatalf("after recovery: %+v %v", got, err)
		}
		if calls != 2 {
			t.Errorf("underlying reads = %d, want 2", calls)
		}
	})

	t.Run("passes expired-token metadata through uncached", func(t *testing.T) {
		// LoadCredentials returns credentials alongside ErrTokenExpired so
		// the plan probe can still read the tier; the cache must not eat
		// either half of that.
		src := NewCachedCredentialSource(func() (Credentials, error) {
			return Credentials{Token: "stale", Subscription: "max"}, ErrTokenExpired
		}, clock)

		got, err := src()
		if !errors.Is(err, ErrTokenExpired) {
			t.Errorf("err = %v, want ErrTokenExpired", err)
		}
		if got.Subscription != "max" {
			t.Errorf("Subscription = %q, want max", got.Subscription)
		}
	})
}
