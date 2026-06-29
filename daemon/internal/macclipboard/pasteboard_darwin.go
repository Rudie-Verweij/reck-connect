//go:build darwin

package macclipboard

/*
#cgo LDFLAGS: -framework AppKit -framework Foundation
#include <stddef.h>
#include <stdlib.h>
extern int reck_set_pasteboard(const void *bytes, size_t n, const char *uti);
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// mimeToUTI mirrors the per-MIME UTI mapping the deleted
// reck-clipboard sidecar used. NSPasteboard accepts a UTI string
// for setData:forType:; the wrong UTI produces a successful write
// that Claude Code can't decode (no chip).
//
// Values come from Apple's UTI registry + the `webp` / `gif` UTI
// strings used by the OEM Photos / Preview apps in macOS 14. They
// are stable between macOS versions in practice.
var mimeToUTI = map[string]string{
	"image/png":  "public.png",
	"image/jpeg": "public.jpeg",
	"image/gif":  "com.compuserve.gif",
	"image/webp": "org.webmproject.webp",
}

// Available reports whether WriteImage can succeed on this host.
// On darwin the AppKit pasteboard is always accessible from the
// daemon's Aqua user session — no probe needed.
func Available() bool { return true }

// WriteImage places `body` on the general pasteboard under the UTI
// that corresponds to `mime`. Returns:
//
//   - error for empty body or unsupported MIME
//   - error if AppKit's setData:forType: returns NO
//   - nil on success
//
// Concurrent callers are serialized inside the cgo layer (NSLock),
// so the daemon does not need its own mutex around the call.
//
// The body slice is COPIED into AppKit-managed memory before the
// cgo call returns. It is safe for the caller to free / GC the
// slice immediately after WriteImage returns.
func WriteImage(mime string, body []byte) error {
	if len(body) == 0 {
		return fmt.Errorf("macclipboard: empty payload (mime=%q)", mime)
	}
	uti, ok := mimeToUTI[mime]
	if !ok {
		return fmt.Errorf("macclipboard: unsupported MIME %q", mime)
	}
	cuti := C.CString(uti)
	defer C.free(unsafe.Pointer(cuti))
	rc := C.reck_set_pasteboard(unsafe.Pointer(&body[0]), C.size_t(len(body)), cuti)
	if rc != 0 {
		return fmt.Errorf("macclipboard: NSPasteboard rejected %s payload (uti=%s, %d bytes)", mime, uti, len(body))
	}
	return nil
}
