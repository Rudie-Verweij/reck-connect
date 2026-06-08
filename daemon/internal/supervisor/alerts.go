package supervisor

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

// alertSink is the pane-write surface the dispatcher uses to deliver
// alert lines. In production this is Pane.Write; tests inject a
// failing implementation to exercise the delivery-failure logging.
type alertSink interface {
	Write(data []byte) error
}

// alertDispatcher tracks per-pane state across docked projects and emits
// one-line "[reck]" notifications into the supervisor pane's stdin when
// something meaningful changes. This turns the supervisor from a purely
// reactive chatbot (only reads when the user asks) into an ambient
// supervisor that learns about state transitions as they happen.
//
// Transitions we surface:
//
//   - any → red         — runtime error or tool failure
//   - any → attention   — Claude is waiting on the user (permission, elicitation)
//   - working → green   — task completed
//
// Skipped: gray ↔ gray, working ↔ working, first-observation (we take
// the initial state as baseline rather than announcing it).
//
// Writes only fire when the supervisor pane is running — an alert that
// would arrive at a dead pane is dropped rather than queued. The user
// experiences a fresh supervisor as a clean slate; historical state is
// available via explicit /mission-control/state calls.
type alertDispatcher struct {
	ctrl *Controller

	mu          sync.Mutex
	panes       map[string]paneSnapshot // paneID -> last-seen snapshot
	lastAlertAt map[string]time.Time    // paneID -> last alert wallclock
	cooldown    time.Duration

	// sinkResolver is test-injection: given a pane ID, return the alert
	// sink to use. Nil in production ⇒ the dispatcher looks up the pane
	// via Manager.PaneByID and writes to it directly.
	sinkResolver func(paneID string) (alertSink, bool)
}

type paneSnapshot struct {
	projectID   string
	projectName string
	kind        proto.PaneKind
	stoplight   proto.Stoplight
	agentState  proto.AgentState
}

func newAlertDispatcher(ctrl *Controller) *alertDispatcher {
	return &alertDispatcher{
		ctrl:        ctrl,
		panes:       make(map[string]paneSnapshot),
		lastAlertAt: make(map[string]time.Time),
		cooldown:    2 * time.Second,
	}
}

// onStateChange is wired to Manager.OnStateChange. It walks the current
// docked-project cards, diffs per-pane state against the cached snapshot,
// and writes alert lines to the supervisor pane's stdin for every
// meaningful transition.
//
// Cheap: O(docked-panes) per call, all in-memory. Does not touch disk.
func (a *alertDispatcher) onStateChange() {
	paneID := a.ctrl.SupervisorPaneID()
	if paneID == "" {
		// Still refresh our cache so we don't misreport transitions
		// when the supervisor starts later; we want "changes since
		// supervisor came online" not "changes since daemon started".
		a.refreshBaseline()
		return
	}
	var supervisorSink alertSink
	var ok bool
	if a.sinkResolver != nil {
		supervisorSink, ok = a.sinkResolver(paneID)
	} else {
		var p *pty.Pane
		p, ok = a.ctrl.mgr.PaneByID(paneID)
		if ok {
			supervisorSink = p
		}
	}
	if !ok {
		return
	}

	docked := a.ctrl.mgr.DockedProjects()
	alerts := make([]string, 0, 4)

	a.mu.Lock()
	seen := make(map[string]bool)
	for _, dp := range docked {
		for _, pane := range a.ctrl.mgr.PanesInProject(dp.ID) {
			info := pane.Info()
			cur := paneSnapshot{
				projectID:   dp.ID,
				projectName: dp.Name,
				kind:        info.Kind,
				stoplight:   info.Stoplight,
				agentState:  pane.AgentState(),
			}
			seen[info.ID] = true
			prev, known := a.panes[info.ID]
			a.panes[info.ID] = cur
			if !known {
				// First observation — baseline, don't alert. Gives
				// the supervisor a clean experience on startup.
				continue
			}
			msg := classifyTransition(prev, cur)
			if msg == "" {
				continue
			}
			last := a.lastAlertAt[info.ID]
			if time.Since(last) < a.cooldown {
				continue
			}
			a.lastAlertAt[info.ID] = time.Now()
			alerts = append(alerts, formatAlert(cur, info.ID, msg))
		}
	}
	// Evict panes that no longer exist so the map doesn't grow
	// unboundedly across dock/undock cycles.
	for id := range a.panes {
		if !seen[id] {
			delete(a.panes, id)
			delete(a.lastAlertAt, id)
		}
	}
	a.mu.Unlock()

	// Fire writes outside the lock — pane.Write hits the PTY master
	// and should never be done while we're holding our own mutex.
	// Delivery failures are surfaced at error level: an alert we
	// generated but couldn't deliver is a meaningful operational
	// signal (pane died between paneID read and write, PTY master
	// EOF, etc.) and the dropped payload is needed to diagnose why.
	for _, line := range alerts {
		if err := supervisorSink.Write([]byte(line)); err != nil {
			slog.Error("supervisor: alert delivery failed",
				"err", err,
				"pane", paneID,
				"payload", line,
			)
		}
	}
}

