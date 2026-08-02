package codexhooks

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

// readDoc parses ~/.codex/config.toml into a map for assertion.
func readDoc(t *testing.T, home string) map[string]any {
	t.Helper()
	p := PathsFor(home)
	raw, err := os.ReadFile(p.ConfigPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := toml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse: %v\n%s", err, raw)
	}
	return doc
}

// asAnyList turns BurntSushi's typed-table arrays (`[]map[string]any`)
// and our internal `[]any` into a single iterable slice. Test helper
// so assertions don't have to know which decoder produced the value.
func asAnyList(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case []map[string]any:
		out := make([]any, len(x))
		for i, m := range x {
			out[i] = m
		}
		return out
	}
	return nil
}

// countReckEntries walks hooks[event] and returns how many inner
// commands carry MarkerV1.
func countReckEntries(doc map[string]any, event string) int {
	hooks, _ := doc["hooks"].(map[string]any)
	if hooks == nil {
		return 0
	}
	list := asAnyList(hooks[event])
	n := 0
	for _, item := range list {
		grp, _ := item.(map[string]any)
		inner := asAnyList(grp["hooks"])
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, MarkerV1) {
				n++
			}
		}
	}
	return n
}

func TestEnsureInstalled_freshHome(t *testing.T) {
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)

	info, err := os.Stat(p.ShimPath)
	if err != nil {
		t.Fatalf("shim missing: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("shim not executable: %o", info.Mode().Perm())
	}

	doc := readDoc(t, home)
	if doc == nil {
		t.Fatal("config.toml missing after install")
	}
	for _, b := range bindings {
		if n := countReckEntries(doc, b.codexEvent); n != 1 {
			t.Errorf("%s: reck entries = %d, want 1", b.codexEvent, n)
		}
	}

	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["hooks"].(bool); !v {
		t.Errorf("features.hooks = %v, want true", feats["hooks"])
	}
	if _, has := feats["codex_hooks"]; has {
		t.Errorf("legacy features.codex_hooks should not be written on fresh install: %v", feats)
	}
}

func TestEnsureInstalled_idempotent(t *testing.T) {
	home := t.TempDir()
	for i := 0; i < 3; i++ {
		if err := EnsureInstalled(home); err != nil {
			t.Fatalf("install %d: %v", i, err)
		}
	}
	doc := readDoc(t, home)
	for _, b := range bindings {
		if n := countReckEntries(doc, b.codexEvent); n != 1 {
			t.Errorf("%s: reck entries = %d after 3 installs, want 1", b.codexEvent, n)
		}
	}
}

func TestEnsureInstalled_preservesUserState(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`model = "gpt-5.5"
approvals_reviewer = "user"

[projects."/some/project"]
trust_level = "trusted"

[plugins."github@curated"]
enabled = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "bash /opt/user/stop-notify.sh"
`)
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)

	if doc["model"] != "gpt-5.5" {
		t.Errorf("model lost or changed: %v", doc["model"])
	}
	if doc["approvals_reviewer"] != "user" {
		t.Errorf("approvals_reviewer lost: %v", doc["approvals_reviewer"])
	}
	projs, _ := doc["projects"].(map[string]any)
	if _, has := projs["/some/project"]; !has {
		t.Errorf("[projects.\"/some/project\"] dropped: %v", projs)
	}
	plugins, _ := doc["plugins"].(map[string]any)
	if _, has := plugins["github@curated"]; !has {
		t.Errorf("plugins entry dropped: %v", plugins)
	}

	// User Stop hook is preserved alongside the Reck Stop hook.
	hooks, _ := doc["hooks"].(map[string]any)
	stopList := asAnyList(hooks["Stop"])
	foundUser := false
	foundReck := false
	for _, item := range stopList {
		grp, _ := item.(map[string]any)
		inner := asAnyList(grp["hooks"])
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, "stop-notify.sh") {
				foundUser = true
			}
			if strings.Contains(cmd, MarkerV1) {
				foundReck = true
			}
		}
	}
	if !foundUser {
		t.Error("user Stop hook was stripped")
	}
	if !foundReck {
		t.Error("Reck Stop hook missing")
	}
}

