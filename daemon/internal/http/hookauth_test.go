package http

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	nethttp "net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

// signHookRequest builds the HMAC headers + canonical body for a fake
// agent-event POST. Centralising the signing math here keeps every
// test in this file using the exact same canonicalisation the shim
// (and VerifyHookSignature) speak — drift would silently turn a green
// suite into a false positive.
func signHookRequest(t *testing.T, secret, method, path string, body []byte) (sig, ts, nonce string) {
	t.Helper()
	ts = strconv.FormatInt(time.Now().Unix(), 10)
	var nbuf [16]byte
	for i := range nbuf {
		// Tests run in many goroutines simultaneously; use a small
		// counter-based generator so two parallel signRequests in the
		// same nanosecond don't collide. crypto/rand would also work
		// but pulls in another dep — and for tests the predictability
		// is fine, the daemon doesn't care how the nonce was made.
		nbuf[i] = byte(i*31 + int(time.Now().UnixNano()&0xff))
	}
	nonce = hex.EncodeToString(nbuf[:]) + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	canonical := method + "\n" + path + "\n" + string(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	sig = hex.EncodeToString(mac.Sum(nil))
	return
}

// postSignedHook posts a signed agent-event request and returns the
// raw response. Body is required (project_id is mandatory after F4)
// — tests pass an empty map when they don't care about payload data.
func postSignedHook(t *testing.T, srv *httptest.Server, paneID, secret, projectID, kind string) *nethttp.Response {
	t.Helper()
	body := []byte(`{"project_id":"` + projectID + `","prompt":"hi"}`)
	path := "/panes/" + paneID + "/agent-event"
	url := srv.URL + path + "?kind=" + kind + "&agent=claude-code"
	sig, ts, nonce := signHookRequest(t, secret, "POST", path, body)
	req, err := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// --- HMAC verification path ---

// TestHookAuth_validSignatureAccepted is the happy path: a properly
// signed POST returns 200 and records the event. Pins the contract that
// the rest of the test file depends on — if the signing helper above
// drifts, this is the first canary.
func TestHookAuth_validSignatureAccepted(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	resp := postSignedHook(t, srv, pane.ID, pane.HookSecret, pane.ProjectID, "user_prompt")
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if got := pane.AgentState(); got != proto.AgentStateWorking {
		t.Errorf("agent state=%s want working", got)
	}
}

// TestHookAuth_missingHeadersRejected covers the "no signature at all"
// case — the F4 invariant: any local process without the secret is
// rejected. Pre-F4 this returned 200 over loopback.
func TestHookAuth_missingHeadersRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	url := srv.URL + "/panes/" + pane.ID + "/agent-event?kind=user_prompt&agent=claude-code"
	body := []byte(`{"project_id":"p1"}`)
	resp, err := nethttp.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("missing sig: status=%d want 401", resp.StatusCode)
	}
}

// TestHookAuth_partialHeadersRejected: any single missing header is
// the same failure class as all-missing. The shim sets all three or
// none; a partial set is either a mistake or an attack.
func TestHookAuth_partialHeadersRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"

	cases := []struct {
		name    string
		headers map[string]string
	}{
		{"no sig", map[string]string{HookAuthHeaderTs: ts, HookAuthHeaderNonce: nonce}},
		{"no ts", map[string]string{HookAuthHeaderSig: sig, HookAuthHeaderNonce: nonce}},
		{"no nonce", map[string]string{HookAuthHeaderSig: sig, HookAuthHeaderTs: ts}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			for k, v := range c.headers {
				req.Header.Set(k, v)
			}
			resp, err := nethttp.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 401 {
				t.Errorf("status=%d want 401", resp.StatusCode)
			}
		})
	}
}

// TestHookAuth_badSignatureRejected: a syntactically-valid but wrong
// signature is rejected. Tests the constant-time-compare path —
// outcome is the same as missing, but the code path is different.
func TestHookAuth_badSignatureRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"
	_, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)
	// Sign with the wrong secret to get the right shape but a wrong value.
	wrongSig, _, _ := signHookRequest(t, "00", "POST", path, body)

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, wrongSig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("status=%d want 401", resp.StatusCode)
	}
}

