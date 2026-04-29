package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, contents string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "projects*.toml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(contents); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return f.Name()
}

func TestLoad_valid(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "p")
	os.Mkdir(proj, 0o755)
	toml := `
[[project]]
id = "p1"
name = "Project One"
cwd = "` + proj + `"
`
	path := writeTemp(t, toml)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("want 1 project, got %d", len(r.Projects))
	}
	if r.Projects[0].DefaultPane != "claude" {
		t.Fatalf("default_pane default should be 'claude', got %q", r.Projects[0].DefaultPane)
	}
	if len(r.Projects[0].Shell) == 0 {
		t.Fatalf("shell default should populate, got empty")
	}
}

func TestLoad_malformedTOML(t *testing.T) {
	path := writeTemp(t, `[[project]] id = not_quoted`)
	_, _, err := Load(path)
	if err == nil {
		t.Fatal("expected parse error")
	}
}

func TestLoad_duplicateID(t *testing.T) {
	dir := t.TempDir()
	toml := `
[[project]]
id = "x"
name = "X"
cwd = "` + dir + `"
[[project]]
id = "x"
name = "X2"
cwd = "` + dir + `"
`
	path := writeTemp(t, toml)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("want 1 project after dedup, got %d", len(r.Projects))
	}
	if len(warns) != 1 || !strings.Contains(warns[0].Error(), "duplicate") {
		t.Fatalf("want duplicate warning, got %v", warns)
	}
}

// TestLoad_missingCwd — hybrid mode rev 3.1, phase 7: a project entry
// whose cwd doesn't exist must NOT be dropped. It's surfaced with
// Available=false so the rail can render a "stale" indicator instead
// of silently losing the project. The warning is still emitted so
// operators see the problem in daemon logs.
func TestLoad_missingCwd(t *testing.T) {
	toml := `
[[project]]
id = "x"
name = "X"
cwd = "/nonexistent/path/here"
`
	path := writeTemp(t, toml)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("want 1 project (kept with Available=false), got %d", len(r.Projects))
	}
	if r.Projects[0].ID != "x" {
		t.Fatalf("want project id 'x', got %q", r.Projects[0].ID)
	}
	if r.Projects[0].Available {
		t.Fatalf("want Available=false for missing cwd, got true")
	}
	if len(warns) != 1 {
		t.Fatalf("want 1 warning, got %v", warns)
	}
	if !strings.Contains(warns[0].Error(), "marked unavailable") {
		t.Fatalf("warning should mention 'marked unavailable'; got %v", warns[0])
	}
}

// TestLoad_availableTrueForExistingCwd — happy-path complement to
// TestLoad_missingCwd: a project whose cwd exists must come back with
// Available=true. Pins the default so a future change can't regress
// the field to a default-false-on-the-zero-value bug.
func TestLoad_availableTrueForExistingCwd(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "p")
	if err := os.Mkdir(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	toml := `
[[project]]
id = "p1"
name = "P1"
cwd = "` + proj + `"
`
	path := writeTemp(t, toml)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("want 1 project, got %d", len(r.Projects))
	}
	if !r.Projects[0].Available {
		t.Fatalf("want Available=true for existing cwd, got false")
	}
}

func TestLoad_invalidID(t *testing.T) {
	dir := t.TempDir()
	toml := `
[[project]]
id = "bad id with spaces"
name = "X"
cwd = "` + dir + `"
`
	path := writeTemp(t, toml)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 0 {
		t.Fatal("invalid id should be filtered out")
	}
	if len(warns) != 1 {
		t.Fatalf("want 1 warning, got %v", warns)
	}
}

func TestAppendProject(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	os.Mkdir(proj, 0o755)
	path := filepath.Join(dir, "projects.toml")
	os.WriteFile(path, []byte(""), 0o600)

	err := AppendProject(path, Project{
		ID: "foo", Name: "Foo", Cwd: proj, DefaultPane: "claude",
	})
	if err != nil {
		t.Fatal(err)
	}

	r, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 1 || r.Projects[0].ID != "foo" {
		t.Fatalf("want one project 'foo', got %+v", r.Projects)
	}
}

