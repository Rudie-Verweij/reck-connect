// Package launcher implements the daemon side of the reck-pane-launcher
// helper binary. The helper exists solely to be the responsible-process
// for all pane children so macOS TCC attributes Accessibility / AppleEvents
// API calls back to the helper, not to reck-stationd. See issue #225.
//
// Wire protocol over the per-pane Unix-domain connection:
//
//   1. Daemon  → helper: SpawnRequest (JSON, length-prefixed, see frame.go)
//   2. Helper  → daemon: SCM_RIGHTS-encoded pty master fd over the same conn,
//                        accompanied by a one-byte 0x01 cookie in the in-band
//                        payload (so the daemon can tell the fd-bearing message
//                        apart from later JSON frames).
//   3. Helper  → daemon: SpawnResponse (JSON, length-prefixed)
//   4. Helper  → daemon: ExitNotice (JSON, length-prefixed) when the child reaps
//   5. Either side may send KillRequest at any time after step 3.
//
// The daemon does not need to round-trip every pty byte through the helper —
// once it has the master fd it owns I/O directly. The helper retains the
// child *exec.Cmd reference so it (and only it) calls cmd.Wait, ensuring the
// kernel's responsibility-process bookkeeping stays consistent.
package launcher

import "encoding/json"

// SpawnRequest is sent by the daemon at the start of every pane connection.
type SpawnRequest struct {
	Argv []string `json:"argv"`
	Env  []string `json:"env"`
	Dir  string   `json:"dir"`
	Cols int      `json:"cols"`
	Rows int      `json:"rows"`
}

// SpawnResponse follows the SCM_RIGHTS fd transfer.
type SpawnResponse struct {
	Pid int    `json:"pid"`
	Err string `json:"err,omitempty"`
}

// ExitNotice is sent once when the child reaps.
type ExitNotice struct {
	Code int `json:"code"`
}

// KillRequest is daemon → helper. Signal is a numeric POSIX signal.
type KillRequest struct {
	Signal int `json:"signal"`
}

// FrameKind categorises a length-prefixed frame so a single conn can carry
// both spawn metadata and runtime control messages without ambiguity.
// Exported so the helper binary in cmd/reck-pane-launcher can speak the
// same wire protocol as the daemon-side client here.
type FrameKind byte

const (
	FrameSpawnRequest  FrameKind = 1
	FrameSpawnResponse FrameKind = 2
	FrameExitNotice    FrameKind = 3
	FrameKillRequest   FrameKind = 4
)

func encodeJSON(v any) ([]byte, error) {
	return json.Marshal(v)
}

func decodeJSON(b []byte, v any) error {
	return json.Unmarshal(b, v)
}
