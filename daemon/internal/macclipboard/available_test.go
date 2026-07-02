package macclipboard

import "testing"

// TestAvailable_isIdempotent verifies Available() is safe to call repeatedly.
// The linux backend caches a one-time xclip/$DISPLAY probe; darwin and the
// no-backend stub are constant. The concrete value is environment-bound
// (darwin: always true; linux: xclip+$DISPLAY present; other: always false),
// so the invariant under test is stability across calls, not a fixed result.
func TestAvailable_isIdempotent(t *testing.T) {
	first := Available()
	for i := 1; i <= 3; i++ {
		if got := Available(); got != first {
			t.Fatalf("Available() not idempotent: call 0 = %v, call %d = %v", first, i, got)
		}
	}
}
