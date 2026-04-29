package supervisor

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/proto"
)

// mockFailingSink always returns the configured error from Write.
type mockFailingSink struct{ err error }

func (m *mockFailingSink) Write(data []byte) error { return m.err }

// captureSlogRecords redirects the default slog to a buffer for the
// duration of fn and returns the captured log output as a string. Uses
// the package-default logger because alerts.go calls slog.Error on the
// default logger; we restore the prior default synchronously on return.
func captureSlogRecords(t *testing.T, fn func()) string {
	t.Helper()
	prev := slog.Default()
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)
	fn()
	// Drain the buffer even if slog flushes lazily (text handler is sync).
	_, _ = io.Copy(&buf, strings.NewReader(""))
	return buf.String()
}

func TestClassifyTransition(t *testing.T) {
	cases := []struct {
		name    string
		prev    paneSnapshot
		cur     paneSnapshot
		wantMsg string
	}{
		{
			name:    "attention escalation fires",
			prev:    paneSnapshot{agentState: proto.AgentStateWorking, stoplight: proto.StoplightOrange},
			cur:     paneSnapshot{agentState: proto.AgentStateAttention, stoplight: proto.StoplightOrange},
			wantMsg: "needs attention",
		},
		{
			name:    "red stoplight fires",
			prev:    paneSnapshot{stoplight: proto.StoplightOrange},
			cur:     paneSnapshot{stoplight: proto.StoplightRed},
			wantMsg: "red / error",
		},
		{
			name:    "working → idle fires task done",
			prev:    paneSnapshot{agentState: proto.AgentStateWorking},
			cur:     paneSnapshot{agentState: proto.AgentStateIdle},
			wantMsg: "task done",
		},
		{
			name:    "gray → idle is silent (not a real completion)",
			prev:    paneSnapshot{agentState: proto.AgentStateUnknown, stoplight: proto.StoplightGray},
			cur:     paneSnapshot{agentState: proto.AgentStateIdle, stoplight: proto.StoplightGreen},
			wantMsg: "",
		},
		{
			name:    "working → working is silent",
			prev:    paneSnapshot{agentState: proto.AgentStateWorking, stoplight: proto.StoplightOrange},
			cur:     paneSnapshot{agentState: proto.AgentStateWorking, stoplight: proto.StoplightOrange},
			wantMsg: "",
		},
		{
			name:    "sustained attention does not re-fire",
			prev:    paneSnapshot{agentState: proto.AgentStateAttention},
			cur:     paneSnapshot{agentState: proto.AgentStateAttention},
			wantMsg: "",
		},
		{
			name:    "red → red does not re-fire",
			prev:    paneSnapshot{stoplight: proto.StoplightRed},
			cur:     paneSnapshot{stoplight: proto.StoplightRed},
			wantMsg: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classifyTransition(c.prev, c.cur)
			if got != c.wantMsg {
				t.Errorf("classifyTransition(%+v, %+v) = %q, want %q", c.prev, c.cur, got, c.wantMsg)
			}
		})
	}
}

// TestOnStateChange_alertDeliveryFailure_logsErrorWithPayload —
// an earlier release regression: when the supervisor pane's sink fails a write,
// the dispatcher must surface the error at slog.Error level with the
// dropped payload attached. Before this, `_ = supervisorPane.Write(...)`
// silently swallowed every write failure; a daemon couldn't tell
// whether an "attention" alert reached the supervisor or not.
//
// This is the end-to-end shape of the fix: drive a real Pane into
// StoplightRed, which fan-outs through Manager.notifyStateChange →
// Controller.handleStateChange → alertDispatcher.onStateChange →
// sink.Write (failing), all synchronously on the caller's goroutine.
// slog.Error is captured via a TextHandler routed to a buffer.
func TestOnStateChange_alertDeliveryFailure_logsErrorWithPayload(t *testing.T) {
	ctrl := newTestController(t)

	// Dock a project + spawn a pane so the dispatcher sees docked state
	// and can compute a transition.
	tmpDir := t.TempDir()
	if _, err := ctrl.mgr.AddProject(proto.AddProjectRequest{Name: "orchard", Cwd: tmpDir}); err != nil {
		t.Fatal(err)
	}
	if err := ctrl.mgr.SetDocked("orchard", true); err != nil {
		t.Fatal(err)
	}
	pane, err := ctrl.mgr.CreatePane("orchard", proto.PaneKindShell, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ctrl.mgr.DeletePane("orchard", pane.ID) })

	// Prime the dispatcher with a prior "working / orange" snapshot so
	// the transition to red classifies as a real alert (not a first-
	// observation baseline).
	ctrl.alerts.mu.Lock()
	ctrl.alerts.panes[pane.ID] = paneSnapshot{
		projectID:   "orchard",
		projectName: "orchard",
		kind:        pane.Kind,
		stoplight:   proto.StoplightOrange,
		agentState:  proto.AgentStateWorking,
	}
	ctrl.alerts.cooldown = 0 // bypass rate limit
	ctrl.alerts.mu.Unlock()

	// Mark the supervisor pane as live; the dispatcher short-circuits
	// when paneID == "".
	ctrl.mu.Lock()
	ctrl.paneID = "supervisor-stub"
	ctrl.mu.Unlock()

	// Inject a failing sink so every alert Write falls into the error-
	// log branch.
	ctrl.alerts.sinkResolver = func(_ string) (alertSink, bool) {
		return &mockFailingSink{err: errors.New("pty closed")}, true
	}

	// Drive the state change inside the capture block so the slog.Error
	// emitted during the stack fan-out lands in our buffer.
	out := captureSlogRecords(t, func() {
		pane.SetStoplight(proto.StoplightRed)
	})

	if !strings.Contains(out, "supervisor: alert delivery failed") {
		t.Errorf("expected delivery-failure error log, got:\n%s", out)
	}
	if !strings.Contains(out, "pty closed") {
		t.Errorf("expected sink error in log, got:\n%s", out)
	}
	if !strings.Contains(out, "red / error") {
		t.Errorf("expected dropped payload in log, got:\n%s", out)
	}
	if !strings.Contains(out, "level=ERROR") {
		t.Errorf("expected ERROR level, got:\n%s", out)
	}
}

func TestFormatAlert(t *testing.T) {
	s := paneSnapshot{projectName: "orchard", kind: proto.PaneKindClaude}
	got := formatAlert(s, "p_3af4c1e6f0a2", "needs attention")
	want := "[reck] orchard — claude pane 3af4c1: needs attention\r"
	if got != want {
		t.Errorf("formatAlert = %q, want %q", got, want)
	}
}
