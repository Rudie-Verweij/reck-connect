.PHONY: help build test vet typecheck dist dist-dir clean

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
