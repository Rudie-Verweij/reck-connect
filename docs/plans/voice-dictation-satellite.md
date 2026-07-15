# Satellite-side voice dictation — make voice-to-text "just work" in reck (issue #67)

## Context

Holding the spacebar in Claude Code inside a reck pane fails with
`ALSA lib pcm_asym.c:105:(_snd_pcm_asym_open) capture slave is not defined`.

Root cause (confirmed against official Claude Code docs + this codebase): Claude Code's
`/voice` **captures audio on whatever machine the CLI runs on**. In reck, `claude` runs on
the **station** (headless Linux daemon, `daemon/internal/pty/pane.go` → `pty.StartWithSize`)
which has **no capture device** → the ALSA error. The microphone is on the **Mac
satellite**, one WebSocket hop away. Anthropic **explicitly does not support** `/voice`
over SSH/remote (capture is always local to the CLI host; transcription runs on their
servers). There is **no station-side fix** — the daemon's own system-prompt preamble
already states the mic lives on the satellite and is "NOT reachable from here"
(`daemon/internal/agent/preamble.go`).

Fix (issue #67's preferred direction): bypass `/voice` and build reck's **own** dictation —
capture the mic in the Electron renderer (Mac), transcribe, and **inject the text into the
focused pane's PTY as keystrokes** via the channel that already exists. The Mac app is
already provisioned (`com.apple.security.device.audio-input` entitlement +
`NSMicrophoneUsageDescription`), so no signing/permission changes.

## Confirmed decisions
- Support **both** local Whisper and Deepgram cloud; **both** land in **Phase 1**.
- **Local Whisper is the default** (zero-key first run). Deepgram is opt-in (needs a key).
- Dictated text is **inserted without a trailing newline** — user reviews, then presses
  Enter (no auto-submit; may become an opt-in setting later).
- Triggers: **both** a mic button **and** a **configurable** hotkey.
- Show a **toast hint** *only* when Claude Code's own voice error appears in a pane (never
  on a normal space press).
- **Local path is layered:** embedded transformers.js (zero-install default, Phase 1) +
  an auto-detected **app-managed native sidecar** (`mlx-whisper`/`whisper.cpp`/
  `faster-whisper`) as a fast-lane when present (Phase 2). Native is faster because of the
  *engine* (Metal/MLX/Neural-Engine, quantized native code) vs sandboxed WASM — **not**
  because it's a separate process. No standalone service / Docker.

## Architecture

**Provider abstraction orchestrated by the Electron main process — no standalone OS
service, no port (Phase 1), no Docker.** Main *is* the transcription host: it holds the
Deepgram key (encrypted), opens the cloud WebSocket, and (Phase 2) spawns the native
whisper. The renderer captures audio and owns the UI. Cloud = a WS to Deepgram's own
cloud; embedded local = WASM/WebGPU in a renderer Web Worker; native local (Phase 2) = an
app-spawned subprocess (per-utterance CLI = no port, or a localhost-only server).

```
Renderer (Mac)                       Main process (Mac)            Station (Linux)
getUserMedia → AudioWorklet          provider router:
  → 16kHz mono PCM  ──IPC──▶           • DeepgramProvider ─WS─▶  (Deepgram cloud)
TranscriptionController                • LocalWhisperProvider
  ◀─ partial/final ──IPC──               P1: transformers.js worker (embedded)
inject FINAL (no newline) via            P2: native mlx-whisper/whisper.cpp (fast-lane)
  layout.getActiveTerminalRecord()
    .term.sendInput(bytes) ───────────────── WS "input" ──────▶ PTY (claude stdin)
```

## Module layout (mirrors `satellite/renderer/src/tts/`)

New `satellite/renderer/src/transcription/`:
- `TranscriptionEngine.ts` — framework-free class; owns capture (getUserMedia +
  AudioWorklet) + the active provider client; emits `partial | final | error`. DI-testable
  like `TtsEngine.ts`.
- `TranscriptionController.ts` — session state (`idle | listening | transcribing`); wires
  engine → UI bar; injects the **final** transcript into the active pane (interim shown in
  the bar only). Mirrors `TtsController.ts`.
