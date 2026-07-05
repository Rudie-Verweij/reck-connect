package pty

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
)

// newManagerWithStore constructs a Manager + sessions.Store rooted in
// t.TempDir, plus a fake $HOME for the Claude transcript dir. Returns
// the manager, store, and the project cwd so tests can populate
// orphan entries that reference it.
func newManagerWithStore(t *testing.T) (*Manager, *sessions.Store, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/echo"},
		configPath,
		store,
	)
	return mgr, store, dir
}

// writeFakeTranscript creates an empty JSONL file at the path
// sessions.List uses to filter-out gone Claude transcripts.
func writeFakeTranscript(t *testing.T, projectCwd, sessionID string) {
	t.Helper()
	home, _ := os.UserHomeDir()
	transcriptDir := filepath.Join(home, ".claude", "projects", sessions.EncodeCwd(projectCwd))
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(transcriptDir, sessionID+".jsonl"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreOrphans_respawnsClaudeAndShellOrphans(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	// Claude orphan: WasLive=true, no live pane, transcript on disk.
	claudeID := sessions.NewUUID()
	writeFakeTranscript(t, projectCwd, claudeID)
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    claudeID,
		Name:         "claude-orphan",
		Cwd:          projectCwd,
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_ghost_claude",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	// Shell orphan: WasLive=true, no live pane, has stored argv.
	shellSlot := sessions.NewUUID()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       shellSlot,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_ghost_shell",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 2 {
		t.Fatalf("Restored = %d, want 2 (claude + shell). full=%+v", r.Restored, r)
	}
	if r.Failed != 0 || r.Skipped != 0 {
		t.Errorf("unexpected failures/skips: %+v", r)
	}

	// Both panes now in the live set.
	live := mgr.PanesInProject("p1")
	if len(live) != 2 {
		t.Fatalf("PanesInProject = %d panes, want 2", len(live))
	}
	seenClaude, seenShell := false, false
	for _, p := range live {
		switch p.Kind {
		case proto.PaneKindClaude:
			seenClaude = true
			if p.SessionID != claudeID {
				t.Errorf("respawned claude SessionID = %q, want %q", p.SessionID, claudeID)
			}
		case proto.PaneKindShell:
			seenShell = true
			if p.SlotID != shellSlot {
				t.Errorf("respawned shell SlotID = %q, want %q", p.SlotID, shellSlot)
			}
		}
	}
	if !seenClaude || !seenShell {
		t.Errorf("missing kind: claude=%v shell=%v", seenClaude, seenShell)
	}

	// Cleanup: drop the panes so t.TempDir teardown isn't racing
	// touch goroutines.
	for _, p := range live {
		_ = mgr.DeletePane("p1", p.ID)
	}
	time.Sleep(50 * time.Millisecond)
}

func TestRestoreOrphans_ignoresEntriesAlreadyLive(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	// Spawn a fresh shell pane; its entry is WasLive=true and bound to
	// the live pane ID. RestoreOrphans should leave it untouched.
	pane, err := mgr.CreatePane("p1", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}

	// Sanity: the entry exists post-spawn.
	if _, ok, err := store.Get("p1", pane.SlotID); err != nil || !ok {
		t.Fatalf("entry missing for slot %s: ok=%v err=%v", pane.SlotID, ok, err)
	}
	_ = projectCwd

	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 0 {
		t.Errorf("Restored = %d, want 0 (entry is already live)", r.Restored)
	}
	if got := len(mgr.PanesInProject("p1")); got != 1 {
		t.Errorf("pane count = %d, want 1", got)
	}

	// Tear down synchronously + wait for the OnExit Touch goroutine
	// so t.TempDir's RemoveAll doesn't race the sessions.json
	// rewrite. Same pattern as TestCreatePane_shellHasSlotIDNotSessionID.
	if err := mgr.DeletePane("p1", pane.ID); err != nil {
		t.Fatalf("DeletePane: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
}

func TestRestoreOrphans_skipsEntriesWithEmptyLastPaneID(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	// LastPaneID empty: pane was never bound. Same drive-by guard as
	// /restore-candidates — shouldn't be respawned.
	now := time.Now().UTC()
	slot := sessions.NewUUID()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 0 {
		t.Errorf("Restored = %d, want 0", r.Restored)
	}
	if got := len(mgr.PanesInProject("p1")); got != 0 {
		t.Errorf("pane count = %d, want 0", got)
	}
}

func TestRestoreOrphans_skipsGracefullyClosedEntries(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	// WasLive=false → user gracefully closed. Don't respawn.
	now := time.Now().UTC()
	slot := sessions.NewUUID()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_was_closed",
		WasLive:      false,
	}); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 0 {
		t.Errorf("Restored = %d, want 0 (entry was gracefully closed)", r.Restored)
	}
}

func TestRestoreOrphans_clearsWasLiveOnRespawnFailure(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	// Shell entry whose argv points at a non-existent binary. Respawn
	// will fail; RestoreOrphans should clear WasLive so subsequent
	// boots don't keep retrying.
	now := time.Now().UTC()
	slot := sessions.NewUUID()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/nonexistent/binary/that/should/not/exist"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_will_fail",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreOrphans(80, 24)
	if r.Failed == 0 {
		t.Logf("respawn unexpectedly succeeded; result=%+v", r)
		// Fall through anyway — even on success, WasLive stays true,
		// which is the existing CreatePaneWith semantics. The test
		// only matters when respawn fails.
		return
	}

	// WasLive should be cleared.
	e, ok, err := store.Get("p1", slot)
	if err != nil || !ok {
		t.Fatalf("entry missing post-restore: ok=%v err=%v", ok, err)
	}
	if e.WasLive {
		t.Errorf("WasLive should be cleared after failed respawn; entry=%+v", e)
	}
}

func TestIsWithinProject(t *testing.T) {
	sep := string(filepath.Separator)
	cases := []struct {
		cwd, root string
		want      bool
	}{
		{"/home/u/proj", "/home/u/proj", true},                                         // equal
		{"/home/u/proj" + sep + ".claude-worktrees" + sep + "x", "/home/u/proj", true}, // worktree descendant
		{"/home/u/proj/sub/deep", "/home/u/proj", true},                                // nested descendant
		{"/home/u/other", "/home/u/proj", false},                                       // unrelated sibling
		{"/home/u/projX", "/home/u/proj", false},                                       // shared-prefix, NOT a descendant
		{"/home/u", "/home/u/proj", false},                                             // parent
		{"/home/u/proj/", "/home/u/proj", true},                                        // trailing slash normalises
	}
	for _, c := range cases {
		if got := isWithinProject(c.cwd, c.root); got != c.want {
			t.Errorf("isWithinProject(%q, %q) = %v, want %v", c.cwd, c.root, got, c.want)
		}
	}
}

// TestRestoreProjectOrphans_selfHealedWorktreeCwdSurvivesGuard — #56: after the
// resume path self-heals a worktree session's cwd to the worktree (a descendant
// of the project root), a subsequent restore must NOT treat that as a
// cwd-mismatch. The relaxed guard allows descendants, so the entry is respawned
// rather than skipped + was_live-cleared.
func TestRestoreProjectOrphans_selfHealedWorktreeCwdSurvivesGuard(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	worktreeCwd := filepath.Join(projectCwd, ".claude-worktrees", "feat")
	if err := os.MkdirAll(worktreeCwd, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	writeFakeTranscript(t, worktreeCwd, sid) // transcript at the worktree's canonical folder
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    sid,
		Name:         "p1/wt",
		Cwd:          worktreeCwd, // already self-healed to the worktree
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_old",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreProjectOrphans("p1", projectCwd, 80, 24)
	if r.Restored != 1 || r.Skipped != 0 {
		t.Fatalf("restore = %+v, want a descendant-cwd worktree session respawned (Restored=1, Skipped=0)", r)
	}
}

// TestRestoreProjectOrphans_gitUnconfirmedKeptReadOnly — #56: a worktree
// session whose transcript is intact but whose worktree set git can't confirm
// (here the project isn't a git repo, so `git worktree list` fails) must NOT be
// relocated + respawned — a transient git failure must not strand a live
// worktree session. Restore keeps it read-only: clears was_live, counts it
// read-only, leaves the transcript untouched and viewable.
func TestRestoreProjectOrphans_gitUnconfirmedKeptReadOnly(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t) // projectCwd is not a git repo → git fails

	// Transcript under a worktree-suffixed folder with no live worktree.
	home, _ := os.UserHomeDir()
	gone := filepath.Join(home, ".claude", "projects", sessions.EncodeCwd(projectCwd)+"--claude-worktrees-removed")
	if err := os.MkdirAll(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	if err := os.WriteFile(filepath.Join(gone, sid+".jsonl"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindClaude,
		SessionID:    sid,
		Name:         "p1/gone",
		Cwd:          projectCwd,
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_old",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreProjectOrphans("p1", projectCwd, 80, 24)
	if r.ReadOnly != 1 || r.Restored != 0 {
		t.Fatalf("restore = %+v, want deleted-worktree session kept read-only (ReadOnly=1, Restored=0)", r)
	}
	if len(mgr.PanesInProject("p1")) != 0 {
		t.Errorf("expected no pane spawned for a deleted-worktree session")
	}
	e, ok, err := store.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("entry missing post-restore: ok=%v err=%v", ok, err)
	}
	if e.WasLive {
		t.Errorf("WasLive should be cleared for a read-only (deleted-worktree) session; entry=%+v", e)
	}
}

// TestRestoreProjectOrphans_goneWorktreeMigratesAndResumes — #56, the "jerry"
// case at the auto-restore layer: the project is a git repo, the session's
// worktree was removed (git lists no match), but its transcript survives. On
// restart the daemon relocates the transcript into the project-root folder and
// resumes it (Restored, not ReadOnly) — the session comes back live with its
// history and keeps was_live.
func TestRestoreProjectOrphans_goneWorktreeMigratesAndResumes(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	root := filepath.Join(dir, "proj")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, root, "init", "-q") // real repo, no matching worktree
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	claudeDir := filepath.Join(dir, "claude-projects")
	gone := filepath.Join(claudeDir, sessions.EncodeCwd(root)+"--claude-worktrees-removed")
	if err := os.MkdirAll(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := sessions.NewUUID()
	orphan := filepath.Join(gone, sid+".jsonl")
	if err := os.WriteFile(orphan, []byte(`{"type":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind: proto.PaneKindClaude, SessionID: sid, Name: "p1/jerry", Cwd: root,
		CreatedAt: now, LastActiveAt: now, LastPaneID: "p_old", WasLive: true,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := NewManagerFromConfig(ManagerConfig{
		Projects:          []config.Project{{ID: "p1", Name: "P1", Cwd: root, Shell: []string{"/bin/sh"}}},
		ClaudeCmd:         []string{"/bin/echo"},
		ConfigPath:        configPath,
		Sessions:          store,
		ClaudeProjectsDir: claudeDir,
	})

	r := mgr.RestoreProjectOrphans("p1", root, 80, 24)
	if r.Restored != 1 || r.ReadOnly != 0 {
		t.Fatalf("restore = %+v, want gone-worktree session migrated + resumed (Restored=1, ReadOnly=0)", r)
	}
	if _, err := os.Stat(sessions.TranscriptPath(claudeDir, root, sid)); err != nil {
		t.Errorf("transcript not relocated to project root: %v", err)
	}
	e, ok, err := store.Get("p1", sid)
	if err != nil || !ok {
		t.Fatalf("entry missing post-restore: ok=%v err=%v", ok, err)
	}
	if !e.WasLive {
		t.Errorf("WasLive should remain true for a resumed session; entry=%+v", e)
	}
	for _, p := range mgr.PanesInProject("p1") {
		_ = mgr.DeletePane("p1", p.ID)
	}
	time.Sleep(50 * time.Millisecond)
}

func TestRestoreOrphans_emptyStoreNoop(t *testing.T) {
	mgr, _, _ := newManagerWithStore(t)
	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 0 || r.Failed != 0 || r.Skipped != 0 {
		t.Errorf("empty store run = %+v, want all zeros", r)
	}
}

// TestRestoreOrphans_skipsRowsWithEmptyIdentity locks in the guard
// against corrupt rows where both SessionID and SlotID are missing.
// Without the guard, CreatePaneWith would fall through to a fresh-
// spawn path (empty ResumeSessionID/RestoreSlotID means "no resume
// requested"), manufacturing a brand-new pane on every boot.
func TestRestoreOrphans_skipsRowsWithEmptyIdentity(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)

	// We can't go through Upsert because Upsert rejects entries with
	// no identity ("session_id required for claude entry"). Hand-build
	// the on-disk file instead — this represents a corrupt row that a
	// future bug might write, exactly the case the guard exists for.
	now := time.Now().UTC()
	corrupt := struct {
		Entries []sessions.Entry `json:"entries"`
	}{
		Entries: []sessions.Entry{{
			Kind:         proto.PaneKindShell,
			Cwd:          projectCwd,
			ShellArgv:    []string{"/bin/sh"},
			CreatedAt:    now,
			LastActiveAt: now,
			LastPaneID:   "p_corrupt",
			WasLive:      true,
			// Both SessionID and SlotID intentionally empty.
		}},
	}
	raw, err := json.Marshal(corrupt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Dir(), "p1.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	r := mgr.RestoreOrphans(80, 24)
	if r.Restored != 0 {
		t.Errorf("Restored = %d, want 0 — corrupt row should never spawn", r.Restored)
	}
	if r.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1", r.Skipped)
	}
	if got := len(mgr.PanesInProject("p1")); got != 0 {
		t.Errorf("pane count = %d, want 0 (no fresh-spawn on corrupt row)", got)
	}
}

// TestReplaceProjects_restoresOrphansForNewlyAddedProjects locks in
// the hybrid-mode hot-add restore path. RestoreOrphans at boot only
// walks projects already in the static registry; a project pushed
// later via PUT /projects (e.g. a station-resident hybrid project
// not present in local projects.toml) used to leave its WasLive
// entries dangling until a daemon restart that included it
// statically — Satellite quit/reopen cycles meanwhile lost the user's
// pane silently.
func TestReplaceProjects_restoresOrphansForNewlyAddedProjects(t *testing.T) {
	mgr, store, _ := newManagerWithStore(t)
	home, _ := os.UserHomeDir()
	// PUT /projects validates cwd lives under PermittedProjectPrefix
	// ($HOME/reck/projects/ by default) — the static-config p1 cwd
	// uses the temp dir directly, but pushed entries must respect the
	// prefix gate.
	p1cwd := filepath.Join(home, "reck", "projects", "p1")
	p2cwd := filepath.Join(home, "reck", "projects", "p2")
	for _, d := range []string{p1cwd, p2cwd} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// Orphan for project "p2" — NOT in the static config the manager
	// was constructed with. Boot-time RestoreOrphans should ignore it.
	shellSlot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p2", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       shellSlot,
		Cwd:          p2cwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_ghost_p2",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	// Sanity: boot-path restore is a no-op for an unregistered project.
	if r := mgr.RestoreOrphans(80, 24); r.Restored != 0 {
		t.Fatalf("boot RestoreOrphans = %+v; expected 0 restored (p2 unregistered)", r)
	}
	if got := len(mgr.PanesInProject("p2")); got != 0 {
		t.Fatalf("PanesInProject(p2) before push = %d, want 0", got)
	}

	// PUT /projects-style push that registers p2 alongside the existing
	// p1. The new ReplaceProjects hook should drain p2's orphans after
	// the in-memory map flips.
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{
		{ID: "p1", Cwd: p1cwd},
		{ID: "p2", Cwd: p2cwd},
	}); err != nil {
		t.Fatalf("ReplaceProjects: %v", err)
	}

	live := mgr.PanesInProject("p2")
	if len(live) != 1 {
		t.Fatalf("p2 panes after push = %d, want 1 (restored from sessions store)", len(live))
	}
	if live[0].SlotID != shellSlot {
		t.Errorf("respawned shell SlotID = %q, want %q", live[0].SlotID, shellSlot)
	}

	// Cleanup so t.TempDir teardown isn't racing pane goroutines.
	for _, p := range live {
		_ = mgr.DeletePane("p2", p.ID)
	}
	time.Sleep(50 * time.Millisecond)
}

// TestReplaceProjects_doesNotReRestorePreExistingProjects guards
// against accidental double-restore: if a project was already
// registered before the push, the hook should NOT fire for it. Probe
// is a SECOND orphan entry inserted between boot-restore and re-push
// — if the hook misfires we'd see a respawn of that fresh orphan,
// pushing pane count to 2.
func TestReplaceProjects_doesNotReRestorePreExistingProjects(t *testing.T) {
	mgr, store, projectCwd := newManagerWithStore(t)
	home, _ := os.UserHomeDir()
	// Push payload needs a prefix-compliant cwd; the static-config
	// p1 cwd (the temp dir) doesn't satisfy the gate but that's fine —
	// PUT semantics replace, so we hand a fresh path under the prefix.
	p1pushCwd := filepath.Join(home, "reck", "projects", "p1")
	if err := os.MkdirAll(p1pushCwd, 0o755); err != nil {
		t.Fatal(err)
	}

	// Boot-restorable orphan #1 for p1.
	slot1 := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot1,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_ghost_1",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	// Drain at boot — produces one live pane for p1.
	if r := mgr.RestoreOrphans(80, 24); r.Restored != 1 {
		t.Fatalf("boot restore = %+v, want 1 restored", r)
	}
	if got := len(mgr.PanesInProject("p1")); got != 1 {
		t.Fatalf("p1 pane count after boot = %d, want 1", got)
	}

	// Probe orphan #2: was_live=true, NO live pane backing it. If
	// the post-replace hook misfires on the pre-existing p1, this row
	// gets respawned and pane count ticks to 2.
	slot2 := sessions.NewUUID()
	if err := store.Upsert("p1", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot2,
		Cwd:          projectCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_ghost_2",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	// Push the same project. The hook MUST NOT fire for p1 (it's
	// pre-existing). Probe orphan #2 should remain orphaned.
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{
		{ID: "p1", Cwd: p1pushCwd},
	}); err != nil {
		t.Fatalf("ReplaceProjects: %v", err)
	}
	if got := len(mgr.PanesInProject("p1")); got != 1 {
		t.Errorf("p1 pane count after re-push = %d, want 1 (probe orphan must NOT respawn)", got)
	}
	probe, ok, gerr := store.Get("p1", slot2)
	if gerr != nil || !ok {
		t.Fatalf("probe entry lookup: ok=%v err=%v", ok, gerr)
	}
	if !probe.WasLive {
		t.Errorf("probe entry was_live = false; expected true (hook must not have touched it)")
	}

	for _, p := range mgr.PanesInProject("p1") {
		_ = mgr.DeletePane("p1", p.ID)
	}
	time.Sleep(50 * time.Millisecond)
}

// TestReplaceProjects_skipsCwdMismatchOnHotAdd guards against project
// ID reuse via PUT /projects (Codex adversarial review finding). The
// sessions store carries an orphan whose stored Cwd no longer matches
// the cwd the project is being registered with — respawning it under
// the new registration would point a stale pane at unrelated state.
// The hot-add restore must skip + clear was_live so the row stops
// resurfacing.
func TestReplaceProjects_skipsCwdMismatchOnHotAdd(t *testing.T) {
	mgr, store, _ := newManagerWithStore(t)
	home, _ := os.UserHomeDir()

	// Two cwds under the permitted prefix. The orphan was minted under
	// oldCwd; the new PUT registers the same project ID under newCwd.
	oldCwd := filepath.Join(home, "reck", "projects", "p2-old")
	newCwd := filepath.Join(home, "reck", "projects", "p2-new")
	for _, d := range []string{oldCwd, newCwd} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	slot := sessions.NewUUID()
	now := time.Now().UTC()
	if err := store.Upsert("p2", sessions.Entry{
		Kind:         proto.PaneKindShell,
		SlotID:       slot,
		Cwd:          oldCwd,
		ShellArgv:    []string{"/bin/sh"},
		CreatedAt:    now,
		LastActiveAt: now,
		LastPaneID:   "p_ghost_p2_old",
		WasLive:      true,
	}); err != nil {
		t.Fatal(err)
	}

	// Push p2 with a DIFFERENT cwd than the orphan stores.
	if err := mgr.ReplaceProjects([]ReplaceProjectsInput{
		{ID: "p1", Cwd: filepath.Join(home, "reck", "projects", "p1")},
		{ID: "p2", Cwd: newCwd},
	}); err != nil {
		// p1's cwd dir doesn't exist — that's fine, ReplaceProjects
		// registers it as Available=false but doesn't reject.
		// Let the call surface other errors.
		t.Fatalf("ReplaceProjects: %v", err)
	}

	// Cwd mismatch → skipped, NOT respawned.
	if got := len(mgr.PanesInProject("p2")); got != 0 {
		t.Errorf("p2 pane count after mismatched-cwd push = %d, want 0 (orphan must be skipped)", got)
	}
	// was_live cleared so the row stops haunting future runs.
	got, ok, gerr := store.Get("p2", slot)
	if gerr != nil || !ok {
		t.Fatalf("entry lookup: ok=%v err=%v", ok, gerr)
	}
	if got.WasLive {
		t.Errorf("entry was_live = true after cwd-mismatch skip; want false (cleared)")
	}
}
