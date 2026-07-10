package http

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	nethttp "net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

// Image-paste upload support (an earlier release, phase 1).
//
// Shape: `POST /panes/:pane_id/uploads` accepts a `multipart/form-data`
// body with one `file` field. The daemon writes the bytes to a per-pane
// tmpdir (`$TMPDIR/reck-pane-<paneID>/`), generates a server-side filename
// (client-supplied names are discarded), and returns the absolute path.
//
// The renderer types the returned path into the PTY as bare text so the
// model (or the user) can read the file off disk. No clipboard write,
// no inline-image protocol — phase 2 adds those; phase 1 is the
// "universal works anywhere" surface.
//
// Security:
//   - Bearer auth is enforced by the router's authMiddleware — no
//     loopback exemption for this endpoint (the hook-shim exemption
//     only covers /panes/:id/agent-event).
//   - 404 when the pane id isn't a currently-live pane. This binds
//     uploads to the WS lifecycle: pane closed → further uploads
//     rejected, no "forgotten" tmpdirs get new bytes.
//   - MIME allowlist (image/png, image/jpeg, image/webp, image/gif).
//     Rejecting other types here is defence-in-depth against typed
//     client bugs; we're not the only line of defence but we shouldn't
//     be the weakest.
//   - Per-request size cap at maxUploadBytes (20 MiB), enforced via
//     MaxBytesReader so oversize doesn't silently truncate.
//   - Filenames are generated server-side from `<unix-ns>-<16-hex>.<ext>`
//     — the client-supplied filename is discarded to close the
//     path-injection class.
//   - Returned absolute paths are treated as bearer-authorised data:
//     the success log line carries pane_id + byte count only, never
//     the path itself.
//
// Cleanup:
//   - Per-pane tmpdir is created lazily on first upload via
//     ensurePaneUploadDir, which also registers a Pane.AddCleanup
//     hook to rm -rf the dir when the pane tears down (either via
//     DeletePane.Kill or child-exit.waitLoop).
//   - On daemon startup, SweepStalePaneUploadDirs removes any
//     `reck-pane-*` dirs left over from a previous daemon run
//     (ungraceful shutdown). Called from cmd/reck-stationd/main.go.

// maxUploadBytes caps a single image upload. 20 MiB matches the plan's
// explicit bound and sits below Anthropic's practical per-image ceiling,
// so anything rejected here would also be rejected downstream. Tight
// enough that a runaway or malicious renderer can't fill the pane tmpdir
// with one shot; loose enough for a full-screen Retina PNG.
const maxUploadBytes = 20 * 1024 * 1024

// multipartHeadroom is the slack above maxUploadBytes allowed for
// multipart envelope overhead (boundary lines, Content-Disposition +
// Content-Type part headers, CRLFs). 64 KiB covers realistic
// browser-emitted headers with margin; the real file-size enforcement
// happens post-copy against maxUploadBytes directly.
const multipartHeadroom = 64 * 1024

// sniffLen is the prefix size fed to http.DetectContentType for
// magic-byte identification. 512 matches the function's documented
// sample budget.
const sniffLen = 512

// statusClientClosedRequest mirrors nginx's 499 ("Client Closed
// Request"). Returned when an upload aborts mid-copy via pane-kill or
// client-disconnect — distinct from 413 (size cap) and 500 (I/O
// error) so callers can tell real failure from deterministic
// teardown.
const statusClientClosedRequest = 499

// paneUploadDirPrefix is the prefix every per-pane tmpdir shares so the
// startup sweep can find leftovers from a previous daemon run without
// needing to read state from disk. The `$TMPDIR` anchor (resolved at
// call time) keeps us on the same filesystem the OS is already scrubbing
// periodically.
const paneUploadDirPrefix = "reck-pane-"

// allowedUploadMIMEs is the phase-1 image allowlist. Non-image paste
// content falls through to the xterm default text-paste path in the
// renderer and never hits this endpoint.
var allowedUploadMIMEs = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif":  ".gif",
}

// paneUploadRegistrations tracks which live panes have already had their
// tmpdir + cleanup hook wired up. We key on pane id rather than the
// *Pane pointer so a pane that briefly disappeared + reappeared under
// the same id (shouldn't happen — ids are regenerated per spawn — but
// belt-and-suspenders) still re-registers cleanup cleanly. Protected
// by uploadRegMu.
var (
	uploadRegMu             sync.Mutex
	paneUploadRegistrations = make(map[string]bool)
)

