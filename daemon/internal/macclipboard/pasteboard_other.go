//go:build !darwin && !linux

package macclipboard

// Stub for build targets without a clipboard backend (Windows, BSDs,
// CI sandboxes). darwin uses cgo + AppKit, linux shells out to xclip;
// anything else is unsupported and the HTTP layer falls back to the
// /uploads path-typing route via a 500 from /clipboard-image.

// Available reports whether WriteImage can succeed. Always false on
// platforms with no backend — keeps the per-pane capability flag
// honest so the renderer doesn't keep retrying a doomed code path.
func Available() bool { return false }

func WriteImage(mime string, body []byte) error {
	_ = mime
	_ = body
	return ErrUnsupported
}