func TestAppendProject_duplicateFails(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	os.Mkdir(proj, 0o755)
	path := filepath.Join(dir, "projects.toml")
	os.WriteFile(path, []byte(""), 0o600)

	p := Project{ID: "foo", Name: "Foo", Cwd: proj, DefaultPane: "claude"}
	if err := AppendProject(path, p); err != nil {
		t.Fatal(err)
	}
	err := AppendProject(path, p)
	if err == nil {
		t.Fatal("expected duplicate to fail")
	}
}

func TestRemoveProject(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	os.Mkdir(proj, 0o755)
	path := filepath.Join(dir, "projects.toml")
	os.WriteFile(path, []byte(""), 0o600)

	AppendProject(path, Project{ID: "a", Name: "A", Cwd: proj})
	AppendProject(path, Project{ID: "b", Name: "B", Cwd: proj})

	if err := RemoveProject(path, "a"); err != nil {
		t.Fatal(err)
	}
	r, _, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 1 || r.Projects[0].ID != "b" {
		t.Fatalf("want only 'b', got %+v", r.Projects)
	}
}

func TestRemoveProject_missingIsNoop(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects.toml")
	os.WriteFile(path, []byte(""), 0o600)
	if err := RemoveProject(path, "nope"); err != nil {
		t.Fatalf("remove of nonexistent should be noop, got %v", err)
	}
}

// TestLoad_rejectsBareShellName — an earlier release acceptance criterion: a config
// with a bare binary name in the `shell` field must be rejected at
// load time so the daemon never execs a PATH-resolved binary.
func TestLoad_rejectsBareShellName(t *testing.T) {
	dir := t.TempDir()
	tomlSrc := `
[[project]]
id = "p1"
name = "BareShell"
cwd = "` + dir + `"
shell = ["zsh", "-l"]
`
	path := writeTemp(t, tomlSrc)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 0 {
		t.Fatalf("project with bare shell name should have been filtered, got %+v", r.Projects)
	}
	if len(warns) == 0 {
		t.Fatal("expected a warning for bare shell name; got none")
	}
	var matched bool
	for _, w := range warns {
		if strings.Contains(w.Error(), "shell[0]") && strings.Contains(w.Error(), "zsh") {
			matched = true
		}
	}
	if !matched {
		t.Errorf("expected warning to mention shell[0] and zsh; got %v", warns)
	}
}

// TestLoad_usesDefaultShellWhenShellOmitted — Codex review fix #3: when
// a persisted project omits its `shell` field, Load must fill the
// resolved absolute default set by SetDefaultShell (which main.go
// calls before Load). Before the fix, Load read $SHELL directly from
// the environment; if $SHELL was bare (e.g. "zsh" on some hosts),
// ResolveBinary rejected it as a bare name and the project silently
// vanished from the registry.
func TestLoad_usesDefaultShellWhenShellOmitted(t *testing.T) {
	dir := t.TempDir()
	// TOML with NO `shell` field — defaulting path must fire.
	tomlSrc := `
[[project]]
id = "nopref"
name = "NoPref"
cwd = "` + dir + `"
`
	path := writeTemp(t, tomlSrc)

	// Publish a resolved default. This mirrors what main.go does
	// before calling Load. Clear it after so other tests don't see it.
	SetDefaultShell([]string{"/bin/sh", "-l"})
	t.Cleanup(func() { SetDefaultShell(nil) })

	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("want 1 project, got %d (warns=%v)", len(r.Projects), warns)
	}
	if r.Projects[0].Shell[0] != "/bin/sh" {
		t.Errorf("Shell[0] = %q, want /bin/sh (resolved default)", r.Projects[0].Shell[0])
	}
}