func TestEnsureInstalled_respectsUserCodexHooksFalse(t *testing.T) {
	// D1: an explicit user setting (true OR false) is preserved, even
	// when it disables the hook system entirely. The daemon surfaces
	// a startup warning at the call site; this package just leaves it.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`[features]
codex_hooks = false
`)
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); v {
		t.Errorf("user-set codex_hooks=false was clobbered to true: %v", feats)
	}
}

func TestEnsureInstalled_respectsUserCodexHooksTrue(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`[features]
codex_hooks = true
other_flag = true
`)
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); !v {
		t.Errorf("codex_hooks not true: %v", feats)
	}
	if v, _ := feats["other_flag"].(bool); !v {
		t.Errorf("sibling feature flag dropped: %v", feats)
	}
}

func TestUninstall_leavesUserHooksAlone(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`model = "gpt-5.5"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "bash /opt/user/stop.sh"
`)
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}

	doc := readDoc(t, home)
	if doc["model"] != "gpt-5.5" {
		t.Errorf("model lost: %v", doc["model"])
	}
	for _, b := range bindings {
		if n := countReckEntries(doc, b.codexEvent); n != 0 {
			t.Errorf("%s: reck entries still present after uninstall: %d", b.codexEvent, n)
		}
	}
	// User Stop hook survives uninstall.
	hooks, _ := doc["hooks"].(map[string]any)
	stopList := asAnyList(hooks["Stop"])
	if len(stopList) != 1 {
		t.Fatalf("expected 1 Stop matcher group after uninstall, got %d: %v", len(stopList), stopList)
	}

	// Shim removed, sidecar gone.
	if _, err := os.Stat(p.ShimPath); !os.IsNotExist(err) {
		t.Errorf("shim still present: %v", err)
	}
	if _, err := os.Stat(p.OwnershipPath); !os.IsNotExist(err) {
		t.Errorf("sidecar still present: %v", err)
	}
}

func TestUninstall_stripsReckAddedFeaturesFlag(t *testing.T) {
	// Fresh config without [features] →
	// install → uninstall → no features.codex_hooks left behind, and
	// no empty [features] header. The flag was Reck-added; uninstall
	// must restore the byte-clean pre-install state.
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	if _, has := doc["features"]; has {
		t.Errorf("features table survived uninstall (Reck added it): %v", doc["features"])
	}
}

func TestUninstall_stripsReckAddedFeaturesFlag_afterReinstall(t *testing.T) {
	// Regression: re-running EnsureInstalled must preserve the sidecar
	// bit recorded on the FIRST install. Without the OR with priorAdded
	// in EnsureInstalled, the second install sees the flag already
	// present (because we wrote it on the first), ensureFeatureFlag
	// returns false, and the sidecar bit gets flipped to false — which
	// would make Uninstall preserve the residue instead of stripping it.
	home := t.TempDir()
	for i := 0; i < 3; i++ {
		if err := EnsureInstalled(home); err != nil {
			t.Fatalf("install %d: %v", i, err)
		}
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	if _, has := doc["features"]; has {
		t.Errorf("features table survived uninstall after re-install: %v", doc["features"])
	}
}

func TestUninstall_preservesUserSetFeaturesFlagFalse(t *testing.T) {
	// User-set features.codex_hooks=false →
	// install (no-op on the flag) → uninstall → flag still present
	// and false. User's opinion preserved.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte("[features]\ncodex_hooks = false\n")
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	v, has := feats["codex_hooks"]
	if !has {
		t.Fatalf("user-set codex_hooks=false dropped on uninstall: %v", doc)
	}
	if b, _ := v.(bool); b {
		t.Errorf("user-set codex_hooks=false flipped to true: %v", v)
	}
}

func TestUninstall_preservesUserSetFeaturesFlagTrue(t *testing.T) {
	// User independently set
	// features.codex_hooks=true → install (no-op on the flag) →
	// uninstall → flag still true. The sidecar records
	// addedByReck=false, so the strip path doesn't fire.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte("[features]\ncodex_hooks = true\nother_flag = true\n")
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); !v {
		t.Errorf("user-set codex_hooks=true dropped on uninstall: %v", feats)
	}
	if v, _ := feats["other_flag"].(bool); !v {
		t.Errorf("sibling feature flag dropped: %v", feats)
	}
}

func TestEnsureInstalled_migratesLegacySidecar_claimsOwnership(t *testing.T) {
	// Sidecar v1→v2 migration: a user who installed under the older
	// schema would have a v1 sidecar (no ownership bit)
	// and a config with `features.codex_hooks = true` that Reck added.
	// On the first post-fix install, the migration must consult the
	// oldest pre-install snapshot and — finding the flag absent there
	// — claim ownership so a subsequent uninstall strips it.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Simulate a v1-schema install's side-effects directly.
	// 1) Empty config before Reck ever ran (the "pre-install snapshot").
	emptySnap := filepath.Join(p.CodexDir, "config.toml.reck-pre-install-1000-1.bak")
	if err := os.WriteFile(emptySnap, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	// 2) Current config has the flag Reck added.
	cur := []byte("[features]\ncodex_hooks = true\n")
	if err := os.WriteFile(p.ConfigPath, cur, 0o600); err != nil {
		t.Fatal(err)
	}
	// 3) Legacy v1 sidecar: no features_flag_added_by_reck field.
	legacy := []byte(`{"version":1,"entries":["/bin/bash 'old' session_start # reck-codex-hook-v1"]}`)
	if err := os.WriteFile(p.OwnershipPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	if _, has := doc["features"]; has {
		t.Errorf("legacy-sidecar Reck-owned flag survived uninstall: %v", doc["features"])
	}
}

func TestEnsureInstalled_renamesLegacyFeatureFlagOnReinstall(t *testing.T) {
	// Codex 0.130 rename: a user upgrading past this fix who has a
	// Reck-owned `features.codex_hooks = true` (from a pre-rename
	// install) should see the legacy key stripped and the canonical
	// `features.hooks = true` written in its place on the next
	// EnsureInstalled. The ownership bit must carry across so a
	// later Uninstall still strips the flag.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-rename Reck install state: empty pre-install snapshot,
	// current config has the legacy flag, v2 sidecar already
	// records Reck ownership (the install that wrote codex_hooks
	// used the v2 schema).
	emptySnap := filepath.Join(p.CodexDir, "config.toml.reck-pre-install-1000-1.bak")
	if err := os.WriteFile(emptySnap, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	cur := []byte("[features]\ncodex_hooks = true\n")
	if err := os.WriteFile(p.ConfigPath, cur, 0o600); err != nil {
		t.Fatal(err)
	}
	v2sidecar := []byte(`{"version":2,"entries":["/bin/bash 'old' session_start # reck-codex-hook-v1"],"features_flag_added_by_reck":true}`)
	if err := os.WriteFile(p.OwnershipPath, v2sidecar, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if _, has := feats["codex_hooks"]; has {
		t.Errorf("Reck-owned legacy codex_hooks should have been migrated away: %v", feats)
	}
	if v, _ := feats["hooks"].(bool); !v {
		t.Errorf("canonical hooks=true should have been written: %v", feats)
	}

	// Uninstall must still strip — ownership bit carried through migration.
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc = readDoc(t, home)
	if _, has := doc["features"]; has {
		t.Errorf("features survived uninstall after rename migration: %v", doc["features"])
	}
}

func TestEnsureInstalled_doesNotMigrateUserOwnedLegacyFlag(t *testing.T) {
	// Symmetric to the migration test: if the legacy codex_hooks was
	// set by the user (snapshot already had it), don't strip it on
	// the rename pass. Reck also leaves `hooks` alone — adding it
	// would override the user's expressed opinion on the hook system
	// under the legacy name.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	userSnap := []byte("[features]\ncodex_hooks = true\n")
	if err := os.WriteFile(filepath.Join(p.CodexDir, "config.toml.reck-pre-install-1000-1.bak"), userSnap, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, userSnap, 0o600); err != nil {
		t.Fatal(err)
	}
	v2sidecar := []byte(`{"version":2,"entries":[],"features_flag_added_by_reck":false}`)
	if err := os.WriteFile(p.OwnershipPath, v2sidecar, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); !v {
		t.Errorf("user-owned legacy codex_hooks=true was stripped: %v", feats)
	}
	if _, has := feats["hooks"]; has {
		t.Errorf("hooks should not be added when user expressed an opinion via legacy key: %v", feats)
	}
}

func TestEnsureInstalled_migratesLegacySidecar_declinesUserOwnedFlag(t *testing.T) {
	// Migration must NOT false-positive on a legacy sidecar when the
	// oldest snapshot shows the user already had the flag before Reck.
	// In that case, the user owns it — leave alone on uninstall.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Oldest snapshot already contains the flag (user-set before Reck).
	userSnap := []byte("[features]\ncodex_hooks = true\n")
	snapPath := filepath.Join(p.CodexDir, "config.toml.reck-pre-install-1000-1.bak")
	if err := os.WriteFile(snapPath, userSnap, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, userSnap, 0o600); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"version":1,"entries":[]}`)
	if err := os.WriteFile(p.OwnershipPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); !v {
		t.Errorf("user-owned legacy flag was stripped by migration: %v", feats)
	}
}

