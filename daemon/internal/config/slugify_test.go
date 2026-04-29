package config

import "testing"

func TestSlugify(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"basic", "Demo Project", "demo-project"},
		{"accent fold", "Möbius Ring", "mobius-ring"},
		{"strip punct", "hello, world!", "hello-world"},
		{"collapse whitespace", "   foo   bar   ", "foo-bar"},
		{"single word", "reck", "reck"},
		{"already slug", "my-cool-project", "my-cool-project"},
		{"digits preserved", "project 42", "project-42"},
		{"strip leading/trailing dashes", "---hi---", "hi"},
		{"lowercase", "HELLO", "hello"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Slugify(tc.in)
			if got != tc.want {
				t.Errorf("Slugify(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSlugifyEmpty(t *testing.T) {
	if Slugify("") != "" {
		t.Error("expected empty input to produce empty slug")
	}
	if Slugify("!!! ???") != "" {
		t.Error("expected punctuation-only input to produce empty slug")
	}
}

func TestSlugifyWithCollision(t *testing.T) {
	existing := map[string]bool{
		"demo":   true,
		"demo-2": true,
	}
	got := SlugifyUnique("Demo", existing)
	if got != "demo-3" {
		t.Errorf("SlugifyUnique returned %q, want demo-3", got)
	}
	if SlugifyUnique("Fresh", existing) != "fresh" {
		t.Errorf("SlugifyUnique should return base slug when no collision")
	}
}
