import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TtsEngine,
  clampRate,
  snapRate,
  sanitizeUtteranceText,
  DEGENERATE_ZERO_BOUNDARY_THRESHOLD,
  type SpokenChunk,
  type TtsBoundary,
} from "./TtsEngine";

class StubUtterance extends EventTarget {
  text = "";
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = "";
  onboundary: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onend: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((ev: SpeechSynthesisErrorEvent) => void) | null = null;
  onstart: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onpause: ((ev: SpeechSynthesisEvent) => void) | null = null;
  onresume: ((ev: SpeechSynthesisEvent) => void) | null = null;

  fireBoundary(charIndex: number, charLength: number, name = "word") {
    const ev = {
      name,
      charIndex,
      charLength,
      elapsedTime: 0,
      utterance: this,
    } as unknown as SpeechSynthesisEvent;
    this.dispatchEvent(new Event("boundary"));
    if (this.onboundary) this.onboundary(ev);
  }

  fireEnd() {
    const ev = { utterance: this } as unknown as SpeechSynthesisEvent;
    this.dispatchEvent(new Event("end"));
    if (this.onend) this.onend(ev);
  }

  fireError(error: string) {
    const ev = {
      error,
      utterance: this,
    } as unknown as SpeechSynthesisErrorEvent;
    this.dispatchEvent(new Event("error"));
    if (this.onerror) this.onerror(ev);
  }
}

class StubSynth extends EventTarget {
  speaking = false;
  paused = false;
  pending = false;
  spoken: StubUtterance[] = [];
  cancelCount = 0;
  pauseCount = 0;
  resumeCount = 0;
  voices: SpeechSynthesisVoice[] = [];

  speak(u: StubUtterance) {
    this.spoken.push(u);
    this.speaking = true;
    this.paused = false;
  }
  cancel() {
    this.cancelCount++;
    this.speaking = false;
    this.paused = false;
  }
  pause() {
    this.pauseCount++;
    this.paused = true;
  }
  resume() {
    this.resumeCount++;
    this.paused = false;
  }
  getVoices() {
    return this.voices;
  }
  fireVoicesChanged() {
    this.dispatchEvent(new Event("voiceschanged"));
  }
}

function chunkOfWords(words: string[]): SpokenChunk {
  // Each word on its own line, col 0, separated by space.
  const text = words.join(" ");
  const rangeMap = [];
  let cursor = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    rangeMap.push({
      charStart: cursor,
      charEnd: cursor + w.length,
      line: i,
      col: 0,
      len: w.length,
    });
    cursor += w.length + 1; // +1 for separating space
  }
  return { text, rangeMap };
}

function makeEngine(synth: StubSynth, opts: { restartDebounceMs?: number } = {}) {
  return new TtsEngine({
    synth: synth as unknown as SpeechSynthesis,
    UtteranceCtor: StubUtterance as unknown as typeof SpeechSynthesisUtterance,
    heartbeatIntervalMs: 100,
    // Default to 0 so existing tests keep their synchronous semantics;
    // the dedicated rapid-drag test below opts back into the real default.
    restartDebounceMs: opts.restartDebounceMs ?? 0,
  });
}

describe("clampRate", () => {
  it("clamps below 0.5 to 0.5", () => {
    expect(clampRate(0.1)).toBe(0.5);
  });
  it("clamps above 6.0 to 6.0", () => {
    expect(clampRate(8.5)).toBe(6.0);
  });
  it("passes through in-range values", () => {
    expect(clampRate(1.25)).toBe(1.25);
    expect(clampRate(4.5)).toBe(4.5);
  });
});

describe("snapRate", () => {
  it("snaps to nearest 0.05", () => {
    expect(snapRate(0.92)).toBe(0.9);
    expect(snapRate(0.93)).toBe(0.95);
  });
  it("returns clean decimals (no float artefacts)", () => {
    expect(snapRate(1.05)).toBe(1.05);
    expect(snapRate(1.25)).toBe(1.25);
    expect(snapRate(1.7)).toBe(1.7);
    expect(snapRate(3.35)).toBe(3.35);
    expect(snapRate(5.95)).toBe(5.95);
  });
  it("clamps and snaps in one call", () => {
    expect(snapRate(0.21)).toBe(0.5);
    expect(snapRate(7.99)).toBe(6.0);
  });
});

