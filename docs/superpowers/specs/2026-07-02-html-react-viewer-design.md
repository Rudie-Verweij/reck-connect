# Design: faithful component & HTML preview in the satellite

- **Date:** 2026-07-02
- **Status:** DRAFT — direction confirmed by user. **Ordering locked: Phase 0 → Phase A (static HTML) → Phase B (faithful Vite preview). Next.js (Phase E) explicitly postponed.** Two Phase-B defaults remain to confirm (providers, transport) — see [Open decisions](#14-open-decisions-confirm-when-back). Supersedes the earlier "sandbox one file" framing (kept as [Tier 1](#5-the-fidelity-ladder), now *not* recommended).
- **Scope:** the satellite file-viewer/preview surface + a new station-side preview runner + (later) daemon service support.

---

## 1. Goal

Open a `.html`, `.jsx`/`.tsx`, or `.js` file and **see it rendered as it would actually appear** — a rendered HTML page, or a React component rendered *exactly as if you had written a `page.tsx` that just renders it*: with its real imported components, the project's `global.css` / Tailwind / design tokens, path aliases, and (best-effort) its context providers. Reuse the markdown viewer's rendered-vs-source pattern and its TTS read-aloud + search where possible.

The user's framing — *"view components directly as how they would be viewed if you created a `page.tsx` only to contain the component"* — is the north star and maps to a concrete mechanism (a Vite **virtual entry module**, §6).

## 2. The core realization (answers "will `global.css` and imports affect it?")

**Fidelity is binary, not a spectrum. It depends entirely on whether we run the project's real bundler.**

- A **single-file transform** (sucrase / babel-standalone) converts one file's JSX→JS and **discards everything else**: it does not resolve `import Button from '@/components/Button'`, never reads `node_modules`, ignores `tsconfig`/Vite path aliases, and runs no PostCSS/Tailwind/CSS-modules. → `global.css`, design system, imported children **do not apply**. This tier cannot deliver the goal.
- Running the component **through the project's own Vite/Next toolchain** resolves the full import graph + `node_modules` + aliases and runs the real CSS pipeline. → `global.css`, Tailwind, imported components, tokens all apply **automatically, because it is the project's build**. Providers are the one thing no toolchain infers for free (§10).

**Conclusion:** to render "as a `page.tsx` would," the preview must be produced by the project's real bundler, which (for fidelity + speed of `node_modules`/Tailwind content-scan) must run **on the station**, not in the satellite/browser.

## 3. Verified architecture facts

### Viewer / TTS (from prior recon, verified against source)
- The file viewer is a **separate Electron `BrowserWindow` popup**, opened via `reckAPI.files.openInViewer(path)`. Render mode is a hardcoded, **duplicated** branch in `FileViewerHost.ts` (`isMarkdownPath` at :201; `if (isMd && markdownMode==="rendered")` at :1335 **and** :1004). Adding modes ⇒ hoist to one classifier first.
- Markdown path = markdown-it (`html:false`) → DOMPurify allowlist → `shell.body.innerHTML`. Cannot render raw HTML or run JS by design.
- **TTS/search are surface-agnostic.** `MarkdownSurfaceAdapter` is a **generic same-document DOM adapter** (`{container, body: HTMLElement}`, floating overlay that never mutates content). `SpeakSurfaceAdapter = {kind, getContainerEl, resolveSpokenChunk, highlightBoundary, clearHighlight, setTheme?, dispose}`. Works on any DOM **in the same document** — an iframe boundary breaks it.

### Networking — the enabling surprise (verified)
- The satellite talks **directly to the station over the tailnet**: plain browser `fetch`/`WebSocket` to `http://<station>:7315` (`api-for-host.ts:142`, `client-core/src/api/client.ts`). **No SSH tunnel, no proxy** in front of the daemon (`docs/architecture.md:3`).
- The daemon binds **`0.0.0.0:7315`** (`ops/…reck-stationd.plist.tmpl --addr 0.0.0.0:7315`). Tailscale's default ACL allows all ports between a user's own devices, so **any** station port on the tailnet interface is reachable from the satellite the same way `:7315` is.
- **There is no CSP anywhere**, `webviewTag` is off but `<iframe>` works, and everything is `http`/`file` (no https ⇒ no mixed-content block). Helper `stationHostFromUrl()` (`tailscale-status.ts:50`) already derives the station host.
- ⇒ `<iframe src="http://<station-tailnet-ip>:<devport>">` is reachable from the satellite with **no CSP/frame-ancestors/mixed-content barrier and no new transport**. The display surface is essentially already wired. *(Caveat: confirm your Tailscale ACLs aren't locked to specific ports; see §14.)*

### Daemon — the gap, and the v1 shortcut (verified)
- The daemon **only spawns PTY-backed panes** (kinds `claude`/`shell`/`codex`). No non-PTY spawn, **no port allocation, no readiness/health for children, no reverse proxy, no auto-restart** (running→exited is terminal). `/health` reports daemon-only status.
- **But** it can already launch `npm run dev`/`vite` as a shell-style pane in the project cwd, and that process stays alive while running. So a **v1 needs no daemon changes**: run the preview server as a pane bound to `0.0.0.0`, discover its port, and iframe it directly. Proper daemon-owned service lifecycle + auth reverse-proxy is a later hardening (§9 Phase C).

### Project model — greenfield build-awareness (verified)
- A "project" is literally `{id, name, cwd}` (`config.Project`, `proto.ts`). reck reads **no** `package.json`/framework/`tsconfig`/Vite/Tailwind config today — framework detection, alias/`global.css` discovery, and provider inference are **all net-new**.
- Project files live under the sshfs mount (`~/reck/projects`), readable via `node:fs` in the satellite main process (`file-viewer.ts` read path). ⇒ a new `satellite/main/project-detect.ts` reading `package.json`/config over the mount is the natural home for detection. The **bundler itself must run station-side** (native `node_modules`, writable `.vite` cache; sshfs is too slow for `node_modules`).

## 4. Prior art (positioning)

Storybook, Ladle, react-cosmos, Histoire, Bit all: render **locally**, require **hand-written stories/fixtures**, and target **a human**. They achieve import/alias fidelity only by **reusing the project's real Vite/webpack config** — and **none** auto-apply `global.css` (you import it in a setup file) or auto-infer providers (all use explicit decorators). Browser-only bundling (esbuild-wasm/sucrase, the CodeSandbox lineage) categorically cannot reach project fidelity — CodeSandbox itself moved off it to a Node microVM. RSC (Next server components) requires the real server runtime; no transform/import-map approach can render it.

## 5. The fidelity ladder

| Tier | Renders | imports + `global.css` + providers | Verdict |
|---|---|---|---|
| **0 · Static HTML** | `.html`, sanitized/inert → `shell.body` | n/a (not React) | **Keep** — cheap companion, reuses markdown TTS/search verbatim |
| **1 · Single-file transform** | one self-contained `.jsx` in a sandboxed iframe | ❌ no | **Drop** (or fallback-only) — the tier that can't see `global.css` |
| **2 · Faithful build (target)** | any component via the project's **real Vite** on the station, virtual `page.tsx` entry, framed in the satellite | ✅ imports/aliases/Tailwind/`global.css`; providers best-effort | **v1 target, Vite-first** |
| **3 · Agent-coupled + accessible** | Tier 2 beside the agent pane, live HMR, **read-aloud + search over the running component** | ✅ + spoken/searchable/live | **The novel peak** — follow-on |

## 6. Architecture (Tier 2)

Three moving pieces:

**(A) Station-side preview runner — new (`reck-preview`, a small Node package/CLI on the station).**
- Detects the project's framework and loads its **real `vite.config`** via programmatic Vite: `createServer({ server: { host: true /* 0.0.0.0 */, hmr: { host: <station>, clientPort } }, appType: 'custom' })` — so `@vitejs/plugin-react`, `@tailwindcss/vite`, `vite-tsconfig-paths`, CSS-modules all run exactly as in the app.
- Serves a **virtual entry module** (Vite plugin, `virtual:reck-preview`) synthesized per target — this *is* the auto-`page.tsx`:
  ```
  import Component from '<absolute path to target file>'
  import '<detected app global.css>'          // Tailwind + tokens apply
  import { Providers } from 'virtual:reck-preview-providers'  // §10
  createRoot(document.getElementById('root')).render(<Providers><Component/></Providers>)
  ```
- HMR, full import graph, and alias resolution come free because it is the project's own bundler.

**(B) Satellite iframe host — extends the existing viewer.**
- New render mode `component-live` in the (now unified) `pickViewerMode` classifier.
- Renders `<iframe src="http://<station>:<devport>/?target=<encoded path>">` into `shell.body`, with a spinner until readiness. Host derived via `stationHostFromUrl()`.
- The iframe is **cross-origin** (its own port/opaque-ish origin) → structurally cannot touch `window.reckAPI` (§11). Good for isolation, but it means TTS/search need a bridge (§10, Tier 3).

**(C) Daemon — v1 unchanged; hardened later.**
- **v1:** the preview runner is launched as a pane (or a plain spawned process) bound to `0.0.0.0`; port discovered from its output/convention. No daemon changes.
- **Phase C:** a first-class **service** abstraction (a 4th non-PTY kind or a parallel service manager): free-port allocation, HTTP readiness probe, restart policy, and an **authenticated reverse-proxy route** (`/preview/:id/*` → `127.0.0.1:<port>`, incl. HMR WS passthrough) so previews ride the daemon's origin + bearer instead of an open tailnet port.

## 7. Data flow (Tier 2, v1)

`openInViewer(path)` → popup → `pickViewerMode` → `component-live` → ensure a `reck-preview` Vite server is running for this project on the station (start if absent) → satellite reads the discovered port → `<iframe src="http://<station>:<port>/?target=<path>">` → station Vite builds the virtual entry with the project's real toolchain → live rendered component (HMR-connected). Agent edits mounted source → Vite HMR → preview updates.

## 8. Providers strategy (auto-infer + manual override)

The single genuinely-unsolved problem; every existing tool punts. Approach:
1. **Auto-infer (best-effort):** detect the app's root `Providers` component / root layout (`app/layout.tsx`, `_app.tsx`, or a `Providers`/`AppProviders` export) and wrap the target in it via the `virtual:reck-preview-providers` module.
2. **Manual override (escape hatch):** if inference is wrong, the user (or the agent) drops a tiny `<Component>.reck-preview.tsx` (or a global `reck.preview.tsx` decorator) exporting a `wrap`. Deterministic, Storybook-decorator-style.
3. Be honest in-product that "zero-config providers" is aspirational; degrade to bare render with a visible hint when neither is found.

## 9. Phases

- **Phase 0 — refactor:** hoist the duplicated render-mode branch into one `pickViewerMode()` + one dispatcher used by `renderForPath` **and** `renderStationRemote`.
- **Phase A — static HTML (Tier 0), independent:** `HtmlRenderer` (wider DOMPurify profile than markdown; strips script/`on*`/iframe) → same-document mount → **reuse `MarkdownSurfaceAdapter` + search verbatim** + Cmd-click cascade. Ships alone; satisfies the "TTS on rendered HTML" intuition for free.
- **Phase B — faithful Vite preview (Tier 2 v1):** `project-detect` (satellite main, over the mount) + `reck-preview` station runner (programmatic Vite + virtual entry + provider auto-wrap) + `component-live` iframe mode + lifecycle (start/reuse/stop the server) + readiness spinner. Providers auto-infer + manual override. TTS/search read **source** in this phase.
- **Phase C — daemon service hardening:** first-class service kind (port allocation, readiness, restart) + authenticated reverse proxy (HTTP + HMR WS) so previews leave the open tailnet port and ride the daemon origin/bearer.
- **Phase D — Tier 3 accessibility + agent-coupling:** a `postMessage` TTS/search **bridge** — a `reck-preview` Vite plugin injects a small script into the served app that answers "extract speakable text / highlight word N" over `postMessage`; satellite-side `HtmlSandboxAdapter` implements `SpeakSurfaceAdapter` against it. Wire the preview to live beside the agent pane.
- **Phase E — Next/RSC (optional, later):** boot real `next dev` + an ephemeral generated route for faithful RSC/`next/image`/`next/font`/layout rendering.

## 10. Components

**New — satellite:**
- `viewer/pickViewerMode.ts` (+test) — classifier (Phase 0)
- `viewer/HtmlRenderer.ts` (+test) — static sanitized HTML → DOM (Phase A)
- `main/project-detect.ts` (+test) — framework + `global.css` + providers detection over the mount (Phase B)
- `viewer/ComponentPreview.ts` (+test) — the `component-live` iframe host + lifecycle/readiness (Phase B)
- `tts/HtmlSandboxAdapter.ts` (+test) — postMessage TTS/search bridge adapter (Phase D)

**New — station:**
- `reck-preview/` — Node package/CLI: programmatic Vite server, `virtual:reck-preview` entry plugin, provider auto-wrap, (Phase D) the injected accessibility-bridge plugin.

**New — daemon (Phase C):**
- a `service` abstraction (port alloc + readiness + restart) and a `/preview/:id/*` reverse proxy (HTTP + WS).

**Touched:**
- `viewer/FileViewerHost.ts` — classifier + one dispatcher; new arms; generalized mode toggle (Preview/Run/Source).
- `tts/SpeakSurfaceAdapter.ts` + `search/SearchSurfaceAdapter.ts` — add `"html"`/`"component"` to `SurfaceKind`.
- `renderer/src/styles.css` — wider HTML tag styling.
- `package.json` (station runner deps: `vite`, `@vitejs/plugin-react`, etc. — installed against the project, not the satellite).
- `proto` + daemon config (Phase C service/port fields; Phase B may add a lightweight "preview" endpoint).

## 11. Security model

- **The previewed dev app is cross-origin** (its own port) and loads through **no preload**, so it **cannot reach `window.reckAPI`** — the ambient-authority hole the earlier sandbox worried about is closed structurally here. Keep the iframe without `allow-same-origin`.
- **Running the project's real `vite.config`/`next.config` executes project code on the always-on station.** This is **within the existing trust boundary**: the station already runs the coding agent that edits and executes this very project. It is *not* the "render an untrusted arbitrary artifact" case. (If untrusted-repo preview is ever wanted, that needs a stronger station-side sandbox — out of scope.)
- **v1 exposes a dev-server port on the tailnet.** Acceptable between your own devices under default Tailscale ACLs, but Phase C's daemon reverse-proxy (bearer/origin-gated, port never on the tailnet) is the hardened end state. Constrain any proxy to daemon-allocated ports only (avoid an SSRF-shaped forwarder).
- Static HTML (Tier 0) stays inert via DOMPurify; add a viewer CSP as hygiene.
- Add an **extension/MIME allowlist** to `file:read` so a "renderer" can't be pointed at `~/.ssh/id_rsa`.

## 12. Hard parts & risks

| Risk / hard part | Mitigation |
|---|---|
| Providers can't be reliably auto-inferred | Best-effort detect + manual `*.reck-preview.tsx` override + honest degrade (§8) |
| Next.js/RSC needs the real Next runtime | Vite-first; Phase E boots real `next dev` + ephemeral route |
| TTS/search can't cross a cross-origin iframe | Phase D postMessage bridge injected by the `reck-preview` plugin |
| Vite HMR over tailnet | `server.host: true` + `hmr.host`/`clientPort` + `allowedHosts` (MagicDNS) config in the runner |
| Framing headers (`X-Frame-Options`/`frame-ancestors`) from some setups | Strip via Electron `onHeadersReceived`, or the Phase C proxy |
| Dev-server lifecycle/ports (no daemon concept today) | v1 = pane + direct port; Phase C = daemon service manager |
| `node_modules` too slow over sshfs | Bundler runs **station-side** natively (never satellite/browser) |
| 2 MB `file:read` cap vs large bundles | n/a for Tier 2 (served, not read); raise cap only if any read path needs it |

## 13. Testing (vitest + jsdom; playwright-electron for e2e)

- `pickViewerMode` — pure matrix unit tests.
- `HtmlRenderer` — jsdom: script/`on*`/iframe stripped, structural tags kept; **plus a test proving `MarkdownSurfaceAdapter` extracts text from its output** (locks in free TTS reuse).
- `project-detect` — fixture repos (Vite, Next, CRA, plain) → correct framework + `global.css` + providers detection.
- `reck-preview` — virtual-entry synthesis (string builder) unit tests; an integration test that a fixture component renders with a Tailwind class applied (proves `global.css` reached it).
- `ComponentPreview` — readiness/lifecycle; e2e that a live component renders in the iframe and **cannot call `reckAPI`**.
- Phase D bridge — postMessage protocol contract tests.

## 14. Open decisions (confirm when back)

1. **✅ CONFIRMED — Ship static `.html` first, then faithful Vite preview.** Phase 0 → A → B. The live-TTS bridge (Phase D) stays deferred.
4. **✅ CONFIRMED — Vite-first; Next.js (Phase E) postponed.** Reusing an existing Storybook/Ladle/cosmos setup when present is a possible cheap win to revisit at Phase B.

Still open (both Phase B only — don't block Phase 0/A):
2. **Providers = auto-infer + manual override** (default). Alternatives: explicit-recipe-only (predictable, no magic) or none-for-v1.
3. **v1 transport = direct tailnet dev-server port** (no daemon change), hardening to a daemon reverse-proxy in Phase C. Confirm your Tailscale ACLs permit non-7315 ports between your devices (else start with the SSH `-L` port-forward fallback reusing the existing `reck-station` identity).
