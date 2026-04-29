# @client-core

Platform-neutral browser plumbing used by the desktop Satellite
(`v2/satellite/`).

No framework, no Electron, no DOM-shell. Just:

- `api/client.ts` — typed HTTP client for the daemon.
- `api/ws.ts` — WebSocket wrapper + base64 byte helpers for the PTY protocol.
- `terminal/terminal-pane.ts` — xterm.js wrapper bound to `PaneWS`.
- `launch-args/tokenize.ts` — `tokenizeClaudeArgs` POSIX-ish shell tokenizer.

The client-core surface stays platform-neutral so any future non-Electron client (browser, mobile, embedded) can adopt it without refactor.

## Import style

Consumers add a `@client-core/*` path alias to their tsconfig + bundler
config. This mirrors the existing `@shared/*` alias for `v2/shared/`.

```ts
import { ApiClient } from "@client-core/api/client";
```

No package.json. No pnpm workspace. TypeScript project references would be
overkill for a source-only shared directory. The Satellite points its
alias at `v2/client-core/src/`.
