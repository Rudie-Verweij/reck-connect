// Package macclipboard writes image bytes to the user's general
// NSPasteboard via cgo + AppKit. Replaces the an earlier release
// reck-clipboard sidecar after the daemon moved into the Aqua user
// session itself (phase 1) — once the daemon owns an
// Aqua audit session, it can drive NSPasteboard directly without a
// per-user agent acting as proxy.
//
// Not intended for non-image clipboard interaction. Read paths are
// not provided (the daemon never reads the user's pasteboard, only
// writes into it on /clipboard-image POSTs).

package macclipboard

import "errors"

// ErrUnsupported is returned by WriteImage on platforms without the
// darwin cgo backend (kept for callers that want to distinguish
// "no NSPasteboard available here" from "NSPasteboard refused this
// payload"). Production builds are darwin-only; the stub exists so
// `go vet ./...` on a Linux dev box doesn't fail to compile.
var ErrUnsupported = errors.New("macclipboard: not supported on this platform")

// MIMEs accepted by WriteImage. Mirrors the daemon's HTTP-side
// allowlist so callers don't need to keep a parallel list in sync —
// just pass the validated MIME string straight through.
//
// Pasteboard UTI mapping is implementation-dependent (see
// pasteboard_darwin.go). On non-darwin builds the function returns
// ErrUnsupported regardless of MIME.
var SupportedMIMEs = []string{
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
}
