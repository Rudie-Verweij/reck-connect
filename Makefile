.PHONY: help build test vet typecheck dist dist-dir clean cross install-linux

help:
	@echo "Reck Connect — common tasks"
	@echo ""
	@echo "  make build       Build the daemon (Go) and the satellite renderer (TS)"
	@echo "  make test        Run Go tests and Vitest"
	@echo "  make vet         Run go vet across the daemon"
	@echo "  make typecheck   Run TypeScript typecheck on the satellite"
	@echo "  make dist        Build a packaged Satellite .app + .dmg installer"
	@echo "  make dist-dir    Build the .app bundle only (skips DMG packaging)"
	@echo "                   — required on macOS 26+ where dmg-builder hits"
	@echo "                     a libexpat ABI clash and python-symlink issues"
	@echo "  make clean       Remove build artefacts"
	@echo "  make cross       Cross-compile the daemon for Linux ARM64 (Raspberry Pi, no cgo)"
	@echo "  make install-linux  Install the station on a Linux/Pi host (run on the Pi)"

build:
	go build ./...
	cd satellite && pnpm install && pnpm build

test:
	go test ./...
	cd satellite && pnpm test

vet:
	go vet ./...

typecheck:
	cd satellite && pnpm typecheck

dist:
	cd satellite && pnpm install && pnpm dist

# Skip the DMG packaging step and emit only the .app bundle under
# satellite/release/mac-arm64/. macOS 26 (Tahoe) ships a python without
# the symlink electron-builder's dmg-builder expects, and an updated
# libexpat that clashes with the bundled native dep ABI. Until both
# upstream issues clear, this is the supported build path on macOS 26+.
# Result is a working unsigned .app you can run directly.
#
# `--` separates pnpm's own flags from arguments forwarded to the
# underlying `dist` script (which ends in `electron-builder --mac
# --publish never`). Without `--`, pnpm would consume `--dir` as a
# pnpm-CLI flag (cwd override) and electron-builder would still build
# the DMG.
dist-dir:
	cd satellite && pnpm install && pnpm dist -- --dir

clean:
	rm -rf satellite/dist satellite/release
	go clean ./...

# Cross-compile the daemon from any host (Mac or Linux) to Linux ARM64
# (Raspberry Pi). CGO_ENABLED=0: the linux pasteboard backend shells out
# to xclip (os/exec) rather than cgo, so no C toolchain is needed. Also
# vets to catch any darwin-only import slipping past the build tags.
cross:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build ./...
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go vet ./...

# Install the station on a Linux/Pi host. Run this ON the Pi (it builds
# into ~/.local/bin and renders a systemd-user unit); see
# ops/install-station-linux.sh.
install-linux:
	./ops/install-station-linux.sh
