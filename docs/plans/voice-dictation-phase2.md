# Voice dictation — Phase 2 plan

Audio-driven word segments (instant "always-blurred-first" text) + a live tuning
harness + explained settings.

> Extends `docs/plans/voice-dictation-satellite.md` (Phase 1: satellite-side
> dictation, Deepgram + local Whisper, the crystallizing ghost-tail overlay,
> the Advanced appearance panel).

## Context — why Phase 2

Phase 1 shipped a working overlay, but three gaps remain:

1. **No instant feedback.** Blurred ghost text only appears once the *engine*
   returns interim text — Deepgram is ~instant, but local Whisper lags ~1.2s+,
   so there's a dead moment after you start speaking. The user wants a blurred
   placeholder **the instant a word is spoken**: *"the text always starts in a
   blurred state."* The signal already exists — `TranscriptionEngine.onChunk`
   measures per-chunk energy (`onLevel` = RMS) and voiced time (`onSpeechMs`);
   we simply stopped *showing* it when the "blobs" were defaulted off. Nothing
   drives a placeholder from the audio itself yet.
2. **Ghost words don't map to real spoken words.** The Phase-1 blob count is a
   rough words-per-voiced-second *estimate*, not actual word boundaries. We want
   **audio-derived segments** so each blurred placeholder corresponds to a real
   spoken word and crystallizes into it.
3. **Defaults are hard to tune by feel.** The Advanced panel exists but the
   parameters are unlabeled in meaning, and there's no way to replay the same
   utterance while tweaking. We want a **replayable tuning page** on the same
   localhost as Reck, and an **info tooltip per parameter**.

Intended outcome: you speak → a blurred placeholder appears immediately per
detected word → it sharpens (crystallizes) into the real word as transcription
resolves. Plus a lab page to dial in the defaults, and self-explaining settings.

## Part A — Audio onset/segment detection (the core)

New module `renderer/src/transcription/onsetDetector.ts` (pure, unit-tested):
- Consume the same Float32 chunks the engine already receives in `onChunk`.
- Track a smoothed energy envelope; detect **onsets** (rising edge crossing an
  open-threshold after a quiet gap) and **offsets** (falling below a
  close-threshold for a min gap) with hysteresis, a min-word-duration, and a
  min-inter-word-gap to reject noise and syllable ripple.
- Emit `onWordOnset(segmentId, tStartMs)` immediately on an onset, and
  `onWordEnd(segmentId, durationMs)` on the matching offset.

Wire into `TranscriptionEngine`: add `onWordOnset`/`onWordEnd` to `EngineHandlers`,
fed from the onset detector in the existing `onChunk` path (alongside `onLevel`
/`onSpeechMs`). Thresholds come from settings (Part D), so they're tunable.

## Part B — Provisional placeholders that crystallize into words

In `TranscriptionController` + `DictationBar`, replace the estimate-based blobs
with an **ordered segment list**:
- On `onWordOnset`: push a provisional segment and render a **blurred
  placeholder** immediately — generic glyph blocks sized to the (growing, then
  final) segment duration, at full `blurStart`. This is the "always starts
  blurred" moment.
- When transcription resolves words (interim → stable), **align** resolved words
  to provisional segments **in order** and swap each placeholder's glyphs for the
  real characters, then run the existing per-character crystallize (blur→sharp,
  left→right). Committed words graduate into the prompt as today.
- Count-mismatch handling (Whisper merges/splits words vs onsets): best-effort
  1:1 by order; **resync on final** (the final full transcription is truth).
  Never block the prompt on alignment — stable text still injects.

Selectable via `appearance.ghostMode`:
- `"estimate"` — Phase 1 behavior (voiced-time word count).
- `"onset"` — Phase 2 (this part). Default `"onset"` once it's solid.

Net: instant blurred placeholders on **both** engines; on Whisper they bridge the
~1.2s lag; on Deepgram they lead the interim by a beat. Text always starts blurred.

## Part C — Tuning/lab page on the same localhost

A standalone page served by the SAME Vite app as the renderer, so it lives on
`http://localhost:5173/...` in dev and loads from disk in the packaged app —
exactly like `popout.html` does today (see `vite.config.ts` `rollupOptions.input`
and `main.ts` `loadURL("http://localhost:5173")` / `loadFile(...)`).

- Add `renderer/dictation-lab.html` + `renderer/src/dictation-lab.ts` and a third
  `input` entry in `vite.config.ts` (mirrors the popout multi-page setup) → served
  at `/dictation-lab.html` on the same origin.
- The page renders the REAL `DictationBar` driven by a **replayable event
  timeline** (scripted onset/interim/final events, and/or a bundled sample audio
  clip fed through the real capture→onset→provider path). A **Replay** button
  re-runs the same clip after each tweak so changes are directly comparable.
- Embeds the Advanced controls (reuse `dictationAdvancedPanel` /
  `DictationAppearance`) with live apply; chosen values can be copied out to
  become the shipped `DEFAULT_APPEARANCE`.
- Reachable from a **link in the Advanced panel** ("Open tuning lab").

## Part D — Explain every setting (info affordances)

- Each Advanced-panel parameter label gets an **info icon**; hover → a tooltip
  with a one-line explanation, unit, and range (e.g. "Char stagger (ms): delay
  between letters de-blurring — the left→right sweep speed. 0–200 ms.").
- Store the descriptions next to the field specs in `dictationAdvancedPanel.ts`.
- Add the onset-detector thresholds (open/close threshold, min gap, min duration)
  to `DictationAppearance` (+ `coerceAppearance`) so they're tunable in the panel
  and the lab, and a `ghostMode` selector.

## Part E — Immediate regression fix (folded into A/B)

Ship a minimal slice of A+B first so the "no blurred text until interim" gap is
closed right away: the first detected onset shows a blurred placeholder instantly,
even before the full segment/alignment machinery. This restores the instant
"blurred something" the moment you speak.

## Verification

- Unit: `onsetDetector` (synthetic envelopes with known onsets/gaps → expected
  events; hysteresis + min-gap reject ripple); segment↔word alignment (equal,
  fewer, more words than segments; resync on final).
- `pnpm typecheck && pnpm test` green (bar the documented pre-existing failures);
  `dictation.spec.ts` still green.
- Manual via the **lab page**: replay a clip → placeholders appear on the first
  syllable, crystallize into words, drain cleanly on stop; tune sliders live.
- `pnpm package`, reinstall, sanity-check console (`[dictation] …`).

## Open decisions

- Onset thresholds are room/mic dependent — expose in the panel; consider a quick
  auto-calibration (sample ambient noise for ~300 ms on begin()).
- Alignment heuristic when Whisper's word count ≠ onset count — start best-effort
  by order + final resync; revisit if it drifts.
- Lab audio source: bundled sample clip vs live mic vs scripted timeline — start
  with a scripted timeline (deterministic, no mic) + optional live mic.

## Workflow

Branch `feat/satellite-voice-dictation` / PR #79. Commit per part; build +
reinstall each step. Land Part E (instant placeholder) + the lab page first so
tuning is possible, then the full onset→word alignment.
