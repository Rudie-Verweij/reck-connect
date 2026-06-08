package launcher

/*
#cgo LDFLAGS:
#include <stdio.h>
#include <stdlib.h>
#include <spawn.h>
#include <signal.h>
#include <errno.h>
#include <string.h>

// responsibility_spawnattrs_setdisclaim is an undocumented but widely-used
// macOS SPI (Firefox, Chromium, LLDB ship with it). When set on a posix_spawn
// attr block, the spawned child is treated as its own responsible process for
// TCC purposes — meaning macOS will create a separate Privacy & Security
// entry under the child's binary path rather than folding the child's
// permission requests under the parent's TCC scope.
//
// Issue #225: this lets reck-pane-launcher own the TCC scope for all pane
// descendants so the AX grant is on the launcher (which is restartable
// without killing panes) rather than on reck-stationd (which is not).
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

extern char **environ;

static int spawn_disclaimed(const char *path, char *const argv[], char *const envp[],
                            int *pid_out, char *errbuf, int errlen) {
    posix_spawnattr_t attrs;
    int rc = posix_spawnattr_init(&attrs);
    if (rc != 0) {
        snprintf(errbuf, errlen, "posix_spawnattr_init: %s", strerror(rc));
        return rc;
    }
    rc = responsibility_spawnattrs_setdisclaim(&attrs, 1);
    if (rc != 0) {
        snprintf(errbuf, errlen, "setdisclaim: %s", strerror(rc));
        posix_spawnattr_destroy(&attrs);
        return rc;
    }
    pid_t pid;
    char *const *env = envp ? envp : environ;
    rc = posix_spawn(&pid, path, NULL, &attrs, argv, env);
    posix_spawnattr_destroy(&attrs);
    if (rc != 0) {
        snprintf(errbuf, errlen, "posix_spawn: %s", strerror(rc));
        return rc;
    }
    *pid_out = (int)pid;
    return 0;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// spawnDisclaimed runs path with the given argv/env and the
// responsibility_spawnattrs_setdisclaim attribute set, so the child becomes
// its own TCC responsible process. envp may be nil to inherit the caller's
// environment.
func spawnDisclaimed(path string, argv []string, envp []string) (int, error) {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	cArgv := make([]*C.char, len(argv)+1)
	for i, a := range argv {
		cArgv[i] = C.CString(a)
		defer C.free(unsafe.Pointer(cArgv[i]))
	}
	cArgv[len(argv)] = nil

	var cEnvp **C.char
	if envp != nil {
		cEnv := make([]*C.char, len(envp)+1)
		for i, e := range envp {
			cEnv[i] = C.CString(e)
			defer C.free(unsafe.Pointer(cEnv[i]))
		}
		cEnv[len(envp)] = nil
		cEnvp = (**C.char)(unsafe.Pointer(&cEnv[0]))
	}

	var cPid C.int
	errBuf := make([]byte, 256)
	rc := C.spawn_disclaimed(
		cPath,
		(**C.char)(unsafe.Pointer(&cArgv[0])),
		cEnvp,
		&cPid,
		(*C.char)(unsafe.Pointer(&errBuf[0])),
		C.int(len(errBuf)),
	)
	if rc != 0 {
		end := 0
		for end < len(errBuf) && errBuf[end] != 0 {
			end++
		}
		return 0, fmt.Errorf("spawnDisclaimed rc=%d: %s", int(rc), string(errBuf[:end]))
	}
	return int(cPid), nil
}