func TestEnsureInstalled_migratesLegacySidecar_declinesOnScalarFeatures(t *testing.T) {
	// A malformed scalar `features = "..."` in the oldest snapshot
	// means ensureFeatureFlag would NOT
	// have added the codex_hooks key (the scalar branch returns
	// early). So if the live config now has `features.codex_hooks`,
	// the user wrote it post-Reck. Migration must decline.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	snap := []byte("features = \"broken-on-purpose\"\nmodel = \"gpt-5.5\"\n")
	if err := os.WriteFile(filepath.Join(p.CodexDir, "config.toml.reck-pre-install-1000-1.bak"), snap, 0o600); err != nil {
		t.Fatal(err)
	}
	cur := []byte("[features]\ncodex_hooks = true\nmodel = \"gpt-5.5\"\n")
	if err := os.WriteFile(p.ConfigPath, cur, 0o600); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"version":1,"entries":[]}`)
	if err := os.WriteFile(p.OwnershipPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); !v {
		t.Errorf("user-set codex_hooks=true (after fixing scalar) was stripped by migration: %v", feats)
	}
}

func TestEnsureInstalled_migratesLegacySidecar_declinesWhenRotated(t *testing.T) {
	// Claude review finding: if snapshot rotation may have evicted the
	// original pre-Reck snapshot (len(snaps) >= MaxSnapshots), we can't
	// prove ownership from the oldest preserved snapshot — it might be
	// post-Reck state. Migration must decline. Acceptance trades a
	// persistent cosmetic residue for a false-positive-free strip.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// MaxSnapshots snapshots, none containing the flag — without the
	// rotation guard, the oldest would falsely indicate Reck added the
	// flag. With the guard, migration declines.
	for i := 0; i < MaxSnapshots; i++ {
		name := filepath.Join(p.CodexDir, fmt.Sprintf("config.toml.reck-pre-install-%d-1.bak", 1000+i))
		if err := os.WriteFile(name, []byte("model = \"gpt-5.5\"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// User added flag themselves after rotation evicted any original snapshot.
	cur := []byte("[features]\ncodex_hooks = true\nmodel = \"gpt-5.5\"\n")
	if err := os.WriteFile(p.ConfigPath, cur, 0o600); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"version":1,"entries":[]}`)
	if err := os.WriteFile(p.OwnershipPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["codex_hooks"].(bool); !v {
		t.Errorf("post-rotation migration stripped a possibly-user-owned flag: %v", feats)
	}
}