- `DictationBar.ts` — per-pane control bar (mic state + live interim text). Clone of
  `SpeakControlBar.ts`, mounted in the same `.pane-controls` stack.
- `providers/DeepgramProvider.ts`, `providers/LocalWhisperProvider.ts` — client shims to
  the main-process router.
- `transcriptionSettings.ts` — `TRANSCRIPTION_CONFIG_KEY = "transcription"`, typed settings
  + `coerce()` + load/save via `window.reckAPI.config`. Mirrors `ttsSettings.ts`. Defaults:
  `{ enabled, provider:"local", localEngine:"embedded",
  localModel:"whisper-large-v3-turbo", hotkeyToggle:"⌘⇧V", hotkeyPushToTalk:"⌥Space",
  autoSubmit:false }`. The **embedded model is user-selectable from settings in Phase 1**
  (curated list: `whisper-large-v3-turbo` [default, best quality] / `whisper-small` /
  `whisper-base` / `whisper-tiny` [fastest, smallest download]) — each maps to its
  transformers.js ONNX repo (e.g. `onnx-community/whisper-large-v3-turbo`).
- `transcriptionShortcuts.ts` — installs hotkeys with **keydown AND keyup** (existing
  installers only do keydown; push-to-talk needs keyup); gated by `isTextEntryTarget()` so
  a held key never leaks into the PTY.
- `initTranscription.ts` — boot entry, invoked non-fatally beside `initTts()` (~`boot.ts:2164`).

New `satellite/main/transcription/`:
- `router.ts` — IPC: `transcription:detectLocal`, `transcription:start`/`:stop`/`:frame`
  (renderer→main audio), streaming `transcription:partial`/`:final`/`:error` (main→renderer)
  — modeled on the `suffixSearch` streaming bridge in `satellite/preload/preload.ts`.
- `deepgram.ts` — Deepgram streaming WS client (key via `readConfig`).
- `localWhisper.ts` — Phase 1 delegates to the renderer transformers.js worker; Phase 2
  adds native detection (`which mlx-whisper|whisper.cpp|faster-whisper`, scan model dirs
  for ggml/gguf) + spawn.

## Concrete integration points (verified during exploration)
- **Inject transcript:** `layout.getActiveTerminalRecord()?.term.sendInput(new TextEncoder()
  .encode(text))` — `sendInput()` already exists (`client-core/src/terminal/terminal-pane.ts:274`);
  active pane via `pane-layout.ts:286`. No trailing newline.
- **Mic button:** clone `ensureHistoryButton()` → `ensureMicButton()` in
  `satellite/renderer/src/ui/paneControls.ts`, mounts beside the TTS bar (`boot.ts:2194`).
- **Hotkeys:** renderer-only, pattern of `tts/ttsShortcuts.ts` + `ui/shortcuts.ts`
  (`installShortcuts`, `isTextEntryTarget`); add a keyup listener for push-to-talk. No
  Electron `globalShortcut` today.
- **Settings UI:** `satellite/renderer/src/ui/settings-view.ts` — new `<h3>Voice dictation</h3>`
  section: enable toggle, provider `<select>`, embedded model `<select>` (Phase 1),
  local native engine/model `<select>` (Phase 2, populated from `transcription:detectLocal`),
  Deepgram key (`type="password"`, the `#s-tok` pattern), hotkey pickers (capture a chord on
  keydown; cross-check `ui/shortcuts.ts`).
- **Storage/secrets:** `satellite/main/storage.ts` — add `"transcription"` to `CONFIG_KEYS`;
  add `"transcription.deepgramKey"` to **both** `CONFIG_KEYS` and `SECRET_CONFIG_KEYS`
  (safeStorage-encrypted, same as `station.token`; never in the plaintext blob).
- **IPC/preload:** add a `transcription` namespace in `satellite/preload/preload.ts` +
  `ipcMain.handle` block in `satellite/main/main.ts` (~line 587); validate every arg at the
  boundary (mirror `isAllowedConfigKey`).
- **Spacebar-error hint:** add optional `onDecodedOutput?: (bytes) => void` prop to
  `TerminalPane`, called in the single output choke point (`terminal-pane.ts:526`
  `onOutput`). A debounced matcher scans for Claude Code's phrases ("Voice input is failing
  repeatedly and has been paused", "microphone") → `showToast(paneWrapper, "Voice can't run
  on the station — use reck dictation (⌘⇧V or the mic button).", { kind: "info" })`
  (`satellite/renderer/src/viewer/Toast.ts`). Fires once per pane per session.