// TestHookAuth_replayRejected: a request signed correctly the first
// time is accepted, then immediately replayed and rejected. This is
// the core nonce-store guarantee — without it, an attacker who could
// snoop one signed event could re-fire it indefinitely.
func TestHookAuth_replayRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)

	post := func() int {
		req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(HookAuthHeaderSig, sig)
		req.Header.Set(HookAuthHeaderTs, ts)
		req.Header.Set(HookAuthHeaderNonce, nonce)
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := post(); got != 200 {
		t.Fatalf("first post: status=%d want 200", got)
	}
	if got := post(); got != 401 {
		t.Errorf("replay: status=%d want 401", got)
	}
}

// TestHookAuth_staleTimestampRejected: a timestamp older than the
// acceptance window is rejected even with a valid signature. Stops
// an attacker who recorded a signed envelope from replaying it after
// the nonce has aged out of the dedup store.
func TestHookAuth_staleTimestampRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"

	// Build the signed envelope at a timestamp 5 minutes in the past.
	// The signature itself is fine — the server should reject on the
	// timestamp window check before the HMAC compare even runs.
	staleTs := strconv.FormatInt(time.Now().Add(-5*time.Minute).Unix(), 10)
	canonical := "POST\n" + path + "\n" + string(body)
	mac := hmac.New(sha256.New, []byte(pane.HookSecret))
	mac.Write([]byte(canonical))
	sig := hex.EncodeToString(mac.Sum(nil))
	nonce := "stale-test-nonce-1234567890abcdef"

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, staleTs)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("stale ts: status=%d want 401", resp.StatusCode)
	}
}

// TestHookAuth_futureTimestampRejected: symmetric check on the
// "+window" side. A clock that's drifted a long way ahead would
// otherwise let an attacker who snuck a signed envelope into the
// future replay it once the daemon's clock catches up.
func TestHookAuth_futureTimestampRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"

	futureTs := strconv.FormatInt(time.Now().Add(5*time.Minute).Unix(), 10)
	canonical := "POST\n" + path + "\n" + string(body)
	mac := hmac.New(sha256.New, []byte(pane.HookSecret))
	mac.Write([]byte(canonical))
	sig := hex.EncodeToString(mac.Sum(nil))

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, futureTs)
	req.Header.Set(HookAuthHeaderNonce, "future-test-nonce")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("future ts: status=%d want 401", resp.StatusCode)
	}
}

// TestHookAuth_methodBindingRejected: a signature computed for a
// different method (here GET) must not validate POST. Pins the F4
// design's method-binding contract — without it, an attacker who
// could induce a hook to sign a benign GET could replay against
// state-changing POSTs.
func TestHookAuth_methodBindingRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	// Sign as if it were a GET; we'll send a POST with the same headers.
	getSig, ts, nonce := signHookRequest(t, pane.HookSecret, "GET", path, body)
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, getSig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("method-bound sig: status=%d want 401", resp.StatusCode)
	}
}

// TestHookAuth_pathBindingRejected: a signature computed against a
// different pane's path must not validate this pane's path even when
// the body is identical. Pins the path-binding contract.
func TestHookAuth_pathBindingRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1"}`)
	wrongPath := "/panes/p_other_pane/agent-event"
	thisPath := "/panes/" + pane.ID + "/agent-event"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", wrongPath, body)
	url := srv.URL + thisPath + "?kind=user_prompt&agent=claude-code"

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("path-bound sig: status=%d want 401", resp.StatusCode)
	}
}

// TestHookAuth_bodyTamperingRejected: any byte mutation of the body
// after signing must invalidate. The simplest end-to-end check that
// the canonical-string scheme actually covers the payload.
func TestHookAuth_bodyTamperingRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"p1","value":"original"}`)
	tampered := []byte(`{"project_id":"p1","value":"attacker"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"

	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(tampered))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("tampered body: status=%d want 401", resp.StatusCode)
	}
}

// --- project_id enforcement ---

