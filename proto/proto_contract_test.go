package proto

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// TestProject_AvailableFieldOnGoStruct — phase 7 of the hybrid mode plan
// adds Project.Available. Pin the Go struct shape so a refactor that
// drops or renames the field can't slip through unnoticed; the wire
// contract with the TS satellite (and proto.md) is hand-maintained, so
// this is the closest we get to compile-time enforcement.
func TestProject_AvailableFieldOnGoStruct(t *testing.T) {
	rt := reflect.TypeOf(Project{})
	f, ok := rt.FieldByName("Available")
	if !ok {
		t.Fatal("Project.Available field missing on Go struct")
	}
	if f.Type.Kind() != reflect.Bool {
		t.Fatalf("Project.Available kind = %s, want bool", f.Type.Kind())
	}
	if got := f.Tag.Get("json"); got != "available" {
		t.Fatalf("Project.Available json tag = %q, want %q (no omitempty — every phase-7+ daemon emits the field as a real boolean)", got, "available")
	}
}

// TestProject_AvailableSerialisedAsAvailable — golden-on-the-wire: the
// Go encoder must produce `"available": true|false` on the JSON. Pins
// both the key spelling and the always-emitted invariant in one shot.
func TestProject_AvailableSerialisedAsAvailable(t *testing.T) {
	cases := []struct {
		name      string
		available bool
	}{
		{"available_true", true},
		{"available_false", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := Project{ID: "x", Name: "X", Cwd: "/", Stoplight: StoplightGray, Available: tc.available}
			raw, err := json.Marshal(p)
			if err != nil {
				t.Fatal(err)
			}
			s := string(raw)
			needle := `"available":true`
			if !tc.available {
				needle = `"available":false`
			}
			if !strings.Contains(s, needle) {
				t.Fatalf("encoded JSON %s missing %s", s, needle)
			}
		})
	}
}

// TestProtoTSDeclares_available — paranoia check that proto.ts and
// proto.md were updated alongside the Go side. Since the two files are
// hand-maintained per proto.md's manual-sync convention, a literal
// string search for `available` in both is the cheapest way to catch
// "I edited the Go side but forgot the TS / docs" mistakes.
//
// Read proto.ts / proto.md off disk relative to this test file's
// location so the check works whether `go test` runs from the package
// dir or the workspace root.
func TestProtoTSDeclares_available(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed; cannot locate proto package directory")
	}
	dir := filepath.Dir(thisFile)
	for _, file := range []string{"proto.ts", "proto.md"} {
		path := filepath.Join(dir, file)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(raw), "available") {
			t.Fatalf("%s does not mention 'available' — did you forget to sync the Project field across proto.ts / proto.md?", file)
		}
	}
}

// TestProject_PaneIDsFieldOnGoStruct — an earlier release adds Project.PaneIDs
// so the renderer can reorder rail dots by layout position. Same shape
// pin as Available: drop or rename and this test fails.
func TestProject_PaneIDsFieldOnGoStruct(t *testing.T) {
	rt := reflect.TypeOf(Project{})
	f, ok := rt.FieldByName("PaneIDs")
	if !ok {
		t.Fatal("Project.PaneIDs field missing on Go struct")
	}
	if f.Type.Kind() != reflect.Slice || f.Type.Elem().Kind() != reflect.String {
		t.Fatalf("Project.PaneIDs kind = %s (elem %s), want []string", f.Type.Kind(), f.Type.Elem().Kind())
	}
	if got := f.Tag.Get("json"); got != "pane_ids" {
		t.Fatalf("Project.PaneIDs json tag = %q, want %q (no omitempty — match the PaneStoplights `[]`-on-empty convention so TS clients can rely on the field being present once the daemon is post-rollout)", got, "pane_ids")
	}
}

// TestProject_PaneIDsAlwaysEmittedAsArray — golden-on-the-wire: even
// for a zero-pane project the encoded JSON contains `"pane_ids":[]`,
// not `null` and not the field omitted. The renderer treats `undefined`
// as "Older daemon, no reorder info"; emitting `null` would tip into
// that branch and silently lose the reorder behaviour for healthy
// projects with no panes yet.
func TestProject_PaneIDsAlwaysEmittedAsArray(t *testing.T) {
	p := Project{ID: "x", Name: "X", Cwd: "/", Stoplight: StoplightGray, PaneIDs: []string{}}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	if !strings.Contains(s, `"pane_ids":[]`) {
		t.Fatalf("encoded JSON %s missing `\"pane_ids\":[]`", s)
	}
}

// TestProtoTSDeclares_pane_ids — sibling of TestProtoTSDeclares_available.
// Cheap literal-match guard against editing the Go struct without syncing
// proto.ts / proto.md.
func TestProtoTSDeclares_pane_ids(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed; cannot locate proto package directory")
	}
	dir := filepath.Dir(thisFile)
	for _, file := range []string{"proto.ts", "proto.md"} {
		path := filepath.Join(dir, file)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(raw), "pane_ids") {
			t.Fatalf("%s does not mention 'pane_ids' — did you forget to sync the Project field across proto.ts / proto.md?", file)
		}
	}
}

// TestPane_CapabilitiesFieldOnGoStruct pins the Pane.Capabilities
// shape introduced for phase 2. JSON tag has no omitempty so
// every phase-2+ daemon emits the object; TS callers can rely on
// `pane.capabilities?.clipboard_image` instead of running through a
// nullable.
func TestPane_CapabilitiesFieldOnGoStruct(t *testing.T) {
	rt := reflect.TypeOf(Pane{})
	f, ok := rt.FieldByName("Capabilities")
	if !ok {
		t.Fatal("Pane.Capabilities field missing on Go struct")
	}
	if f.Type.Name() != "PaneCapabilities" {
		t.Fatalf("Pane.Capabilities type = %s, want PaneCapabilities", f.Type.Name())
	}
	if got := f.Tag.Get("json"); got != "capabilities" {
		t.Fatalf("Pane.Capabilities json tag = %q, want %q (no omitempty)", got, "capabilities")
	}
	caps := reflect.TypeOf(PaneCapabilities{})
	cf, ok := caps.FieldByName("ClipboardImage")
	if !ok {
		t.Fatal("PaneCapabilities.ClipboardImage missing")
	}
	if cf.Type.Kind() != reflect.Bool {
		t.Fatalf("ClipboardImage kind = %s, want bool", cf.Type.Kind())
	}
	if got := cf.Tag.Get("json"); got != "clipboard_image" {
		t.Fatalf("ClipboardImage json tag = %q, want %q", got, "clipboard_image")
	}
}

// TestProtoTSDeclares_clipboard_image keeps proto.ts / proto.md in
// sync with the Go side for Phase 2. Same paranoia check
// shape as TestProtoTSDeclares_available.
func TestProtoTSDeclares_clipboard_image(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed; cannot locate proto package directory")
	}
	dir := filepath.Dir(thisFile)
	for _, file := range []string{"proto.ts", "proto.md"} {
		path := filepath.Join(dir, file)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(raw), "clipboard_image") {
			t.Fatalf("%s does not mention 'clipboard_image' — did you forget to sync the PaneCapabilities field across proto.ts / proto.md?", file)
		}
	}
}
