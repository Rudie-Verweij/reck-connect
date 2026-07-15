// Voice-dictation diagnostic self-test, exposed as
// `window.reckDictationSelfTest`. Two consumers:
//   - the e2e-electron dictation spec, which runs these checks in the real
//     built app (with Chromium's fake media device) to catch end-to-end
//     breakage no jsdom unit test can see;
//   - a human in DevTools: `await reckDictationSelfTest.run()` prints a
//     structured report of exactly which layer is broken.
//
// Every check returns facts instead of throwing, so one dead layer doesn't
// hide the state of the others.

import { AudioCapture } from "./AudioCapture";
import { rms, WHISPER_SAMPLE_RATE } from "./pcm";
import { DeepgramProvider } from "./providers/DeepgramProvider";
import { LocalWhisperProvider } from "./providers/LocalWhisperProvider";
import type { Transcriber } from "./providers/types";
import { saveDeepgramKey } from "./transcriptionSettings";

export interface CaptureReport {
  ok: boolean;
  sampleRate: number;
  chunks: number;
  totalSamples: number;
  /** Peak per-chunk RMS seen — silence bug shows up as ~0 here. */
  maxRms: number;
  error?: string;
}

export interface WhisperReport {
  ok: boolean;
  repo: string;
  ready: boolean;
  prepareMs: number;
  transcribeMs: number;
  finalText: string | null;
  partials: string[];
  progressTicks: number;
  error?: string;
}

export interface DeepgramReport {
  ok: boolean;
  partials: string[];
  finalText: string | null;
  errors: string[];
  /** Raw main-process lifecycle lines (kind:"debug" events). */
  debug: string[];
  error?: string;
}

function sine(seconds: number, hz = 440, rate = WHISPER_SAMPLE_RATE, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Open the real mic pipeline for `ms` and report whether audio flows. */
async function capture(ms = 1500): Promise<CaptureReport> {
  const report: CaptureReport = {
    ok: false,
    sampleRate: 0,
    chunks: 0,
    totalSamples: 0,
    maxRms: 0,
  };
  const cap = new AudioCapture({
    onChunk: (chunk) => {
      report.chunks++;
      report.totalSamples += chunk.length;
      const level = rms(chunk);
      if (level > report.maxRms) report.maxRms = level;
    },
    onError: (err) => {
      report.error = msg(err);
    },
  });
  try {
    await withTimeout(cap.start(), 10_000, "AudioCapture.start");
    report.sampleRate = cap.getSampleRate();
    await new Promise((r) => setTimeout(r, ms));
    const { samples } = await withTimeout(cap.stop(), 5_000, "AudioCapture.stop");
    if (samples.length > report.totalSamples) report.totalSamples = samples.length;
    // "Audio flows" = we got chunks and at least ambient noise level. The
    // fake test device plays a loud tone; a real mic in a quiet room still
    // sits well above true digital silence.
    report.ok = report.chunks > 0 && report.maxRms > 1e-6;
  } catch (err) {
    report.error = msg(err);
    try {
      await cap.stop();
    } catch {
      // Already torn down.
    }
  }
  return report;
}

/** Load a local Whisper model and transcribe a synthetic tone end to end. */
async function whisper(repo = "Xenova/whisper-tiny", timeoutMs = 240_000): Promise<WhisperReport> {
  const report: WhisperReport = {
    ok: false,
    repo,
    ready: false,
    prepareMs: -1,
    transcribeMs: -1,
    finalText: null,
    partials: [],
    progressTicks: 0,
  };
  const provider: Transcriber = new LocalWhisperProvider(repo);
  const handlers = {
    onPartial: (t: string) => {
      report.partials.push(t);
    },
    onFinal: (t: string) => {
      report.finalText = t;
    },
    onProgress: () => {
      report.progressTicks++;
    },
    onError: (m: string) => {
      report.error = report.error ? `${report.error}; ${m}` : m;
    },
  };
  try {
    const t0 = performance.now();
    await withTimeout(provider.prepare(handlers), timeoutMs, `prepare(${repo})`);
    report.prepareMs = Math.round(performance.now() - t0);
    report.ready = true;

    await provider.begin(handlers, WHISPER_SAMPLE_RATE);
    const audio = sine(1.5);
    // Feed once so the voice-activity gate opens, then finalize.
    provider.feed(audio, WHISPER_SAMPLE_RATE);
    const t1 = performance.now();
    await withTimeout(provider.end(audio, WHISPER_SAMPLE_RATE), 120_000, "transcribe");
    report.transcribeMs = Math.round(performance.now() - t1);
    // A pure tone rarely yields words; success = the pipeline COMPLETED
    // (model loaded, ORT session ran, a final arrived) without erroring.
    report.ok = report.finalText !== null && !report.error;
  } catch (err) {
    report.error = report.error ?? msg(err);
  } finally {
    provider.dispose();
  }
  return report;
}

/** Stream a synthetic tone through the Deepgram path and report every event. */
async function deepgram(key?: string, seconds = 2): Promise<DeepgramReport> {
  const report: DeepgramReport = {
    ok: false,
    partials: [],
    finalText: null,
    errors: [],
    debug: [],
  };
  // Record raw router events (incl. main-process debug lines) alongside the
  // provider's interpreted view.
  const unsub = window.reckAPI.transcription.onEvent((ev) => {
    if (ev.kind === "debug") report.debug.push(ev.text);
  });
  const provider: Transcriber = new DeepgramProvider();
  const handlers = {
    onPartial: (t: string) => {
      report.partials.push(t);
    },
    onFinal: (t: string) => {
      report.finalText = t;
    },
    onError: (m: string) => {
      report.errors.push(m);
    },
  };
  try {
    if (key) await saveDeepgramKey(key);
    await provider.prepare(handlers);
    await withTimeout(provider.begin(handlers, WHISPER_SAMPLE_RATE), 15_000, "deepgram begin");
    // ~4 frames/s of 250ms tone frames, like live capture would send.
    const frame = sine(0.25);
    const frames = Math.ceil(seconds / 0.25);
    for (let i = 0; i < frames; i++) {
      provider.feed(frame, WHISPER_SAMPLE_RATE);
      await new Promise((r) => setTimeout(r, 250));
    }
    await withTimeout(
      provider.end(new Float32Array(0), WHISPER_SAMPLE_RATE),
      10_000,
      "deepgram end",
    );
    report.ok = report.errors.length === 0 && report.finalText !== null;
  } catch (err) {
    report.errors.push(msg(err));
  } finally {
    unsub();
    provider.dispose();
  }
  return report;
}

async function run(opts: { deepgramKey?: string; whisperRepo?: string } = {}): Promise<{
  capture: CaptureReport;
  whisper: WhisperReport;
  deepgram: DeepgramReport;
}> {
  const cap = await capture();
  console.log("[dictation-selftest] capture:", cap);
  const wh = await whisper(opts.whisperRepo);
  console.log("[dictation-selftest] whisper:", wh);
  const dg = await deepgram(opts.deepgramKey);
  console.log("[dictation-selftest] deepgram:", dg);
  return { capture: cap, whisper: wh, deepgram: dg };
}

export const dictationSelfTest = { capture, whisper, deepgram, run };

declare global {
  interface Window {
    reckDictationSelfTest: typeof dictationSelfTest;
  }
}

export function registerDictationSelfTest(): void {
  window.reckDictationSelfTest = dictationSelfTest;
}
