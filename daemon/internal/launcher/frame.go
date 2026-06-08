package launcher

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
)

// Wire frame: 1-byte kind, 4-byte big-endian length, payload bytes.
//
// The pty fd transfer is a one-shot: helper sends a single-byte payload
// over WriteMsgUnix with the SCM_RIGHTS oob (see SendFD/RecvFD), then a
// regular framed JSON SpawnResponse follows.

const maxFrameLen = 1 << 20 // 1 MiB — far above any realistic JSON payload

// WriteFrame writes a length-prefixed frame to w. Exported for use from the
// helper binary in cmd/reck-pane-launcher.
func WriteFrame(w io.Writer, kind FrameKind, payload []byte) error {
	if len(payload) > maxFrameLen {
		return fmt.Errorf("launcher: frame too large (%d > %d)", len(payload), maxFrameLen)
	}
	hdr := make([]byte, 5)
	hdr[0] = byte(kind)
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

// ReadFrame reads a single length-prefixed frame from r.
func ReadFrame(r io.Reader) (FrameKind, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	kind := FrameKind(hdr[0])
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > maxFrameLen {
		return 0, nil, fmt.Errorf("launcher: frame length %d exceeds max %d", n, maxFrameLen)
	}
	if n == 0 {
		return kind, nil, nil
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return kind, payload, nil
}

// SendFD sends a single file descriptor over the conn via SCM_RIGHTS. Caller
// (helper) closes its copy after the call returns; the receiver gets a
// freshly-dup'd fd in the kernel.
func SendFD(c *net.UnixConn, fd int) error {
	oob := syscall.UnixRights(fd)
	// Single-byte payload — zero-byte SCM_RIGHTS messages are dropped on macOS.
	_, _, err := c.WriteMsgUnix([]byte{0xff}, oob, nil)
	return err
}

// RecvFD reads a single file descriptor sent by SendFD. Returns the fd as an
// int; caller is responsible for wrapping it in os.NewFile.
func RecvFD(c *net.UnixConn) (int, error) {
	buf := make([]byte, 1)
	oob := make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := c.ReadMsgUnix(buf, oob)
	if err != nil {
		return -1, err
	}
	if n != 1 || buf[0] != 0xff {
		return -1, fmt.Errorf("launcher: unexpected fd-frame payload %v", buf[:n])
	}
	scms, err := syscall.ParseSocketControlMessage(oob[:oobn])
	if err != nil {
		return -1, fmt.Errorf("launcher: parse cmsg: %w", err)
	}
	if len(scms) == 0 {
		return -1, errors.New("launcher: no SCM_RIGHTS cmsg")
	}
	fds, err := syscall.ParseUnixRights(&scms[0])
	if err != nil {
		return -1, fmt.Errorf("launcher: parse rights: %w", err)
	}
	if len(fds) != 1 {
		for _, f := range fds {
			_ = syscall.Close(f)
		}
		return -1, fmt.Errorf("launcher: expected 1 fd, got %d", len(fds))
	}
	// FD_CLOEXEC so the received fd doesn't leak into future pane children
	// the daemon spawns through the helper.
	_, _, e1 := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fds[0]), syscall.F_SETFD, syscall.FD_CLOEXEC)
	if e1 != 0 {
		_ = syscall.Close(fds[0])
		return -1, fmt.Errorf("launcher: set FD_CLOEXEC: %v", e1)
	}
	return fds[0], nil
}