// TestAgentEvent_projectIDRequiredInBody: even with a valid HMAC, an
// empty body (or one without project_id) must be rejected 400.
// Defense in depth — the signature already binds to the pane, but
// project_id-in-body acts as a sanity check that the shim is wired
// to the right pane.
func TestAgentEvent_projectIDRequiredInBody(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	cases := []struct {
		name string
		body []byte
		want int
	}{
		{"empty body", []byte(``), 400},
		{"body without project_id", []byte(`{"prompt":"hi"}`), 400},
		{"body with empty project_id", []byte(`{"project_id":""}`), 400},
		{"non-object body", []byte(`"just a string"`), 400},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := "/panes/" + pane.ID + "/agent-event"
			url := srv.URL + path + "?kind=user_prompt&agent=claude-code"
			sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, c.body)
			req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(c.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(HookAuthHeaderSig, sig)
			req.Header.Set(HookAuthHeaderTs, ts)
			req.Header.Set(HookAuthHeaderNonce, nonce)
			resp, err := nethttp.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != c.want {
				t.Errorf("status=%d want %d", resp.StatusCode, c.want)
			}
		})
	}
}

// TestAgentEvent_projectIDMismatchRejected: signed event whose body
// declares the wrong project_id is 403. This is the H2 invariant
// from the prior agent-event design, kept after F4 — the HMAC alone
// is enough to bind to the pane, but the body field flags shim
// misconfiguration explicitly.
func TestAgentEvent_projectIDMismatchRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	body := []byte(`{"project_id":"some-other-project"}`)
	path := "/panes/" + pane.ID + "/agent-event"
	url := srv.URL + path + "?kind=user_prompt&agent=claude-code"
	sig, ts, nonce := signHookRequest(t, pane.HookSecret, "POST", path, body)
	req, _ := nethttp.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HookAuthHeaderSig, sig)
	req.Header.Set(HookAuthHeaderTs, ts)
	req.Header.Set(HookAuthHeaderNonce, nonce)
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("status=%d want 403", resp.StatusCode)
	}
}

// --- Loopback-without-HMAC ---

// TestAgentEvent_loopbackWithoutHMACRejected is the security-critical
// regression: pre-F4 a local POST with no auth at all returned 200.
// After F4 it must be 401 — the loopback exemption is gone, the
// HMAC is the only gate. This is the test that fails before the fix
// and passes after.
func TestAgentEvent_loopbackWithoutHMACRejected(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	url := srv.URL + "/panes/" + pane.ID + "/agent-event?kind=user_prompt&agent=claude-code"
	body := bytes.NewBufferString(`{"project_id":"p1"}`)
	resp, err := nethttp.Post(url, "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("loopback no-HMAC: status=%d want 401 (was 200 pre-fix)", resp.StatusCode)
	}
}

// --- Nonce store unit tests ---

// TestNonceStore_perPaneCapHit: filling one pane's nonce slots to the
// per-pane cap should return 429 on the next attempt and NOT insert.
// We drive the store directly so the test doesn't depend on a real
// HTTP fixture (and can deterministically observe Len()).
func TestNonceStore_perPaneCapHit(t *testing.T) {
	s := NewNonceStore()
	for i := 0; i < perPaneNonceCap; i++ {
		nonce := fmt.Sprintf("nonce-%d", i)
		if err := s.CheckAndStore("paneA", nonce); err != nil {
			t.Fatalf("fill %d: %v", i, err)
		}
	}
	preLen := s.Len()
	err := s.CheckAndStore("paneA", "one-too-many")
	if err == nil {
		t.Fatal("expected error at cap, got nil")
	}
	var hae *HookAuthError
	if !errors.As(err, &hae) || hae.Code != 429 {
		t.Fatalf("err=%v, want 429 HookAuthError", err)
	}
	if got := s.Len(); got != preLen {
		t.Errorf("store mutated on cap-hit: len pre=%d post=%d", preLen, got)
	}

	// A different pane should still be able to insert — the per-pane
	// cap fires per pane, not globally.
	if err := s.CheckAndStore("paneB", "fresh"); err != nil {
		t.Errorf("paneB insert after paneA cap: %v", err)
	}
}

