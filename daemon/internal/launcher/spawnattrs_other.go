//go:build !darwin

package launcher

import (
	"errors"
	"os"
	"syscall"
)

// spawnDisclaimed on non-darwin platforms is a plain process spawn.
//
// macOS uses responsibility_spawnattrs_setdisclaim so the helper becomes its
// own TCC responsible process. Linux has no TCC equivalent, so the helper
// just runs as a child of the daemon.
//
// Setsid is enabled to match the helper's session/pgid invariant the
// Manager relies on for pgid-based pane teardown (see spawn.go).
func spawnDisclaimed(path string, argv []string, envp []string) (int, error) {
	if path == "" {
		return 0, errors.New("spawnDisclaimed: empty path")
	}
	if envp == nil {
		envp = os.Environ()
	}
	attr := &os.ProcAttr{
		Env:   envp,
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
		Sys:   &syscall.SysProcAttr{Setsid: true},
	}
	proc, err := os.StartProcess(path, argv, attr)
	if err != nil {
		return 0, err
	}
	return proc.Pid, nil
}
