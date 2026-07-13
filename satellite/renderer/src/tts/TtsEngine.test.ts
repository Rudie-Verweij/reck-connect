import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TtsEngine,
  clampRate,
  snapRate,
  sanitizeUtteranceText,
  segmentText,
  MAX_UTTERANCE_CHARS,
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

  // Spec-faithful paused semantics: pause() pauses the GLOBAL queue, and
  // neither speak() nor cancel() unpauses it — only resume() does. (This
  // is exactly the trap the paused-queue wedge tests below exercise.)
  speak(u: StubUtterance) {
    this.spoken.push(u);
    this.speaking = true;
  }
  cancel() {
    this.cancelCount++;
    this.speaking = false;
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

describe("TtsEngine paused-queue wedge (pause → cancel → speak)", () => {
  // pause() pauses the GLOBAL SpeechSynthesis queue and cancel() empties
  // the queue WITHOUT unpausing it. So pause → stop/re-speak used to leave
  // the queue paused forever: every later speak() (any surface, any pane)
  // sat silently queued until app restart, and the heartbeat couldn't
  // rescue it because a never-started utterance has speaking === false.
  // The engine must therefore clear the paused state whenever it cancels.
  let synth: StubSynth;
  let engine: TtsEngine;

  beforeEach(() => {
    synth = new StubSynth();
    engine = makeEngine(synth);
  });

  afterEach(() => engine.dispose());

  it("stop() while paused clears the global paused state", () => {
    engine.start(chunkOfWords(["a", "b"]));
    engine.pause();
    engine.stop();
    expect(synth.paused).toBe(false);
  });

  it("start() while paused un-wedges the queue so the new utterance can play", () => {
    engine.start(chunkOfWords(["a", "b"]));
    engine.pause();
    engine.start(chunkOfWords(["c", "d"]));
    expect(synth.paused).toBe(false);
    expect(synth.spoken).toHaveLength(2);
  });

  it("start() clears a paused queue even with no current utterance (ended while paused)", () => {
    engine.start(chunkOfWords(["a"]));
    engine.pause();
    synth.spoken[0].fireEnd(); // engine drops currentUtt; queue stays paused
    engine.start(chunkOfWords(["b"]));
    expect(synth.paused).toBe(false);
    expect(synth.spoken).toHaveLength(2);
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

describe("segmentText", () => {
  it("returns one segment when text fits", () => {
    expect(segmentText("hello world", 100)).toEqual([{ start: 0, end: 11 }]);
  });

  it("returns no segments for empty text", () => {
    expect(segmentText("", 100)).toEqual([]);
  });

  it("splits on whitespace so words are never cut, covering the whole string", () => {
    const text = "aaaa bbbb cccc dddd";
    const segs = segmentText(text, 10);
    expect(segs.length).toBeGreaterThan(1);
    // Contiguous cover of [0, n) — concatenation reconstitutes the text.
    expect(segs[0].start).toBe(0);
    expect(segs[segs.length - 1].end).toBe(text.length);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBe(segs[i - 1].end);
    }
    expect(segs.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(10);
  });

  it("hard-splits a single token longer than the cap", () => {
    const segs = segmentText("xxxxxxxxxxxx", 5); // 12 x's, no whitespace
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(5);
    expect(segs.map((s) => "xxxxxxxxxxxx".slice(s.start, s.end)).join("")).toBe(
      "xxxxxxxxxxxx",
    );
  });

  it("has a sane production cap", () => {
    expect(MAX_UTTERANCE_CHARS).toBeGreaterThan(0);
    expect(MAX_UTTERANCE_CHARS).toBeLessThanOrEqual(32000);
  });
});

describe("utterance segmentation (long tool payloads must not wedge)", () => {
  let synth: StubSynth;
  beforeEach(() => {
    synth = new StubSynth();
  });

  function makeEngineCapped(max: number) {
    return new TtsEngine({
      synth: synth as unknown as SpeechSynthesis,
      UtteranceCtor: StubUtterance as unknown as typeof SpeechSynthesisUtterance,
      heartbeatIntervalMs: 100,
      restartDebounceMs: 0,
      maxUtteranceChars: max,
    });
  }

  /** Fire end on the latest utterance until no new segment is chained. */
  function drain() {
    let prev = -1;
    for (let g = 0; g < 200 && synth.spoken.length !== prev; g++) {
      prev = synth.spoken.length;
      synth.spoken[synth.spoken.length - 1].fireEnd();
    }
  }

  it("speaks a big chunk as several bounded utterances, one at a time", () => {
    const engine = makeEngineCapped(10);
    const chunk = chunkOfWords(["aaaa", "bbbb", "cccc", "dddd"]); // 19 chars
    engine.start(chunk);
    // Only the first segment is queued up front — the rest chain on end.
    expect(synth.spoken).toHaveLength(1);
    drain();
    expect(synth.spoken.length).toBeGreaterThan(1);
    for (const u of synth.spoken) expect(u.text.length).toBeLessThanOrEqual(10);
    // The segments reconstitute the original spoken text exactly.
    expect(synth.spoken.map((u) => u.text).join("")).toBe(chunk.text);
  });

  it("fires 'end' to listeners only once, after the LAST segment", () => {
    const engine = makeEngineCapped(10);
    let ended = 0;
    engine.on("end", () => ended++);
    engine.start(chunkOfWords(["aaaa", "bbbb", "cccc", "dddd"]));
    // Draining every segment fires 'end' exactly once (after the last).
    drain();
    expect(ended).toBe(1);
  });

  it("maps a boundary in a later segment back to the right word (segBase offset)", () => {
    const engine = makeEngineCapped(10);
    const heard: TtsBoundary[] = [];
    engine.on("boundary", (b) => heard.push(b));
    // "aaaa bbbb cccc dddd" → seg0 "aaaa bbbb ", seg1 "cccc dddd".
    engine.start(chunkOfWords(["aaaa", "bbbb", "cccc", "dddd"]));
    expect(synth.spoken).toHaveLength(1);
    synth.spoken[0].fireEnd(); // advance to seg1 (segBase = 10)
    expect(synth.spoken).toHaveLength(2);
    synth.spoken[1].fireBoundary(0, 4); // rel 0 in seg1 → abs 10 → "cccc"
    expect(heard).toHaveLength(1);
    expect(heard[0].word).toBe("cccc");
  });

  it("a short chunk still speaks as exactly one utterance", () => {
    const engine = makeEngineCapped(MAX_UTTERANCE_CHARS);
    engine.start(chunkOfWords(["alpha", "bravo"]));
    expect(synth.spoken).toHaveLength(1);
    drain();
    expect(synth.spoken).toHaveLength(1);
  });

  it("holds the next segment when a pause races a segment end, then speaks it on resume (no wedge)", () => {
    const engine = makeEngineCapped(10);
    engine.start(chunkOfWords(["aaaa", "bbbb", "cccc", "dddd"])); // 2 segments
    expect(synth.spoken).toHaveLength(1);
    // User pauses just as segment 0 finishes — pause() lands, then the
    // browser still delivers the finishing utterance's end.
    engine.pause();
    expect(synth.paused).toBe(true);
    synth.spoken[0].fireEnd();
    // Segment 1 must NOT be pushed into the paused queue (that wedges forever).
    expect(synth.spoken).toHaveLength(1);
    expect(synth.paused).toBe(true);
    // Resume runs the held segment.
    engine.resume();
    expect(synth.paused).toBe(false);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toBe("cccc dddd");
  });

  it("a rate change in the gap between segments restarts from the new segment, not the prior one", () => {
    const engine = makeEngineCapped(10);
    engine.start(chunkOfWords(["aaaa", "bbbb", "cccc", "dddd"]));
    synth.spoken[0].fireEnd(); // advance to seg1; no boundary fired yet
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toBe("cccc dddd");
    engine.setRate(2); // during the gap, before seg1's first boundary
    expect(synth.spoken).toHaveLength(3);
    expect(synth.spoken[2].text).toBe("cccc dddd"); // NOT the whole chunk
  });

  it("start() with empty text speaks nothing and still fires end", () => {
    const engine = makeEngineCapped(MAX_UTTERANCE_CHARS);
    let ended = 0;
    engine.on("end", () => ended++);
    engine.start({ text: "", rangeMap: [] });
    expect(synth.spoken).toHaveLength(0);
    expect(ended).toBe(1);
  });

  it("an error mid-chunk resets state so a late end can't chain a stale segment", () => {
    const engine = makeEngineCapped(10);
    engine.start(chunkOfWords(["aaaa", "bbbb", "cccc", "dddd"]));
    const errored = synth.spoken[0];
    errored.fireError("interrupted");
    // A late end delivered on the errored utterance must not speak segment 1.
    errored.fireEnd();
    expect(synth.spoken).toHaveLength(1);
  });
});

describe("TtsEngine — reswap (recompute upcoming words on scroll)", () => {
  let synth: StubSynth;

  beforeEach(() => {
    synth = new StubSynth();
  });

  function mk(respliceMode?: "scheduled" | "immediate"): TtsEngine {
    return new TtsEngine({
      synth: synth as unknown as SpeechSynthesis,
      UtteranceCtor: StubUtterance as unknown as typeof SpeechSynthesisUtterance,
      heartbeatIntervalMs: 100,
      restartDebounceMs: 0,
      respliceMode,
    });
  }

  it("does NOT cancel/re-speak when the upcoming tail is unchanged (zero-gap)", () => {
    const engine = mk();
    engine.start(chunkOfWords(["alpha", "beta", "gamma", "delta"]));
    synth.spoken[0].fireBoundary(0, 5); // speaking "alpha"
    const cancelsBefore = synth.cancelCount;
    engine.reswap(chunkOfWords(["alpha", "beta", "gamma", "delta"]));
    expect(synth.cancelCount).toBe(cancelsBefore);
    expect(synth.spoken).toHaveLength(1);
    engine.dispose();
  });

  it("schedules an append swap: keeps playing, then continues into new content on end", () => {
    const engine = mk();
    engine.start(chunkOfWords(["alpha", "beta"]));
    synth.spoken[0].fireBoundary(0, 5); // "alpha"
    engine.reswap(chunkOfWords(["alpha", "beta", "gamma", "delta"]));
    // Divergence is a pure append (past the old end) → no immediate cancel.
    expect(synth.cancelCount).toBe(0);
    expect(synth.spoken).toHaveLength(1);
    synth.spoken[0].fireBoundary(6, 4); // "beta" — still before the old end
    expect(synth.spoken).toHaveLength(1);
    // Old chunk finishes → the append continues seamlessly into new content.
    synth.spoken[0].fireEnd();
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toContain("gamma");
    engine.dispose();
  });

  it("schedules a mid-tail swap: swaps only once the cursor reaches the divergence", () => {
    const engine = mk();
    engine.start(chunkOfWords(["alpha", "beta", "gamma", "delta"]));
    synth.spoken[0].fireBoundary(0, 5); // "alpha"
    engine.reswap(chunkOfWords(["alpha", "beta", "DELTA", "delta"]));
    expect(synth.cancelCount).toBe(0); // divergence ("gamma"→"DELTA") is ahead
    synth.spoken[0].fireBoundary(6, 4); // "beta" — still before divergence
    expect(synth.cancelCount).toBe(0);
    synth.spoken[0].fireBoundary(11, 5); // reaches "gamma" (divCharOld) → swap
    expect(synth.cancelCount).toBe(1);
    expect(synth.spoken).toHaveLength(2);
    expect(synth.spoken[1].text).toContain("DELTA");
    engine.dispose();
  });

  it("immediate mode swaps right away, resuming at the current word", () => {
    const engine = mk("immediate");
    engine.start(chunkOfWords(["alpha", "beta", "gamma"]));
    synth.spoken[0].fireBoundary(6, 4); // "beta"
    engine.reswap(chunkOfWords(["alpha", "beta", "gamma", "delta"]));
    expect(synth.cancelCount).toBe(1);
    expect(synth.spoken).toHaveLength(2);
    // Resumes from the current word onward — never re-speaks past content.
    expect(synth.spoken[1].text.startsWith("beta")).toBe(true);
    engine.dispose();
  });

  it("immediate mode still skips the swap when the tail is unchanged", () => {
    const engine = mk("immediate");
    engine.start(chunkOfWords(["alpha", "beta", "gamma"]));
    synth.spoken[0].fireBoundary(0, 5);
    engine.reswap(chunkOfWords(["alpha", "beta", "gamma"]));
    expect(synth.cancelCount).toBe(0);
    expect(synth.spoken).toHaveLength(1);
    engine.dispose();
  });

  it("is a no-op when nothing is playing", () => {
    const engine = mk();
    engine.reswap(chunkOfWords(["a", "b"]));
    expect(synth.cancelCount).toBe(0);
    expect(synth.spoken).toHaveLength(0);
    engine.dispose();
  });

  it("is a no-op while paused, and drops any pending swap", () => {
    const engine = mk();
    engine.start(chunkOfWords(["alpha", "beta", "gamma", "delta"]));
    synth.spoken[0].fireBoundary(0, 5);
    engine.pause();
    engine.reswap(chunkOfWords(["alpha", "beta", "DELTA", "delta"]));
    expect(synth.cancelCount).toBe(0);
    expect(synth.spoken).toHaveLength(1);
    engine.dispose();
  });

  it("getPlaybackAnchor reports the current word in chunk coordinates", () => {
    const engine = mk();
    engine.start(chunkOfWords(["alpha", "beta"]));
    synth.spoken[0].fireBoundary(6, 4); // "beta" at charIndex 6, line 1
    expect(engine.getPlaybackAnchor()).toEqual({
      charIndex: 6,
      word: "beta",
      line: 1,
      col: 0,
    });
    engine.dispose();
  });
});
