//go:build !darwin

package macclipboard

// Stub for non-darwin builds (CI / dev boxes). Production is
// darwin-only; the daemon binary that ships to the station is
// always macOS. This stub keeps `go build ./...` clean on Linux
// without pulling cgo / AppKit linkage into the build graph.

func WriteImage(mime string, body []byte) error {
	_ = mime
	_ = body
	return ErrUnsupported
}
