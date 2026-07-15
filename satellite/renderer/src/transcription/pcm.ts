// Pure PCM helpers for the dictation capture pipeline. Kept dependency-free
// and side-effect-free so they can be unit-tested without an AudioContext.
//
// The mic is captured as Float32 mono at the AudioContext's native rate
// (usually 48 kHz). Deepgram accepts linear16 at any declared sample rate,
// so streaming just needs Float32 → Int16. The embedded Whisper model wants
// Float32 at 16 kHz, so the accumulated utterance is resampled once at stop.

/** Whisper's required input rate (embedded transformers.js path). */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Linear-interpolation resample. Adequate for speech STT; avoids pulling a
 * DSP dependency. Returns a copy when the rates already match.
 */
export function resampleLinear(
  input: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (srcRate === dstRate) return input.slice();
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  const lastIdx = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = i0 + 1 <= lastIdx ? i0 + 1 : lastIdx;
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Convert normalized Float32 samples ([-1, 1]) to signed 16-bit PCM. */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i];
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Root-mean-square amplitude of a sample buffer (0 = silence). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Concatenate captured Float32 chunks into one contiguous buffer. */
export function mergeFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
