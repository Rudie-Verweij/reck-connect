package config

import (
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// Slugify converts a human project name into a filesystem-safe id.
// Fold accents (Möbius → mobius), lowercase, replace runs of non-alphanumeric
// characters with a single hyphen, and strip leading/trailing hyphens.
// Returns the empty string only when the input reduces to nothing.
func Slugify(name string) string {
	t := transform.Chain(
		norm.NFD,
		runes.Remove(runes.In(unicode.Mn)),
		norm.NFC,
	)
	folded, _, _ := transform.String(t, name)

	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(folded) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash {
			b.WriteRune('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// SlugifyUnique returns Slugify(name), appending "-2", "-3", …, as needed
// until the slug is not in `existing`. Caller owns the existing-set.
// Panics (as an internal invariant) if the base slug is empty — callers
// must guard against that path (empty Name is rejected at the HTTP layer).
//
// The returned slug always fits within MaxProjectIDLen so it round-trips
// cleanly through ValidateProjectID and survives a daemon restart. Long
// Slugify output is truncated (trailing hyphens stripped) before the
// collision-counter suffix is appended.
func SlugifyUnique(name string, existing map[string]bool) string {
	base := Slugify(name)
	if base == "" {
		panic("SlugifyUnique called with empty slug; caller must reject empty names")
	}
	// Reserve 8 bytes for a collision suffix so "base-999" is still
	// within the MaxProjectIDLen cap enforced by Load().
	const suffixRoom = 8
	if cap := MaxProjectIDLen - suffixRoom; len(base) > cap {
		base = strings.TrimRight(base[:cap], "-")
		if base == "" {
			// Edge case: the cap fell inside a hyphen run or the
			// input was entirely one run of non-alphanumerics.
			// Fall through to a deterministic default.
			base = "project"
		}
	}
	if !existing[base] {
		return base
	}
	for i := 2; i < 1000; i++ {
		cand := fmt.Sprintf("%s-%d", base, i)
		if !existing[cand] {
			return cand
		}
	}
	// Exhausted — extraordinarily unlikely. Fall through with a random suffix.
	return fmt.Sprintf("%s-%d", base, 1000)
}