// TestLoad_rejectsProjectIfDefaultShellIsBare — defence in depth. Even
// if some test / future caller installs a bare default via SetDefaultShell,
// Load's ResolveBinary pass still refuses and the project is warn+skip'd.
// We don't want a single misuse of SetDefaultShell to unlock the
// PATH-shadow vulnerability.
func TestLoad_rejectsProjectIfDefaultShellIsBare(t *testing.T) {
	dir := t.TempDir()
	tomlSrc := `
[[project]]
id = "nopref"
name = "NoPref"
cwd = "` + dir + `"
`
	path := writeTemp(t, tomlSrc)

	// Pathological: someone pushed a bare name through SetDefaultShell.
	SetDefaultShell([]string{"zsh", "-l"})
	t.Cleanup(func() { SetDefaultShell(nil) })

	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Projects) != 0 {
		t.Errorf("project with bare default shell should have been skipped, got %+v", r.Projects)
	}
	if len(warns) == 0 {
		t.Error("expected a warning about the bare shell")
	}
}

// TestLoad_absoluteShellResolves — happy path: an absolute shell path is
// accepted and the project loads normally.
func TestLoad_absoluteShellResolves(t *testing.T) {
	dir := t.TempDir()
	tomlSrc := `
[[project]]
id = "p1"
name = "AbsShell"
cwd = "` + dir + `"
shell = ["/bin/sh"]
`
	path := writeTemp(t, tomlSrc)
	r, warns, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("want 1 project, got %d", len(r.Projects))
	}
	if r.Projects[0].Shell[0] != "/bin/sh" {
		t.Errorf("Shell[0] = %q, want /bin/sh", r.Projects[0].Shell[0])
	}
}

// TestFsyncParentDir_happyPath — the helper must complete cleanly for a
// real file in a real directory. Smoke test that it doesn't panic on a
// reasonable input and actually hits the dir-open → Sync → Close path.
func TestFsyncParentDir_happyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if err := os.WriteFile(path, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fsyncParentDir(path); err != nil {
		t.Fatalf("fsyncParentDir on valid path: %v", err)
	}
}

// TestFsyncParentDir_missingDir — passing a path whose parent doesn't
// exist must surface a clear error rather than silently succeeding.
// We want writeAll's caller to see rename-dir failures loudly.
func TestFsyncParentDir_missingDir(t *testing.T) {
	bogus := filepath.Join(t.TempDir(), "no-such-dir", "file")
	if err := fsyncParentDir(bogus); err == nil {
		t.Error("fsyncParentDir on missing parent should have errored")
	}
}