// TestNonceStore_globalCapHit: filling the global cap with entries
// spread across many panes (none of which individually hit the
// per-pane cap) returns 429 on the next attempt regardless of pane.
func TestNonceStore_globalCapHit(t *testing.T) {
	s := NewNonceStore()
	// Spread across enough panes that no individual pane's per-pane
	// cap fires before the global cap. globalNonceCap / perPaneNonceCap
	// rounded up gives us the minimum panes needed.
	panesNeeded := globalNonceCap/perPaneNonceCap + 1
	added := 0
	for p := 0; p < panesNeeded && added < globalNonceCap; p++ {
		paneID := fmt.Sprintf("pane-%d", p)
		for i := 0; i < perPaneNonceCap && added < globalNonceCap; i++ {
			nonce := fmt.Sprintf("n-%d-%d", p, i)
			if err := s.CheckAndStore(paneID, nonce); err != nil {
				t.Fatalf("global fill p=%d i=%d: %v", p, i, err)
			}
			added++
		}
	}
	if got := s.Len(); got != globalNonceCap {
		t.Fatalf("setup: len=%d want %d", got, globalNonceCap)
	}
	// One more from a fresh pane (so per-pane cap can't be the cause)
	// must trip the global cap → 429.
	err := s.CheckAndStore("pane-fresh", "extra")
	if err == nil {
		t.Fatal("expected global-cap error, got nil")
	}
	var hae *HookAuthError
	if !errors.As(err, &hae) || hae.Code != 429 {
		t.Fatalf("err=%v, want 429 HookAuthError", err)
	}
	if got := s.Len(); got != globalNonceCap {
		t.Errorf("store mutated on global cap-hit: len=%d want %d", got, globalNonceCap)
	}
}

// TestNonceStore_pruneFreesSpace: after entries age out of the
// 2× window, the store automatically reclaims them on the next
// CheckAndStore — the per-pane cap should NOT be a permanent
// ceiling for a pane that's quiet for a minute.
func TestNonceStore_pruneFreesSpace(t *testing.T) {
	s := NewNonceStore()
	now := time.Unix(1_700_000_000, 0)
	s.SetClock(func() time.Time { return now })

	// Fill to per-pane cap at t=0.
	for i := 0; i < perPaneNonceCap; i++ {
		nonce := fmt.Sprintf("old-%d", i)
		if err := s.CheckAndStore("paneA", nonce); err != nil {
			t.Fatalf("fill %d: %v", i, err)
		}
	}
	// Confirm the cap blocks a fresh insert at the same instant.
	if err := s.CheckAndStore("paneA", "blocked"); err == nil {
		t.Fatal("expected cap-hit before time advance")
	}
	// Advance time past the prune window (2× the timestamp skew).
	now = now.Add(3 * hookAuthTimestampSkew)
	// Next insert prunes the expired entries first, then succeeds.
	if err := s.CheckAndStore("paneA", "after-window"); err != nil {
		t.Errorf("post-prune insert: %v", err)
	}
	if got := s.Len(); got != 1 {
		t.Errorf("expected single entry after prune, len=%d", got)
	}
}

