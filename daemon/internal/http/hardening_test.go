package http

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestApplyTimeouts_wiresAllFields is a guard against a future refactor
// silently dropping one of the timeout fields. The production spine
// (main.go) calls ApplyTimeouts and nothing else, so this is the last
// line of defense before a new deployment ships with an unbounded read
// timeout or a 1 MiB header cap.
func TestApplyTimeouts_wiresAllFields(t *testing.T) {
	var s nethttp.Server
	ApplyTimeouts(&s)
	if s.ReadHeaderTimeout == 0 {
		t.Error("ReadHeaderTimeout = 0; want a bounded value")
	}
	if s.ReadTimeout == 0 {
		t.Error("ReadTimeout = 0; want a bounded value")
	}
	if s.WriteTimeout == 0 {
		t.Error("WriteTimeout = 0; want a bounded value")
	}
	if s.IdleTimeout == 0 {
		t.Error("IdleTimeout = 0; want a bounded value")
	}
	if s.MaxHeaderBytes == 0 || s.MaxHeaderBytes > 1<<20 {
		t.Errorf("MaxHeaderBytes = %d; want bounded below 1 MiB", s.MaxHeaderBytes)
	}
	// Sanity: ReadHeaderTimeout must be <= ReadTimeout. If header-timeout
	// is longer, slow-loris on headers effectively wins.
	if s.ReadHeaderTimeout > s.ReadTimeout {
		t.Errorf("ReadHeaderTimeout (%v) > ReadTimeout (%v)",
			s.ReadHeaderTimeout, s.ReadTimeout)
	}
}

// TestHTTPSlowLoris_closesConnection exercises the real http.Server
// hardening with a shortened ReadHeaderTimeout: a client that writes the
// request line then stalls must be disconnected before the handler runs.
// We shrink the timeout to 200ms so the test doesn't wall-clock for 5s.
func TestHTTPSlowLoris_closesConnection(t *testing.T) {
	s := newServer(t)
	httpServer := &nethttp.Server{
		Handler:           s.Router(),
		ReadHeaderTimeout: 200 * time.Millisecond,
		ReadTimeout:       400 * time.Millisecond,
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = httpServer.Serve(ln) }()
	t.Cleanup(func() { _ = httpServer.Close() })

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Write a partial request line. A real slow-loris sends partial
	// headers byte-by-byte forever; we simulate that with an
	// incomplete request that never finishes. The server must drop
	// the connection at ReadHeaderTimeout regardless.
	if _, err := conn.Write([]byte("GET /health HTTP/1.1\r\nHost: localhost\r\n")); err != nil {
		t.Fatal(err)
	}

	// Don't send the terminating \r\n. Give the server time to enforce
	// the header timeout, then try a read. net.Conn's Read must return
	// an error (usually EOF or a reset) once the server closes.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1024)
	n, readErr := conn.Read(buf)

	// Expect: either EOF, a connection reset, or a short 408 response.
	// All three are acceptable outcomes — net/http may send "408 Request
	// Timeout" before closing in some builds. What must NOT happen is a
	// successful "200 OK" reply to the partial request.
	if readErr == nil && n > 0 {
		body := string(buf[:n])
		if strings.Contains(body, "200 OK") {
			t.Errorf("server answered 200 OK on partial headers: %q", body)
		}
	}
	// A deadline-exceeded error after 2s would mean the server is still
	// holding the connection open — that's the slow-loris win condition
	// we want to reject.
	if netErr, ok := readErr.(net.Error); ok && netErr.Timeout() {
		t.Errorf("server kept slow-loris connection open past header timeout")
	}
}

// TestMaxBytesReader_returns413 exercises the per-handler body cap on
// the create-project endpoint: a POST body of maxJSONBody+1 bytes must
// be rejected with 413 Request Entity Too Large, not silently truncated
// or passed as a malformed JSON decode failure.
func TestMaxBytesReader_returns413(t *testing.T) {
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()

	// Build a JSON body that is valid JSON but larger than maxJSONBody.
	// The body begins {"name":"X","cwd":"X","filler":"<big>"} so that
	// decoding would succeed on a truncated version too — but
	// MaxBytesReader fires first with 413.
	filler := bytes.Repeat([]byte("x"), maxJSONBody+10_000)
	body := []byte(`{"name":"X","cwd":"/tmp","filler":"`)
	body = append(body, filler...)
	body = append(body, []byte(`"}`)...)
	resp, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusRequestEntityTooLarge {
		got, _ := io.ReadAll(resp.Body)
		t.Errorf("status = %d body=%q, want 413", resp.StatusCode, string(got))
	}
}

