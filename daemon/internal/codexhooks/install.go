// Package codexhooks installs the Codex CLI lifecycle hook shims into
// the running user's ~/.codex/config.toml. Mirror of internal/hooks for
// Claude Code panes — the shim posts the same canonical Reck `kind=`
// query param and HMAC contract to /panes/<id>/agent-event so the
// stoplight state machine treats Codex panes identically to Claude.
//
// Round-trip preservation contract: the installer
// reads the full TOML document, mutates only the slots it owns
// (`features.hooks` — formerly `features.codex_hooks` before codex
// 0.130 deprecated that name — and the Reck-marked entries under
// `[[hooks.<Event>]]`), and writes the rest verbatim. Comments are
// lost (acceptable, documented), but no other user state — projects,
// plugins, TUI prefs, model defaults — is touched. A Reck-installed
// legacy `codex_hooks=true` is migrated to `hooks=true` on the next
// daemon start to clear the TUI deprecation warning.
//
// All writes go through a per-PID temp file + rename and are guarded
// by an advisory flock (~/.codex/.reck-codex-hook.lock) so two daemons
// racing to start can't half-write each other's output.
package codexhooks

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/BurntSushi/toml"
)

// MarkerV1 is embedded into every Reck-installed hook command. Presence
// of the marker plus a sidecar match identifies our entries on
// re-install — substring matches alone are NOT a trigger (a user hook
// with the marker in a comment is preserved, mirroring the Claude
// installer's contract).
const MarkerV1 = "reck-codex-hook-v1"

// MaxSnapshots caps the number of pre-install backups kept under
// ~/.codex/config.toml.reck-pre-install-<unix-ts>.bak. Older entries
// rotate out so a long-running daemon doesn't accumulate hundreds of
// backups.
const MaxSnapshots = 5

//go:embed reck-codex-hook.sh
var hookShimContent []byte

// eventBinding pairs a Codex CLI hook name with its canonical Reck
// kind (the `kind=` query param the shim POSTs). The Codex event set
// differs from Claude's: `PreCompact` / `PostCompact` are Codex-only,
// and Codex has no `PostToolUseFailure` / `PermissionDenied` equivalent.
type eventBinding struct {
	codexEvent string
	kind       string
}

var bindings = []eventBinding{
	{"SessionStart", "session_start"},
	{"UserPromptSubmit", "user_prompt"},
	{"PreToolUse", "pre_tool"},
	{"PostToolUse", "post_tool"},
	{"PermissionRequest", "permission_request"},
	{"PreCompact", "pre_compact"},
	{"PostCompact", "post_compact"},
	{"Stop", "stop"},
}

// Paths describes where we install files, derived from $HOME.
type Paths struct {
	CodexDir      string
	HooksDir      string
	ShimPath      string
	ConfigPath    string
	LockPath      string
	OwnershipPath string
}

// PathsFor returns the install paths rooted at home.
func PathsFor(home string) Paths {
	codexDir := filepath.Join(home, ".codex")
	hooksDir := filepath.Join(codexDir, "hooks")
	return Paths{
		CodexDir:      codexDir,
		HooksDir:      hooksDir,
		ShimPath:      filepath.Join(hooksDir, "reck-codex-hook.sh"),
		ConfigPath:    filepath.Join(codexDir, "config.toml"),
		LockPath:      filepath.Join(codexDir, ".reck-codex-hook.lock"),
		OwnershipPath: filepath.Join(codexDir, ".reck-codex-hooks.json"),
	}
}

// ownershipVersionCurrent is the schema version this package writes.
// v1 sidecars lack the FeaturesFlagAddedByReck field; an
// upgrade from v1→v2 triggers a one-shot migration that consults the
// oldest pre-install snapshot to determine whether Reck originally
// added the features flag.
const ownershipVersionCurrent = 2

