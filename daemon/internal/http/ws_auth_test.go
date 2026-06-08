package http

import (
	nethttp "net/http"
	"net/http/httptest"
	"testing"
)

// TestExtractWSBearer_table covers the parsing layer that authMiddleware
// hooks WS upgrades through: bearer must survive multiple comma-separated
// subprotocols, whitespace noise, repeated headers, and case quirks.
func TestExtractWSBearer_table(t *testing.T) {
	cases := []struct {
		name     string
		header   []string
		wantTok  string
		wantOff  string // the offered subprotocol string the server must echo
	}{
		{
			name:    "single entry",
			header:  []string{"reck-bearer.abcdef"},
			wantTok: "abcdef",
			wantOff: "reck-bearer.abcdef",
		},
		{
			name:    "comma-separated alongside other proto",
			header:  []string{"chat, reck-bearer.xyz"},
			wantTok: "xyz",
			wantOff: "reck-bearer.xyz",
		},
		{
			name:    "multiple headers",
			header:  []string{"foo", "reck-bearer.zzz, bar"},
			wantTok: "zzz",
			wantOff: "reck-bearer.zzz",
		},
		{
			name:    "empty",
			header:  []string{},
			wantTok: "",
			wantOff: "",
		},
		{
			name:    "prefix but no suffix",
			header:  []string{"reck-bearer."},
			wantTok: "",                // empty token
			wantOff: "reck-bearer.",    // still a valid prefix match
		},
		{
			name:    "prefix must be exact (no prefix collision)",
			header:  []string{"reck-bearer-extra.tok"},
			wantTok: "",
			wantOff: "",
		},
		{
			name:    "whitespace around entries",
			header:  []string{"  reck-bearer.padded  "},
			wantTok: "padded",
			wantOff: "reck-bearer.padded",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := nethttp.Header{}
			for _, v := range c.header {
				h.Add("Sec-WebSocket-Protocol", v)
			}
			gotTok, gotOff := extractWSBearer(h)
			if gotTok != c.wantTok {
				t.Errorf("token = %q, want %q", gotTok, c.wantTok)
			}
			if gotOff != c.wantOff {
				t.Errorf("offered = %q, want %q", gotOff, c.wantOff)
			}
		})
	}
}

// TestAuth_WSSubprotocolBearer verifies the primary browser-auth path:
// offering `reck-bearer.<token>` via Sec-WebSocket-Protocol authenticates
// the request (rather than the Authorization header). We hit /projects
// (not a real WS endpoint) so we don't have to stand up an actual
// upgrade — the middleware runs the same way for any /ws/ path, but the
// entries under / exercise the extraction code identically up to the
// path guard, which means we hit the WS branch only when Path begins
// with /ws/. So: use a WS-shaped path that the router can dispatch.
//
// We exercise this via a fake /ws/p1/x route through the router so we
// hit the auth branch. Even if the WS upgrade itself fails (no
// Upgrade header), auth is checked first.
func TestAuth_WSSubprotocolBearer(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-secret")
	s := newServer(t)
	// Bypass newTestHandler: this test asserts on subprotocol-only auth,
	// so the wrapper's Authorization-header injection would mask the
	// 401 paths it covers.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	// Valid subprotocol → auth passes, we get past the middleware.
	// The handler will then try to upgrade and fail (no Upgrade
	// header from plain GET), but the status will NOT be 401.
	req, _ := nethttp.NewRequest("GET", srv.URL+"/ws/p1/p_abc", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "reck-bearer.main-secret")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == nethttp.StatusUnauthorized {
		t.Errorf("valid subprotocol bearer: got 401, should pass auth")
	}

	// Wrong token in subprotocol → 401.
	req, _ = nethttp.NewRequest("GET", srv.URL+"/ws/p1/p_abc", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "reck-bearer.WRONG")
	resp, err = nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Errorf("wrong subprotocol token: status=%d want 401", resp.StatusCode)
	}

	// Query string fallback MUST NOT work anymore. Before the fix,
	// `?token=main-secret` passed auth; we now require the subprotocol.
	resp, err = nethttp.Get(srv.URL + "/ws/p1/p_abc?token=main-secret")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Errorf("query-string token: status=%d want 401 (query fallback should be removed)", resp.StatusCode)
	}
}

// TestAuth_WSSubprotocolBearerOnNonWSPath ensures the subprotocol-auth
// path doesn't leak onto non-WS endpoints. A client can still offer the
// subprotocol as a curiosity, but it must NOT authenticate an HTTP
// request where the caller should be using the Authorization header.
func TestAuth_WSSubprotocolBearerOnNonWSPath(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-secret")
	// Bypass newTestHandler: this test asserts that subprotocol bearer
	// must NOT authenticate plain HTTP, which requires the request to
	// reach authMiddleware with no Authorization header set.
	srv := httptest.NewServer(newServer(t).Router())
	defer srv.Close()

	req, _ := nethttp.NewRequest("GET", srv.URL+"/projects", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "reck-bearer.main-secret")
	// No Authorization header — the WS-auth fallback should NOT apply
	// to plain HTTP endpoints. Auth must fail.
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Errorf("subprotocol on non-WS path: status=%d want 401", resp.StatusCode)
	}
}