describe("TtsEngine.start", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => {
    engine.dispose();
  });

  it("creates an utterance and calls speak with the chunk text", () => {
    const chunk = chunkOfWords(["hello", "world"]);
    engine.start(chunk);

    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text).toBe("hello world");
  });

  it("applies the rate option, snapped to 0.05", () => {
    engine.start(chunkOfWords(["a"]), { rate: 1.23 });
    expect(synth.spoken[0].rate).toBe(1.25);
  });

  it("defaults the rate to 1.0 when not provided", () => {
    engine.start(chunkOfWords(["a"]));
    expect(synth.spoken[0].rate).toBe(1.0);
  });

  it("applies the voice option when provided", () => {
    const voice = { name: "Samantha", lang: "en-US" } as SpeechSynthesisVoice;
    engine.start(chunkOfWords(["a"]), { voice });
    expect(synth.spoken[0].voice).toBe(voice);
  });

  it("cancels a previous utterance when start is re-invoked", () => {
    engine.start(chunkOfWords(["one"]));
    expect(synth.cancelCount).toBe(0);
    engine.start(chunkOfWords(["two"]));
    expect(synth.cancelCount).toBe(1);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toBe("two");
  });
});

describe("TtsEngine.stop / pause / resume", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => {
    engine.dispose();
  });

  it("stop() cancels the synth", () => {
    engine.start(chunkOfWords(["a"]));
    engine.stop();
    expect(synth.cancelCount).toBe(1);
  });

  it("pause() pauses the synth", () => {
    engine.start(chunkOfWords(["a"]));
    engine.pause();
    expect(synth.pauseCount).toBe(1);
  });

  it("resume() resumes the synth", () => {
    engine.start(chunkOfWords(["a"]));
    engine.pause();
    engine.resume();
    expect(synth.resumeCount).toBe(1);
  });

  it("isSpeaking reflects synth.speaking", () => {
    engine.start(chunkOfWords(["a"]));
    expect(engine.isSpeaking()).toBe(true);
    synth.speaking = false;
    expect(engine.isSpeaking()).toBe(false);
  });

  it("isPaused reflects synth.paused", () => {
    engine.start(chunkOfWords(["a"]));
    engine.pause();
    expect(engine.isPaused()).toBe(true);
    engine.resume();
    expect(engine.isPaused()).toBe(false);
  });
});

describe("TtsEngine boundary mapping", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => engine.dispose());

  it("emits a 'boundary' event with mapped line/col/len for word events", () => {
    const events: TtsBoundary[] = [];
    engine.on("boundary", (b) => events.push(b));

    const chunk = chunkOfWords(["alpha", "beta", "gamma"]);
    engine.start(chunk);
    const utt = synth.spoken[0];

    utt.fireBoundary(0, 5);
    utt.fireBoundary(6, 4);
    utt.fireBoundary(11, 5);

    expect(events).toEqual([
      { line: 0, col: 0, len: 5, word: "alpha", charIndex: 0 },
      { line: 1, col: 0, len: 4, word: "beta", charIndex: 6 },
      { line: 2, col: 0, len: 5, word: "gamma", charIndex: 11 },
    ]);
  });

  it("ignores non-word boundary events (e.g. sentence)", () => {
    const events: TtsBoundary[] = [];
    engine.on("boundary", (b) => events.push(b));
    engine.start(chunkOfWords(["alpha"]));
    synth.spoken[0].fireBoundary(0, 5, "sentence");
    expect(events).toEqual([]);
  });

  it("falls back to the next-best rangemap entry when charIndex falls in a gap", () => {
    // Construct a chunk with a deliberate gap (e.g. punctuation between words).
    const chunk: SpokenChunk = {
      text: "alpha, beta",
      rangeMap: [
        { charStart: 0, charEnd: 5, line: 0, col: 0, len: 5 },
        { charStart: 7, charEnd: 11, line: 0, col: 7, len: 4 },
      ],
    };
    const events: TtsBoundary[] = [];
    engine.on("boundary", (b) => events.push(b));

    engine.start(chunk);
    // charIndex 5 (the comma) — no exact entry; engine should ignore (no mapping).
    synth.spoken[0].fireBoundary(5, 1);
    expect(events).toEqual([]);

    // charIndex 7 — exact match.
    synth.spoken[0].fireBoundary(7, 4);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ line: 0, col: 7, len: 4, word: "beta" });
  });
});