type ownershipRecord struct {
	Version int      `json:"version"`
	Entries []string `json:"entries"`
	// FeaturesFlagAddedByReck records whether Reck added a feature
	// flag at install time (legacy `features.codex_hooks` pre-rename,
	// or `features.hooks` post-rename) that was absent in the
	// pre-install snapshot. On uninstall, if this is true AND the
	// on-disk value is still `true`, the key (and an emptied
	// [features] table) are stripped — restoring the pre-install
	// byte-clean state. A user-flipped value between install and
	// uninstall is left alone. The rename migration
	// (codex 0.130 deprecation) reuses this bit: a Reck-owned legacy
	// `codex_hooks=true` is stripped and `hooks=true` is written in
	// its place, keeping the ownership bit set across the rename.
	FeaturesFlagAddedByReck bool `json:"features_flag_added_by_reck,omitempty"`
}

func loadOwnership(path string) (entries map[string]bool, addedByReck bool, version int, err error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]bool{}, false, ownershipVersionCurrent, nil
	}
	if err != nil {
		return nil, false, 0, fmt.Errorf("read ownership %s: %w", path, err)
	}
	if len(data) == 0 {
		return map[string]bool{}, false, ownershipVersionCurrent, nil
	}
	var rec ownershipRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return map[string]bool{}, false, ownershipVersionCurrent, nil
	}
	out := make(map[string]bool, len(rec.Entries))
	for _, cmd := range rec.Entries {
		out[cmd] = true
	}
	return out, rec.FeaturesFlagAddedByReck, rec.Version, nil
}

