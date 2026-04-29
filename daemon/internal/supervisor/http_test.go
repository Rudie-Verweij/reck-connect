package supervisor

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestMissionControlChat_bodyTooLarge mirrors the agent-event body-cap
// test in internal/http: an oversize chat payload must be rejected
// with 413, not silently truncated into a malformed-JSON 400. This is
// the companion to a Codex finding — before the refactor, ServeChat
// used io.LimitReader, which quietly dropped the tail instead of
// surfacing the overflow.
//
// The 413 path short-circuits in httpx.DecodeJSONBody before any
// Controller/Manager state is touched, so a zero-value Controller is
// sufficient for this test.
func TestMissionControlChat_bodyTooLarge(t *testing.T) {
	// Valid-ish JSON wrapper + oversize filler that pushes the total
	// body well past maxChatMessage. MaxBytesReader inside
	// DecodeJSONBody fires and returns 413.
	filler := bytes.Repeat([]byte("x"), maxChatMessage+10_000)
	body := []byte(`{"message":"`)
	body = append(body, filler...)
	body = append(body, []byte(`"}`)...)

	req := httptest.NewRequest(http.MethodPost, "/mission-control/chat",
		bytes.NewReader(body))
	rec := httptest.NewRecorder()

	var c Controller // zero value: auth off, no manager, no token
	c.ServeChat(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		got, _ := io.ReadAll(rec.Body)
		t.Errorf("status = %d body=%q, want 413", rec.Code, string(got))
	}
}

// TestMissionControlChat_trailingData is the trailing-data counterpart:
// a small valid JSON value followed by non-whitespace inside the cap
// must be rejected as 400 "trailing data after JSON body", not
// silently accepted. This guards the same hole on ServeChat that
// TestDecodeJSONBody_rejectsTrailingGarbageWithinCap guards on
// /projects — one shared helper means one shared rejection policy.
func TestMissionControlChat_trailingData(t *testing.T) {
	body := []byte(`{"message":"hi"}garbage after body {}`)

	req := httptest.NewRequest(http.MethodPost, "/mission-control/chat",
		bytes.NewReader(body))
	rec := httptest.NewRecorder()

	var c Controller
	c.ServeChat(rec, req)

	if rec.Code != http.StatusBadRequest {
		got, _ := io.ReadAll(rec.Body)
		t.Errorf("status = %d body=%q, want 400 (trailing data)",
			rec.Code, string(got))
	}
	got := rec.Body.String()
	if !strings.Contains(got, "trailing data") {
		t.Errorf("body = %q, want 'trailing data' marker", got)
	}
}

// TestMissionControlChat_wellFormedShortCircuitsOnEmptyMessage sanity
// checks that a well-formed body with an empty message reaches the
// normal 400 "message required" path, not 413/400 from the decode
// helper. If this test flips to 413 after a cap change, the helper
// and the empty-message check are disagreeing about when to reject.
func TestMissionControlChat_wellFormedShortCircuitsOnEmptyMessage(t *testing.T) {
	body := fmt.Sprintf(`{"message":%q}`, "")

	req := httptest.NewRequest(http.MethodPost, "/mission-control/chat",
		bytes.NewReader([]byte(body)))
	rec := httptest.NewRecorder()

	var c Controller
	c.ServeChat(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (message required)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "message required") {
		t.Errorf("body = %q, want 'message required'", rec.Body.String())
	}
}
