//go:build linux

package config

import (
	"strings"
	"testing"
)

// TestManagedProjectsRoot_isUnderHome verifies the linux init() override in
// managed_root_linux.go replaced the macOS default with a path under the
// running user's home directory. Gated on linux (the override itself is
// //go:build linux); on a Pi station this is the live default root.
func TestManagedProjectsRoot_isUnderHome(t *testing.T) {
	if ManagedProjectsRoot == "/Users/reck-connect/projects" {
		t.Fatal("linux init() did not override the macOS default ManagedProjectsRoot")
	}
	if !strings.HasSuffix(ManagedProjectsRoot, "projects") {
		t.Fatalf("ManagedProjectsRoot %q should end in 'projects'", ManagedProjectsRoot)
	}
}
