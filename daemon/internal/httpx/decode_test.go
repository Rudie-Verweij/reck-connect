package httpx

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type payload struct {
	Name string `json:"name"`
}

// TestDecodeJSONBody_happyPath is the baseline: a small, valid body
// decodes cleanly and the handler sees nothing written.
func TestDecodeJSONBody_happyPath(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader(`{"name":"ok"}`))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err != nil {
		t.Fatalf("unexpected err: %v (status=%d body=%q)",
			err, rec.Code, rec.Body.String())
	}
	if p.Name != "ok" {
		t.Errorf("Name = %q, want ok", p.Name)
	}
	if rec.Code != 200 {
		t.Errorf("status = %d, want 200 (helper should not write on success)", rec.Code)
	}
}

// TestDecodeJSONBody_happyPathTrailingWhitespace accepts whitespace
// tokens after the JSON value — RFC 8259 treats those as
// insignificant, so we must too.
func TestDecodeJSONBody_happyPathTrailingWhitespace(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader("{\"name\":\"ok\"}  \r\n\t\n"))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err != nil {
		t.Fatalf("whitespace after value rejected: %v", err)
	}
}

// TestDecodeJSONBody_oversize exercises the MaxBytesReader cap on a
// single oversized JSON value (the cap fires during Decode).
func TestDecodeJSONBody_oversize(t *testing.T) {
	filler := bytes.Repeat([]byte("x"), 2048)
	body := []byte(`{"name":"`)
	body = append(body, filler...)
	body = append(body, []byte(`"}`)...)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err == nil {
		t.Fatal("expected error on oversize body")
	}
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", rec.Code)
	}
}

// TestDecodeJSONBody_trailingGarbagePastCap is the core regression
// guard for a Codex finding: small valid JSON + megabytes of junk
// must be 413, not silently accepted.
func TestDecodeJSONBody_trailingGarbagePastCap(t *testing.T) {
	valid := `{"name":"ok"}`
	filler := bytes.Repeat([]byte("x"), 2048)
	body := append([]byte(valid), filler...)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err == nil {
		t.Fatal("expected error on oversize trailing data")
	}
	if rec.Code != http.StatusRequestEntityTooLarge {
		got, _ := io.ReadAll(rec.Body)
		t.Errorf("status = %d body=%q, want 413", rec.Code, string(got))
	}
}

// TestDecodeJSONBody_trailingGarbageWithinCap is the 400 variant:
// small valid JSON + small junk (well under the cap) must still be
// rejected as "trailing data after JSON body".
func TestDecodeJSONBody_trailingGarbageWithinCap(t *testing.T) {
	body := []byte(`{"name":"ok"}garbage`)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err == nil {
		t.Fatal("expected error on trailing data")
	}
	if rec.Code != http.StatusBadRequest {
		got, _ := io.ReadAll(rec.Body)
		t.Errorf("status = %d body=%q, want 400", rec.Code, string(got))
	}
	if !strings.Contains(rec.Body.String(), "trailing data") {
		t.Errorf("body = %q, want to mention 'trailing data'",
			rec.Body.String())
	}
}

// TestDecodeJSONBody_multipleJSONValues covers the "two JSON values
// concatenated" form specifically — another legitimate-looking
// attack shape. The second value is JSON, but it's still trailing
// data we refuse to parse.
func TestDecodeJSONBody_multipleJSONValues(t *testing.T) {
	body := []byte(`{"name":"a"}{"name":"b"}`)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err == nil {
		t.Fatal("expected error on multiple JSON values")
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// TestDecodeJSONBody_malformedJSON is a sanity check: syntactically
// broken input must still surface 400, not 413.
func TestDecodeJSONBody_malformedJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/x",
		strings.NewReader(`{"name": not-a-string}`))
	rec := httptest.NewRecorder()
	var p payload
	if err := DecodeJSONBody(rec, req, 1024, &p); err == nil {
		t.Fatal("expected decode error")
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
