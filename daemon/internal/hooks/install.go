// Package hooks installs the Claude Code lifecycle hook shims into the
// running user's ~/.claude/settings.json. Run at daemon startup so every
// Reck station (local or remote) ensures its own Claude installation is
// wired up to forward lifecycle events back to the daemon — no manual
// bash/jq step, works identically whether the daemon is on your laptop
// (local mode) or a remote Mac Studio (station mode).
package hooks

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// MarkerV1 is embedded into every Reck-installed command string. Presence
// of the marker identifies our entries so a fresh install can strip and
// replace them without touching the user's own hooks.
const MarkerV1 = "reck-hook-v1"

//go:embed reck-claude-hook.sh
var hookShimContent []byte

//go:embed reck-statusline.sh
var statusLineShimContent []byte

// eventBinding pairs a Claude Code hook name with its canonical Reck
// event kind (the `kind=` query param the shim POSTs to the daemon).
type eventBinding struct {
	claudeEvent string
	kind        string
}

var bindings = []eventBinding{
	{"SessionStart", "session_start"},
	{"UserPromptSubmit", "user_prompt"},
	{"PreToolUse", "pre_tool"},
	{"PostToolUse", "post_tool"},
	{"PostToolUseFailure", "post_tool_failure"},
	{"PermissionRequest", "permission_request"},
	{"PermissionDenied", "permission_denied"},
	{"Elicitation", "elicitation"},
	{"Stop", "stop"},
	{"StopFailure", "stop_failure"},
	{"Notification", "notification"},
	{"SessionEnd", "session_end"},
}

// Paths describes where we install files, derived from $HOME.
type Paths struct {
	ClaudeDir    string
	HooksDir     string
	ShimPath     string
	SettingsPath string
	// StatusLineShimPath is the reck-statusline.sh forwarder installed as
	// the Claude Code statusLine command.
	StatusLineShimPath string
	// StatusLinePriorPath records the user's original statusLine value (if
	// any) so it can be chained to at render time and restored on
	// Uninstall. Separate from OwnershipPath so the existing hook-ownership
	// sidecar format and its tests are untouched.
	StatusLinePriorPath string
	// LockPath is the sentinel file used to serialise concurrent daemon
	// installers. Two daemons starting at once (or Ensure+Uninstall races
	// from a developer restart) would otherwise race on temp-file rename
	// and corrupt settings.json.
	LockPath string
	// OwnershipPath records the exact hook commands Reck owns, so a
	// subsequent install/uninstall can strip them by structured lookup
	// rather than substring matching on the MarkerV1 string (which could
	// collide with an unrelated user hook that merely mentions the
	// marker in a comment).
	OwnershipPath string
}

// PathsFor returns the install paths rooted at home.
func PathsFor(home string) Paths {
	claudeDir := filepath.Join(home, ".claude")
	hooksDir := filepath.Join(claudeDir, "hooks")
	return Paths{
		ClaudeDir:           claudeDir,
		HooksDir:            hooksDir,
		ShimPath:            filepath.Join(hooksDir, "reck-claude-hook.sh"),
		SettingsPath:        filepath.Join(claudeDir, "settings.json"),
		LockPath:            filepath.Join(claudeDir, ".reck-hook.lock"),
		OwnershipPath:       filepath.Join(claudeDir, ".reck-hooks.json"),
		StatusLineShimPath:  filepath.Join(hooksDir, "reck-statusline.sh"),
		StatusLinePriorPath: filepath.Join(claudeDir, ".reck-statusline.json"),
	}
}

// ownershipRecord is the on-disk format for the ownership sidecar.
// Version is reserved for future schema migrations; Entries lists the
// exact command strings Reck owns (one per hook binding). Stored at
// ~/.claude/.reck-hooks.json.
type ownershipRecord struct {
	Version int      `json:"version"`
	Entries []string `json:"entries"`
}

// loadOwnership reads the ownership sidecar into a set. Missing file is
// not an error — returns an empty set, which combined with canonical-
// form matching handles the fresh-install case cleanly.
func loadOwnership(path string) (map[string]bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]bool{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read ownership %s: %w", path, err)
	}
	if len(data) == 0 {
		return map[string]bool{}, nil
	}
	var rec ownershipRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		// Treat corrupt sidecar as "no prior ownership claim" rather than
		// bubble up — an operator who hand-edited the file gets a fresh
		// install instead of a startup failure.
		return map[string]bool{}, nil
	}
	out := make(map[string]bool, len(rec.Entries))
	for _, cmd := range rec.Entries {
		out[cmd] = true
	}
	return out, nil
}

