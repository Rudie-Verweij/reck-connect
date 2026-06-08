package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// newServerWithClipboard wires the standard fixture plus a stub
// clipboardWrite. The default stub is a no-op success — tests that need
// failure modes override it before calling Router().
func newServerWithClipboard(t *testing.T) (*Server, *clipboardCallRecorder) {
	t.Helper()
	s := newServer(t)
	rec := &clipboardCallRecorder{}
	s.ClipboardWriter = rec.Write
	return s, rec
}

type clipboardCallRecorder struct {
	mu       sync.Mutex
	calls    []recordedCall
	stub     func(string, []byte) error
}

type recordedCall struct {
	mime string
	body []byte
}

func (r *clipboardCallRecorder) Write(mime string, body []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, recordedCall{mime: mime, body: append([]byte(nil), body...)})
	if r.stub != nil {
		return r.stub(mime, body)
	}
	return nil
}

func (r *clipboardCallRecorder) Calls() []recordedCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]recordedCall, len(r.calls))
	copy(out, r.calls)
	return out
}

func (r *clipboardCallRecorder) SetStub(fn func(string, []byte) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stub = fn
}

func TestClipboardImage_happyPath(t *testing.T) {
	s, rec := newServerWithClipboard(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	body := bytes.NewReader(pngBytes)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+paneID+"/clipboard-image", body)
	req.Header.Set("Content-Type", "image/png")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, string(b))
	}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatal("expected ok:true")
	}
	calls := rec.Calls()
	if len(calls) != 1 {
		t.Fatalf("clipboard writer calls=%d, want 1", len(calls))
	}
	if calls[0].mime != "image/png" {
		t.Fatalf("mime=%q want image/png", calls[0].mime)
	}
	if !bytes.Equal(calls[0].body, pngBytes) {
		t.Fatal("body bytes mismatch through endpoint")
	}
}

func TestClipboardImage_unknownPane404(t *testing.T) {
	s, rec := newServerWithClipboard(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body := bytes.NewReader(pngBytes)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/p_notreal/clipboard-image", body)
	req.Header.Set("Content-Type", "image/png")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusNotFound {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
	if calls := rec.Calls(); len(calls) != 0 {
		t.Fatalf("clipboard writer should not be called on 404; got %d", len(calls))
	}
}

func TestClipboardImage_unsupportedMIME415(t *testing.T) {
	s, rec := newServerWithClipboard(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+paneID+"/clipboard-image",
		bytes.NewReader([]byte{0xff, 0xd8}))
	req.Header.Set("Content-Type", "image/svg+xml")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnsupportedMediaType {
		t.Fatalf("status=%d want 415", resp.StatusCode)
	}
	if calls := rec.Calls(); len(calls) != 0 {
		t.Fatalf("expected no clipboard write; got %d", len(calls))
	}
}

func TestClipboardImage_oversize413(t *testing.T) {
	s, rec := newServerWithClipboard(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	big := make([]byte, maxClipboardImageBytes+1024)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+paneID+"/clipboard-image",
		bytes.NewReader(big))
	req.Header.Set("Content-Type", "image/png")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d want 413", resp.StatusCode)
	}
	if calls := rec.Calls(); len(calls) != 0 {
		t.Fatalf("expected no clipboard write; got %d", len(calls))
	}
}

// phase 2: the sidecar is gone, so the old "503 with
// reason" contract is gone too. A pasteboard write failure now
// returns 500 with the error text — the satellite renderer can
// still fall back to the universal /uploads path on any non-200.
func TestClipboardImage_pasteboardErrorReturns500(t *testing.T) {
	s, rec := newServerWithClipboard(t)
	rec.SetStub(func(string, []byte) error {
		return errors.New("simulated NSPasteboard rejection")
	})
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+paneID+"/clipboard-image",
		bytes.NewReader(pngBytes))
	req.Header.Set("Content-Type", "image/png")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusInternalServerError {
		t.Fatalf("status=%d want 500", resp.StatusCode)
	}
}

func TestClipboardImage_emptyBody400(t *testing.T) {
	s, _ := newServerWithClipboard(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+paneID+"/clipboard-image",
		bytes.NewReader(nil))
	req.Header.Set("Content-Type", "image/png")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusBadRequest {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

// TestPaneInfo_capabilitiesFlag pins the Pane.Info contract: the
// capabilities object surfaces ClipboardImage = true only when (a)
// the pane is Claude AND (b) the daemon is on darwin. Shell panes
// always report false because writing 0x16 to a shell would do
// something surprising.
func TestPaneInfo_capabilitiesFlag(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()
	paneID := createShellPaneInP1(t, srv)

	d, ok := s.Manager.PaneByID(paneID)
	if !ok {
		t.Fatal("pane lookup failed")
	}
	info := d.Info()
	if info.Capabilities.ClipboardImage {
		t.Fatal("shell pane must not report clipboard_image=true")
	}

	// Verify the capabilities object always serialises (no omitempty).
	raw, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"capabilities":`) {
		t.Fatalf("Pane JSON missing capabilities key: %s", string(raw))
	}
}
