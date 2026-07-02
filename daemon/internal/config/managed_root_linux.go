//go:build linux

package config

import (
	"os"
	"path/filepath"
)

// On Linux the macOS-style /Users/reck-connect/projects path is wrong.
// Place the managed projects root under the running user's home dir
// instead: ~/projects. Mac binaries are unaffected — this file
// is gated on linux.
func init() {
	if home, err := os.UserHomeDir(); err == nil {
		ManagedProjectsRoot = filepath.Join(home, "projects")
	}
}
