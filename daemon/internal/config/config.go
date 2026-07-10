// Package config loads and validates the station's project registry.
package config

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
)

// ManagedProjectsRoot is the directory where the daemon creates project
// directories when POST /projects is called without a cwd. Anything
// under this path is safe to rm-rf on DELETE /projects/:id; anything
// outside must be left alone.
//
// Declared as var (not const) so tests can override at runtime — every
// test in `daemon/internal/pty/*_test.go` mutates this directly to a
// `t.TempDir()`. Production wiring lives in the daemon binary's
// `main.go`: it asserts RECK_STATION_ROOT is set (station mode only)
// and overwrites this var before Manager construction. Keeping the
// env read out of package init means `go test` is deterministic
// regardless of the developer's shell env.
var ManagedProjectsRoot = "/Users/reck-connect/projects"

// Project is one entry in projects.toml.
type Project struct {
	ID          string   `toml:"id"`
	Name        string   `toml:"name"`
	Cwd         string   `toml:"cwd"`
	DefaultPane string   `toml:"default_pane"` // "claude" | "shell" | "codex"; defaults to "claude"
	Shell       []string `toml:"shell"`        // defaults to [$SHELL, "-l"]
	Preamble    string   `toml:"preamble"`     // optional; claude: --append-system-prompt, codex: -c developer_instructions
	// Archived is true when the user put this project to sleep: its panes
	// are killed to free RAM, but its session rows keep was_live=true so
	// unarchive can respawn them. Persisted so archive survives daemon
	// restarts. Distinct from removal — archive never deletes the cwd.
	Archived bool `toml:"archived,omitempty"`
	// DisplayName is the user-given override. Empty = no override;
	// callers render Name. Persisted here so it survives restart and is
	// visible to every connected client.
	DisplayName string `toml:"display_name,omitempty"`
	// Available reports whether the project's cwd was reachable when the
	// registry was last loaded. False means the project block exists in
	// projects.toml but the directory it points at is missing — surfaced
	// to clients (hybrid mode rev 3.1) so the project still appears on
	// the rail with a "stale" indicator instead of silently disappearing.
	// Not persisted — derived per Load() call by os.Stat(p.Cwd).
	Available bool `toml:"-"`
}

// Registry is the root of projects.toml.
type Registry struct {
	Projects []Project `toml:"project"`
}

var idRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

// defaultShell is the absolute-path shell argv used as the fallback for
// projects that omit their `shell` field in projects.toml. Set once by
// the daemon at startup via SetDefaultShell; unset in tests and other
// library callers, where Load falls through to an $SHELL-derived
// inline default.
//
// Why this exists as package-level state rather than a Load() parameter:
//
//   - Codex review (an earlier release fix #3) called out that main.go was resolving
//     $SHELL via exec.LookPath AFTER config.Load ran, so the load path
//     saw bare $SHELL from the environment and dropped any persisted
//     project that omitted `shell`. The fix is "resolve shell BEFORE
//     Load, pass the resolved path into Load".
//   - Load has many internal re-read callers (AppendProject, RemoveProject,
//     SetProjectDisplayName) that each re-invoke
//     Load(path) to read-modify-write. Changing Load's signature forces
//     every one of those to thread the default through, and it's easy
//     to miss one — especially one that only runs during a mutation,
//     which would regress a persisted project silently.
//   - A package-level set-once-at-startup var closes the gap cleanly:
//     main.go calls SetDefaultShell before the first Load, and every
//     subsequent Load in the same process sees the same resolved value.
var defaultShell []string

// SetDefaultShell installs the resolved-absolute-path default shell
// argv used by subsequent Load() calls as the fallback for projects
// that omit their `shell` field. Call once at daemon startup, after
// resolving via exec.LookPath, BEFORE the first config.Load.
//
// Passing nil / empty restores the inline $SHELL-derived default
// (primarily useful in tests that want to clear package state).
func SetDefaultShell(argv []string) {
	defaultShell = append([]string(nil), argv...)
}