// writeOwnership writes the ownership sidecar atomically. Empty list
// removes the sidecar (clean uninstall state).
func writeOwnership(path string, entries []string) error {
	if len(entries) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove ownership %s: %w", path, err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	rec := ownershipRecord{Version: 1, Entries: entries}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal ownership: %w", err)
	}
	tmp := fmt.Sprintf("%s.reck.tmp.%d", path, os.Getpid())
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s → %s: %w", tmp, path, err)
	}
	return nil
}

// withInstallLock acquires an exclusive OS-level advisory lock on
// p.LockPath for the duration of fn. The lock guards the entire
// read-modify-write-rename sequence in settings.json, the shim write,
// and the sidecar ownership file — without it, two daemons can race
// on rename and one half-writes the other's temp file into place.
//
// The lock file is created if missing (0600) and never deleted — leaving
// it around is fine, it's ~0 bytes and saves the next caller a mkdir.
// Returns whatever fn returned, or a lock-acquisition error.
func withInstallLock(p Paths, fn func() error) error {
	if err := os.MkdirAll(p.ClaudeDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", p.ClaudeDir, err)
	}
	f, err := os.OpenFile(p.LockPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("open lock %s: %w", p.LockPath, err)
	}
	defer f.Close()
	// LOCK_EX blocks until exclusive access is granted. This is fine in
	// the daemon startup path — EnsureInstalled runs once at boot, and
	// two daemons racing to boot are an operator error worth slowing.
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock %s: %w", p.LockPath, err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

// EnsureInstalled writes the current embedded shim to
// $home/.claude/hooks/reck-claude-hook.sh and merges Reck's hook
// entries into $home/.claude/settings.json. Idempotent: every Reck
// entry is tagged with MarkerV1 in its command string, so re-running
// this strips our prior entries before writing fresh ones. The user's
// own hooks (entries without the marker) are left alone.
//
// Concurrency-safe across daemon instances: an advisory flock on
// ~/.claude/.reck-hook.lock serialises installers, and both the
// settings.json temp file and the shim script use per-PID temp names
// so two racing processes don't collide on the rename source path.
func EnsureInstalled(home string) error {
	p := PathsFor(home)
	return withInstallLock(p, func() error {
		if err := os.MkdirAll(p.HooksDir, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", p.HooksDir, err)
		}
		if err := writeShimIfChanged(p.ShimPath, hookShimContent); err != nil {
			return fmt.Errorf("write shim: %w", err)
		}
		if err := writeShimIfChanged(p.StatusLineShimPath, statusLineShimContent); err != nil {
			return fmt.Errorf("write statusline shim: %w", err)
		}
		// Load the prior ownership sidecar so we can strip older Reck
		// entries (e.g. from a shim path that moved) without relying on
		// MarkerV1 substring matching. Missing file ⇒ fresh install;
		// the canonical-form match in stripOwnedEntries still catches
		// the current install's own entries.
		owned, err := loadOwnership(p.OwnershipPath)
		if err != nil {
			return err
		}
		settings, err := readSettings(p.SettingsPath)
		if err != nil {
			return err
		}
		updated := applyHooks(settings, p.ShimPath, owned)
		if err := applyStatusLine(updated, p.StatusLineShimPath, p.StatusLinePriorPath); err != nil {
			return err
		}
		if err := writeSettings(p.SettingsPath, updated); err != nil {
			return err
		}
		// Record the commands we just wrote so the next install can
		// recognise them even if the shim path changes.
		fresh := make([]string, 0, len(bindings))
		for _, b := range bindings {
			fresh = append(fresh, hookCommandFor(p.ShimPath, b.kind))
		}
		return writeOwnership(p.OwnershipPath, fresh)
	})
}

// Uninstall strips every Reck-marked hook entry from settings.json and
// removes the shim script. Non-Reck hooks are preserved. Takes the
// same install lock as EnsureInstalled so a racing daemon can't
// re-install the marker between our read and rename.
func Uninstall(home string) error {
	p := PathsFor(home)
	return withInstallLock(p, func() error {
		owned, err := loadOwnership(p.OwnershipPath)
		if err != nil {
			return err
		}
		settings, err := readSettings(p.SettingsPath)
		if err != nil {
			return err
		}
		stripped := stripReckHooks(settings, p.ShimPath, owned)
		if err := stripStatusLine(stripped, p.StatusLineShimPath, p.StatusLinePriorPath); err != nil {
			return err
		}
		if err := writeSettings(p.SettingsPath, stripped); err != nil {
			return err
		}
		if err := os.Remove(p.ShimPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove shim %s: %w", p.ShimPath, err)
		}
		if err := os.Remove(p.StatusLineShimPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove statusline shim %s: %w", p.StatusLineShimPath, err)
		}
		// Clear the sidecar — we no longer own anything.
		return writeOwnership(p.OwnershipPath, nil)
	})
}

// --- internal helpers ---

func readSettings(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(data) == 0 {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

func writeSettings(path string, m map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}
	// Atomic write: per-PID temp + rename. Even with the install flock
	// guarding our own package, a non-Reck tool on the system might run
	// write-and-rename against the same directory; using a per-PID temp
	// name so we never overwrite someone else's in-progress file.
	tmp := fmt.Sprintf("%s.reck.tmp.%d", path, os.Getpid())
	// Clean up any leftover from a prior crashed run with this PID
	// (unlikely but keeps the happy path idempotent).
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		// Best-effort cleanup of the orphan temp file so the next run
		// doesn't see a stale `.reck.tmp.<pid>` from a prior error.
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s → %s: %w", tmp, path, err)
	}
	return nil
}

// writeShimIfChanged is the atomic shim writer: if the on-disk content
// differs from `content`, write it via per-PID temp + rename (matching
// writeSettings). Avoids spurious mtime bumps on identical content and
// guarantees the shim at the final path is never a half-written file
// if the daemon crashes mid-write.
func writeShimIfChanged(path string, content []byte) error {
	existing, err := os.ReadFile(path)
	if err == nil && bytesEqual(existing, content) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	tmp := fmt.Sprintf("%s.reck.tmp.%d", path, os.Getpid())
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, content, 0o755); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s → %s: %w", tmp, path, err)
	}
	return nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// hookCommandFor returns the canonical, shell-safe command string for