describe("TtsEngine 'end' and 'error' events", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => engine.dispose());

  it("fires 'end' when the utterance ends", () => {
    const ends: number[] = [];
    engine.on("end", () => ends.push(1));
    engine.start(chunkOfWords(["a"]));
    synth.spoken[0].fireEnd();
    expect(ends).toEqual([1]);
  });

  it("fires 'error' when the utterance errors", () => {
    const errs: string[] = [];
    engine.on("error", (e) => errs.push(e.message));
    engine.start(chunkOfWords(["a"]));
    synth.spoken[0].fireError("network");
    expect(errs).toEqual(["network"]);
  });

  it("does not fire 'end' for a cancelled utterance after a restart", () => {
    const ends: number[] = [];
    engine.on("end", () => ends.push(1));
    engine.start(chunkOfWords(["one"]));
    const first = synth.spoken[0];
    engine.start(chunkOfWords(["two"]));
    // Browsers fire 'end' on the cancelled utterance — engine must suppress it.
    first.fireEnd();
    expect(ends).toEqual([]);
    // The second utterance's end should still fire.
    synth.spoken[1].fireEnd();
    expect(ends).toEqual([1]);
  });
});

describe("TtsEngine setRate while speaking", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => engine.dispose());

  it("snaps and stores the new rate", () => {
    engine.setRate(1.27);
    expect(engine.getRate()).toBe(1.25);
  });

  it("applies on the next start()", () => {
    engine.setRate(1.5);
    engine.start(chunkOfWords(["a"]));
    expect(synth.spoken[0].rate).toBe(1.5);
  });

  it("starts at default 1.0", () => {
    expect(engine.getRate()).toBe(1.0);
  });

  it("does NOT restart utterance when not speaking", () => {
    engine.setRate(1.5);
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancelCount).toBe(0);
  });

  it("restarts the utterance with new rate when called WHILE speaking", () => {
    engine.start(chunkOfWords(["alpha", "beta", "gamma"]));
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].rate).toBe(1.0);

    // Pretend we just heard a boundary at the start of "beta" (charIndex=6).
    synth.spoken[0].fireBoundary(6, 4);

    engine.setRate(1.75);
    // Engine should have cancelled and re-spoken with the new rate.
    expect(synth.cancelCount).toBe(1);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].rate).toBe(1.75);
  });

  it("restart slices the spoken text from the last boundary onward", () => {
    const chunk = chunkOfWords(["alpha", "beta", "gamma"]);
    engine.start(chunk);
    synth.spoken[0].fireBoundary(6, 4); // "beta"
    engine.setRate(1.5);
    // Remaining text should be "beta gamma" (from charIndex 6 onward).
    expect(synth.spoken[1].text).toBe("beta gamma");
  });

  it("restart preserves the voice from the original utterance", () => {
    const voice = { name: "Samantha", lang: "en-US" } as SpeechSynthesisVoice;
    engine.start(chunkOfWords(["alpha", "beta"]), { voice });
    synth.spoken[0].fireBoundary(0, 5);
    engine.setRate(1.4);
    expect(synth.spoken[1].voice).toBe(voice);
  });

  it("does NOT restart when the new rate equals the current rate", () => {
    engine.start(chunkOfWords(["alpha"]), { rate: 1.5 });
    engine.setRate(1.5);
    expect(synth.cancelCount).toBe(0);
    expect(synth.spoken).toHaveLength(1);
  });

  it("does NOT fire 'end' for the cancelled utterance during a rate-change restart", () => {
    const ends: number[] = [];
    engine.on("end", () => ends.push(1));
    engine.start(chunkOfWords(["alpha", "beta"]));
    synth.spoken[0].fireBoundary(0, 5);
    engine.setRate(1.5);
    // The cancelled utterance must NOT bubble its 'end' to listeners.
    synth.spoken[0].fireEnd();
    expect(ends).toEqual([]);
    // The new utterance ending should still fire.
    synth.spoken[1].fireEnd();
    expect(ends).toEqual([1]);
  });

  it("uses charIndex 0 if no boundary has fired yet (restart from beginning)", () => {
    engine.start(chunkOfWords(["alpha", "beta", "gamma"]));
    // No boundary fired — last position is the start of the utterance.
    engine.setRate(1.5);
    expect(synth.spoken[1].text).toBe("alpha beta gamma");
  });
});

