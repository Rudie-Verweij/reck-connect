.PHONY: help build test vet typecheck dist clean

help:
	@echo "Reck Connect — common tasks"
	@echo ""
	@echo "  make build       Build the daemon (Go) and the satellite renderer (TS)"
	@echo "  make test        Run Go tests and Vitest"
	@echo "  make vet         Run go vet across the daemon"
	@echo "  make typecheck   Run TypeScript typecheck on the satellite"
	@echo "  make dist        Build a packaged Satellite .app bundle"
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

clean:
	rm -rf satellite/dist satellite/release
	go clean ./...