// MaxProjectIDLen is the upper bound used by ValidateProjectID. Matches
// the {0,63} quantifier in idRe, giving 64 bytes total including the
// leading alphanumeric. Kept as a named const so creation-path code can
// cap derived IDs before they'd be rejected by Load on the next restart.
const MaxProjectIDLen = 64

// ValidateProjectID is the single source of truth for whether a project
// ID is acceptable. Both the creation path (Manager.AddProject) and the
// load path (Load) route through this so an ID accepted at runtime can
// never be dropped as invalid after a daemon restart.
//
// Rules: must match idRe (ASCII-alphanumeric start, then alphanumeric /
// underscore / hyphen, total 1..MaxProjectIDLen bytes).
func ValidateProjectID(id string) error {
	if id == "" {
		return fmt.Errorf("project id: empty")
	}
	if len(id) > MaxProjectIDLen {
		return fmt.Errorf("project id: length %d exceeds %d", len(id), MaxProjectIDLen)
	}
	if !idRe.MatchString(id) {
		return fmt.Errorf("project id: %q does not match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", id)
	}
	return nil
}

// Load reads and validates the registry. Malformed TOML is a fatal error;
// per-project issues (bad cwd, duplicate id) log + skip but do not fail.
func Load(path string) (*Registry, []error, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", path, err)
	}
	var r Registry
	if err := toml.Unmarshal(raw, &r); err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", path, err)
	}
	var warnings []error
	seen := make(map[string]bool)
	clean := r.Projects[:0]
	for i := range r.Projects {
		p := &r.Projects[i]
		if err := ValidateProjectID(p.ID); err != nil {
			warnings = append(warnings, fmt.Errorf("project %q: %w", p.ID, err))
			continue
		}
		if seen[p.ID] {
			warnings = append(warnings, fmt.Errorf("project %q: duplicate id", p.ID))
			continue
		}
		if p.Cwd == "" {
			warnings = append(warnings, fmt.Errorf("project %q: cwd empty", p.ID))
			continue
		}
		// Hybrid mode rev 3.1: a missing cwd no longer drops the project.
		// Mark Available=false and keep the entry so the rail can render a
		// "stale" indicator. Other validation failures below (default_pane,
		// shell resolution) still warn+skip — those are config typos, not
		// the "directory moved / unmounted" case this branch handles.
		available := true
		if st, err := os.Stat(p.Cwd); err != nil || !st.IsDir() {
			warnings = append(warnings, fmt.Errorf("project %q: cwd %s not a directory (marked unavailable)", p.ID, p.Cwd))
			available = false
		}
		if p.DefaultPane == "" {
			p.DefaultPane = "claude"
		}
		if p.DefaultPane != "claude" && p.DefaultPane != "shell" && p.DefaultPane != "codex" {
			warnings = append(warnings, fmt.Errorf("project %q: default_pane must be claude, shell, or codex", p.ID))
			continue
		}
		if len(p.Shell) == 0 {
			// Prefer the daemon-resolved default (set by main.go via
			// SetDefaultShell before Load runs) over the raw $SHELL
			// environment variable. Without this, a bare $SHELL like
			// "zsh" / "bash" on the host would flow through here and
			// then be rejected by ResolveBinary below, silently
			// dropping a persisted project from the registry at
			// startup. The new-project / AddProject creation path
			// already uses the resolved default via Manager.defaultShell
			// — we want Load to match.
			if len(defaultShell) > 0 {
				p.Shell = append([]string(nil), defaultShell...)
			} else {
				sh := os.Getenv("SHELL")
				if sh == "" {
					sh = "/bin/zsh"
				}
				p.Shell = []string{sh, "-l"}
			}
		}
		// an earlier release: every pane-spawn path must exec an absolute path, not
		// a bare name. Resolve here at load so a config-level typo
		// ("zsh" instead of "/bin/zsh") is surfaced when the daemon
		// reads projects.toml rather than when the user first tries to
		// open a shell pane. Failure → warn+skip the project (same
		// severity as a bad cwd).
		//
		// Note: when defaultShell is populated, p.Shell[0] is already
		// absolute, so ResolveBinary just confirms it's executable.
		resolved, err := ResolveBinary(fmt.Sprintf("project %q shell[0]", p.ID), p.Shell[0])
		if err != nil {
			warnings = append(warnings, err)
			continue
		}
		p.Shell[0] = resolved
		p.Cwd = filepath.Clean(p.Cwd)
		p.Available = available
		seen[p.ID] = true
		clean = append(clean, *p)
	}
	r.Projects = clean
	return &r, warnings, nil
}