// one Reck-owned hook binding. The shim path is single-quoted so a
// $HOME containing spaces (e.g. "/Users/John Doe") still parses as one
// token at the shell. Any literal `'` in the path is escaped as `'\”`
// — harmless on sane filesystems but correct in the edge case.
//
// We emit the absolute `/bin/bash` rather than relying on PATH lookup:
// PATH at hook-runtime is whatever Claude Code inherits from the user's
// shell, and a malicious `~/.local/bin/bash` ahead of `/bin` would
// otherwise hijack every hook invocation. macOS guarantees `/bin/bash`
// exists (system shell, bash 3.2 baseline) — adequate for the shim,
// which only exec's our Go binary.
//
// Return-value format (stable, checked by ownership recognition):
//
//	/bin/bash '<shim>' <kind> # reck-hook-v1
//
// This exact string is stored in the sidecar file so subsequent
// installs can distinguish Reck-owned hooks from user hooks that
// happen to contain the marker substring. Migration from the prior
// `bash '<shim>' …` form is handled via the sidecar: a daemon that
// already wrote the old command remembers the exact string and
// strips it via `isReckOwnedCommand` on the next install.
func hookCommandFor(shimPath, kind string) string {
	return fmt.Sprintf("/bin/bash '%s' %s # %s",
		strings.ReplaceAll(shimPath, "'", `'\''`),
		kind,
		MarkerV1,
	)
}

// applyHooks mutates settings.hooks, stripping prior Reck entries and
// writing fresh ones keyed off bindings. All other keys are preserved.
// Ownership is established via structured recognition (exact canonical
// command match OR sidecar lookup), NOT loose substring matching —
// a user hook whose command string happens to contain "reck-hook-v1"
// in a comment or filename is left alone.
func applyHooks(settings map[string]any, shimPath string, ownedCommands map[string]bool) map[string]any {
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	for _, b := range bindings {
		canonical := hookCommandFor(shimPath, b.kind)
		kept := stripOwnedEntries(hooks[b.claudeEvent], canonical, ownedCommands)
		fresh := map[string]any{
			"matcher": "",
			"hooks": []any{
				map[string]any{
					"type":    "command",
					"command": canonical,
				},
			},
		}
		hooks[b.claudeEvent] = append(kept, fresh)
	}
	settings["hooks"] = hooks
	return settings
}

// stripReckHooks removes all Reck-owned entries from every event key in
// settings.hooks, identified by exact command match against the current
// shim binding or the provided sidecar-owned set. Empty event arrays
// are deleted to keep the JSON tidy.
func stripReckHooks(settings map[string]any, shimPath string, ownedCommands map[string]bool) map[string]any {
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		return settings
	}
	for _, b := range bindings {
		canonical := hookCommandFor(shimPath, b.kind)
		kept := stripOwnedEntries(hooks[b.claudeEvent], canonical, ownedCommands)
		if len(kept) == 0 {
			delete(hooks, b.claudeEvent)
		} else {
			hooks[b.claudeEvent] = kept
		}
	}
	if len(hooks) == 0 {
		delete(settings, "hooks")
	} else {
		settings["hooks"] = hooks
	}
	return settings
}

