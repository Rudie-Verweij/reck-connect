// Package httpx holds framework-agnostic HTTP helpers the daemon's
// handler packages share. Keeping this layer separate from
// internal/http lets any handler package import the decode helper
// without risking a dependency cycle.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// DecodeJSONBody wraps r.Body in http.MaxBytesReader, decodes exactly
// one JSON value into v, and drains the remainder to enforce the cap
// and reject trailing data. Responses on failure:
//
//   - 413 Request Entity Too Large when the body (decoded value +
//     trailing drain) exceeds max. This is the actually-enforced
//     per-handler cap.
//   - 400 Bad Request when the first JSON value fails to decode, or
//     when anything other than JSON whitespace follows the value.
//
// The ordering matters: MaxBytesReader overflow takes precedence over
// the trailing-data check, so a small valid value followed by
// megabytes of junk is rejected as 413 even though there was also
// trailing non-whitespace. That matches the stated policy ("the
// per-handler cap is actually enforced") and closes the hole where a
// single json.Decoder.Decode stopped mid-stream and let the tail slip
// under the cap.
//
// Returns a non-nil error in every failure case so callers can
// short-circuit with a simple `if err := DecodeJSONBody(...); err !=
// nil { return }`.
func DecodeJSONBody(w http.ResponseWriter, r *http.Request, max int64, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return writeDecodeError(w, err)
	}
	return rejectTrailing(w, dec.Buffered(), r.Body)
}

// rejectTrailing walks the unread tail of a decoded request body and
// returns nil only if nothing but whitespace (tabs/spaces/CR/LF) is
// present. On any non-whitespace bytes it writes 400; on a
// MaxBytesReader overflow it writes 413.
//
// MaxBytesReader takes precedence over the trailing-data check: we
// drain the whole tail first and record whether any non-whitespace
// was seen, then decide. If the drain trips MaxBytesReader, 413 wins
// even if there was also trailing junk.
func rejectTrailing(w http.ResponseWriter, buffered io.Reader, body io.Reader) error {
	tail := io.MultiReader(buffered, body)
	buf := make([]byte, 1024)
	sawTrailing := false
	for {
		n, err := tail.Read(buf)
		for i := 0; i < n; i++ {
			if !isJSONWhitespace(buf[i]) {
				sawTrailing = true
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return writeDecodeError(w, err)
		}
	}
	if sawTrailing {
		http.Error(w, "trailing data after JSON body", http.StatusBadRequest)
		return errors.New("trailing data after JSON body")
	}
	return nil
}

// isJSONWhitespace reports whether b is one of the four ASCII bytes
// RFC 8259 §2 permits as insignificant whitespace between JSON tokens.
// Anything else after the first complete value is trailing data.
func isJSONWhitespace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// writeDecodeError maps a json/MaxBytesReader error to an HTTP status +
// body and returns the original error so the caller can propagate it.
// Centralised so the first-value and trailing-data paths stay in sync.
func writeDecodeError(w http.ResponseWriter, err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return err
	}
	http.Error(w, "bad body", http.StatusBadRequest)
	return err
}