// writerMu guards concurrent writes to the registry file. Does not protect
// against external processes editing the file — daemon is the sole writer.
var writerMu sync.Mutex

// renderProjectBlock emits a single [[project]] TOML table to w.
func renderProjectBlock(w io.Writer, p Project) {
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "[[project]]")
	fmt.Fprintf(w, "id   = %q\n", p.ID)
	fmt.Fprintf(w, "name = %q\n", p.Name)
	fmt.Fprintf(w, "cwd  = %q\n", p.Cwd)
	if p.DefaultPane != "" && p.DefaultPane != "claude" {
		fmt.Fprintf(w, "default_pane = %q\n", p.DefaultPane)
	}
	if len(p.Shell) > 0 {
		fmt.Fprint(w, "shell = [")
		for i, s := range p.Shell {
			if i > 0 {
				fmt.Fprint(w, ", ")
			}
			fmt.Fprintf(w, "%q", s)
		}
		fmt.Fprintln(w, "]")
	}
	if p.Preamble != "" {
		if strings.ContainsRune(p.Preamble, '\n') {
			fmt.Fprintf(w, "preamble = \"\"\"\n%s\"\"\"\n", p.Preamble)
		} else {
			fmt.Fprintf(w, "preamble = %q\n", p.Preamble)
		}
	}
	if p.Archived {
		fmt.Fprintln(w, "archived = true")
	}
	if p.DisplayName != "" {
		fmt.Fprintf(w, "display_name = %q\n", p.DisplayName)
	}
}

