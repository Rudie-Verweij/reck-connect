package http

// GET /projects/{id}/sessions/{session_id}/transcript?offset=<bytes>
//
// Serves a Claude Code session's JSONL transcript so the satellite can
// render the full chat (exact scrollbar + whole-conversation search) in
// its transcript view. Claude Code appends the transcript live at
//
//	<claudeProjectsDir>/<EncodeCwd(cwd)>/<session-uuid>.jsonl
//
// so the satellite tails it by polling with the last returned offset:
// each response carries the next offset in X-Reck-Transcript-Offset and
// sets X-Reck-Transcript-More when a chunk was capped. The body is raw
// JSONL bytes from the requested offset — parsing happens client-side.

import (
	"io"
	nethttp "net/http"
	"os"
	"regexp"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
)

const (
	// TranscriptOffsetHeader carries the byte offset a tailing client
	// should request next (== file size when the response drained it).
	TranscriptOffsetHeader = "X-Reck-Transcript-Offset"
	// TranscriptMoreHeader is set to "1" when bytes remain past this
	// chunk, so a catch-up client keeps fetching without a poll delay.
	TranscriptMoreHeader = "X-Reck-Transcript-More"
	// transcriptMaxChunk caps a single response body so a multi-MB
	// catch-up is paged instead of buffered wholesale. Kept at 1 MiB:
	// large enough to be few round-trips, small enough that each fetch
	// finishes well within the client's timeout over a station/Tailscale
	// link and the satellite renders in smaller, smoother batches.
	transcriptMaxChunk = 1 << 20
)

// sessionIDRe matches an RFC 4122 UUID — the only shape Claude Code
// accepts for --session-id. Validated BEFORE any filesystem access
// because the session id becomes a path component.
var sessionIDRe = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (s *Server) handleTranscript(w nethttp.ResponseWriter, r *nethttp.Request) {
	id := chi.URLParam(r, "id")
	if s.rejectSupervisorOutOfScope(w, r, id) {
		return
	}
	sessionID := chi.URLParam(r, "session_id")
	if !sessionIDRe.MatchString(sessionID) {
		nethttp.Error(w, "session id must be a UUID", nethttp.StatusBadRequest)
		return
	}
	offset := int64(0)
	if raw := r.URL.Query().Get("offset"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			nethttp.Error(w, "offset must be a non-negative integer", nethttp.StatusBadRequest)
			return
		}
		offset = n
	}
	detail, ok := s.Manager.ProjectDetail(id)
	if !ok {
		nethttp.Error(w, "project not found", nethttp.StatusNotFound)
		return
	}
	claudeDir, err := sessions.DefaultClaudeProjectsDir()
	if err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusInternalServerError)
		return
	}
	// Locate by session id, not just the canonical path: worktree/subdir
	// sessions live under a different EncodeCwd() dir than the project cwd.
	path, found := sessions.FindTranscript(claudeDir, detail.Cwd, sessionID)
	if !found {
		nethttp.Error(w, "transcript not found", nethttp.StatusNotFound)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		// Raced away between the stat and the open (TTL'd by Claude Code),
		// or a genuine server problem.
		if os.IsNotExist(err) {
			nethttp.Error(w, "transcript not found", nethttp.StatusNotFound)
			return
		}
		nethttp.Error(w, err.Error(), nethttp.StatusInternalServerError)
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusInternalServerError)
		return
	}
	size := st.Size()
	// A poller whose offset ran past the file (shouldn't happen for an
	// append-only transcript, but be safe) resyncs to the real size
	// instead of getting stuck re-requesting a hole.
	start := min(offset, size)
	chunk := min(size-start, int64(transcriptMaxChunk))

	w.Header().Set("Content-Type", "application/x-ndjson")
	// The satellite renderer reads these from a cross-origin fetch();
	// non-safelisted response headers are invisible unless exposed.
	w.Header().Set("Access-Control-Expose-Headers",
		TranscriptOffsetHeader+", "+TranscriptMoreHeader)
	w.Header().Set(TranscriptOffsetHeader, strconv.FormatInt(start+chunk, 10))
	if start+chunk < size {
		w.Header().Set(TranscriptMoreHeader, "1")
	}
	if chunk == 0 {
		return
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		nethttp.Error(w, err.Error(), nethttp.StatusInternalServerError)
		return
	}
	// Headers are already written on first byte; a mid-copy error can
	// only truncate the body, which the client detects because the
	// received length won't reach the promised offset.
	_, _ = io.Copy(w, io.LimitReader(f, chunk))
}