// TestWriteAll_durabilityPath — end-to-end cover: writeAll → disk →
// Load again. The point is to make sure adding Sync calls didn't break
// the read path (e.g. by leaving the file in a weird state). A true
// crash-durability test would require a subprocess + SIGKILL between
// Sync and observation, which is too flaky for unit tests; treat this
// as the "doesn't break the happy path" golden plus a smoke check that
// the rendered file is readable and complete.
func TestWriteAll_durabilityPath(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "x")
	if err := os.Mkdir(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(path, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []Project{
		{ID: "a", Name: "A", Cwd: proj, DefaultPane: "claude", Shell: []string{"/bin/sh"}},
		{ID: "b", Name: "B", Cwd: proj, DefaultPane: "claude", Shell: []string{"/bin/sh"}},
		{ID: "c", Name: "C", Cwd: proj, DefaultPane: "claude", Shell: []string{"/bin/sh"}},
	} {
		if err := AppendProject(path, p); err != nil {
			t.Fatalf("AppendProject %s: %v", p.ID, err)
		}
	}
	// Remove middle project — goes through writeAll (post-Sync path).
	if err := RemoveProject(path, "b"); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	r, warns, err := Load(path)
	if err != nil {
		t.Fatalf("Load after writeAll: %v", err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(r.Projects) != 2 {
		t.Fatalf("want 2 projects after remove, got %d (%+v)", len(r.Projects), r.Projects)
	}
	for _, p := range r.Projects {
		if p.ID == "b" {
			t.Errorf("project b should have been removed")
		}
	}
	// No stray .tmp left behind.
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf(".tmp file leaked after writeAll: stat err=%v", err)
	}
}

func TestDeriveID(t *testing.T) {
	cases := []struct {
		name     string
		existing []string
		want     string
	}{
		{"Reck Connect", nil, "reck-connect"},
		{"CLV5", nil, "clv5"},
		{"My Thing!!", nil, "my-thing"},
		{"collide", []string{"collide"}, "collide-2"},
		{"collide", []string{"collide", "collide-2"}, "collide-3"},
		{"___", nil, "project"},
		{"", nil, "project"},
	}
	for _, c := range cases {
		got := DeriveID(c.name, c.existing)
		if got != c.want {
			t.Errorf("DeriveID(%q, %v) = %q, want %q", c.name, c.existing, got, c.want)
		}
	}
}

// TestDeriveID_longNameBoundedAndRoundTrips is the persistence-invariant
// regression: an overlong input name must produce an ID that ValidateProjectID
// accepts, so the project doesn't disappear on the next daemon restart.
func TestDeriveID_longNameBoundedAndRoundTrips(t *testing.T) {
	long := strings.Repeat("Foo Bar ", 40) // ~320 chars of input
	got := DeriveID(long, nil)
	if err := ValidateProjectID(got); err != nil {
		t.Fatalf("DeriveID produced invalid ID %q: %v", got, err)
	}
	if len(got) > MaxProjectIDLen {
		t.Errorf("len(%q)=%d exceeds MaxProjectIDLen=%d", got, len(got), MaxProjectIDLen)
	}
	// Collision suffix still fits.
	got2 := DeriveID(long, []string{got})
	if err := ValidateProjectID(got2); err != nil {
		t.Fatalf("collision-suffixed ID %q invalid: %v", got2, err)
	}
}

// TestValidateProjectID_parityWithLoad is the rebuild invariant in both
// directions: every ID that ValidateProjectID accepts must load cleanly,
// every one it rejects must be filtered out by Load.
func TestValidateProjectID_parityWithLoad(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		id    string
		valid bool
	}{
		{"foo", true},
		{"foo-bar", true},
		{"FOO_BAR-123", true},
		{"a", true},
		{strings.Repeat("x", MaxProjectIDLen), true},
		{"", false},
		{"-leading-dash", false},
		{"_leading_underscore", false},
		{"has space", false},
		{"has/slash", false},
		{"has.dot", false},
		{strings.Repeat("x", MaxProjectIDLen+1), false},
	}
	for _, c := range cases {
		err := ValidateProjectID(c.id)
		if (err == nil) != c.valid {
			t.Errorf("ValidateProjectID(%q) err=%v, want valid=%v", c.id, err, c.valid)
			continue
		}
		// Round-trip through Load using a TOML fragment with the given id.
		// cwd is a tmpdir so the only rejection source is the id rule.
		toml := "[[project]]\nid = " + quoteTOML(c.id) + "\nname = \"X\"\ncwd = " + quoteTOML(dir) + "\n"
		path := writeTemp(t, toml)
		r, warns, err := Load(path)
		if err != nil {
			t.Errorf("Load failed for %q: %v", c.id, err)
			continue
		}
		loaded := len(r.Projects) == 1 && r.Projects[0].ID == c.id
		if loaded != c.valid {
			t.Errorf("Load(%q) loaded=%v warnings=%v, want valid=%v",
				c.id, loaded, warns, c.valid)
		}
	}
}

// quoteTOML escapes a string for use as a TOML basic string literal.
// Just enough for the parity test — we only feed ids + tmpdir paths.
func quoteTOML(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