// ctxReader wraps an io.Reader and short-circuits Read when the
// supplied ctx has been cancelled. Coarse-grained: a blocking Read
// doesn't unblock on cancel, but since the wrapped reader is the
// MaxBytesReader-capped request body, reads are bounded and each
// chunk yields a fresh ctx check. Sufficient for aborting io.Copy
// on pane-kill or client-disconnect.
type ctxReader struct {
	r   io.Reader
	ctx context.Context
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// paneUploadDir returns the absolute path of the per-pane upload dir
// for paneID, resolved against the current $TMPDIR. No side effects —
// directory creation happens in ensurePaneUploadDir.
func paneUploadDir(paneID string) string {
	return filepath.Join(os.TempDir(), paneUploadDirPrefix+paneID)
}

// ensurePaneUploadDir creates the per-pane tmpdir if it doesn't exist
// yet and registers a cleanup hook on the pane (exactly once across
// the pane's lifetime) to rm -rf the dir when the pane tears down.
// Returns the absolute directory path ready for file writes.
//
// The double-check (re-read registration flag under the lock after
// MkdirAll) guards against two concurrent uploads racing to wire the
// cleanup — pane.AddCleanup is idempotent on re-registration but we'd
// pointlessly register two identical rm-rf funcs otherwise.
func ensurePaneUploadDir(pane *pty.Pane) (string, error) {
	dir := paneUploadDir(pane.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	uploadRegMu.Lock()
	if !paneUploadRegistrations[pane.ID] {
		paneUploadRegistrations[pane.ID] = true
		// Clean up tmpdir + the registration entry when the pane dies.
		// The registration entry cleanup keeps the map from growing
		// unboundedly across a long-lived daemon.
		pane.AddCleanup(func() {
			_ = os.RemoveAll(dir)
			uploadRegMu.Lock()
			delete(paneUploadRegistrations, pane.ID)
			uploadRegMu.Unlock()
		})
	}
	uploadRegMu.Unlock()
	return dir, nil
}

// generateUploadFilename returns a server-side filename of the form
// `<unix-nanos>-<16 hex>.ext`. The nanosecond prefix keeps a natural
// sort order when listing the dir; the 16-hex random suffix avoids
// collisions if two uploads land within the same ns (the clock has <1µs
// resolution on some platforms). Client-supplied names are discarded at
// call sites; this is the only name that reaches disk.
func generateUploadFilename(ext string) (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d-%s%s", time.Now().UnixNano(), hex.EncodeToString(b[:]), ext), nil
}

// handlePaneUpload serves POST /panes/:pane_id/uploads.
//
// Accepts `multipart/form-data` with one `file` field. Rejects with:
//   - 401 — handled by authMiddleware upstream; never reaches here.
//   - 404 — pane id doesn't correspond to a live pane.
//   - 413 — body exceeds maxUploadBytes.
//   - 415 — Content-Type on the form part isn't a recognised image MIME.
//   - 400 — malformed form or missing `file` part.
//   - 500 — disk write failed.
//
// On 200, response body is `{"path": "<abs-path>"}`. The caller types
// this path into the PTY.
func (s *Server) handlePaneUpload(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		slog.Info("upload_rejected", "pane", paneID, "reason", "pane_not_found")
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}

	start := time.Now()
	slog.Info("upload_started", "pane", pane.ID, "project", pane.ProjectID)

	// Chain pane-kill with client-disconnect into a single ctx so
	// either path aborts an in-flight read. r.Context() alone fires
	// only on client-disconnect / server shutdown, not on pane-local
	// teardown; pane.UploadsCtx() alone misses client disconnects
	// mid-upload. Both are needed.
	//
	// On pane-kill we also close r.Body so a read blocked inside
	// ParseMultipartForm (waiting for more wire bytes from a slow or
	// stalled client) unwinds with an error instead of hanging until
	// the client gives up. Client-disconnect is already handled by
	// Go's http server closing the body automatically.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	paneCtx := pane.UploadsCtx()
	go func() {
		select {
		case <-paneCtx.Done():
			cancel()
			_ = r.Body.Close()
		case <-ctx.Done():
		}
	}()

	// Cap the full request body: file cap + multipart envelope
	// headroom. The real file-size cap is enforced post-copy against
	// the written bytes, independently of the envelope headroom, so
	// a tricky multipart that packs boundary bytes can't smuggle
	// past maxUploadBytes of file content.
	r.Body = nethttp.MaxBytesReader(w, r.Body, maxUploadBytes+multipartHeadroom)

	if err := r.ParseMultipartForm(maxUploadBytes + multipartHeadroom); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			reason := "client_disconnect"
			if paneCtx.Err() != nil {
				reason = "pane_kill"
			}
			slog.Info("upload_cancelled",
				"pane", pane.ID,
				"reason", reason,
				"bytes_written", 0,
				"stage", "parse_multipart",
			)
			nethttp.Error(w, "upload cancelled: "+reason, statusClientClosedRequest)
			return
		}
		var maxErr *nethttp.MaxBytesError
		if errors.As(err, &maxErr) {
			slog.Info("upload_rejected", "pane", pane.ID, "reason", "size_cap_parse")
			nethttp.Error(w, "upload too large", nethttp.StatusRequestEntityTooLarge)
			return
		}
		slog.Info("upload_rejected", "pane", pane.ID, "reason", "parse_multipart", "err", err.Error())
		nethttp.Error(w, "parse multipart: "+err.Error(), nethttp.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		slog.Info("upload_rejected", "pane", pane.ID, "reason", "missing_file")
		nethttp.Error(w, "missing file field", nethttp.StatusBadRequest)
		return
	}
	defer file.Close()

	// header.Header is a textproto.MIMEHeader — the Content-Type of
	// the form *part* (what the browser's paste-blob Content-Type
	// was), distinct from the outer request's multipart Content-Type.
	// Trim a trailing charset= in case a browser ever tags one on.
	declaredCT := normalizeContentType(header.Header.Get("Content-Type"))
	ext, ok := allowedUploadMIMEs[declaredCT]
	if !ok {
		slog.Info("upload_rejected",
			"pane", pane.ID,
			"reason", "unsupported_mime",
			"declared", declaredCT,
		)
		nethttp.Error(w, "unsupported media type", nethttp.StatusUnsupportedMediaType)
		return
	}

	// Magic-byte sniff the first chunk. Defends against a hostile or
	// buggy client lying about Content-Type to slip a non-image
	// payload (executable, script, archive) past the declared-MIME
	// allowlist above. http.DetectContentType is the standard library
	// sniffer and reports correct MIME for PNG/JPEG/GIF/WebP from the
	// first 512 bytes — all four image types we allow.
	sniffBuf := make([]byte, sniffLen)
	nSniff, sniffErr := io.ReadFull(file, sniffBuf)
	// ErrUnexpectedEOF = short but valid read; EOF = empty file. Both
	// acceptable — the sniff + subsequent allowlist check will catch
	// a genuinely malformed payload.
	if sniffErr != nil && !errors.Is(sniffErr, io.ErrUnexpectedEOF) && !errors.Is(sniffErr, io.EOF) {
		slog.Info("upload_rejected", "pane", pane.ID, "reason", "sniff_read", "err", sniffErr.Error())
		nethttp.Error(w, "read failed: "+sniffErr.Error(), nethttp.StatusBadRequest)
		return
	}
	sniffBuf = sniffBuf[:nSniff]
	detectedCT := normalizeContentType(nethttp.DetectContentType(sniffBuf))
	// Strict match: detected MIME must equal declared MIME. Relaxing
	// this to "detected is *in the allowlist*" would let a client
	// declare image/png, ship JPEG bytes (also allowlisted), and end
	// up with a `.png` file containing non-PNG bytes — so any
	// downstream consumer trusting the extension gets format-
	// confused. Requiring equality closes that gap and matches the
	// error string's stated intent.
	if detectedCT != declaredCT {
		slog.Info("upload_rejected",
			"pane", pane.ID,
			"reason", "content_sniff",
			"declared", declaredCT,
			"detected", detectedCT,
		)
		nethttp.Error(w, "content does not match declared image type", nethttp.StatusUnsupportedMediaType)
		return
	}

	dir, err := ensurePaneUploadDir(pane)
	if err != nil {
		slog.Warn("upload_failed", "pane", pane.ID, "stage", "mkdir", "err", err.Error())
		nethttp.Error(w, "mkdir: "+err.Error(), nethttp.StatusInternalServerError)
		return
	}
	name, err := generateUploadFilename(ext)
	if err != nil {
		slog.Warn("upload_failed", "pane", pane.ID, "stage", "name", "err", err.Error())
		nethttp.Error(w, "name: "+err.Error(), nethttp.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, name)

	// O_EXCL so the 16-hex suffix collision-case is a hard error
	// rather than a silent overwrite of another pane's in-flight upload.
	// 0o600 so only the daemon user can read the uploaded image from
	// disk — paths are secrets (bearer-authorised).
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		slog.Warn("upload_failed", "pane", pane.ID, "stage", "open", "err", err.Error())
		nethttp.Error(w, "open dst: "+err.Error(), nethttp.StatusInternalServerError)
		return
	}

	// Replay the sniffed prefix then stream the remainder. Wrap in a
	// ctx-aware reader so pane-kill or client-disconnect aborts the
	// copy; otherwise the tmpdir rm-rf cleanup callback could race
	// the in-flight write.
	src := &ctxReader{r: io.MultiReader(bytes.NewReader(sniffBuf), file), ctx: ctx}
	n, copyErr := io.Copy(out, src)
	closeErr := out.Close()

	// Enforce the real file-size cap post-copy. MaxBytesReader
	// capped the body at maxUploadBytes+multipartHeadroom, so a
	// client could in principle push up to that on the wire; the
	// file content itself must stay at maxUploadBytes.
	if copyErr == nil && n > maxUploadBytes {
		_ = os.Remove(dst)
		slog.Info("upload_rejected", "pane", pane.ID, "reason", "file_size_cap", "bytes", n)
		nethttp.Error(w, "upload too large", nethttp.StatusRequestEntityTooLarge)
		return
	}

	if copyErr != nil {
		_ = os.Remove(dst)
		if ctxErr := ctx.Err(); ctxErr != nil {
			reason := "client_disconnect"
			if paneCtx.Err() != nil {
				reason = "pane_kill"
			}
			slog.Info("upload_cancelled",
				"pane", pane.ID,
				"reason", reason,
				"bytes_written", n,
			)
			nethttp.Error(w, "upload cancelled: "+reason, statusClientClosedRequest)
			return
		}
		var maxErr *nethttp.MaxBytesError
		if errors.As(copyErr, &maxErr) {
			slog.Info("upload_rejected", "pane", pane.ID, "reason", "size_cap_copy", "bytes", n)
			nethttp.Error(w, "upload too large", nethttp.StatusRequestEntityTooLarge)
			return
		}
		slog.Warn("upload_failed", "pane", pane.ID, "stage", "copy", "err", copyErr.Error())
		nethttp.Error(w, "write: "+copyErr.Error(), nethttp.StatusInternalServerError)
		return
	}
	if closeErr != nil {
		_ = os.Remove(dst)
		slog.Warn("upload_failed", "pane", pane.ID, "stage", "close", "err", closeErr.Error())
		nethttp.Error(w, "close: "+closeErr.Error(), nethttp.StatusInternalServerError)
		return
	}

	// Post-copy ctx re-check. A pane-kill that fires AFTER io.Copy
	// completed but BEFORE we wrote the response would have let the
	// tmpdir cleanup rm-rf the just-written file while the handler
	// still reports 200 + path. Treat a cancelled ctx at this point
	// as a cancelled upload: delete our file (in case cleanup hasn't
	// reached it yet) and return 499 instead of a success path
	// pointing at nothing. There's a residual nanosecond window
	// between this check and writeJSON; acceptable because the
	// consumer (satellite) retries on missing-path read errors.
	if ctxErr := ctx.Err(); ctxErr != nil {
		_ = os.Remove(dst)
		reason := "client_disconnect"
		if paneCtx.Err() != nil {
			reason = "pane_kill"
		}
		slog.Info("upload_cancelled",
			"pane", pane.ID,
			"reason", reason,
			"bytes_written", n,
			"stage", "post_copy",
		)
		nethttp.Error(w, "upload cancelled: "+reason, statusClientClosedRequest)
		return
	}

	// Success log — pane id + byte count + duration. The absolute
	// path itself is bearer-authorised and must not appear at info
	// level (plan pins this: handlers "must not log upload paths").
	slog.Info("upload_completed",
		"pane", pane.ID,
		"project", pane.ProjectID,
		"mime", declaredCT,
		"bytes", n,
		"duration_ms", time.Since(start).Milliseconds(),
	)
	writeJSON(w, proto.PaneUploadResponse{Path: dst})
}

