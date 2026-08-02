package usage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Local Claude Code credentials: the OAuth access token the quota poller
// needs, plus the subscription facts that ride along in the same blob.
//
// We READ this store and never write it. Refreshing an expired token is
// Claude Code's job, not ours — an expired token means the poller skips a
// tick, and the next `claude` run rotates it. That keeps the daemon out of
// the auth business entirely: no refresh-token handling, no clobbering a
// credential file another process owns.
//
// Two backends, same JSON payload:
//
//	macOS — the login keychain, item "Claude Code-credentials"
//	Linux — ~/.claude/.credentials.json
//
// The payload is shaped:
//
//	{"claudeAiOauth": {
//	   "accessToken": "...", "refreshToken": "...",
//	   "expiresAt": 1784823143492,            // UNIX MILLISECONDS
//	   "subscriptionType": "max",
//	   "rateLimitTier": "default_claude_max_20x"}}
//
// Only accessToken, expiresAt, subscriptionType and rateLimitTier are read.
// The refresh token is never parsed, never stored, and never logged.

// keychainService is the macOS keychain item Claude Code stores its
// credentials under.
const keychainService = "Claude Code-credentials"

// ErrNoCredentials means no usable credential blob was found. Callers
// treat this as "skip this tick", not as a fault.
var ErrNoCredentials = errors.New("usage: no Claude credentials available")

// ErrTokenExpired means credentials were found but the access token is
// past its expiry. Also a skip, not a fault.
var ErrTokenExpired = errors.New("usage: Claude access token expired")

// Credentials is the subset of the credential blob this package uses.
// Token is deliberately not included in String()/logging anywhere.
type Credentials struct {
	Token         string
	ExpiresAt     time.Time
	Subscription  string // "pro" | "max" | "team" | "enterprise" | ""
	RateLimitTier string // e.g. "default_claude_max_20x"; "" when absent
}

// Valid reports whether the token is present and not expired as of now.
func (c Credentials) Valid(now time.Time) bool {
	return c.Token != "" && (c.ExpiresAt.IsZero() || c.ExpiresAt.After(now))
}

// CredentialSource yields the current credentials. Injected so the poller
// can be tested without a keychain or a real home directory.
type CredentialSource func() (Credentials, error)

// credRefreshSkew re-reads a little before the token actually expires, so
// a poll never fires with a token that lapses in flight.
const credRefreshSkew = time.Minute

// NewCachedCredentialSource wraps src so a successful read is reused until
// the token is close to expiring.
//
// This matters most on macOS, where reading credentials means spawning
// `security` to hit the login keychain: without caching, a 5-minute poll
// is ~288 keychain reads a day for a token that only rotates every few
// hours. On Linux it saves a much cheaper file read, but the behaviour is
// worth keeping identical across platforms.
//
// Only successes are cached — an error always re-reads next time, so a
// station that has just been authenticated starts working on the next
// tick rather than waiting out a cache entry.
func NewCachedCredentialSource(src CredentialSource, now func() time.Time) CredentialSource {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	var (
		mu     sync.Mutex
		cached Credentials
		ok     bool
	)
	return func() (Credentials, error) {
		mu.Lock()
		defer mu.Unlock()
		if ok && cached.Valid(now().Add(credRefreshSkew)) {
			return cached, nil
		}
		c, err := src()
		if err != nil {
			// Don't let a stale entry mask a credential store that has
			// genuinely gone away.
			ok = false
			cached = Credentials{}
			return c, err
		}
		cached, ok = c, true
		return c, nil
	}
}

// LoadCredentials reads and parses the platform credential store. It
// returns ErrNoCredentials when nothing readable is present, and
// ErrTokenExpired when the blob parsed but the token is stale.
//
// On ErrTokenExpired the parsed Credentials are returned ALONGSIDE the
// error, because expiry only invalidates the token: subscriptionType and
// rateLimitTier are still accurate. That lets the plan probe keep working
// on a station where nobody has run Claude for a while, while the quota
// poller — which genuinely needs a live token — still refuses.
func LoadCredentials() (Credentials, error) {
	raw, err := readCredentialBlob()
	if err != nil {
		return Credentials{}, err
	}
	c, err := parseCredentials(raw)
	if err != nil {
		return Credentials{}, err
	}
	if !c.Valid(time.Now()) {
		if c.Token == "" {
			return Credentials{}, ErrNoCredentials
		}
		return c, ErrTokenExpired
	}
	return c, nil
}

// readCredentialBlob returns the raw credential JSON for this platform.
func readCredentialBlob() ([]byte, error) {
	if runtime.GOOS == "darwin" {
		if b, err := readKeychainBlob(); err == nil {
			return b, nil
		}
		// Fall through: a Mac may still have the file form (e.g. when
		// Claude Code ran with the keychain unavailable).
	}
	return readCredentialFile("")
}

// readKeychainBlob shells out to `security` for the macOS keychain item.
// The daemon inherits the same ACL as any other reader of this item; if
// the read is denied or the item is absent we degrade to ErrNoCredentials
// rather than blocking on a UI prompt.
func readKeychainBlob() ([]byte, error) {
	cmd := exec.Command("security", "find-generic-password", "-s", keychainService, "-w")
	out, err := cmd.Output()
	if err != nil {
		return nil, ErrNoCredentials
	}
	out = []byte(strings.TrimSpace(string(out)))
	if len(out) == 0 {
		return nil, ErrNoCredentials
	}
	return out, nil
}

// readCredentialFile reads ~/.claude/.credentials.json. home may be empty
// to resolve the current user's home directory (tests pass a temp dir).
func readCredentialFile(home string) ([]byte, error) {
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil || h == "" {
			return nil, ErrNoCredentials
		}
		home = h
	}
	b, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		return nil, ErrNoCredentials
	}
	return b, nil
}

// credWire mirrors only the fields we consume. Everything else in the blob
// — refresh tokens, MCP OAuth entries for every connected server — is left
// unparsed on purpose.
type credWire struct {
	ClaudeAiOauth struct {
		AccessToken      string `json:"accessToken"`
		ExpiresAt        int64  `json:"expiresAt"` // unix MILLIseconds
		SubscriptionType string `json:"subscriptionType"`
		RateLimitTier    string `json:"rateLimitTier"`
	} `json:"claudeAiOauth"`
}

// parseCredentials extracts the fields we need. Kept pure and separate
// from the platform read so the wire handling is unit-testable.
func parseCredentials(raw []byte) (Credentials, error) {
	var w credWire
	if err := json.Unmarshal(raw, &w); err != nil {
		return Credentials{}, fmt.Errorf("usage: malformed credential blob: %w", err)
	}
	o := w.ClaudeAiOauth
	if o.AccessToken == "" {
		return Credentials{}, ErrNoCredentials
	}
	c := Credentials{
		Token:         o.AccessToken,
		Subscription:  strings.ToLower(strings.TrimSpace(o.SubscriptionType)),
		RateLimitTier: strings.TrimSpace(o.RateLimitTier),
	}
	if o.ExpiresAt > 0 {
		c.ExpiresAt = time.UnixMilli(o.ExpiresAt).UTC()
	}
	return c, nil
}
