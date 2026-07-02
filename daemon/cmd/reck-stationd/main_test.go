package main

import (
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
)

// TestParseDaemonMode_validInputs — the two accepted strings must
// round-trip to the canonical typed constants. If either of these
// breaks, the daemon would either reject a legitimate Satellite
// invocation or silently fall through to the wrong preamble branch.
func TestParseDaemonMode_validInputs(t *testing.T) {
	cases := []struct {
		in   string
		want agent.DaemonMode
	}{
		{"station", agent.ModeStation},
		{"local", agent.ModeLocal},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := parseDaemonMode(tc.in)
			if err != nil {
				t.Fatalf("parseDaemonMode(%q) returned error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("parseDaemonMode(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestParseDaemonMode_invalidInputs — anything outside the closed set
// must error. This is the load-bearing guarantee from Phase 6 of the
// hybrid-mode plan: a typo in the launchd plist or in
// daemon-spawn.ts must NOT silently fall through to the station-mode
// preamble. Cases include common typos, case mismatches, the empty
// string, and adjacent-meaning words a future contributor might guess.
func TestParseDaemonMode_invalidInputs(t *testing.T) {
	for _, in := range []string{
		"",
		"Station",       // case sensitivity is intentional; flag values are exact
		"STATION",
		"Local",
		"LOCAL",
		"stations",      // plural typo
		"loca",          // truncation typo
		"station ",      // trailing space (flag.Parse wouldn't normally produce this, but defensive)
		" local",        // leading space
		"hybrid",        // a tempting-sounding wrong answer
		"both",
		"remote",
	} {
		t.Run(in, func(t *testing.T) {
			got, err := parseDaemonMode(in)
			if err == nil {
				t.Fatalf("parseDaemonMode(%q) unexpectedly succeeded with %q", in, got)
			}
			// Error message must name BOTH valid options so an
			// operator who hits this knows what to fix without
			// grepping the source.
			msg := err.Error()
			if !strings.Contains(msg, `"station"`) || !strings.Contains(msg, `"local"`) {
				t.Errorf("error message %q should name both valid modes", msg)
			}
			// The bad input should appear in the error so an
			// operator can see what was actually parsed (vs. a
			// shell-quoting accident).
			if in != "" && !strings.Contains(msg, in) {
				t.Errorf("error message %q should echo the bad input %q", msg, in)
			}
		})
	}
}

// TestParseDaemonMode_returnsTypedZero — on error the returned
// DaemonMode must be the zero value, never a "guess" like ModeStation.
// Callers in main.go should crash before they get here, but if some
// future refactor ignores the error, we want the typed zero to surface
// downstream as "unset" rather than a silent fallback to station.
func TestParseDaemonMode_returnsTypedZero(t *testing.T) {
	got, err := parseDaemonMode("nonsense")
	if err == nil {
		t.Fatal("expected error")
	}
	if got != "" {
		t.Errorf("parseDaemonMode error path returned non-zero mode %q; want zero value", got)
	}
}

// phase 2: writePidfile / daemonPidfilePath were retired
// alongside the reck-clipboard sidecar that read the file for
// peer-auth. No replacement; the daemon no longer writes anything
// under ~/.reck/.

// TestDaemonURLFromAddr — the URL the daemon publishes via
// $RECK_DAEMON_URL must point to an address the lifecycle-hook shim
// can actually reach. Wildcard binds (":7315", "0.0.0.0:7315",
// "[::]:7315") collapse to 127.0.0.1 because loopback is part of every
// wildcard listener. An explicit non-loopback bind (e.g. a Tailscale IP
// on a Linux station) MUST be preserved verbatim: a Pi station bound to
// its tailnet IP was silently dropping every hook POST because the old
// code always used 127.0.0.1, where nothing was listening — leaving the
// stoplight stuck on gray for every Claude pane.
func TestDaemonURLFromAddr(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{":7315", "http://127.0.0.1:7315"},
		{"0.0.0.0:7315", "http://127.0.0.1:7315"},
		{"[::]:7315", "http://127.0.0.1:7315"},
		{"127.0.0.1:7315", "http://127.0.0.1:7315"},
		{"100.64.0.1:7315", "http://100.64.0.1:7315"}, // non-loopback (tailnet) bind preserved
		{"192.168.1.42:8080", "http://192.168.1.42:8080"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got := daemonURLFromAddr(tc.in)
			if got != tc.want {
				t.Errorf("daemonURLFromAddr(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
