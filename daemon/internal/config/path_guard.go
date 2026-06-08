package config

import (
	"path/filepath"
	"strings"
)

// IsUnderManagedRoot returns true iff `p` canonically resolves to a path
// strictly under `root` (not `root` itself, not outside it, no symlink
// escape). Use this before any destructive filesystem operation that
// should only touch daemon-created project directories.
func IsUnderManagedRoot(p, root string) bool {
	pr, err := filepath.EvalSymlinks(p)
	if err != nil {
		return false
	}
	rr, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	pa, err := filepath.Abs(pr)
	if err != nil {
		return false
	}
	ra, err := filepath.Abs(rr)
	if err != nil {
		return false
	}
	if pa == ra {
		return false
	}
	rel, err := filepath.Rel(ra, pa)
	if err != nil {
		return false
	}
	if rel == "." || strings.HasPrefix(rel, "..") {
		return false
	}
	return true
}
