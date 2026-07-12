import { test, expect } from "@playwright/test";
import { launchApp, LaunchedApp } from "./harness";
import type {
  CaptureReport,
  DeepgramReport,
  WhisperReport,
} from "../renderer/src/transcription/selfTest";

/**
 * End-to-end dictation diagnostics. Runs the renderer's
 * `window.reckDictationSelfTest` inside the real built app, with Chromium's
 * fake media device standing in for the mic (a generated tone — loud,
 * deterministic, no OS permission prompt).
 *
 * These tests exist because the dictation stack failed silently in ways no
 * jsdom unit test could see (audio-graph silence, ONNX/WASM loading in the
 * packaged renderer, Deepgram socket lifecycle). If a layer breaks again,
 * the failing assertion names it.
 *
 * The Whisper test downloads Xenova/whisper-tiny (~40 MB) into the
 * test-scoped profile on each run — slow but honest.
 */

const FAKE_MEDIA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ args: FAKE_MEDIA_ARGS });
  // The self-test hook is registered at the top of boot().
  await launched.window.waitForFunction(
    () => Boolean((window as never as { reckDictationSelfTest?: unknown }).reckDictationSelfTest),
    undefined,
    { timeout: 15_000 },
  );
});

test.afterAll(async () => {
  await launched?.close();
});

test("mic capture actually produces audio (worklet + audio graph)", async () => {
  const report = await launched.window.evaluate<CaptureReport>(() =>
    window.reckDictationSelfTest.capture(1500),
  );
  expect(report.error, `capture error: ${report.error}`).toBeUndefined();
  expect(report.sampleRate).toBeGreaterThan(0);
  expect(report.chunks).toBeGreaterThan(0);
  // The fake device plays a loud tone; anywhere near digital silence means
  // the capture graph is broken (e.g. sample-rate mismatch muting the
  // MediaStream source).
  expect(
    report.maxRms,
    `audio is silent (maxRms=${report.maxRms}) — capture graph is not passing sound`,
  ).toBeGreaterThan(0.01);
});

test("local whisper loads and completes a transcription", async () => {
  test.setTimeout(360_000);
  const report = await launched.window.evaluate<WhisperReport>(
    () => window.reckDictationSelfTest.whisper("Xenova/whisper-tiny"),
    undefined,
  );
  expect(report.error, `whisper error: ${report.error}`).toBeUndefined();
  expect(report.ready, "model never became ready").toBe(true);
  expect(report.finalText, "no final transcription arrived").not.toBeNull();
  // Speed regression guard: tiny on 1.5s of audio must not take the ~8s+
  // the graph-optimization-disabled path did. Generous bound for CI noise.
  expect(
    report.transcribeMs,
    `transcription took ${report.transcribeMs}ms — optimization regression?`,
  ).toBeLessThan(6_000);
});

test("deepgram without a key fails loudly, not silently", async () => {
  const report = await launched.window.evaluate<DeepgramReport>(() =>
    window.reckDictationSelfTest.deepgram(),
  );
  // The whole bug class here was silent failure. No key configured must
  // produce an explicit, human-readable error.
  expect(report.errors.length, "no error surfaced for a keyless session").toBeGreaterThan(0);
  expect(report.errors.join(" ")).toMatch(/deepgram api key/i);
});

// Full cloud round-trip — only when a key is provided (needs network + quota).
// Run: DEEPGRAM_TEST_KEY=... pnpm test:e2e:electron
test("deepgram streams audio end to end (requires DEEPGRAM_TEST_KEY)", async () => {
  test.skip(!process.env.DEEPGRAM_TEST_KEY, "DEEPGRAM_TEST_KEY not set");
  test.setTimeout(60_000);
  const report = await launched.window.evaluate<DeepgramReport, string>(
    (key) => window.reckDictationSelfTest.deepgram(key, 2),
    process.env.DEEPGRAM_TEST_KEY!,
  );
  expect(report.errors, `deepgram errors: ${report.errors.join("; ")}`).toEqual([]);
  // The debug stream proves the socket opened and audio left the process.
  expect(report.debug.join("\n")).toMatch(/connection open/);
  expect(report.debug.join("\n")).toMatch(/closed .*after [1-9]\d* frames/);
  // A pure tone won't produce words, but the session must finalize cleanly.
  expect(report.finalText).not.toBeNull();
});