// stripOwnedEntries walks the `[{matcher, hooks:[{command, ...}]}]` array
// and drops any inner-hook command that is Reck-owned: either an exact
// match of the current canonical form, or a known-owned command recorded
// in the sidecar (handles stale shim paths from older installs). A user
// hook whose command simply contains the marker substring is NOT stripped
// — ownership is structural, not textual. Empty matcher groups are pruned.
func stripOwnedEntries(raw any, canonical string, owned map[string]bool) []any {
	list, _ := raw.([]any)
	out := make([]any, 0, len(list))
	for _, item := range list {
		grp, ok := item.(map[string]any)
		if !ok {
			out = append(out, item) // unexpected shape — preserve
			continue
		}
		innerRaw, _ := grp["hooks"].([]any)
		keptInner := make([]any, 0, len(innerRaw))
		for _, h := range innerRaw {
			hm, ok := h.(map[string]any)
			if !ok {
				keptInner = append(keptInner, h)
				continue
			}
			cmd, _ := hm["command"].(string)
			if isReckOwnedCommand(cmd, canonical, owned) {
				continue
			}
			keptInner = append(keptInner, h)
		}
		if len(keptInner) > 0 {
			grp["hooks"] = keptInner
			out = append(out, grp)
		}
	}
	return out
}

// legacyReckShimFilename is the historical shim filename that
// Older.2 Reck installs wrote into settings.json. Captured as a
// literal so the migration regex can pin the path tail, rejecting
// hooks whose path happens to match the <path> <kind> # <marker>
// shape but doesn't reference our actual shim file.
const legacyReckShimFilename = "reck-claude-hook.sh"

// legacyReckKinds enumerates the canonical-event tokens the Older.2
// installer emitted — identical to the kind field of bindings. Used
// to bound the <kind> capture in legacyReckCommandPattern so a user
// hook like `bash /opt/script.sh stop # reck-hook-v1` where "stop"
// happens to be one of our kinds but the path is theirs won't match
// (the path suffix check does the heavy lifting). Kept separate for
// explicitness and for the compiled alternation.
var legacyReckKinds = []string{
	"session_start",
	"user_prompt",
	"pre_tool",
	"post_tool",
	"post_tool_failure",
	"permission_request",
	"permission_denied",
	"elicitation",
	"stop",
	"stop_failure",
	"notification",
	"session_end",
	// also accept the synthesized internal-only kind for completeness;
	// not currently emitted by the installer but future-proof.
	"user_interrupt",
}

// legacyReckCommandPattern matches the Older.2 hook command format
// with a tight path + kind constraint:
//
//	^bash <path>/.claude/hooks/reck-claude-hook.sh <kind> # reck-hook-v1$
//
// Where <kind> is one of the known binding kinds (see legacyReckKinds)
// and the path must end with our exact shim filename under
// `.claude/hooks/`. This is narrow enough that a user-crafted hook
// like `bash /opt/custom.sh stop # reck-hook-v1` does NOT match
// (wrong path tail); the regex only claims hooks whose command
// genuinely looks like something a prior Reck install wrote.
//
// Used only as a one-shot migration heuristic when the ownership
// sidecar is missing. A user hook that merely contains the marker
// in a comment (e.g. "bash /x.sh  # also see reck-hook-v1") does NOT
// match this form and is preserved.
var legacyReckCommandPattern = regexp.MustCompile(
	`^bash (\S.*/\.claude/hooks/` + regexp.QuoteMeta(legacyReckShimFilename) + `) (` +
		strings.Join(legacyReckKinds, "|") + `) # ` +
		regexp.QuoteMeta(MarkerV1) + `$`,
)

// isReckOwnedCommand determines whether the given hook command string
// is one we should claim. Ownership is ONE of:
//
//   - Exact equality with the current canonical form (covers the freshly-
//     installed state — this is the overwhelmingly common case).
//   - Exact equality with a command recorded in the sidecar (covers
//     stale shim paths from a prior daemon whose $HOME moved, etc).
//   - Exact match of the Older.2 unquoted command format AND the
//     path ends with our historical shim filename under .claude/hooks
//     AND the kind is one of our binding kinds (one-shot migration
//     for existing daemons being upgraded).
//
// Substring matching on MarkerV1 is intentionally NOT a trigger —
// a user's unrelated hook that happens to embed "reck-hook-v1" in a
// comment or filename must not be stripped. The tightened legacy
// regex similarly refuses to claim `bash /opt/foo.sh stop # reck-hook-v1`
// because "/opt/foo.sh" is not our shim path.
func isReckOwnedCommand(cmd, canonical string, owned map[string]bool) bool {
	if cmd == canonical {
		return true
	}
	if owned != nil && owned[cmd] {
		return true
	}
	if legacyReckCommandPattern.MatchString(cmd) {
		return true
	}
	return false
}