func TestUninstall_preservesUserFlippedFeaturesFlag(t *testing.T) {
	// Reck added codex_hooks=true on install; user then flipped it to
	// false between install and uninstall. Uninstall must respect the
	// user's flip and leave the key as-is — even though the sidecar
	// records addedByReck=true, the on-disk value no longer matches
	// what Reck wrote.
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)
	// User flips the flag manually.
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	feats["codex_hooks"] = false
	doc["features"] = feats
	out, err := encodeConfig(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, out, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	got := readDoc(t, home)
	gf, _ := got["features"].(map[string]any)
	v, has := gf["codex_hooks"]
	if !has {
		t.Fatalf("user-flipped codex_hooks=false dropped on uninstall: %v", got)
	}
	if b, _ := v.(bool); b {
		t.Errorf("user-flipped codex_hooks=false coerced to true: %v", v)
	}
}

func TestSidecar_strippedAcrossShimPathChange(t *testing.T) {
	// If the shim path changes between installs (e.g. $HOME moves),
	// the sidecar's record of the old command must let the next
	// install strip it cleanly. Same contract the Claude installer
	// relies on.
	home := t.TempDir()
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	p := PathsFor(home)
	// Read sidecar, swap the canonical commands to point at a stale
	// shim path, write the doc with those stale commands, then re-run
	// EnsureInstalled and assert the stale entries are gone.
	owned, addedByReck, _, err := loadOwnership(p.OwnershipPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(owned) != len(bindings) {
		t.Fatalf("sidecar should record %d entries, got %d", len(bindings), len(owned))
	}
	// Inject a stale entry directly: pretend the sidecar already has
	// a command that points at an old shim path. Re-install should
	// produce the canonical command and not duplicate.
	stale := "/bin/bash '/old/path/reck-codex-hook.sh' session_start # " + MarkerV1
	owned[stale] = true
	staleEntries := make([]string, 0, len(owned))
	for k := range owned {
		staleEntries = append(staleEntries, k)
	}
	sort.Strings(staleEntries)
	if err := writeOwnership(p.OwnershipPath, staleEntries, addedByReck); err != nil {
		t.Fatal(err)
	}

	// Manually inject the stale command into config.toml so the next
	// install has something to strip via sidecar lookup.
	doc := readDoc(t, home)
	hooks, _ := doc["hooks"].(map[string]any)
	ssList := asAnyList(hooks["SessionStart"])
	ssList = append(ssList, map[string]any{
		"hooks": []any{
			map[string]any{"type": "command", "command": stale},
		},
	})
	hooks["SessionStart"] = ssList
	doc["hooks"] = hooks
	out, err := encodeConfig(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, out, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	got := readDoc(t, home)
	if n := countReckEntries(got, "SessionStart"); n != 1 {
		t.Errorf("expected 1 reck SessionStart entry after stale-cleanup, got %d", n)
	}
	// Stale command should not appear anywhere.
	hooks2, _ := got["hooks"].(map[string]any)
	for _, item := range asAnyList(hooks2["SessionStart"]) {
		grp, _ := item.(map[string]any)
		for _, h := range asAnyList(grp["hooks"]) {
			hm, _ := h.(map[string]any)
			if hm["command"] == stale {
				t.Errorf("stale entry survived re-install: %v", stale)
			}
		}
	}
}

func TestSnapshot_writtenAndRotated(t *testing.T) {
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, []byte("model = \"gpt-5.5\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxSnapshots+3; i++ {
		if err := EnsureInstalled(home); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(p.CodexDir)
	if err != nil {
		t.Fatal(err)
	}
	snaps := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "config.toml.reck-pre-install-") &&
			strings.HasSuffix(e.Name(), ".bak") {
			snaps++
		}
	}
	if snaps == 0 {
		t.Fatal("no snapshots written")
	}
	if snaps > MaxSnapshots {
		t.Errorf("snapshot count = %d, expected <= %d (rotation broken)", snaps, MaxSnapshots)
	}
}

func TestSnapshot_skippedOnFreshInstall(t *testing.T) {
	// No prior config.toml ⇒ nothing to snapshot. The first install
	// is creating the file, not mutating it.
	home := t.TempDir()
	p := PathsFor(home)
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(p.CodexDir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "config.toml.reck-pre-install-") {
			t.Errorf("unexpected snapshot on fresh install: %s", e.Name())
		}
	}
}

