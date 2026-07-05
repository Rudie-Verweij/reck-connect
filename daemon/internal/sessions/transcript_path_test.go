package sessions

import (
	"path/filepath"
	"testing"
)

func TestTranscriptPath(t *testing.T) {
	got := TranscriptPath("/root/claude-projects", "/home/user/projects/my app", "abc-123")
	want := filepath.Join("/root/claude-projects", "-home-user-projects-my-app", "abc-123.jsonl")
	if got != want {
		t.Fatalf("TranscriptPath = %q, want %q", got, want)
	}
}

func TestDefaultClaudeProjectsDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	got, err := DefaultClaudeProjectsDir()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".claude", "projects")
	if got != want {
		t.Fatalf("DefaultClaudeProjectsDir = %q, want %q", got, want)
	}
}