## Phasing (each phase independently useful; one PR per phase)
- **Phase 0 — the hint (tiny).** Output tap + toast. Kills the ugly silent failure. No
  capture yet.
- **Phase 1 — make it work, both engines.** Capture + AudioWorklet + `DeepgramProvider`
  (streaming) **and** embedded `LocalWhisperProvider` (transformers.js, lazy-loaded,
  default) + mic button + toggle hotkey + settings (enable, provider select, **embedded
  model select** [`whisper-large-v3-turbo` default … `whisper-tiny`], Deepgram key) +
  insert final transcript (no newline). Local default → works with no key on day one.
- **Phase 2 — native local fast-lane.** Detect `mlx-whisper`/`whisper.cpp`/`faster-whisper`
  + on-disk models (`transcription:detectLocal`), engine/model dropdown; use native when
  present, embedded as fallback.
- **Phase 3 — push-to-talk + polish.** Hold-to-talk keyup, configurable hotkey picker,
  interim-text display in `DictationBar`.

## New dependencies (flag before install)
- Cloud: `@deepgram/sdk` (or a raw WS client).
- Embedded local: `@huggingface/transformers` (transformers.js) + ONNX runtime — **lazy
  dynamic `import()` in a Web Worker**, model fetched from the HF hub **on first use**, so
  the base bundle stays lean and Deepgram-only users never pay for it. Requires allowing
  renderer fetches to `huggingface.co` (CSP/network) on first local-model download.

## Risks / notes
- **WebGPU in packaged Electron 30 (Chromium 124):** transformers.js prefers WebGPU; verify
  it's enabled in the packaged app (may need a command-line switch) with a WASM fallback.
  `whisper-large-v3-turbo` realistically needs WebGPU to be pleasant — if WebGPU is
  unavailable, fall back to a smaller model on WASM.
- **Default local model:** `whisper-large-v3-turbo` (best quality; larger first-use
  download — on the order of a few hundred MB quantized). `whisper-small`/`base`/`tiny`
  selectable for a smaller download / faster CPU-WASM path.
- Renderer-only hotkeys work while reck is focused; global capture would need
  `globalShortcut` in main (out of scope).

## Testing (TDD, per repo rules — pure units first, like `rail-collapse.test.ts`)
- `transcriptionSettings.coerce()` — validation/defaults.
- Trigger-phrase matcher — matches Claude's messages, ignores lookalikes, fires once.
- PCM frame framing / 16kHz resample math.
- (Phase 2) native model-detection parser (dir listing / `which` output → model list).
Capture, IPC, and provider WS are verified manually (TTS's Web Speech usage has no unit
coverage either).

## Verification
1. `cd satellite && pnpm typecheck && pnpm test` — green except the two documented
   pre-existing station-root failures (`main/rsync-copy.test.ts`, `renderer/src/project-push.test.ts`).
2. `pnpm package`, quit + reinstall `/Applications/Reck Connect Satellite.app` (ditto from
   `release/mac-arm64/`).
3. Manual: in a Claude pane, click the mic (or hotkey), speak → text inserts into the PTY
   (no auto-send); press Enter to submit. Test local (no key) and Deepgram (with key).
4. Manual: hold spacebar in Claude Code → the toast hint appears once.
5. Manual: settings → switch provider, enter/save a Deepgram key (survives restart),
   rebind the hotkey.

## Phase status
- [ ] Phase 0 — spacebar-error toast hint
- [ ] Phase 1 — capture + Deepgram + embedded Whisper + mic button + toggle hotkey + settings
- [ ] Phase 2 — native local fast-lane + detection
- [ ] Phase 3 — push-to-talk + configurable hotkey picker + interim display

## Workflow
- Feature branch `feat/satellite-voice-dictation` off `main` (per CLAUDE.md — never on `main`).
- One PR per phase; `Closes #67` only on the phase that fully resolves it (earlier phases
  reference #67 for context). PRs on the `mehdigreefhorst` fork.
