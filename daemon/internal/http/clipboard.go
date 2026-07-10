package http

import (
	"errors"
	"io"
	"log/slog"
	nethttp "net/http"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/rudie-verweij/reck-connect/daemon/internal/macclipboard"
)

// pasteSerializer guarantees that each clipboard-image request's
// pasteboard-write + Ctrl+V trigger pair is atomic with respect to
// other clipboard-image requests in this process. Codex 2026-04-28
// pre-commit review caught the race: NSPasteboard.general is
// process/user-global; if request A writes image A, request B
// writes image B before A reaches `pane.Write(ctrlVByte)`, then
// pane A's Claude reads image B from the pasteboard. The cgo
// layer's NSLock only serialises clearContents+setData; the chip
// trigger lives outside that critical section, so we need a
// daemon-side mutex covering both.
//
// Process-global is the right scope because the pasteboard itself
// is process-global. Per-pane locking wouldn't help — a paste on
// pane A while pane B's paste is mid-flight would still race.
//
// Holding cost is bounded by the cgo NSPasteboard write (~ms) plus
// a single PTY byte write (~µs). Concurrent paste storms degrade to
// serial throughput, which matches user expectations (the user can
// only see one chip at a time anyway).
var pasteSerializer sync.Mutex

// Image-paste support — POST /panes/:pane_id/clipboard-image. Content-Type
// names the MIME of the raw body. Handler:
//   1. validates the pane is live (404 otherwise),
//   2. caps the body at maxClipboardImageBytes (413 over),
//   3. writes the bytes to NSPasteboard.general directly via cgo
//      (internal/macclipboard) — phase 2 replaced the per-user
//      reck-clipboard sidecar UDS forward,
//   4. writes a single 0x16 (Ctrl+V) into the pane PTY AFTER the
//      pasteboard write completes (otherwise Claude reads stale
//      clipboard contents),
//   5. returns {"ok": true}.
//
// 20 MiB cap matches /uploads.
const maxClipboardImageBytes = 20 * 1024 * 1024

// allowedClipboardMIMEs mirrors macclipboard.SupportedMIMEs. Kept as a
// map so the lookup is O(1); a small unit test pins the two lists
// in sync.
var allowedClipboardMIMEs = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif":  true,
}

// ctrlVByte is the SYN byte (0x16) that Claude Code's terminal mode
// reads as Ctrl+V — the trigger that makes it pull the freshly-set
// pasteboard image into a chip attachment. Sent verbatim to the PTY
// master AFTER macclipboard.WriteImage returns so Claude can't read
// stale clipboard contents.
var ctrlVByte = []byte{0x16}

func (s *Server) handleClipboardImage(w nethttp.ResponseWriter, r *nethttp.Request) {
	paneID := chi.URLParam(r, "pane_id")
	pane, ok := s.Manager.PaneByID(paneID)
	if !ok {
		slog.Info("clipboard_image_rejected", "pane", paneID, "reason", "pane_not_found")
		nethttp.Error(w, "pane not found", nethttp.StatusNotFound)
		return
	}

	mime := normalizeContentType(r.Header.Get("Content-Type"))
	if !allowedClipboardMIMEs[mime] {
		slog.Info("clipboard_image_rejected",
			"pane", pane.ID,
			"reason", "unsupported_mime",
			"declared", mime,
		)
		nethttp.Error(w, "unsupported media type", nethttp.StatusUnsupportedMediaType)
		return
	}

	r.Body = nethttp.MaxBytesReader(w, r.Body, maxClipboardImageBytes+1)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *nethttp.MaxBytesError
		if errors.As(err, &maxErr) {
			slog.Info("clipboard_image_rejected",
				"pane", pane.ID, "reason", "size_cap")
			nethttp.Error(w, "image too large", nethttp.StatusRequestEntityTooLarge)
			return
		}
		slog.Info("clipboard_image_rejected", "pane", pane.ID, "reason", "read", "err", err.Error())
		nethttp.Error(w, "read body: "+err.Error(), nethttp.StatusBadRequest)
		return
	}
	if len(body) > maxClipboardImageBytes {
		slog.Info("clipboard_image_rejected", "pane", pane.ID, "reason", "size_cap", "bytes", len(body))
		nethttp.Error(w, "image too large", nethttp.StatusRequestEntityTooLarge)
		return
	}
	if len(body) == 0 {
		slog.Info("clipboard_image_rejected", "pane", pane.ID, "reason", "empty_body")
		nethttp.Error(w, "empty body", nethttp.StatusBadRequest)
		return
	}

	// Pasteboard write + Ctrl+V trigger must be atomic with respect
	// to other clipboard-image requests — see pasteSerializer doc.
	// Pasteboard write goes FIRST so Claude reads the right image
	// when the chip-summoning byte arrives.
	pasteSerializer.Lock()
	if err := s.clipboardWrite(mime, body); err != nil {
		pasteSerializer.Unlock()
		slog.Info("clipboard_image_failed", "pane", pane.ID, "err", err.Error())
		nethttp.Error(w, "clipboard write: "+err.Error(), nethttp.StatusInternalServerError)
		return
	}
	if err := pane.Write(ctrlVByte); err != nil {
		pasteSerializer.Unlock()
		slog.Warn("clipboard_image_failed", "pane", pane.ID, "stage", "ctrl_v_write", "err", err.Error())
		nethttp.Error(w, "pty write: "+err.Error(), nethttp.StatusInternalServerError)
		return
	}
	pasteSerializer.Unlock()

	slog.Info("clipboard_image_ok",
		"pane", pane.ID,
		"project", pane.ProjectID,
		"mime", mime,
		"bytes", len(body),
	)
	writeJSON(w, map[string]any{"ok": true})
}

// clipboardWrite is a level of indirection so tests can stub the
// pasteboard call. Production wires it to macclipboard.WriteImage —
// a cgo + AppKit call that copies the bytes onto NSPasteboard.general.
func (s *Server) clipboardWrite(mime string, body []byte) error {
	if s.ClipboardWriter != nil {
		return s.ClipboardWriter(mime, body)
	}
	return macclipboard.WriteImage(mime, body)
}
