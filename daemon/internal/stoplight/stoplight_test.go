package stoplight

import (
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

func TestEvaluate_gray(t *testing.T) {
	now := time.Now()
	s := Evaluate(Signals{HasOutputEver: false, LastOutputAt: now}, now)
	if s != proto.StoplightGray {
		t.Fatalf("want gray, got %s", s)
	}
}

func TestEvaluate_orange_recentOutput(t *testing.T) {
	now := time.Now()
	s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-1 * time.Second)}, now)
	if s != proto.StoplightOrange {
		t.Fatalf("want orange, got %s", s)
	}
}

func TestEvaluate_green_idle(t *testing.T) {
	now := time.Now()
	// Any gap ≥ IdleThreshold flips to green.
	s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-IdleThreshold - time.Second)}, now)
	if s != proto.StoplightGreen {
		t.Fatalf("want green, got %s", s)
	}
}

func TestEvaluate_orangeToGreenBoundary(t *testing.T) {
	now := time.Now()
	// Just under the threshold → still orange.
	if s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-IdleThreshold + 100*time.Millisecond)}, now); s != proto.StoplightOrange {
		t.Fatalf("just under threshold: want orange, got %s", s)
	}
	// Exactly at / past threshold → green.
	if s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-IdleThreshold)}, now); s != proto.StoplightGreen {
		t.Fatalf("at threshold: want green, got %s", s)
	}
}

func TestEvaluate_red_onAwaitingApproval(t *testing.T) {
	now := time.Now()
	if Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-1 * time.Second), AwaitingApproval: true}, now) != proto.StoplightRed {
		t.Fatal("want red when awaiting (recent output)")
	}
	if Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-40 * time.Second), AwaitingApproval: true}, now) != proto.StoplightRed {
		t.Fatal("want red when awaiting (idle)")
	}
}

func TestEvaluate_awaitingTrumpsIdle(t *testing.T) {
	now := time.Now()
	s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-time.Hour), AwaitingApproval: true}, now)
	if s != proto.StoplightRed {
		t.Fatalf("want red, got %s", s)
	}
}

func TestEvaluate_red_onExitNonZero(t *testing.T) {
	now := time.Now()
	code := 1
	s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-5 * time.Second), Exited: true, ExitCode: &code}, now)
	if s != proto.StoplightRed {
		t.Fatalf("want red for non-zero exit, got %s", s)
	}
}

func TestEvaluate_green_onExitZero(t *testing.T) {
	now := time.Now()
	code := 0
	s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now.Add(-1 * time.Second), Exited: true, ExitCode: &code}, now)
	if s != proto.StoplightGreen {
		t.Fatalf("want green for clean exit, got %s", s)
	}
}

func TestEvaluate_exitTrumpsAwaiting(t *testing.T) {
	// A pane that exited after emitting OSC 777 should show its exit state,
	// not stale "awaiting approval" red. (Non-zero exit is still red — but
	// for different reason — and zero exit should be green regardless of
	// any leftover awaiting flag.)
	now := time.Now()
	code := 0
	s := Evaluate(Signals{HasOutputEver: true, LastOutputAt: now, AwaitingApproval: true, Exited: true, ExitCode: &code}, now)
	if s != proto.StoplightGreen {
		t.Fatalf("exit zero should win over stale awaiting, got %s", s)
	}
}

// --- Agent-pane (Kind=claude) branch ---

func TestEvaluate_claude_gray_noEventYet(t *testing.T) {
	// A freshly spawned Claude pane has emitted bytes (title/tips) but no
	// lifecycle hook has fired yet — the UI should not treat it as "working".
	now := time.Now()
	s := Evaluate(Signals{
		Kind:          proto.PaneKindClaude,
		AgentState:    proto.AgentStateUnknown,
		HasOutputEver: true,
		LastOutputAt:  now.Add(-100 * time.Millisecond),
	}, now)
	if s != proto.StoplightGray {
		t.Fatalf("want gray before any hook event, got %s", s)
	}
}

func TestEvaluate_claude_agentStateMap(t *testing.T) {
	now := time.Now()
	cases := []struct {
		state proto.AgentState
		want  proto.Stoplight
	}{
		{proto.AgentStateWorking, proto.StoplightOrange},
		{proto.AgentStateIdle, proto.StoplightGreen},
		{proto.AgentStateAttention, proto.StoplightRed},
	}
	for _, c := range cases {
		got := Evaluate(Signals{
			Kind:       proto.PaneKindClaude,
			AgentState: c.state,
			// Intentionally cross-pollute byte-flow fields to confirm they are
			// ignored for Claude panes.
			HasOutputEver:    true,
			LastOutputAt:     now.Add(-time.Hour),
			AwaitingApproval: true,
		}, now)
		if got != c.want {
			t.Fatalf("agentState=%s: want %s, got %s", c.state, c.want, got)
		}
	}
}

func TestEvaluate_claude_exitStillWinsOverAgentState(t *testing.T) {
	// Exit semantics apply to Claude panes too — a non-zero-exited Claude
	// pane is red even if its last event said "idle".
	now := time.Now()
	code := 1
	s := Evaluate(Signals{
		Kind:       proto.PaneKindClaude,
		AgentState: proto.AgentStateIdle,
		Exited:     true,
		ExitCode:   &code,
	}, now)
	if s != proto.StoplightRed {
		t.Fatalf("non-zero exit should still be red, got %s", s)
	}
}

func TestEvaluate_shell_unaffectedByAgentState(t *testing.T) {
	// Shell panes don't receive hook events — an accidental AgentState
	// value shouldn't leak into their stoplight.
	now := time.Now()
	s := Evaluate(Signals{
		Kind:          proto.PaneKindShell,
		AgentState:    proto.AgentStateIdle,
		HasOutputEver: true,
		LastOutputAt:  now.Add(-500 * time.Millisecond),
	}, now)
	if s != proto.StoplightOrange {
		t.Fatalf("shell pane with recent output should be orange, got %s", s)
	}
}
