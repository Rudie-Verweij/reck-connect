# fix(tts): reliable default voice, language-aware Automatic mode, voice picker, and rate controls

## Problem

On some Macs the text-to-speech feature spoke with a bizarre voice (macOS's novelty voice **Albert**) even though the user never chose it — and on other machines the same build sounded fine. Investigating with a live repro turned up four distinct defects, all fixed here.

### Root cause of the wrong voice

The app never set `utterance.voice`, delegating the choice to Chromium. Chromium's fallback resolves against the OS default voice — but **Siri voices are never exposed to the Web Speech API** (nor to any third-party app), so when the user's macOS System Voice is a Siri voice, Chromium silently falls back to the first alphabetical English voice: Albert. Verified live: `getVoices()` flagged `Zoe (Premium) ← default` while an unset-voice utterance still spoke with the wrong voice, proving the `default` flag is not what Chromium's no-voice path uses. Machines "that worked" simply had a non-Siri system voice.

## What this PR does (one commit each)

1. **`fix(tts)` — explicit default voice + un-wedged speech queue + voice picker**
   - New `defaultVoice.ts` resolver: when no voice is configured, the app picks one itself — right language first, then Premium > Enhanced > classic system voices (Samantha, Daniel, …), with the macOS novelty voices (Albert, Bad News, Bells, …) hard-excluded. `utterance.voice` and `utterance.lang` are now always set.
   - `speechSynthesis` is one global queue per window and its **paused flag survives `cancel()`** — a stale pause silently swallows every later `speak()` (observed as "no sound at all"). The engine now `cancel()` + `resume()` before every utterance and after stop.
   - The bar label used to say "Default voice" while playing something arbitrary; it now shows the actually-resolved voice compactly (e.g. `EN (Zoe)`) and clicking it expands a two-column picker — languages (with counts) left, that language's voices right, plus an "Automatic (best available)" option. The choice persists via the existing TTS settings.

2. **`feat(tts)` — language detection + quality-first scoring; dev docs**
   - On Automatic, the chunk about to be spoken is language-detected (lightweight stopword scoring: en/nl/de/fr/es) so Dutch text gets a Dutch voice (e.g. `NL (Claire)`) and English text an English one. Ambiguous/code-heavy text falls back to the UI locale. (macOS's "Detect languages" toggle applies only to Apple's own Spoken Content, never to apps.)
   - Scoring fix: voice **quality now dominates within a language**; exact region is only a tiebreak. Previously an `en-GB` locale made plain Daniel (en-GB) beat Zoe (Premium) (en-US).
   - `satellite/README.md`: replaced the stale "`pnpm dev` is currently broken" note with working dev instructions — `RECK_STATION_ROOT` and `VITE_RECK_STATION_ROOT` must be in the shell that runs `pnpm dev` (a packaged install gets them baked in at build time / injected via LSEnvironment, which is why dev-from-source is the only setup that hits this). Also: quit the installed app while running dev, or the two fight over the local `reck-stationd` and the loser spams `auth rejected`.

3. **`docs(satellite)`** — clarify that `~/.config/reck/satellite.env` is sourced only by the packaging wrapper (`ops/build-app.sh`); nothing reads it at runtime or in `pnpm dev`.

4. **`feat(tts)` — typed rate entry + ± steppers with a mellow pulse**
   - Click the rate readout to type an exact speed. Input is sanitised live (digits + one dot/comma; negatives and letters are untypeable), comma accepted as decimal separator, invalid/empty input keeps the old rate, valid values clamped to [0.5, 6] and snapped to 0.05. Enter commits, Escape cancels without triggering the global stop-TTS shortcut.
   - New − / + buttons flank the rate slider (0.05 steps, clamped).
   - Discrete rate changes give the readout a slight scale pulse; slider drags stay animation-free.

## Tests

- 290 TTS-suite tests pass (was 254), including new specs: `defaultVoice.test.ts` (novelty exclusion, quality-vs-region, language fallback), `languageDetect.test.ts` (nl/en/de detection, null on short/code text), picker interaction tests, and typed-rate/stepper tests.
- Full unit suite: 1915 passed. `pnpm typecheck` clean.
- Verified live on a machine with a Siri system voice: Automatic now resolves `EN (Zoe)` for English and `NL (Claire)` for Dutch text; pause → stop → play no longer goes silent.

## Notes for reviewers

- `NOVELTY_VOICE_NAMES` and `KNOWN_GOOD_NAMES` in `defaultVoice.ts` are macOS-specific curation; other platforms simply never match them and fall through to language/quality scoring.
- The stopword detector is intentionally tiny (no dependency); extending it to another language is a one-array addition in `languageDetect.ts`.