func writeOwnership(path string, entries []string, featuresFlagAddedByReck bool) error {
	if len(entries) == 0 && !featuresFlagAddedByReck {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove ownership %s: %w", path, err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	rec := ownershipRecord{Version: ownershipVersionCurrent, Entries: entries, FeaturesFlagAddedByReck: featuresFlagAddedByReck}
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

func withInstallLock(p Paths, fn func() error) error {
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", p.CodexDir, err)
	}
	f, err := os.OpenFile(p.LockPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("open lock %s: %w", p.LockPath, err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock %s: %w", p.LockPath, err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

// EnsureInstalled writes the embedded shim into ~/.codex/hooks/ and
// merges Reck's hook entries into ~/.codex/config.toml. Idempotent:
// every Reck entry is a single canonical command string; re-running
// strips the prior set (via exact-match or sidecar lookup) before
// writing fresh ones. User-authored hook entries — and every TOML
// table outside the `[hooks]` and `[features]` slots — are preserved.
func EnsureInstalled(home string) error {
	p := PathsFor(home)
	return withInstallLock(p, func() error {
		if err := os.MkdirAll(p.HooksDir, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", p.HooksDir, err)
		}
		if err := writeShimIfChanged(p.ShimPath, hookShimContent); err != nil {
			return fmt.Errorf("write shim: %w", err)
		}
		owned, priorAdded, priorVersion, err := loadOwnership(p.OwnershipPath)
		if err != nil {
			return err
		}
		// Sidecar v1→v2 migration: a v1 sidecar has no ownership
		// bit. If the user is on the upgrade path — Reck previously
		// added a feature flag (legacy `codex_hooks` or new `hooks`) to
		// a config that didn't have it — the oldest pre-install
		// snapshot will lack the flag under both names. Walk it before
		// snapshotting/rewriting the config so we can claim ownership
		// for uninstall cleanup. False positives are avoided: if the
		// user had either form of the flag before Reck ever installed,
		// the snapshot shows it and migration declines.
		if priorVersion < ownershipVersionCurrent && !priorAdded {
			if reckAddedFlagInPriorInstall(p.CodexDir) {
				priorAdded = true
			}
		}
		raw, err := readConfig(p.ConfigPath)
		if err != nil {
			return err
		}
		if len(raw) > 0 {
			if err := writeSnapshot(p.ConfigPath, raw); err != nil {
				return err
			}
			if err := rotateSnapshots(p.CodexDir, MaxSnapshots); err != nil {
				return err
			}
		}
		doc, err := decodeConfig(raw)
		if err != nil {
			return err
		}
		// OR with the prior sidecar bit: on a re-install,
		// ensureFeatureFlag sees the key already present (because the
		// previous install wrote it) and returns false. Without the OR,
		// we'd drop ownership on every re-install, and uninstall would
		// then leave the flag behind.
		//
		// Migration runs before ensureFeatureFlag: a Reck-owned legacy
		// `features.codex_hooks=true` is stripped so codex 0.130 stops
		// warning. ensureFeatureFlag then writes the canonical `hooks`
		// key on the same install pass.
		migrateLegacyFeatureFlag(doc, priorAdded)
		addedByReck := ensureFeatureFlag(doc) || priorAdded
		applyHooks(doc, p.ShimPath, owned)
		out, err := encodeConfig(doc)
		if err != nil {
			return err
		}
		if err := writeConfig(p.ConfigPath, out); err != nil {
			return err
		}
		fresh := make([]string, 0, len(bindings))
		for _, b := range bindings {
			fresh = append(fresh, hookCommandFor(p.ShimPath, b.kind))
		}
		return writeOwnership(p.OwnershipPath, fresh, addedByReck)
	})
}

// Uninstall strips Reck-marked hook entries from config.toml and
// removes the shim. A user-set feature flag (`features.hooks` or the
// legacy `features.codex_hooks`, true OR false) is preserved; a
// Reck-set `features.hooks = true` — or a leftover legacy
// `features.codex_hooks = true` recorded via FeaturesFlagAddedByReck
// in the sidecar — is stripped when the on-disk value still matches
// what Reck wrote, restoring the pre-install byte-clean state.
// Snapshots are kept for the configured retention so the user
// has a rollback path even after uninstall.
func Uninstall(home string) error {
	p := PathsFor(home)
	return withInstallLock(p, func() error {
		owned, addedByReck, priorVersion, err := loadOwnership(p.OwnershipPath)
		if err != nil {
			return err
		}
		// Sidecar v1→v2 migration: a v1 sidecar has no ownership
		// bit. If the user uninstalls before any re-install runs the
		// migration in EnsureInstalled, consult the oldest snapshot to
		// claim ownership of a Reck-added flag.
		if priorVersion < ownershipVersionCurrent && !addedByReck {
			if reckAddedFlagInPriorInstall(p.CodexDir) {
				addedByReck = true
			}
		}
		raw, err := readConfig(p.ConfigPath)
		if err != nil {
			return err
		}
		if len(raw) == 0 {
			// Nothing to uninstall from. Still remove shim + sidecar.
			_ = os.Remove(p.ShimPath)
			return writeOwnership(p.OwnershipPath, nil, false)
		}
		if err := writeSnapshot(p.ConfigPath, raw); err != nil {
			return err
		}
		if err := rotateSnapshots(p.CodexDir, MaxSnapshots); err != nil {
			return err
		}
		doc, err := decodeConfig(raw)
		if err != nil {
			return err
		}
		stripHooks(doc, p.ShimPath, owned)
		if addedByReck {
			stripReckOwnedFeatureFlag(doc)
		}
		out, err := encodeConfig(doc)
		if err != nil {
			return err
		}
		if err := writeConfig(p.ConfigPath, out); err != nil {
			return err
		}
		if err := os.Remove(p.ShimPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove shim %s: %w", p.ShimPath, err)
		}
		return writeOwnership(p.OwnershipPath, nil, false)
	})
}

// --- internal helpers ---

func readConfig(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}

func decodeConfig(raw []byte) (map[string]any, error) {
	doc := map[string]any{}
	if len(raw) == 0 {
		return doc, nil
	}
	if err := toml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse config.toml: %w", err)
	}
	normalizeAny(doc)
	return doc, nil
}

// normalizeAny coerces BurntSushi/toml's typed array decodings
// (`[]map[string]any` for arrays of tables) into plain `[]any` so the
// rest of the package can mutate values uniformly. Walks the document
// recursively and rewrites every nested array.
//
// Without this normalisation, the slot mutations append `map[string]any`
// values into a slice of concrete `[]map[string]any`, which Go can't do —
// and `[]any`-typed assertions fail across BurntSushi's typed slices.
func normalizeAny(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			x[k] = normalizeAny(val)
		}
		return x
	case []map[string]any:
		out := make([]any, len(x))
		for i, m := range x {
			out[i] = normalizeAny(m)
		}
		return out
	case []any:
		for i, e := range x {
			x[i] = normalizeAny(e)
		}
		return x
	default:
		return v
	}
}

func encodeConfig(doc map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	enc := toml.NewEncoder(&buf)
	enc.Indent = ""
	if err := enc.Encode(doc); err != nil {
		return nil, fmt.Errorf("encode config.toml: %w", err)
	}
	return buf.Bytes(), nil
}

func writeConfig(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
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

// writeSnapshot copies `raw` into a timestamped backup so the user has
// a one-step rollback path after the first mutation. The filename
// embeds nanosecond resolution + PID so rapid back-to-back installs
// (or two daemon restarts within the same wall-clock second) don't
// clobber each other's snapshot. rotateSnapshots prunes by sort order
// — the format is still lexicographically sortable.
func writeSnapshot(configPath string, raw []byte) error {
	dir := filepath.Dir(configPath)
	base := filepath.Base(configPath)
	name := fmt.Sprintf("%s.reck-pre-install-%d-%d.bak",
		base, time.Now().UnixNano(), os.Getpid())
	dst := filepath.Join(dir, name)
	tmp := fmt.Sprintf("%s.reck.tmp.%d", dst, os.Getpid())
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write snapshot %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename snapshot %s: %w", dst, err)
	}
	return nil
}

func rotateSnapshots(codexDir string, keep int) error {
	entries, err := os.ReadDir(codexDir)
	if err != nil {
		return nil
	}
	var snaps []string
	prefix := "config.toml.reck-pre-install-"
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if strings.HasPrefix(n, prefix) && strings.HasSuffix(n, ".bak") {
			snaps = append(snaps, n)
		}
	}
	if len(snaps) <= keep {
		return nil
	}
	sort.Strings(snaps) // unix-ts is sortable lexicographically
	excess := len(snaps) - keep
	for _, name := range snaps[:excess] {
		_ = os.Remove(filepath.Join(codexDir, name))
	}
	return nil
}