func TestRoundTrip_realFixturePreservesEverything(t *testing.T) {
	// A redacted copy of a real-world config. The round-trip MUST
	// preserve every top-level key; preservation is non-negotiable.
	// Comments are allowed to vanish.
	raw, err := os.ReadFile(filepath.Join("testdata", "fixture-real.toml.txt"))
	if err != nil {
		t.Fatal(err)
	}
	// Capture the set of top-level keys before installation.
	var before map[string]any
	if err := toml.Unmarshal(raw, &before); err != nil {
		t.Fatal(err)
	}
	wantKeys := keysOf(before)

	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	got := readDoc(t, home)
	gotKeys := keysOf(got)

	for _, k := range wantKeys {
		if !contains(gotKeys, k) {
			t.Errorf("top-level key dropped: %q (got: %v)", k, gotKeys)
		}
	}
	// `${HOME}` placeholder must round-trip verbatim — the fixture's
	// header documents this. Encoders that interpret ${} would corrupt
	// the projects path.
	projs, _ := got["projects"].(map[string]any)
	foundHomeKey := false
	for k := range projs {
		if strings.Contains(k, "${HOME}") {
			foundHomeKey = true
			break
		}
	}
	if !foundHomeKey {
		t.Errorf("${HOME} placeholder lost from [projects.*] keys: %v", projs)
	}
}

