package macclipboard

import (
	"errors"
	"strings"
	"testing"
)

// Test the input-validation surface of WriteImage. Real NSPasteboard
// round-trip lives in N-tests — Go testing inside `go test ./...` runs
// without an Aqua session under most CI configs, so unit-testing the
// AppKit call path would be flaky.
//
// On non-darwin builds these cases all return ErrUnsupported (the
// platform stub short-circuits before the validation runs). The
// asserts use errors.Is + substring checks so the same test compiles
// + passes under both build tags.

func TestWriteImage_emptyPayload(t *testing.T) {
	err := WriteImage("image/png", nil)
	if err == nil {
		t.Fatal("expected error for nil payload, got nil")
	}
}

func TestWriteImage_unsupportedMIME(t *testing.T) {
	err := WriteImage("application/x-quake-pak", []byte{0x00})
	if err == nil {
		t.Fatal("expected error for unsupported mime, got nil")
	}
	if errors.Is(err, ErrUnsupported) {
		// non-darwin build — the platform stub short-circuits before
		// any MIME validation. Accept that without further checks.
		return
	}
	if !strings.Contains(err.Error(), "unsupported") && !strings.Contains(err.Error(), "MIME") {
		t.Fatalf("error %q does not mention MIME / unsupported", err.Error())
	}
}

func TestSupportedMIMEs_matchesDarwinUTIMap(t *testing.T) {
	// Sanity: the public allowlist must not advertise a MIME the
	// darwin build can't handle. If a MIME is added to SupportedMIMEs
	// without a UTI mapping, callers will pass it in and WriteImage
	// will fail at runtime — catch that at test time instead.
	// Use a single-byte payload so the MIME validation runs before
	// any empty-body short-circuit. The actual NSPasteboard write
	// likely fails (1 byte isn't a valid image), but the error
	// message will say so — what we're checking is that the MIME
	// itself isn't rejected as unmapped.
	for _, m := range SupportedMIMEs {
		err := WriteImage(m, []byte{0x00})
		if errors.Is(err, ErrUnsupported) {
			continue // non-darwin stub
		}
		if err != nil && strings.Contains(err.Error(), "unsupported MIME") {
			t.Errorf("MIME %q is in SupportedMIMEs but WriteImage rejected it as unsupported MIME", m)
		}
	}
}
