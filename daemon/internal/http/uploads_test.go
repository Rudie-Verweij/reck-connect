package http

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	nethttp "net/http"

	"github.com/rudie-verweij/reck-connect/proto"
)

// pngBytes is a 1x1 PNG used as the upload payload throughout these
// tests. Tiny so tests stay fast; real enough that we never depend on
// a zero-byte special case accidentally masking a bug.
var pngBytes = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

// makeUploadBody builds a multipart body with a single "file" part
// carrying the given bytes + Content-Type. Returns (body reader,
// Content-Type header).
func makeUploadBody(t *testing.T, contentType string, payload []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	// The browser passes `filename=image.png` on a paste; we set one so
	// the server has a chance to mis-trust it (the assertion is that it
	// doesn't — see TestPaneUpload_serverGeneratesFilename).
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="../../etc/passwd"`)
	hdr.Set("Content-Type", contentType)
	part, err := w.CreatePart(hdr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, w.FormDataContentType()
}

// createShellPaneInP1 spawns a shell pane under the pre-registered
// fixture project p1 (from newServer) and returns the pane id. The
// upload endpoint's live-pane-binding check doesn't care about pane
// kind, so a shell pane (which needs no Claude CLI resolved) is the
// cheapest test vehicle. Not named `createShellPane` because that
// name's already taken by pane_io_test.go for a different flow that
// creates a brand-new project first.
func createShellPaneInP1(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	body, _ := json.Marshal(proto.CreatePaneRequest{Kind: proto.PaneKindShell})
	r, err := nethttp.Post(srv.URL+"/projects/p1/panes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("create pane: status=%d body=%s", r.StatusCode, string(b))
	}
	var cr proto.CreatePaneResponse
	if err := json.NewDecoder(r.Body).Decode(&cr); err != nil {
		t.Fatal(err)
	}
	if cr.PaneID == "" {
		t.Fatal("empty pane id")
	}
	return cr.PaneID
}

// TestPaneUpload_happyPath verifies the common case: paste a PNG into
// a live pane → daemon writes to a per-pane tmpdir → returns the
// absolute path → renderer types it into the PTY.
//
// Assertions pin the contract the phase-1 plan specifies:
//   - Response path is absolute.
//   - Response path lies under $TMPDIR/reck-pane-<paneID>/.
//   - The file on disk matches the uploaded bytes exactly.
//   - The generated filename ends with .png and does NOT echo the
//     client-supplied "../../etc/passwd" name.
func TestPaneUpload_happyPath(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	body, ct := makeUploadBody(t, "image/png", pngBytes)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status=%d body=%s", r.StatusCode, string(b))
	}
	var resp proto.PaneUploadResponse
	if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(resp.Path) {
		t.Fatalf("path not absolute: %q", resp.Path)
	}
	wantDir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	if gotDir := filepath.Dir(resp.Path); gotDir != wantDir {
		t.Fatalf("path parent = %q, want %q", gotDir, wantDir)
	}
	onDisk, err := os.ReadFile(resp.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, pngBytes) {
		t.Fatalf("on-disk bytes differ from uploaded bytes (got %d bytes, want %d)", len(onDisk), len(pngBytes))
	}
	// Server-generated filename: never echoes the client-supplied name,
	// always carries a MIME-derived extension.
	name := filepath.Base(resp.Path)
	if strings.Contains(name, "passwd") || strings.Contains(name, "..") || strings.Contains(name, "/") {
		t.Fatalf("filename %q leaks client-supplied path components", name)
	}
	if !strings.HasSuffix(name, ".png") {
		t.Fatalf("filename %q doesn't end in .png (MIME-derived extension)", name)
	}
}

// TestPaneUpload_unknownPane404 — the live-pane binding from the plan:
// "handlers must reject if the pane ID does not correspond to a
// currently-live pane". A random pane id must 404, not 200-with-tmpdir.
func TestPaneUpload_unknownPane404(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	body, ct := makeUploadBody(t, "image/png", pngBytes)
	r, err := nethttp.Post(srv.URL+"/panes/p_deadbeefcafe/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != nethttp.StatusNotFound {
		t.Fatalf("status=%d, want 404", r.StatusCode)
	}
	// Defense-in-depth: an unknown pane must NOT have created a tmpdir
	// with the rejected id. Otherwise a probe could poison disk state.
	stray := filepath.Join(os.TempDir(), "reck-pane-p_deadbeefcafe")
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Fatalf("tmpdir %q should not exist for a rejected pane", stray)
	}
}

// TestPaneUpload_badBearer401 pins the authMiddleware contract: a
// wrong bearer gets 401 before the upload handler runs, regardless of
// pane id. Without this, image bytes could be written to disk under
// an unauthenticated request — the plan explicitly calls out
// bearer-auth as required.
func TestPaneUpload_badBearer401(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-secret")
	s := newServer(t)
	// Bypass newTestHandler: this test must drive the real router so the
	// "no Authorization header" path returns 401 instead of being masked
	// by the test wrapper's bearer injection.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	// Create a live pane (using the correct token) so the "bad bearer
	// on a real pane" case exercises the 401-before-anything-else path
	// rather than the 404 path.
	createReq, _ := nethttp.NewRequest("POST", srv.URL+"/projects/p1/panes",
		bytes.NewReader(mustJSON(t, proto.CreatePaneRequest{Kind: proto.PaneKindShell})))
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("Authorization", "Bearer main-secret")
	r, err := nethttp.DefaultClient.Do(createReq)
	if err != nil {
		t.Fatal(err)
	}
	var cr proto.CreatePaneResponse
	if err := json.NewDecoder(r.Body).Decode(&cr); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if cr.PaneID == "" {
		t.Fatal("create pane failed")
	}

	// Now attempt upload without auth → 401.
	body, ct := makeUploadBody(t, "image/png", pngBytes)
	req, _ := nethttp.NewRequest("POST", srv.URL+"/panes/"+cr.PaneID+"/uploads", body)
	req.Header.Set("Content-Type", ct)
	// No Authorization header at all — authMiddleware's constant-time
	// compare against "Bearer main-secret" fails, 401.
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Fatalf("no bearer: status=%d want 401", resp.StatusCode)
	}

	// Wrong bearer — also 401.
	req, _ = nethttp.NewRequest("POST", srv.URL+"/panes/"+cr.PaneID+"/uploads", body)
	req.Header.Set("Content-Type", ct)
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err = nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Fatalf("wrong bearer: status=%d want 401", resp.StatusCode)
	}
}

// TestPaneUpload_cleanupOnPaneClose — the plan calls this out
// explicitly: "Per-pane tmpdir … invoked in whatever path currently
// handles pane termination (DeletePane / PTY EOF / close)." We verify
// the DeletePane path here: upload → tmpdir exists → delete pane →
// tmpdir gone.
//
// The PTY-EOF path is exercised by the pane_test.go cleanup test in
// the pty package, which doesn't need HTTP scaffolding.
func TestPaneUpload_cleanupOnPaneClose(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	body, ct := makeUploadBody(t, "image/png", pngBytes)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("upload status=%d", r.StatusCode)
	}
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("upload dir should exist before pane close: %v", err)
	}

	// Close the pane via the HTTP endpoint — same path the Satellite
	// uses — so cleanup runs through whatever wiring the daemon
	// actually deploys.
	delReq, _ := nethttp.NewRequest("DELETE", srv.URL+"/projects/p1/panes/"+paneID, nil)
	resp, err := nethttp.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("delete pane status=%d", resp.StatusCode)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("upload dir should be gone after pane close; stat err = %v", err)
	}
}

// TestPaneUpload_unsupportedMIME415 pins the MIME allowlist contract
// from the plan's security section: a declared type outside the
// allowlist is rejected with 415 Unsupported Media Type before it
// reaches disk. application/octet-stream stands in for any binary the
// renderer would never send (it only sends allowlisted MIMEs).
func TestPaneUpload_unsupportedMIME415(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	body, ct := makeUploadBody(t, "application/octet-stream", []byte("arbitrary bytes"))
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != nethttp.StatusUnsupportedMediaType {
		t.Fatalf("status=%d, want 415", r.StatusCode)
	}
	// Sanity: no stray file was written for the rejected MIME.
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) > 0 {
		t.Fatalf("rejected MIME left %d file(s) on disk", len(entries))
	}
}

// TestPaneUpload_pdfAccepted covers Scope B: a PDF (strict sniff, magic
// bytes recognised by the stdlib) uploads and lands with a .pdf name.
func TestPaneUpload_pdfAccepted(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	// "%PDF-" prefix makes http.DetectContentType report application/pdf.
	body, ct := makeUploadBody(t, "application/pdf", []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"))
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status=%d body=%s, want 200", r.StatusCode, string(b))
	}
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".pdf") {
		t.Fatalf("want one .pdf on disk, got %v", entries)
	}
}

// TestPaneUpload_textMarkdownAccepted covers the sniffText policy: a
// Markdown file is declared text/markdown but sniffs as text/plain, and
// must be accepted (equality would wrongly reject it) and saved .md.
func TestPaneUpload_textMarkdownAccepted(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	body, ct := makeUploadBody(t, "text/markdown", []byte("# Title\n\nSome **markdown** body.\n"))
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status=%d body=%s, want 200", r.StatusCode, string(b))
	}
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".md") {
		t.Fatalf("want one .md on disk, got %v", entries)
	}
}

// makeUploadBodyNamed is makeUploadBody with a caller-chosen client
// filename, for exercising the arbitrary-file path (extension derived
// from the untrusted filename).
func makeUploadBodyNamed(t *testing.T, contentType, filename string, payload []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
	hdr.Set("Content-Type", contentType)
	part, err := w.CreatePart(hdr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, w.FormDataContentType()
}

// TestPaneUpload_arbitraryFileByExtension covers the drag-drop any-file
// path: a type not in the MIME allowlist is stored, with its extension
// taken from the (untrusted) client filename and no content sniff.
func TestPaneUpload_arbitraryFileByExtension(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	body, ct := makeUploadBodyNamed(t, "application/octet-stream", "analysis.py", []byte("import os\nprint('hi')\n"))
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status=%d body=%s, want 200", r.StatusCode, string(b))
	}
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".py") {
		t.Fatalf("want one .py on disk, got %v", entries)
	}
	// Server-generated basename must not echo the client filename.
	if strings.Contains(entries[0].Name(), "analysis") {
		t.Fatalf("stored name %q leaks client filename", entries[0].Name())
	}
}

// TestPaneUpload_arbitraryRejectsUnusableExtension: an unknown MIME with
// no usable extension (no dot, or a non-alphanumeric one) is rejected —
// the server has nothing safe to name the file.
func TestPaneUpload_arbitraryRejectsUnusableExtension(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	for _, name := range []string{"Makefile", "../../etc/passwd", "weird.name!", "trailingdot."} {
		body, ct := makeUploadBodyNamed(t, "application/octet-stream", name, []byte("data"))
		r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != nethttp.StatusUnsupportedMediaType {
			t.Fatalf("filename %q: status=%d, want 415", name, r.StatusCode)
		}
	}
}

// TestPaneUpload_textRejectsBinary covers the sniffText security gate: a
// binary payload declared under a text extension (here text/plain with
// PKZip bytes) must be rejected, so an executable/archive can't be
// smuggled in disguised as a .txt.
func TestPaneUpload_textRejectsBinary(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	zipBytes := []byte{0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00}
	body, ct := makeUploadBody(t, "text/plain", zipBytes)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != nethttp.StatusUnsupportedMediaType {
		t.Fatalf("status=%d, want 415", r.StatusCode)
	}
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) > 0 {
		t.Fatalf("binary-as-text upload left %d file(s) on disk", len(entries))
	}
}

// TestSweepStalePaneUploadDirs verifies the startup sweep removes
// `reck-pane-*` dirs that don't match a currently-live pane id. The
// plan calls this out as the hedge against ungraceful shutdowns.
func TestSweepStalePaneUploadDirs(t *testing.T) {
	// Point $TMPDIR at a fresh dir so we're not picking up the real
	// daemon's leftovers on a developer machine. os.TempDir() reads
	// TMPDIR on every call — perfect for this test shape.
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	stale := filepath.Join(tmp, "reck-pane-p_staleone")
	live := filepath.Join(tmp, "reck-pane-p_liveone")
	other := filepath.Join(tmp, "not-reck-at-all")
	for _, d := range []string{stale, live, other} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	SweepStalePaneUploadDirs(map[string]bool{"p_liveone": true})

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale dir should be removed: %v", err)
	}
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("live dir should be preserved: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("unrelated dir should be untouched: %v", err)
	}
}

// mustJSON is a one-liner helper so test call sites don't repeat the
// json.Marshal / _ = err dance.
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestPaneUpload_contentSniffRejection pins the magic-byte sniff
// contract: a request declaring image/png but carrying non-image
// bytes (a PKZip header in this case) is rejected with 415 and no
// file is written to disk. Without this, a hostile client could slip
// arbitrary content past the declared-MIME allowlist by lying about
// Content-Type.
func TestPaneUpload_contentSniffRejection(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	// PKZip signature: 50 4b 03 04. DetectContentType returns
	// "application/zip" for this — not in the image allowlist.
	zipBytes := []byte{0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00}
	body, ct := makeUploadBody(t, "image/png", zipBytes)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != nethttp.StatusUnsupportedMediaType {
		t.Fatalf("status=%d, want 415", r.StatusCode)
	}
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) > 0 {
		t.Fatalf("content-sniff rejected upload left %d file(s) in %q", len(entries), dir)
	}
}

// TestPaneUpload_declaredVsDetectedMismatch pins the strict MIME
// match: a client declaring image/png but shipping JPEG bytes must
// be rejected even though BOTH types are in the allowlist. Without
// strict equality the file would be written with a .png extension
// containing JPEG content, breaking any downstream consumer that
// trusts the extension to tell it how to decode.
func TestPaneUpload_declaredVsDetectedMismatch(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	// JPEG SOI marker (FF D8 FF E0) + JFIF header. DetectContentType
	// returns "image/jpeg" for this. Declaring image/png while
	// sending these bytes must be rejected.
	jpegBytes := []byte{
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
	}
	body, ct := makeUploadBody(t, "image/png", jpegBytes)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != nethttp.StatusUnsupportedMediaType {
		t.Fatalf("status=%d, want 415 (declared/detected mismatch)", r.StatusCode)
	}
}

// TestPaneUpload_sizeBoundaryAtMax: exactly maxUploadBytes of payload
// is accepted. The multipart envelope adds ~150 bytes on top — the
// MaxBytesReader cap (maxUploadBytes + multipartHeadroom) covers that
// without truncating the file. Pins the "20 MiB limit applied to
// wrong boundary" fix.
func TestPaneUpload_sizeBoundaryAtMax(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping 20 MiB upload in short mode")
	}
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	payload := make([]byte, maxUploadBytes)
	// Put a real PNG signature at the front so sniff accepts it.
	copy(payload, pngBytes)
	body, ct := makeUploadBody(t, "image/png", payload)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status=%d body=%s, want 200 (at-max boundary)", r.StatusCode, string(b))
	}
}

// TestPaneUpload_sizeBoundaryOverMax: one byte over maxUploadBytes is
// rejected with 413. Pins the post-copy file-size enforcement that
// catches oversize bytes that slipped past MaxBytesReader's
// envelope-inclusive cap.
func TestPaneUpload_sizeBoundaryOverMax(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping 20 MiB+1 upload in short mode")
	}
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)
	payload := make([]byte, maxUploadBytes+1)
	copy(payload, pngBytes)
	body, ct := makeUploadBody(t, "image/png", payload)
	r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != nethttp.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d, want 413", r.StatusCode)
	}
	// No stray file on disk for an oversize upload.
	dir := filepath.Join(os.TempDir(), "reck-pane-"+paneID)
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) > 0 {
		t.Fatalf("oversize upload left %d file(s) in %q", len(entries), dir)
	}
}

// Note: the "kill pane mid-upload returns 499" invariant is covered
// by TestPane_UploadsCtxCancelsBeforeCleanup in the pty package —
// the unit test proves Kill cancels UploadsCtx before registered
// cleanup callbacks fire, which is the ordering the HTTP handler
// relies on to abort before rm-rf races the in-flight write. An
// end-to-end HTTP test would need a reliable way to stall the
// server inside ParseMultipartForm, which ParseMultipartForm's
// batched body reads don't expose without a bespoke slow-reader
// plumbed through net/http's internals — not worth the flakiness
// for marginal coverage over the unit test.

// TestListPaneUploads_happyPath verifies GET /panes/:pane_id/uploads
// returns every previously-uploaded image for the pane, with
// size_bytes + mod_time populated and ordered newest-first.
func TestListPaneUploads_happyPath(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)

	// Upload twice so we can assert list length + ordering.
	uploaded := make([]string, 0, 2)
	for i := 0; i < 2; i++ {
		body, ct := makeUploadBody(t, "image/png", pngBytes)
		r, err := nethttp.Post(srv.URL+"/panes/"+paneID+"/uploads", ct, body)
		if err != nil {
			t.Fatal(err)
		}
		var resp proto.PaneUploadResponse
		if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if resp.Path == "" {
			t.Fatalf("upload %d: empty path", i)
		}
		uploaded = append(uploaded, resp.Path)
	}

	// Now list.
	r, err := nethttp.Get(srv.URL + "/panes/" + paneID + "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("status=%d body=%s", r.StatusCode, string(b))
	}
	var list proto.PaneUploadsListResponse
	if err := json.NewDecoder(r.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Uploads) != 2 {
		t.Fatalf("got %d uploads, want 2", len(list.Uploads))
	}
	// Every listed path must match an upload response path — the list
	// must not invent paths or drop any. Filesystem mtime resolution on
	// some platforms (APFS: 1 ns; ext4: 1 s) makes the newest-first
	// ordering assertion tie-dependent, so compare as a set first.
	gotSet := map[string]bool{list.Uploads[0].Path: true, list.Uploads[1].Path: true}
	for _, p := range uploaded {
		if !gotSet[p] {
			t.Errorf("upload %q missing from list response", p)
		}
	}
	for _, u := range list.Uploads {
		if u.SizeBytes != int64(len(pngBytes)) {
			t.Errorf("size_bytes=%d want %d", u.SizeBytes, len(pngBytes))
		}
		if u.ModTime == "" {
			t.Errorf("mod_time empty for %s", u.Path)
		}
		if !filepath.IsAbs(u.Path) {
			t.Errorf("path %q not absolute", u.Path)
		}
	}
}

// TestListPaneUploads_emptyBeforeAnyUpload — a pane that has never
// received an upload lists as `{"uploads": []}` (200), not 404. The
// per-pane tmpdir is lazy so ReadDir returns ENOENT; the handler
// collapses that to an empty list so callers can treat all panes
// uniformly.
func TestListPaneUploads_emptyBeforeAnyUpload(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	paneID := createShellPaneInP1(t, srv)

	r, err := nethttp.Get(srv.URL + "/panes/" + paneID + "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("status=%d want 200", r.StatusCode)
	}
	var list proto.PaneUploadsListResponse
	if err := json.NewDecoder(r.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Uploads) != 0 {
		t.Fatalf("got %d uploads, want 0", len(list.Uploads))
	}
}

// TestListPaneUploads_unknownPane404 mirrors the POST's live-pane
// binding: a random/unknown pane id must 404, not return an empty list
// (which would let an attacker distinguish "pane exists but empty" from
// "pane doesn't exist" by status code — not a meaningful secret, but
// keeping the POST and GET behaviours symmetrical avoids surprising a
// caller that switches methods).
func TestListPaneUploads_unknownPane404(t *testing.T) {
	s := newServer(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	r, err := nethttp.Get(srv.URL + "/panes/p_does_not_exist/uploads")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != nethttp.StatusNotFound {
		t.Fatalf("status=%d want 404", r.StatusCode)
	}
}