func TestEmptyFixture_roundTrips(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "fixture-fresh.toml.txt"))
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	feats, _ := doc["features"].(map[string]any)
	if v, _ := feats["hooks"].(bool); !v {
		t.Errorf("empty input should get hooks=true; got %v", feats)
	}
	for _, b := range bindings {
		if n := countReckEntries(doc, b.codexEvent); n != 1 {
			t.Errorf("%s: reck entries = %d, want 1", b.codexEvent, n)
		}
	}
}

func TestEnsureInstalled_preservesScalarFeaturesValue(t *testing.T) {
	// If a user has a malformed `features = "x"` (scalar instead of
	// table), Codex will reject the config either way. The installer
	// must not silently overwrite the user's value with a fresh
	// `[features]` table — that would mask the original error and
	// drop user data on disk.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`features = "broken-on-purpose"
model = "gpt-5.5"
`)
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	if got := doc["features"]; got != "broken-on-purpose" {
		t.Errorf("scalar features value clobbered: got %v", got)
	}
}

func TestEnsureInstalled_preservesScalarHooksValue(t *testing.T) {
	// Same shape for `hooks = "x"`: the package must not overwrite
	// the user's malformed scalar with our [hooks] table.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`hooks = "user-was-typing"
model = "gpt-5.5"
`)
	if err := os.WriteFile(p.ConfigPath, prior, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	doc := readDoc(t, home)
	if got := doc["hooks"]; got != "user-was-typing" {
		t.Errorf("scalar hooks value clobbered: got %v", got)
	}
}

func TestSnapshot_distinctNamesWithinSameSecond(t *testing.T) {
	// Two installs that mutate the file within the same wall-clock
	// second must produce two distinct snapshots — otherwise the
	// rollback path silently loses one of the prior states. UnixNano
	// + PID guarantees uniqueness.
	home := t.TempDir()
	p := PathsFor(home)
	if err := os.MkdirAll(p.CodexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, []byte(`model = "v1"`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigPath, []byte(`model = "v2"`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureInstalled(home); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(p.CodexDir)
	if err != nil {
		t.Fatal(err)
	}
	snaps := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "config.toml.reck-pre-install-") &&
			strings.HasSuffix(e.Name(), ".bak") {
			snaps++
		}
	}
	if snaps < 2 {
		t.Errorf("expected ≥2 distinct snapshots from rapid back-to-back installs, got %d", snaps)
	}
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