// TestDecodeJSONBody_rejectsTrailingGarbagePastCap is the adversarial
// regression: Decoder.Decode stops after the first JSON value and does
// NOT read to EOF, so without an explicit trailing-data check a caller
// can send `{"name":"ok"}<megabytes of junk>` and the MaxBytesReader
// cap never fires. decodeJSONBody must force a second Decode that
// either sees io.EOF (accept) or trips MaxBytesReader on the trailing
// bytes (413). Oversize trailing data → 413.
func TestDecodeJSONBody_rejectsTrailingGarbagePastCap(t *testing.T) {
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()
	dir := t.TempDir()

	// Valid JSON object, closed cleanly — then an enormous trailing
	// blob that pushes the total body well past maxJSONBody. A second
	// Decode call hits MaxBytesReader and surfaces 413.
	valid := fmt.Sprintf(`{"name":"Trail","cwd":%q}`, dir)
	filler := bytes.Repeat([]byte("x"), maxJSONBody+10_000)
	body := append([]byte(valid), filler...)

	resp, err := nethttp.Post(srv.URL+"/projects", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusRequestEntityTooLarge {
		got, _ := io.ReadAll(resp.Body)
		t.Errorf("status = %d body=%q, want 413 (oversize trailing garbage)",
			resp.StatusCode, string(got))
	}
}

// TestDecodeJSONBody_rejectsTrailingGarbageWithinCap is the companion
// case where the trailing data stays under MaxBytesReader's cap but is
// still unambiguously "more than one JSON value". Must be 400 with the
// "trailing data" body so callers aren't silently accepted.
func TestDecodeJSONBody_rejectsTrailingGarbageWithinCap(t *testing.T) {
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()
	dir := t.TempDir()

	// Valid JSON + some junk (well under maxJSONBody so the 413 path
	// doesn't fire). Without the second Decode, the handler would
	// happily accept — this test guarantees it doesn't.
	valid := fmt.Sprintf(`{"name":"Trail","cwd":%q}`, dir)
	body := valid + `   garbage after body {}`

	resp, err := nethttp.Post(srv.URL+"/projects", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != nethttp.StatusBadRequest {
		t.Errorf("status = %d body=%q, want 400 (trailing data within cap)",
			resp.StatusCode, string(got))
	}
	// Spot-check the error string so a future refactor that silently
	// drops the trailing check shows up as a test failure rather than
	// just a status-code flip.
	if !bytes.Contains(got, []byte("trailing data")) {
		t.Errorf("body = %q, want to mention 'trailing data'", string(got))
	}
}

// TestMaxBytesReader_normalBodyPasses is the counterexample: a small,
// valid body on the same endpoint must pass, proving MaxBytesReader
// doesn't over-restrict legitimate traffic.
func TestMaxBytesReader_normalBodyPasses(t *testing.T) {
	srv := httptest.NewServer(newTestHandler(t, newServer(t)))
	defer srv.Close()
	dir := t.TempDir()
	body := fmt.Sprintf(`{"name":"Ok","cwd":%q}`, dir)
	resp, err := nethttp.Post(srv.URL+"/projects", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		got, _ := io.ReadAll(resp.Body)
		t.Errorf("small body rejected: status=%d body=%q", resp.StatusCode, string(got))
	}
}

// TestAgentEvent_bodyTooLarge hits the agent-event path specifically.
// It has its own body cap (1 MiB) since lifecycle hooks can ship full
// tool I/O dumps. Going over must still surface 413.
func TestAgentEvent_bodyTooLarge(t *testing.T) {
	s, pane := newServerWithPane(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	// JSON array of enough data to exceed maxAgentEventBody+1 bytes so
	// MaxBytesReader's overflow fires. The body is valid JSON at the
	// cap but becomes oversize once past it.
	filler := bytes.Repeat([]byte("x"), maxAgentEventBody+10_000)
	body := []byte(`{"dump":"`)
	body = append(body, filler...)
	body = append(body, []byte(`"}`)...)

	u := srv.URL + "/panes/" + pane.ID + "/agent-event?kind=user_prompt&agent=claude-code"
	resp, err := nethttp.Post(u, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != nethttp.StatusRequestEntityTooLarge {
		t.Errorf("agent-event oversize body: status=%d want 413", resp.StatusCode)
	}
}

// TestHeaderCap_rejectsOversizeHeader confirms MaxHeaderBytes trims the
// 1 MiB net/http default to something actually bounded. We spin up a
// real listener with a tiny cap and send a bloated header well past
// both the cap and net/http's internal 4 KiB read buffer; the server
// must close the connection or return 431.
func TestHeaderCap_rejectsOversizeHeader(t *testing.T) {
	s := newServer(t)
	const cap = 512
	httpServer := &nethttp.Server{
		Handler:           s.Router(),
		ReadHeaderTimeout: 2 * time.Second,
		MaxHeaderBytes:    cap,
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = httpServer.Serve(ln) }()
	t.Cleanup(func() { _ = httpServer.Close() })

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))

	// Send a request with headers well over the cap. net/http reserves
	// an internal 4 KiB read buffer, so we push past both MaxHeaderBytes
	// and that buffer so the reject fires deterministically.
	big := strings.Repeat("X", 16*1024)
	req := "GET /health HTTP/1.1\r\nHost: localhost\r\nX-Huge: " + big + "\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		// Some stacks RST the connection mid-write once the header
		// cap fires. That is a valid rejection outcome too.
		return
	}

	// Expect either 431 Request Header Fields Too Large or EOF/close
	// within the deadline. What must NOT happen is a 200.
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		return // EOF before any response is also an acceptable result
	}
	if strings.Contains(line, "200") {
		t.Errorf("server answered 200 despite oversized header: %q", line)
	}
}
