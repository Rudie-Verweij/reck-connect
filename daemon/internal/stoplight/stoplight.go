// Package stoplight computes per-pane stoplight state from PTY activity.
package stoplight

import (
	"context"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/pty"
	"github.com/rudie-verweij/reck-connect/proto"
)

const (
	// IdleThreshold: any output in the last N seconds keeps a pane orange;
	// past it, the pane flips to green. Collapsed from a two-window design
	// (5s working, 30s idle) because Claude streams continuously while
	// generating — sub-second gaps are normal and >3s of silence reliably
	// means the task has finished.
	IdleThreshold = 3 * time.Second
	// How often we re-evaluate (1 Hz).
	TickInterval = 1 * time.Second
)

// Signals is the full set of per-pane inputs that shape its stoplight.
// The fields used depend on Kind:
//   - Claude / agent-hooked panes: AgentState is authoritative (driven by
//     lifecycle hook events). Byte-flow fields are ignored.
//   - Shell / unhooked panes: fall back to the byte-flow heuristic
//     (HasOutputEver + LastOutputAt + AwaitingApproval).
//
// Exit fields (Exited, ExitCode) always apply regardless of Kind.
type Signals struct {
	Kind       proto.PaneKind
	AgentState proto.AgentState

	HasOutputEver    bool
	LastOutputAt     time.Time
	AwaitingApproval bool
	Exited           bool
	ExitCode         *int // nil while running; set on exit
}

// Evaluate returns the stoplight for a pane based on its current signals.
//
// Precedence (top-most wins, for every Kind):
//  1. Exited with non-zero code → red (crash / error)
//  2. Exited with zero code → green (task finished)
//
// For Claude / agent-hooked panes (Kind == claude), after exit checks:
//  3. AgentState == attention → red
//  4. AgentState == working   → orange
//  5. AgentState == idle      → green
//  6. AgentState == unknown   → gray (no hook event yet)
//
// For shell / unhooked panes:
//  7. Never emitted any output → gray
//  8. OSC 777 approval pending → red (legacy heuristic)
//  9. Output in last IdleThreshold → orange
//
// 10. Otherwise → green
func Evaluate(sig Signals, now time.Time) proto.Stoplight {
	if sig.Exited {
		if sig.ExitCode != nil && *sig.ExitCode != 0 {
			return proto.StoplightRed
		}
		return proto.StoplightGreen
	}
	if sig.Kind == proto.PaneKindClaude {
		switch sig.AgentState {
		case proto.AgentStateAttention:
			return proto.StoplightRed
		case proto.AgentStateWorking:
			return proto.StoplightOrange
		case proto.AgentStateIdle:
			return proto.StoplightGreen
		default:
			return proto.StoplightGray
		}
	}
	// Shell / unhooked: byte-flow heuristic
	if !sig.HasOutputEver {
		return proto.StoplightGray
	}
	if sig.AwaitingApproval {
		return proto.StoplightRed
	}
	if now.Sub(sig.LastOutputAt) < IdleThreshold {
		return proto.StoplightOrange
	}
	return proto.StoplightGreen
}

// Runner ticks at 1 Hz and updates every pane's stoplight.
type Runner struct {
	mgr *pty.Manager
}

func NewRunner(mgr *pty.Manager) *Runner {
	return &Runner{mgr: mgr}
}

// Run until ctx is done.
func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(TickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, pane := range r.mgr.AllPanes() {
				sig := Signals{
					Kind:             pane.Kind,
					AgentState:       pane.AgentState(),
					HasOutputEver:    len(pane.ReplayTail(1)) > 0,
					LastOutputAt:     pane.LastOutputAt(),
					AwaitingApproval: pane.AwaitingApproval(),
					Exited:           pane.State() == proto.PaneStateExited,
					ExitCode:         pane.ExitCode(),
				}
				pane.SetStoplight(Evaluate(sig, now))
			}
		}
	}
}