// TestNonceStore_concurrentInsertsRace exercises the mutex contract.
// Without the lock, two goroutines racing on the same nonce could
// both pass the existence check and double-insert — the test would
// then sometimes see counts > 1 for the same key. With the lock,
// exactly one inserts and the rest get 401-replay.
func TestNonceStore_concurrentInsertsRace(t *testing.T) {
	s := NewNonceStore()
	const goroutines = 32
	var wg sync.WaitGroup
	successes := 0
	var mu sync.Mutex
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := s.CheckAndStore("paneA", "shared-nonce")
			if err == nil {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if successes != 1 {
		t.Errorf("concurrent inserts: %d succeeded, want exactly 1", successes)
	}
	if got := s.Len(); got != 1 {
		t.Errorf("len=%d want 1", got)
	}
}

// --- Shim ↔ server interop ---

// TestShim_signatureMatchesVerifier runs the actual reck-claude-hook.sh
// shim against a captured-curl mock and feeds its computed HMAC
// signature back through VerifyHookSignature. Pins the cross-language
// canonical-string contract — if the shim ever drifts from
// METHOD + "\n" + PATH + "\n" + BODY, this test fails locally before
// any production daemon ever rejects a real hook.
//
// Skipped if /bin/bash, openssl, or python3 are unavailable, but on a
// stock macOS dev machine + the daemon's CI image those are all
// present.
func TestShim_signatureMatchesVerifier(t *testing.T) {
	for _, bin := range []string{"/bin/bash", "openssl", "python3"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("shim test prereq missing: %s (%v)", bin, err)
		}
	}

	// Locate the shim relative to this test file. The test is in
	// daemon/internal/http; the shim lives in daemon/internal/hooks.
	shimPath, err := filepath.Abs("../hooks/reck-claude-hook.sh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(shimPath); err != nil {
		t.Fatalf("shim not found at %s: %v", shimPath, err)
	}

	const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	const paneID = "p_testpane01"
	const projectID = "proj1"

	// Build a tmp dir holding a `curl` shim that captures all args and
	// the body file, then prepend it to PATH so the real shim invokes
	// our capture instead of network curl.
	tmp := t.TempDir()
	captureFile := filepath.Join(tmp, "captured")
	bodyCopyFile := filepath.Join(tmp, "body")
	curlShim := filepath.Join(tmp, "curl")
	curlShimBody := `#!/usr/bin/env bash
{
  for arg in "$@"; do
    printf '%s\n' "$arg"
  done
} > ` + shellQuote(captureFile) + `
for arg in "$@"; do
  case "$arg" in
    @*)
      cp "${arg:1}" ` + shellQuote(bodyCopyFile) + `
      ;;
  esac
done
`
	if err := os.WriteFile(curlShim, []byte(curlShimBody), 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("/bin/bash", shimPath, "user_prompt")
	cmd.Stdin = bytes.NewBufferString(`{"prompt":"hello world"}`)
	cmd.Env = append(os.Environ(),
		"PATH="+tmp+string(os.PathListSeparator)+os.Getenv("PATH"),
		"RECK_PANE_ID="+paneID,
		"RECK_PROJECT_ID="+projectID,
		"RECK_DAEMON_URL=http://127.0.0.1:9999",
		"RECK_HOOK_SECRET="+secret,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("shim run failed: %v\nout: %s", err, out)
	}

	captured, err := os.ReadFile(captureFile)
	if err != nil {
		t.Fatalf("capture missing: %v", err)
	}
	body, err := os.ReadFile(bodyCopyFile)
	if err != nil {
		t.Fatalf("body capture missing: %v", err)
	}

	// Pull the headers we care about out of the captured args.
	headers := map[string]string{}
	lines := strings.Split(strings.TrimSpace(string(captured)), "\n")
	for i := 0; i < len(lines)-1; i++ {
		if lines[i] == "-H" {
			parts := strings.SplitN(lines[i+1], ":", 2)
			if len(parts) == 2 {
				headers[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
			}
		}
	}

	sig := headers[HookAuthHeaderSig]
	ts := headers[HookAuthHeaderTs]
	nonce := headers[HookAuthHeaderNonce]
	if sig == "" || ts == "" || nonce == "" {
		t.Fatalf("shim didn't emit all hook headers: %+v", headers)
	}

	// Verify body is a JSON object with the merged project_id.
	var bodyObj map[string]any
	if err := json.Unmarshal(body, &bodyObj); err != nil {
		t.Fatalf("shim body not JSON: %v\n%s", err, body)
	}
	if got, want := bodyObj["project_id"], projectID; got != want {
		t.Errorf("shim body project_id=%v, want %s", got, want)
	}
	if got, want := bodyObj["prompt"], "hello world"; got != want {
		t.Errorf("shim body lost original prompt: got=%v want=%s", got, want)
	}

	// Round-trip the shim's signature through VerifyHookSignature. The
	// nonce store accepts on first use; if either the canonical-string
	// shape OR the HMAC math drifts, this returns a HookAuthError.
	store := NewNonceStore()
	path := "/panes/" + paneID + "/agent-event"
	err = VerifyHookSignature(store, secret, "POST", path, body, sig, ts, nonce)
	if err != nil {
		t.Fatalf("server rejected shim signature: %v\nbody: %s\nheaders: %+v",
			err, body, headers)
	}
}

// shellQuote single-quotes a string for safe embedding in a bash
// snippet. The shim test only ever feeds tmpdir paths through it so a
// minimal escape (single-quote → '\'') is sufficient.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func init() {
	// Touch strings to keep imports honest if a refactor moves error
	// constants around without updating tests.
	_ = strings.HasPrefix
}