// writeShimIfChanged is the atomic shim writer (per-PID temp + rename).
func writeShimIfChanged(path string, content []byte) error {
	existing, err := os.ReadFile(path)
	if err == nil && bytes.Equal(existing, content) {
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

// hookCommandFor returns the canonical, shell-safe command string for
// one Reck-owned codex hook. Format mirrors the Claude installer:
//
//	/bin/bash '<shim>' <kind> # reck-codex-hook-v1
//
// The shim path is single-quoted so a $HOME containing spaces parses
// as one token. /bin/bash is absolute (PATH at hook-runtime is the
// user's shell PATH; a malicious ~/.local/bin/bash would otherwise
// hijack hooks).
func hookCommandFor(shimPath, kind string) string {
	return fmt.Sprintf("/bin/bash '%s' %s # %s",
		strings.ReplaceAll(shimPath, "'", `'\''`),
		kind,
		MarkerV1,
	)
}

// ensureFeatureFlag sets features.hooks=true ONLY if both `hooks`
// and the legacy `codex_hooks` are absent. Per D1: a user-set value
// is respected — and that respect extends across the codex 0.130
// rename. A `codex_hooks` left on disk by the user (not Reck) is
// treated as an expressed opinion on the hook system: if it's true,
// they wanted hooks on; if false, they wanted them off. Either way,
// don't add `hooks` and override their choice. The daemon's startup
// log surfaces a warning at the call site when the effective value
// is false.
//
// Returns true iff this call added the canonical `hooks` key (i.e.
// neither name was present). Used by EnsureInstalled to record
// ownership so Uninstall can strip the Reck-added flag.
//
// If `features` exists but isn't a table (e.g. user wrote
// `features = "broken"`), leave it alone. Codex would already reject
// such a config; we don't compound the error by overwriting.
//
// Codex 0.130 renamed the flag from `codex_hooks` to `hooks`. The
// migration of a Reck-owned legacy entry happens separately in
// `migrateLegacyFeatureFlag` (which strips it before this function
// runs) so the user-opinion check above can rely on a clean slate.
func ensureFeatureFlag(doc map[string]any) bool {
	if existing, present := doc["features"]; present {
		if _, ok := existing.(map[string]any); !ok {
			return false
		}
	}
	feats, _ := doc["features"].(map[string]any)
	if feats == nil {
		feats = map[string]any{}
	}
	if _, has := feats["hooks"]; has {
		doc["features"] = feats
		return false
	}
	if _, has := feats["codex_hooks"]; has {
		doc["features"] = feats
		return false
	}
	feats["hooks"] = true
	doc["features"] = feats
	return true
}

// migrateLegacyFeatureFlag strips a Reck-owned `features.codex_hooks`
// entry on disk before `ensureFeatureFlag` writes the new
// `features.hooks` key. Codex 0.130 deprecated `codex_hooks` and emits
// a TUI warning every spawn until the legacy key is gone.
//
// Only strips when:
//  1. The key exists.
//  2. Its value is still `true` — the exact value Reck wrote. A user
//     who flipped it to `false` between install and rename has
//     expressed an opinion; preserve it (mirrors the
//     stripReckOwnedFeatureFlag rule).
//  3. `addedByReck` says Reck owned the legacy flag.
//
// No-ops when `addedByReck=false` (the user wrote the legacy flag
// themselves; rewriting it is their call).
func migrateLegacyFeatureFlag(doc map[string]any, addedByReck bool) {
	if !addedByReck {
		return
	}
	feats, ok := doc["features"].(map[string]any)
	if !ok {
		return
	}
	v, has := feats["codex_hooks"]
	if !has {
		return
	}
	b, ok := v.(bool)
	if !ok || !b {
		return
	}
	delete(feats, "codex_hooks")
	if len(feats) == 0 {
		delete(doc, "features")
	} else {
		doc["features"] = feats
	}
}

// reckAddedFlagInPriorInstall implements the v1→v2 sidecar
// migration. Version 1 sidecars don't record ownership of the feature
// flag. To recover ownership for users upgrading past that schema, walk
// the oldest pre-install snapshot: if the flag was absent there (under
// EITHER the legacy `codex_hooks` name or the new `hooks` name), Reck
// added it on the first install. If the snapshot already had a flag
// under either name, the user owned it — decline.
//
// Conservative fallbacks (return false) for cases where ownership
// can't be proven:
//   - no snapshots at all (none ever written, or pre-rotated)
//   - snapshot rotation may have evicted the original (`len(snaps) ==
//     MaxSnapshots`) — the oldest preserved snapshot is not
//     necessarily the pre-Reck state, so its contents don't prove
//     ownership
//   - oldest snapshot is unreadable or unparseable
//   - oldest snapshot has a scalar `features = "..."` (matches
//     `ensureFeatureFlag`'s skip branch — that install couldn't
//     have added the key, so if the live config now has it, the user
//     wrote it)
//
// In each fallback case the legacy bug persists for that user but no
// user-owned flag is mistakenly stripped.
func reckAddedFlagInPriorInstall(codexDir string) bool {
	entries, err := os.ReadDir(codexDir)
	if err != nil {
		return false
	}
	var snaps []string
	prefix := "config.toml.reck-pre-install-"
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if strings.HasPrefix(n, prefix) && strings.HasSuffix(n, ".bak") {
			snaps = append(snaps, n)
		}
	}
	if len(snaps) == 0 || len(snaps) >= MaxSnapshots {
		return false
	}
	sort.Strings(snaps)
	raw, err := os.ReadFile(filepath.Join(codexDir, snaps[0]))
	if err != nil {
		return false
	}
	if len(raw) == 0 {
		// Empty oldest snapshot means the first install ran against an
		// empty config — Reck unambiguously added the flag.
		return true
	}
	var doc map[string]any
	if err := toml.Unmarshal(raw, &doc); err != nil {
		return false
	}
	feats, ok := doc["features"].(map[string]any)
	if !ok {
		// Either `features` is absent (Reck would have added the key
		// here on the earlier install) OR it's a scalar like
		// `features = "broken"` (ensureFeatureFlag returns
		// without touching the doc). Distinguish:
		if _, present := doc["features"]; present {
			return false
		}
		return true
	}
	_, hasLegacy := feats["codex_hooks"]
	_, hasNew := feats["hooks"]
	return !hasLegacy && !hasNew
}

// stripReckOwnedFeatureFlag removes `features.hooks` when the
// on-disk value is still `true` (the value Reck wrote post-rename).
// A user who flipped it to `false` between install and uninstall has
// expressed an opinion — preserve it. If `features` ends up empty
// after the strip, drop the table entirely so the rendered TOML has
// no empty `[features]` header.
//
// Legacy `features.codex_hooks` is intentionally NOT touched here:
// migrateLegacyFeatureFlag (run on every EnsureInstalled) already
// strips a Reck-owned legacy flag and replaces it with the canonical
// `hooks` key, so by uninstall time the only Reck-owned flag still on
// disk is `hooks`. A leftover `codex_hooks` at uninstall time means
// the user owns it (either set before Reck, or set after the
// rename); leaving it alone preserves their opinion.
func stripReckOwnedFeatureFlag(doc map[string]any) {
	feats, ok := doc["features"].(map[string]any)
	if !ok {
		return
	}
	v, has := feats["hooks"]
	if !has {
		return
	}
	b, ok := v.(bool)
	if !ok || !b {
		return
	}
	delete(feats, "hooks")
	if len(feats) == 0 {
		delete(doc, "features")
	} else {
		doc["features"] = feats
	}
}

// applyHooks mutates doc.hooks in place: strips prior Reck entries
// (exact-match canonical or sidecar-known) and appends a fresh
// MatcherGroup per binding. Other matcher groups under the same event
// — user-authored hooks — are left untouched. The `hooks.state` table
// (if present) is preserved verbatim because it lives under hooks but
// is not iterated here.
func applyHooks(doc map[string]any, shimPath string, owned map[string]bool) {
	if existing, present := doc["hooks"]; present {
		if _, ok := existing.(map[string]any); !ok {
			// User wrote `hooks = "broken"` (or similar). Codex would
			// reject this config; leaving it alone preserves the
			// original-key-and-value contract from D2.
			return
		}
	}
	hooks, _ := doc["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	for _, b := range bindings {
		canonical := hookCommandFor(shimPath, b.kind)
		kept := stripOwnedGroups(hooks[b.codexEvent], canonical, owned)
		// Per-event scalar collision: if the user wrote
		// `hooks.<Event> = "x"` (a scalar instead of a MatcherGroup
		// array), stripOwnedGroups returns nil. Leave that event
		// alone — overwriting with our fresh group would silently
		// drop the user's value.
		if kept == nil {
			if existing, has := hooks[b.codexEvent]; has {
				if _, ok := existing.([]any); !ok {
					if _, ok := existing.([]map[string]any); !ok {
						continue
					}
				}
			}
		}
		fresh := map[string]any{
			"hooks": []any{
				map[string]any{
					"type":    "command",
					"command": canonical,
				},
			},
		}
		hooks[b.codexEvent] = append(kept, fresh)
	}
	doc["hooks"] = hooks
}

// stripHooks removes every Reck-owned entry from doc.hooks. Matcher
// groups whose only inner hook was Reck-owned are dropped; events
// whose entire MatcherGroup list ends up empty are deleted; the
// hooks table itself is removed if it ends up empty. hooks.state and
// any user-authored matcher groups for the same events are preserved.
func stripHooks(doc map[string]any, shimPath string, owned map[string]bool) {
	hooks, _ := doc["hooks"].(map[string]any)
	if hooks == nil {
		return
	}
	for _, b := range bindings {
		canonical := hookCommandFor(shimPath, b.kind)
		kept := stripOwnedGroups(hooks[b.codexEvent], canonical, owned)
		if len(kept) == 0 {
			delete(hooks, b.codexEvent)
		} else {
			hooks[b.codexEvent] = kept
		}
	}
	if len(hooks) == 0 {
		delete(doc, "hooks")
	} else {
		doc["hooks"] = hooks
	}
}

// stripOwnedGroups walks `[[hooks.<Event>]]` (an array of MatcherGroups)
// and drops any inner-hook command that is Reck-owned. A MatcherGroup
// whose `hooks` array becomes empty is itself dropped — leaving an
// empty group in TOML is valid but produces a noisy diff for users.
// Other keys on the MatcherGroup (`matcher`, future fields) are
// preserved on the surviving inner-hook arrays.
func stripOwnedGroups(raw any, canonical string, owned map[string]bool) []any {
	list, _ := raw.([]any)
	out := make([]any, 0, len(list))
	for _, item := range list {
		grp, ok := item.(map[string]any)
		if !ok {
			out = append(out, item)
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

func isReckOwnedCommand(cmd, canonical string, owned map[string]bool) bool {
	if cmd == canonical {
		return true
	}
	if owned != nil && owned[cmd] {
		return true
	}
	return false
}
