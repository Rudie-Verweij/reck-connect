package pty

import "strings"

// sensitiveArgvFlags is the set of flags whose values must be redacted
// before argv is logged. Matches both separated (`--flag value`) and
// equals (`--flag=value`) forms.
//
//   - --session-id / --resume — live session UUIDs; anyone with log
//     access could `claude --resume <uuid>` into a persisted conversation.
//   - --api-key — raw credential passed through to the agent.
//   - --append-system-prompt — not a secret, but after an earlier release it
//     carries a multi-KiB daemon-emitted preamble plus any project
//     preamble. Logging it verbatim on every spawn drowns /var/log/
//     with the same ~3 KiB block. Redacting keeps logs useful; the
//     content is reconstructable from the daemon binary + projects.toml.
var sensitiveArgvFlags = map[string]bool{
	"--session-id":           true,
	"--resume":               true,
	"--api-key":              true,
	"--append-system-prompt": true,
}

// redactedPlaceholder is what replaces the value half of a sensitive flag.
const redactedPlaceholder = "<redacted>"

// redactArgv returns a copy of argv with the values of any flag in
// sensitiveArgvFlags replaced by <redacted>. Both separated form
// (`--session-id UUID`) and equals form (`--session-id=UUID`) are
// handled. The input slice is never mutated.
//
// Example:
//
//	redactArgv([]string{"claude", "--resume", "abc-123"})
//	  → []string{"claude", "--resume", "<redacted>"}
//
//	redactArgv([]string{"claude", "--api-key=sk-xxx"})
//	  → []string{"claude", "--api-key=<redacted>"}
func redactArgv(argv []string) []string {
	if len(argv) == 0 {
		return nil
	}
	out := make([]string, len(argv))
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		// Equals form: `--flag=value`.
		if eq := strings.IndexByte(a, '='); eq > 0 && strings.HasPrefix(a, "--") {
			name := a[:eq]
			if sensitiveArgvFlags[name] {
				out[i] = name + "=" + redactedPlaceholder
				continue
			}
		}
		// Separated form: `--flag value`. If a sensitive flag is the
		// current token and there's a follow-up arg, redact the follow-up
		// in one shot and skip past it.
		if sensitiveArgvFlags[a] && i+1 < len(argv) {
			out[i] = a
			out[i+1] = redactedPlaceholder
			i++
			continue
		}
		out[i] = a
	}
	return out
}