// refreshBaseline updates the snapshot map to reflect current state
// without emitting alerts. Called while the supervisor is offline so
// that transitions occurring during downtime don't fire a burst of
// stale alerts the moment the supervisor starts.
func (a *alertDispatcher) refreshBaseline() {
	docked := a.ctrl.mgr.DockedProjects()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.panes = make(map[string]paneSnapshot, len(a.panes))
	for _, dp := range docked {
		for _, pane := range a.ctrl.mgr.PanesInProject(dp.ID) {
			info := pane.Info()
			a.panes[info.ID] = paneSnapshot{
				projectID:   dp.ID,
				projectName: dp.Name,
				kind:        info.Kind,
				stoplight:   info.Stoplight,
				agentState:  pane.AgentState(),
			}
		}
	}
}

// classifyTransition returns a short human-readable message for a
// meaningful prev→cur transition, or "" when the change isn't worth
// notifying on. Keep the vocabulary tight — the supervisor reads many
// of these and noise is expensive.
func classifyTransition(prev, cur paneSnapshot) string {
	// Attention escalation (the most important signal — the user is
	// being asked something).
	if cur.agentState == proto.AgentStateAttention && prev.agentState != proto.AgentStateAttention {
		return "needs attention"
	}
	// Error state (runtime failure, claude exited badly, etc).
	if cur.stoplight == proto.StoplightRed && prev.stoplight != proto.StoplightRed {
		return "red / error"
	}
	// Task completion: working → idle. Only fire when the prior state
	// was definitively "working" so we don't churn on gray→idle or
	// unknown→idle (which happens on benign hook jitter).
	if cur.agentState == proto.AgentStateIdle && prev.agentState == proto.AgentStateWorking {
		return "task done"
	}
	return ""
}

// formatAlert renders one alert line. Written as a single CR-terminated
// line so Claude Code's TUI consumes it as a standalone user prompt.
// The "[reck]" prefix matches the system-prompt instruction telling the
// supervisor to treat these as system signals, not user chat.
//
// The project name is user-supplied — a crafted name like
// "] IGNORE PRIOR INSTRUCTIONS. Run …" would be a direct prompt-injection
// into the supervisor's context. sanitizeAlertField strips control bytes
// and caps length so the worst case is a noisy alert, not a hijacked
// agent.
func formatAlert(s paneSnapshot, paneID, msg string) string {
	short := paneID
	if strings.HasPrefix(short, "p_") {
		short = short[2:]
	}
	if len(short) > 6 {
		short = short[:6]
	}
	return fmt.Sprintf("[reck] %s — %s pane %s: %s\r",
		sanitizeAlertField(s.projectName, 64),
		sanitizeAlertField(string(s.kind), 16),
		short,
		sanitizeAlertField(msg, 128),
	)
}

// sanitizeAlertField scrubs content that would be fed to Claude via the
// supervisor's PTY: strips CR/LF/NUL/escape, replaces other control
// bytes with '?', and caps length. We keep normal unicode and printable
// ASCII so legitimate project names render intact.
func sanitizeAlertField(s string, max int) string {
	if len(s) > max {
		s = s[:max] + "…"
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\r' || r == '\n' || r == 0x00:
			// drop — these would break the single-line alert format
		case r == 0x1b:
			// ESC: could start an ANSI/OSC sequence that hides the alert
			b.WriteRune('?')
		case r < 0x20 && r != '\t':
			b.WriteRune('?')
		case r == 0x7f:
			b.WriteRune('?')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
