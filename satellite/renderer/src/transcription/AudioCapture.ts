// Microphone capture for dictation. Runs entirely in the renderer (the Mac,
// where the mic is). Produces mono Float32 audio via an AudioWorklet:
//   - streaming consumers (Deepgram) get buffered chunks via `onChunk`;
//   - `stop()` returns the whole utterance for a transcribe-on-stop engine
//     (embedded Whisper), which resamples it to 16 kHz.
//
// The worklet processor is loaded from an inline Blob URL so it needs no
// separate bundled asset. Not unit-tested (getUserMedia / AudioContext /
// AudioWorklet have no jsdom equivalent) — verified manually.

import { mergeFloat32 } from "./pcm";

// Buffer ~2048 samples per posted chunk (~128 ms at 16 kHz): large enough
// that Deepgram gets sensible frame sizes, small enough for low latency.
const WORKLET_CHUNK_SAMPLES = 2048;

const WORKLET_SRC = `
class ReckCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    this._target = ${WORKLET_CHUNK_SAMPLES};
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'flush') {
        this._emit();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  _emit() {
    if (this._count === 0) return;
    const out = new Float32Array(this._count);
    let o = 0;
    for (const c of this._buf) { out.set(c, o); o += c.length; }
    this.port.postMessage(out, [out.buffer]);
    this._buf = [];
    this._count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this._buf.push(ch.slice(0));
      this._count += ch.length;
      if (this._count >= this._target) this._emit();
    }
    return true;
  }
}
registerProcessor('reck-capture', ReckCaptureProcessor);
`;

export interface AudioCaptureCallbacks {
  /** Fired for each buffered Float32 chunk at the capture sample rate. */
  onChunk?: (chunk: Float32Array, sampleRate: number) => void;
  onError?: (err: unknown) => void;
}

export interface CapturedAudio {
  /** The full utterance, mono Float32, at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
}

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 0;
  private flushResolve: (() => void) | null = null;

  constructor(private readonly cb: AudioCaptureCallbacks = {}) {}

  isActive(): boolean {
    return this.ctx !== null;
  }

  /** The capture sample rate (0 until started). */
  getSampleRate(): number {
    return this.sampleRate;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Ask for 16 kHz directly; the OS may still hand us 48 kHz, so we read
    // the real rate back and let the embedded path resample if needed.
    const AudioCtx: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx({ sampleRate: 16000 });
    this.sampleRate = this.ctx.sampleRate;

    const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "reck-capture");
    this.node.port.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (data instanceof Float32Array) {
        this.chunks.push(data);
        this.cb.onChunk?.(data, this.sampleRate);
      } else if (data && data.type === "flushed") {
        this.flushResolve?.();
        this.flushResolve = null;
      }
    };
    // A zero-gain sink keeps the graph pulling without echoing the mic.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  /** Ask the worklet to post any buffered tail, then resolve. */
  private flush(): Promise<void> {
    const node = this.node;
    if (!node) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      node.port.postMessage({ type: "flush" });
      // Safety net in case the worklet is already torn down.
      setTimeout(resolve, 200);
    });
  }

  /** Stop capture and return the full captured utterance. */
  async stop(): Promise<CapturedAudio> {
    if (!this.ctx) return { samples: new Float32Array(0), sampleRate: 0 };
    await this.flush();
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx.close();
    } catch (err) {
      this.cb.onError?.(err);
    }
    const merged = mergeFloat32(this.chunks);
    const sampleRate = this.sampleRate;
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.stream = null;
    this.chunks = [];
    return { samples: merged, sampleRate };
  }
}