describe("TtsEngine setRate debounce (rapid drag coalescing)", () => {
  it("coalesces N rapid setRate calls within the debounce window into one restart", () => {
    vi.useFakeTimers();
    try {
      const synth = new StubSynth();
      const engine = makeEngine(synth, { restartDebounceMs: 60 });
      engine.start(chunkOfWords(["alpha", "beta", "gamma"]));
      synth.spoken[0].fireBoundary(0, 5);
      // Simulate rapid slider drag.
      engine.setRate(1.5);
      engine.setRate(1.7);
      engine.setRate(2.0);
      engine.setRate(2.4);
      // Within the debounce window — no restart yet.
      expect(synth.cancelCount).toBe(0);
      expect(synth.spoken).toHaveLength(1);
      vi.advanceTimersByTime(80);
      // After window — exactly ONE restart, with the LAST rate.
      expect(synth.cancelCount).toBe(1);
      expect(synth.spoken).toHaveLength(2);
      expect(synth.spoken[1].rate).toBe(2.4);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("getRate() reflects the latest rate immediately, even before the restart fires", () => {
    vi.useFakeTimers();
    try {
      const synth = new StubSynth();
      const engine = makeEngine(synth, { restartDebounceMs: 60 });
      engine.start(chunkOfWords(["alpha"]));
      engine.setRate(1.7);
      // The rate is updated immediately so the slider/UI stays in sync,
      // even though the engine restart is debounced.
      expect(engine.getRate()).toBe(1.7);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TtsEngine 10-second stall workaround (heartbeat)", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    synth = new StubSynth();
    engine = makeEngine(synth); // heartbeat 100ms in test
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it("calls pause+resume on a heartbeat cadence while speaking", () => {
    engine.start(chunkOfWords(["a"]));
    expect(synth.pauseCount).toBe(0);
    vi.advanceTimersByTime(100);
    expect(synth.pauseCount).toBe(1);
    expect(synth.resumeCount).toBe(1);
    vi.advanceTimersByTime(100);
    expect(synth.pauseCount).toBe(2);
    expect(synth.resumeCount).toBe(2);
  });

  it("does NOT heartbeat after stop()", () => {
    engine.start(chunkOfWords(["a"]));
    engine.stop();
    const beforePauses = synth.pauseCount;
    vi.advanceTimersByTime(500);
    expect(synth.pauseCount).toBe(beforePauses);
  });

  it("does NOT heartbeat while user-initiated pause is active", () => {
    engine.start(chunkOfWords(["a"]));
    engine.pause();
    const beforePauses = synth.pauseCount;
    const beforeResumes = synth.resumeCount;
    vi.advanceTimersByTime(500);
    // No additional pause/resume from heartbeat — would un-pause the user.
    expect(synth.pauseCount).toBe(beforePauses);
    expect(synth.resumeCount).toBe(beforeResumes);
  });
});

describe("TtsEngine voice loading", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => engine.dispose());

  it("returns the current voices when populated", async () => {
    synth.voices = [{ name: "Samantha" } as SpeechSynthesisVoice];
    const voices = await engine.getVoices();
    expect(voices).toHaveLength(1);
  });

  it("waits for voiceschanged when initially empty", async () => {
    synth.voices = [];
    const promise = engine.getVoices();
    // Schedule the event after the promise is awaited.
    queueMicrotask(() => {
      synth.voices = [{ name: "Daniel" } as SpeechSynthesisVoice];
      synth.fireVoicesChanged();
    });
    const voices = await promise;
    expect(voices).toHaveLength(1);
    expect(voices[0].name).toBe("Daniel");
  });
});

describe("TtsEngine.dispose", () => {
  it("removes listeners and stops heartbeat", () => {
    vi.useFakeTimers();
    const synth = new StubSynth();
    const engine = makeEngine(synth);
    engine.start(chunkOfWords(["a"]));
    engine.dispose();
    const before = synth.pauseCount;
    vi.advanceTimersByTime(500);
    expect(synth.pauseCount).toBe(before);
    vi.useRealTimers();
  });
});

// ── Utterance sanitization + degenerate-boundary guard ──
//
// macOS speech synthesis reports charIndex=0 for EVERY word boundary of
// the whole utterance when the text contains U+2260 "≠" (probe-verified;
// position-independent, single occurrence suffices). The
// engine therefore (a) strips verified-poison chars from the SPOKEN
// string — length-preserving so rangeMap offsets stay aligned — and
// (b) detects the degenerate all-zeros boundary shape at runtime for
// poison chars we haven't met yet.

describe("sanitizeUtteranceText", () => {
  it("replaces ≠ with a single space, preserving length", () => {
    const input = "lookup library ≠ analysis results";
    const result = sanitizeUtteranceText(input);
    expect(result).toBe("lookup library   analysis results");
    expect(result.length).toBe(input.length);
    expect(result).not.toContain("≠");
  });

  it("returns clean text unchanged", () => {
    const input = "plain text — with safe specials → like these ≤ ones";
    expect(sanitizeUtteranceText(input)).toBe(input);
  });

  it("replaces every occurrence", () => {
    const input = "a ≠ b ≠ c";
    const result = sanitizeUtteranceText(input);
    expect(result).not.toContain("≠");
    expect(result.length).toBe(input.length);
  });
});

describe("TtsEngine utterance sanitization", () => {
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => engine.dispose());

  it("speaks the sanitized text, not the original", () => {
    const chunk = chunkOfWords(["alpha", "≠", "bravo"]);
    engine.start(chunk);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text).not.toContain("≠");
    expect(synth.spoken[0].text.length).toBe(chunk.text.length);
  });

  it("boundary events after the poison char still map to the original words", () => {
    const chunk = chunkOfWords(["alpha", "≠", "bravo"]);
    engine.start(chunk);
    const heard: TtsBoundary[] = [];
    engine.on("boundary", (b) => heard.push(b));
    // "bravo" starts at charIndex 8 ("alpha ≠ bravo") — same offset in
    // the sanitized string because the replacement is length-preserving.
    synth.spoken[0].fireBoundary(8, 5);
    expect(heard).toHaveLength(1);
    expect(heard[0].word).toBe("bravo");
  });
});

const spyOnWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("TtsEngine degenerate-boundary guard", () => {
  let synth: StubSynth;
  let engine: TtsEngine;
  let warnSpy: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
    warnSpy = spyOnWarn();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    engine.dispose();
  });

  function fireZeros(utt: StubUtterance, n: number) {
    for (let i = 0; i < n; i++) utt.fireBoundary(0, 5);
  }

  it("emits 'degenerate' once and warns after the threshold of consecutive zero boundaries", () => {
    engine.start(chunkOfWords(["alpha", "bravo", "charlie"]));
    let degenerate = 0;
    engine.on("degenerate", () => degenerate++);
    fireZeros(synth.spoken[0], DEGENERATE_ZERO_BOUNDARY_THRESHOLD);
    expect(degenerate).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // More zeros do not re-fire.
    fireZeros(synth.spoken[0], 5);
    expect(degenerate).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses boundary emission once degenerate", () => {
    engine.start(chunkOfWords(["alpha", "bravo", "charlie"]));
    const heard: TtsBoundary[] = [];
    engine.on("boundary", (b) => heard.push(b));
    fireZeros(synth.spoken[0], DEGENERATE_ZERO_BOUNDARY_THRESHOLD);
    const emittedBeforeDegenerate = heard.length;
    synth.spoken[0].fireBoundary(6, 5); // would be "bravo" in a healthy stream
    expect(heard.length).toBe(emittedBeforeDegenerate);
  });

  it("a progressing boundary resets the zero streak", () => {
    engine.start(chunkOfWords(["alpha", "bravo", "charlie"]));
    let degenerate = 0;
    engine.on("degenerate", () => degenerate++);
    fireZeros(synth.spoken[0], DEGENERATE_ZERO_BOUNDARY_THRESHOLD - 1);
    synth.spoken[0].fireBoundary(6, 5); // healthy progression
    fireZeros(synth.spoken[0], DEGENERATE_ZERO_BOUNDARY_THRESHOLD - 1);
    expect(degenerate).toBe(0);
  });

  it("resets the guard for each new utterance", () => {
    engine.start(chunkOfWords(["alpha", "bravo"]));
    fireZeros(synth.spoken[0], DEGENERATE_ZERO_BOUNDARY_THRESHOLD);
    engine.start(chunkOfWords(["charlie", "delta"]));
    const heard: TtsBoundary[] = [];
    engine.on("boundary", (b) => heard.push(b));
    synth.spoken[1].fireBoundary(0, 7);
    expect(heard).toHaveLength(1);
    expect(heard[0].word).toBe("charlie");
  });
});