// handleListPaneUploads serves GET /panes/:pane_id/uploads.
//
// Returns the list of images currently in the pane's tmpdir — the
// uploads the daemon has written but not yet cleaned up. Paths match
// what POST /panes/:pane_id/uploads returned; SizeBytes and ModTime are
// stat'd at list time.
//
// Ordering: newest-first by ModTime (ties broken by filename, which is
// itself prefixed with unix-ns — so the tiebreak is deterministic but
// rarely hit). Callers that want oldest-first can reverse client-side.
//
// Rejects with:
//   - 401 — handled by authMiddleware upstream; never reaches here.
//   - 404 — pane id doesn't correspond to a live pane.
//   - 500 — tmpdir read failed for a reason other than "dir doesn't
//     exist yet" (which collapses to a 200 with an empty list).
//
// Success: 200 with PaneUploadsListResponse{Uploads: []}. The empty
// case (no uploads yet, or per-pane tmpdir never created) is a 200 with
// `{"uploads": []}`, not a 404 — callers can treat it uniformly.
func (s *Server) handleListPaneUploads(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}

	dir := paneUploadDir(pane.ID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Pane has never received a successful upload. Not an error —
			// just an empty list.
			writeJSON(w, proto.PaneUploadsListResponse{Uploads: []proto.PaneUpload{}})
			return
		}
		slog.Warn("uploads_list_failed", "pane", pane.ID, "stage", "readdir", "err", err.Error())
		nethttp.Error(w, "readdir: "+err.Error(), nethttp.StatusInternalServerError)
		return
	}

	out := make([]proto.PaneUpload, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, statErr := e.Info()
		if statErr != nil {
			// File vanished between ReadDir and Info — skip silently.
			// Entries raced out from under a concurrent cleanup aren't
			// interesting enough to log at warn level.
			continue
		}
		out = append(out, proto.PaneUpload{
			Path:      filepath.Join(dir, e.Name()),
			SizeBytes: info.Size(),
			ModTime:   info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	// Newest first. Ties on ModTime (possible on filesystems with ≥1s
	// mtime resolution if two uploads land in the same second) fall
	// back to filename — our generated names start with unix-ns, so
	// that's still a deterministic newest-first ordering.
	sort.Slice(out, func(i, j int) bool {
		if out[i].ModTime != out[j].ModTime {
			return out[i].ModTime > out[j].ModTime
		}
		return out[i].Path > out[j].Path
	})

	writeJSON(w, proto.PaneUploadsListResponse{Uploads: out})
}

// normalizeContentType strips parameters (charset=, boundary=) and
// lowercases a MIME type. Browsers sometimes append `; charset=utf-8`
// to an image MIME on a paste blob, and DetectContentType can tag
// `; charset=utf-8` onto text/plain; both cases must collapse to the
// bare media type before allowlist lookup.
func normalizeContentType(raw string) string {
	ct := strings.TrimSpace(raw)
	if idx := strings.Index(ct, ";"); idx >= 0 {
		ct = strings.TrimSpace(ct[:idx])
	}
	return strings.ToLower(ct)
}

// SweepStalePaneUploadDirs removes any `reck-pane-*` directories in
// $TMPDIR that don't match a currently-live pane id. Intended to be
// called once at daemon startup so a previous crash/kill doesn't leak
// image tmpdirs indefinitely. Failure modes (non-readable tmpdir, stat
// errors on individual entries) are logged and skipped — this is
// best-effort hygiene, not a required-for-correctness step.
//
// `liveIDs` is the set of pane ids the new daemon run has registered at
// startup. For the current codebase that set is always empty (panes are
// only created post-startup via explicit API / auto-spawn), but the
// function takes it as a parameter so a future daemon that restores
// panes from disk at boot can use the same sweeper without changes.
func SweepStalePaneUploadDirs(liveIDs map[string]bool) {
	tmp := os.TempDir()
	entries, err := os.ReadDir(tmp)
	if err != nil {
		slog.Warn("upload sweep: readdir", "err", err, "tmp", tmp)
		return
	}
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, paneUploadDirPrefix) {
			continue
		}
		paneID := strings.TrimPrefix(name, paneUploadDirPrefix)
		if liveIDs[paneID] {
			continue
		}
		path := filepath.Join(tmp, name)
		if err := os.RemoveAll(path); err != nil {
			slog.Warn("upload sweep: remove", "err", err, "dir", path)
			continue
		}
		removed++
	}
	if removed > 0 {
		slog.Info("upload sweep", "removed", removed)
	}
}
