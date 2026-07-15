import { describe, it, expect } from "vitest";
import { resampleLinear, floatToInt16, mergeFloat32 } from "./pcm";

describe("resampleLinear", () => {
  it("returns an empty buffer for empty input", () => {
    expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it("returns a copy (not the same ref) when rates match", () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    const out = resampleLinear(input, 16000, 16000);
    expect(Array.from(out)).toEqual([0.1, -0.2, 0.3].map((v) => Math.fround(v)));
    expect(out).not.toBe(input);
  });

  it("downsamples 48k → 16k to about a third of the length", () => {
    const input = new Float32Array(3000).fill(0.5);
    const out = resampleLinear(input, 48000, 16000);
    expect(out.length).toBe(1000);
    // A constant signal stays constant through interpolation.
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 5);
  });

  it("upsamples 8k → 16k to about double the length", () => {
    const input = new Float32Array([0, 1, 0, 1]);
    const out = resampleLinear(input, 8000, 16000);
    expect(out.length).toBe(8);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it("interpolates linearly between two samples", () => {
    const input = new Float32Array([0, 1]);
    const out = resampleLinear(input, 1, 2); // double the rate
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
  });
});

describe("floatToInt16", () => {
  it("maps 0 to 0, +1 to 32767, -1 to -32768", () => {
    const out = floatToInt16(new Float32Array([0, 1, -1]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32768);
  });

  it("clamps out-of-range values", () => {
    const out = floatToInt16(new Float32Array([2, -3]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it("produces the same length as its input", () => {
    expect(floatToInt16(new Float32Array(512)).length).toBe(512);
  });
});

describe("mergeFloat32", () => {
  it("concatenates chunks in order", () => {
    const merged = mergeFloat32([
      new Float32Array([1, 2]),
      new Float32Array([3]),
      new Float32Array([4, 5]),
    ]);
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns an empty buffer for no chunks", () => {
    expect(mergeFloat32([]).length).toBe(0);
  });
});
