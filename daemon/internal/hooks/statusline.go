package hooks

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// The Claude Code statusLine setting is a SINGLE value (an object with a
// "command"), not an additive array like hooks. So installing Reck's
// forwarder means replacing whatever was there — which would silently
// destroy a user's own statusline. To avoid that we:
//
//   1. Capture the user's prior statusLine into a dedicated sidecar
//      (StatusLinePriorPath) the first time we take over.
//   2. Embed the prior command string as $1 of our forwarder command, so
//      reck-statusline.sh renders it by piping the same payload into it.
//   3. Restore the captured prior verbatim on Uninstall.
//
// The prior sidecar is kept separate from the hook-ownership sidecar so
// the existing hook install format (and its tests) stay untouched.

// statusLinePrior is the on-disk record of the user's original statusLine.
type statusLinePrior struct {
	Version int             `json:"version"`
	Had     bool            `json:"had"`             // was a prior statusLine configured?
	Prior   json.RawMessage `json:"prior,omitempty"` // the original value, restored on uninstall
}

// statusLineCommandFor builds our canonical statusLine command string:
//
//	/bin/bash '<shim>' '<prior-command>' # reck-hook-v1
//
// Both the shim path and the prior command are single-quoted (with '\”
// escaping) so a path or command containing spaces/quotes survives the
// shell intact. The trailing marker comment identifies the entry as ours.
func statusLineCommandFor(shimPath, priorCommand string) string {
	return fmt.Sprintf("/bin/bash '%s' '%s' # %s",
		strings.ReplaceAll(shimPath, "'", `'\''`),
		strings.ReplaceAll(priorCommand, "'", `'\''`),
		MarkerV1,
	)
}

// isReckStatusLine reports whether the given statusLine value is one Reck
// installed: an object whose command references our shim path and carries
// the marker. Because the command embeds the (variable) prior command, we
// can't exact-match — we recognise it structurally by shim path + marker.
func isReckStatusLine(v any, shimPath string) bool {
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	cmd, _ := m["command"].(string)
	if cmd == "" {
		return false
	}
	return strings.Contains(cmd, shimPath) && strings.HasSuffix(cmd, MarkerV1)
}

// commandOf extracts the "command" string from a statusLine object value,
// or "" when absent / not an object.
func commandOf(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	c, _ := m["command"].(string)
	return c
}

// applyStatusLine sets settings["statusLine"] to Reck's forwarder,
// capturing (or preserving) the user's prior statusLine in the sidecar so
// it can be chained to and later restored.
func applyStatusLine(settings map[string]any, shimPath, priorPath string) error {
	existing, hasExisting := settings["statusLine"]

	var priorCommand string
	if isReckStatusLine(existing, shimPath) {
		// Re-install: the real prior lives in the sidecar (our current
		// wrapper is NOT the prior). Load it so we keep chaining to it and
		// don't overwrite the sidecar with our own wrapper.
		if pr, err := loadStatusLinePrior(priorPath); err == nil && pr != nil && pr.Had {
			priorCommand = commandOf(rawToAny(pr.Prior))
		}
	} else {
		// First install, or the user replaced our statusLine with theirs.
		// Capture the current value as the prior to preserve/restore.
		pr := statusLinePrior{Version: 1}
		if hasExisting && existing != nil {
			raw, err := json.Marshal(existing)
			if err != nil {
				return fmt.Errorf("marshal prior statusLine: %w", err)
			}
			pr.Had = true
			pr.Prior = raw
			priorCommand = commandOf(existing)
		}
		if err := writeStatusLinePrior(priorPath, pr); err != nil {
			return err
		}
	}

	settings["statusLine"] = map[string]any{
		"type":    "command",
		"command": statusLineCommandFor(shimPath, priorCommand),
	}
	return nil
}

// stripStatusLine restores the user's prior statusLine (or removes ours if
// there was none) and clears the prior sidecar. Non-Reck statusLine values
// are left untouched.
func stripStatusLine(settings map[string]any, shimPath, priorPath string) error {
	existing, ok := settings["statusLine"]
	if ok && isReckStatusLine(existing, shimPath) {
		pr, err := loadStatusLinePrior(priorPath)
		if err == nil && pr != nil && pr.Had {
			settings["statusLine"] = rawToAny(pr.Prior)
		} else {
			delete(settings, "statusLine")
		}
	}
	if err := os.Remove(priorPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove statusline prior %s: %w", priorPath, err)
	}
	return nil
}

// --- sidecar IO ---

func loadStatusLinePrior(path string) (*statusLinePrior, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read statusline prior %s: %w", path, err)
	}
	if len(data) == 0 {
		return nil, nil
	}
	var pr statusLinePrior
	if err := json.Unmarshal(data, &pr); err != nil {
		// Corrupt sidecar ⇒ treat as "no prior" rather than fail startup.
		return nil, nil
	}
	return &pr, nil
}

func writeStatusLinePrior(path string, pr statusLinePrior) error {
	data, err := json.MarshalIndent(pr, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal statusline prior: %w", err)
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

// rawToAny decodes a json.RawMessage into a generic any, returning nil on
// error (an empty/absent prior).
func rawToAny(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}