// AppendProject writes a new [[project]] block to the registry file.
// Returns an error if a project with the same id already exists on disk.
func AppendProject(path string, p Project) error {
	writerMu.Lock()
	defer writerMu.Unlock()

	// Re-read current registry to detect duplicates on disk.
	current, _, err := Load(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if current != nil {
		for _, existing := range current.Projects {
			if existing.ID == p.ID {
				return fmt.Errorf("project %q already exists", p.ID)
			}
		}
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	renderProjectBlock(f, p)
	return nil
}

// SetProjectArchived rewrites the registry file with the named project's
// archived flag set to the given value. Idempotent — no-op when the project
// is already in the requested state, or when it doesn't exist. Any other
// project blocks are preserved verbatim via a full re-render.
func SetProjectArchived(path string, id string, archived bool) error {
	writerMu.Lock()
	defer writerMu.Unlock()

	current, _, err := Load(path)
	if err != nil {
		return err
	}
	if current == nil {
		return nil
	}
	changed := false
	for i := range current.Projects {
		if current.Projects[i].ID == id {
			if current.Projects[i].Archived == archived {
				return nil
			}
			current.Projects[i].Archived = archived
			changed = true
			break
		}
	}
	if !changed {
		return nil
	}
	return writeAll(path, current.Projects)
}

// SetProjectDisplayName rewrites the registry file with the named project's
// display_name set to the given value. Empty string clears the override.
// Idempotent — no-op when the project is already in the requested state,
// or when it doesn't exist.
func SetProjectDisplayName(path string, id string, displayName string) error {
	writerMu.Lock()
	defer writerMu.Unlock()

	current, _, err := Load(path)
	if err != nil {
		return err
	}
	if current == nil {
		return nil
	}
	changed := false
	for i := range current.Projects {
		if current.Projects[i].ID == id {
			if current.Projects[i].DisplayName == displayName {
				return nil
			}
			current.Projects[i].DisplayName = displayName
			changed = true
			break
		}
	}
	if !changed {
		return nil
	}
	return writeAll(path, current.Projects)
}

// RemoveProject rewrites the registry file without the named project.
// Returns nil even if the project is not present (idempotent delete).
func RemoveProject(path string, id string) error {
	writerMu.Lock()
	defer writerMu.Unlock()

	current, _, err := Load(path)
	if err != nil {
		return err
	}
	if current == nil {
		return nil
	}
	kept := current.Projects[:0]
	for _, p := range current.Projects {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	if len(kept) == len(current.Projects) {
		return nil // not found; idempotent
	}
	return writeAll(path, kept)
}

// writeAll replaces the entire file with a rendered registry.
//
// Durability (an earlier release review fix): the atomic write pattern (write-to-tmp →
// rename) is only crash-safe if the data AND the directory entry are
// forced through the buffer cache before the caller observes success.
// On Linux/ext4 (and APFS) a bare `Close`+`Rename` can survive a kernel
// crash uncommitted — the rename is visible in memory but not in the
// journal, so a power loss replays as if the rename never happened. The
// daemon would then restart with the OLD registry (project still listed)
// while the live state has already killed the panes and removed the cwd.
// That's the exact split-brain the Wave 1 transactional ordering was
// meant to prevent.
//
// Fix: fsync the temp file before close, then fsync the parent directory
// after rename. fsyncParentDir wraps the dir-open/fsync/close in a
// single call so every writeAll caller gets the guarantee.
func writeAll(path string, projects []Project) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp) }()
	fmt.Fprintln(f, "# Managed by reck-stationd. Edits outside the daemon may be overwritten on next write.")
	for _, p := range projects {
		renderProjectBlock(f, p)
	}
	// Force data through the page cache before the rename, so the
	// renamed inode never points at a zero-length or torn-write file.
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	// Force the directory-entry rename through to disk. Without this,
	// rename survives in the VFS dentry cache but not necessarily in
	// the on-disk journal until the next metadata flush.
	return fsyncParentDir(path)
}

// fsyncParentDir opens the parent directory of path read-only and
// fsyncs it, flushing the rename's directory-entry change to stable
// storage. No-op on platforms where Sync on a directory handle isn't
// supported (Windows) — but v2 daemon only runs on Darwin/Linux, both
// of which honor it.
func fsyncParentDir(path string) error {
	dir := filepath.Dir(path)
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open dir %s: %w", dir, err)
	}
	syncErr := d.Sync()
	closeErr := d.Close()
	if syncErr != nil {
		return fmt.Errorf("sync dir %s: %w", dir, syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close dir %s: %w", dir, closeErr)
	}
	return nil
}

// DeriveID slugifies `name` and suffixes `-N` if needed to avoid collisions
// with anything in `existingIDs`.
//
// The returned ID is always <= MaxProjectIDLen bytes and round-trips
// through ValidateProjectID. A long input is truncated (trimmed of any
// trailing hyphen introduced by truncation) to leave room for a
// collision-suffix of the form "-2".
func DeriveID(name string, existingIDs []string) string {
	slug := strings.Builder{}
	prevDash := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			slug.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				slug.WriteRune('-')
				prevDash = true
			}
		}
	}
	base := strings.Trim(slug.String(), "-")
	if base == "" {
		base = "project"
	}
	// Reserve headroom for a collision suffix ("-NN...") so
	// base + "-2", base + "-10", ... always fits within MaxProjectIDLen.
	// 8 bytes of suffix room covers collision counters up to "-9999999".
	const suffixRoom = 8
	if cap := MaxProjectIDLen - suffixRoom; len(base) > cap {
		base = strings.TrimRight(base[:cap], "-")
		if base == "" {
			base = "project"
		}
	}
	existing := make(map[string]bool, len(existingIDs))
	for _, id := range existingIDs {
		existing[id] = true
	}
	if !existing[base] {
		return base
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !existing[candidate] {
			return candidate
		}
	}
}
