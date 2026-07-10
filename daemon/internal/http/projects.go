package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	nethttp "net/http"

	"github.com/rudie-verweij/reck-connect/daemon/internal/agent"
	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

// handlePutProjects accepts a wholesale-replace push of the local-mode
// daemon's project map from the Satellite. Hybrid mode rev 3.1, phase 8.
//
// Trust boundary: this RPC is the new local-daemon perimeter. The cwd in
// each entry becomes exec.Command.Dir for any local Claude pane the
// Satellite later spawns under the corresponding project ID. A
// compromised renderer can send anything over the loopback socket — the
// only thing standing between that and a `claude` process running with
// any cwd of the attacker's choosing is the validation in
// Manager.ReplaceProjects (absolute + permitted-prefix + no-traversal +
// no-escaping-symlink). Don't loosen those rules without a security
// review.
//
// Mode gate: this handler returns 409 Conflict in station mode; the
// station's projects.toml is authoritative there and the renderer must
// not try to push the local-mode list into it. Station-mode rejection
// is at the HTTP boundary (here) rather than inside ReplaceProjects so
// the manager stays mode-agnostic — local-call paths (config.Load,
// AddProject) keep working the same way regardless of mode.
//
// Auth: the standard authMiddleware applies. When DAEMON_TOKEN is set
// (production local-mode daemons spawned by the Satellite via Phase 5's
// per-spawn random-token mechanism), missing/wrong bearer → 401.
//
// Wire shapes accepted (both decode to the same in-memory list):
//
//   - {"projects": [{"id": "...", "cwd": "..."}, ...]}
//   - [{"id": "...", "cwd": "..."}, ...]
//
// The bare-array form is documented in the plan ("Payload: [{id, cwd}]")
// and is what the renderer sends; the wrapped form is accepted for
// future-proofing if we ever need to add per-push metadata (e.g. a
// "generation" counter).
func (s *Server) handlePutProjects(w nethttp.ResponseWriter, r *nethttp.Request) {
	// Mode gate at the HTTP boundary. The manager stays mode-agnostic so
	// the config.Load / AddProject paths keep working in both modes;
	// only the new RPC surface is mode-restricted.
	if s.Manager.Mode() != agent.ModeLocal {
		nethttp.Error(w, "PUT /projects not allowed in station mode (projects.toml is authoritative)", nethttp.StatusConflict)
		return
	}

	inputs, err := decodePutProjectsBody(w, r)
	if err != nil {
		// decodePutProjectsBody has already written the response.
		return
	}

	if err := s.Manager.ReplaceProjects(inputs); err != nil {
		// All validation failures wrap pty.ErrPutProjectsRejected so
		// the HTTP layer can render a single 400 without sniffing the
		// detail string. The detail still goes to the audit log so an
		// operator can debug bad payloads, but the wire response is
		// kept generic enough not to leak filesystem paths the caller
		// didn't already send (the caller sent the cwd, so echoing the
		// id back is fine).
		if errors.Is(err, pty.ErrPutProjectsRejected) {
			slog.Info("put projects rejected", "err", err.Error())
			nethttp.Error(w, err.Error(), nethttp.StatusBadRequest)
			return
		}
		slog.Warn("put projects internal error", "err", err)
		nethttp.Error(w, "internal error", nethttp.StatusInternalServerError)
		return
	}

	writeJSON(w, proto.PutProjectsResponse{Ok: true, Count: len(inputs)})
}

// decodePutProjectsBody reads the request body and accepts either the
// {"projects": [...]} wrapper or a bare array. Returns the
// pty.ReplaceProjectsInput slice ready for ReplaceProjects.
//
// Body-size cap: maxJSONBody (64 KiB) is plenty — even a thousand
// projects at ~80 bytes each fits comfortably.
//
// Decode strictness: DisallowUnknownFields is intentionally NOT used —
// future Satellite versions may add per-entry metadata (e.g. a hint
// about whether the cwd was reachable when the renderer last polled),
// and rejecting those would force a coordinated bump of every old
// daemon in the field. The trust boundary is the cwd validation, not
// the decode-strict mode.
//
// Error-response policy: any decode failure writes a 400 with a generic
// "invalid request body" line. We deliberately don't surface the
// underlying json.SyntaxError detail (it can leak offset numbers from
// pathological payloads) — the structured log line carries the detail
// for operator debugging.
func decodePutProjectsBody(w nethttp.ResponseWriter, r *nethttp.Request) ([]pty.ReplaceProjectsInput, error) {
	r.Body = nethttp.MaxBytesReader(w, r.Body, maxJSONBody+1)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *nethttp.MaxBytesError
		if errors.As(err, &maxErr) {
			nethttp.Error(w, "request body too large", nethttp.StatusRequestEntityTooLarge)
			return nil, err
		}
		nethttp.Error(w, "read body: "+err.Error(), nethttp.StatusBadRequest)
		return nil, err
	}
	if len(raw) == 0 {
		// Empty body is ambiguous: explicit "no projects" should be
		// `[]` or `{"projects": []}`. Reject empty so a renderer bug
		// where it forgot to attach the body doesn't accidentally
		// drop every project.
		nethttp.Error(w, "request body is empty; send `[]` to drop all projects", nethttp.StatusBadRequest)
		return nil, errors.New("empty body")
	}

	// Sniff the first non-whitespace byte to choose between the
	// wrapped and bare-array forms. Both are first-class.
	first := firstNonWhitespace(raw)
	var entries []proto.PutProjectsEntry
	switch first {
	case '[':
		if err := json.Unmarshal(raw, &entries); err != nil {
			slog.Info("put projects decode failed (bare array form)", "err", err)
			nethttp.Error(w, "invalid request body: expected [{\"id\":\"...\",\"cwd\":\"...\"}, ...]", nethttp.StatusBadRequest)
			return nil, err
		}
	case '{':
		var req proto.PutProjectsRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			slog.Info("put projects decode failed (object form)", "err", err)
			nethttp.Error(w, "invalid request body: expected {\"projects\": [{\"id\":\"...\",\"cwd\":\"...\"}, ...]}", nethttp.StatusBadRequest)
			return nil, err
		}
		entries = req.Projects
	default:
		nethttp.Error(w, "invalid request body: expected JSON array or object", nethttp.StatusBadRequest)
		return nil, errors.New("unrecognised body shape")
	}

	out := make([]pty.ReplaceProjectsInput, 0, len(entries))
	for _, e := range entries {
		out = append(out, pty.ReplaceProjectsInput{ID: e.ID, Cwd: e.Cwd})
	}
	return out, nil
}

// firstNonWhitespace returns the first byte of `raw` that isn't ASCII
// whitespace, or 0 if the slice contains only whitespace. Used to sniff
// the JSON top-level shape (array vs. object) without a full decode.
func firstNonWhitespace(raw []byte) byte {
	for _, b := range bytes.TrimLeft(raw, " \t\r\n") {
		return b
	}
	return 0
}
