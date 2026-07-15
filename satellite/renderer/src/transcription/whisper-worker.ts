// Embedded Whisper transcription worker. Runs off the UI thread; lazily
// imports transformers.js (so its ~large bundle + ONNX runtime only load
// when the local engine is first used) and fetches the model from the HF
// hub on first use. Prefers WebGPU, falls back to WASM.
//
// The model is loaded AND warmed up (a tiny silent inference) before the
// caller starts recording — the warm-up validates the compute device end to
// end, so a WebGPU incompatibility (e.g. an adapter that doesn't expose the
// subgroup limits transformers.js expects) is caught here and we fall back
// to WASM, instead of blowing up mid-transcription after the user has spoken.
//
// Protocol:
//   main → worker: { type: "prepare"|"transcribe", repo, generation, audio? }
//   worker → main: { type: "status", status: "loading"|"transcribing" }
//                  { type: "ready" }        (prepare succeeded, model warm)
//                  { type: "result", text } (transcribe succeeded)
//                  { type: "error", message }

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import { sanitizeTranscript } from "./transcriptClean";

// Always fetch from the Hugging Face hub (no local model files bundled).
env.allowLocalModels = false;

// Multithreaded WASM when SharedArrayBuffer is available (main.ts enables the
// Chromium feature) — the single biggest CPU-inference speedup we control.
try {
  if (typeof SharedArrayBuffer !== "undefined" && env.backends.onnx.wasm) {
    const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    env.backends.onnx.wasm.numThreads = threads;
    console.log(`[whisper-worker] WASM threads: ${threads}`);
  } else {
    console.log("[whisper-worker] SharedArrayBuffer unavailable — single-threaded WASM");
  }
} catch (err) {
  console.warn("[whisper-worker] could not configure WASM threads:", err);
}

type InMessage =
  | {
      type: "prepare";
      // All repos this session will use — typically [tiny-for-partials,
      // selected-model-for-finals]. Loaded in order; ready fires when ALL are.
      repos: string[];
      generation: number;
    }
  | {
      type: "transcribe";
      repo: string;
      generation: number;
      audio: Float32Array;
      // "partial" = a live snapshot while still recording (shown as interim);
      // "final" = the complete utterance on stop (injected). Default final.
      kind?: "partial" | "final";
      // ISO language code; omit/"auto" = let Whisper detect.
      language?: string;
    };

// One pipeline per repo, kept warm for the life of the worker — the partial
// (tiny) and final (selected) models coexist.
const pipelines = new Map<string, AutomaticSpeechRecognitionPipeline>();

/**
 * Is WebGPU actually usable for transformers.js here? Its GPU kernels read
 * the subgroup-size limits; some Chromium/Metal backends (e.g. this Electron
 * build) don't expose them, and reading them throws
 * "Cannot read properties of undefined (reading 'subgroupMinSize')". We probe
 * the adapter and require those limits before ever selecting WebGPU, so we
 * never trip that crash — otherwise we use WASM.
 */
async function webgpuUsable(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
    if (!gpu?.requestAdapter) return false;
    const adapter = (await gpu.requestAdapter()) as { limits?: Record<string, unknown> } | null;
    if (!adapter?.limits) return false;
    return typeof adapter.limits.subgroupMinSize === "number";
  } catch {
    return false;
  }
}

/** Load + warm up one model, choosing a safe device. Cached per repo. */
async function ensureReady(
  repo: string,
  generation: number,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const cached = pipelines.get(repo);
  if (cached) return cached;
  post({ type: "status", status: "loading", generation });

  // Device + dtype fallbacks. transformers.js is pinned to 3.8.1 because its
  // bundled onnxruntime-web runs these Whisper exports at FULL graph
  // optimization; 4.x's ORT crashed in TransposeDQWeightsForMatMulNBits and
  // forced us to disable optimization, which made inference ~4× slower.
  // Cached model files are reused across same-dtype retries (no re-download).
  const configs: Array<{ device: "webgpu" | "wasm"; dtype: string }> = [];
  if (await webgpuUsable()) {
    configs.push({ device: "webgpu", dtype: "fp16" });
  }
  configs.push({ device: "wasm", dtype: "q8" }, { device: "wasm", dtype: "fp32" });

  // Aggregate per-file download progress into an overall 0-100.
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: {
    status?: string;
    file?: string;
    loaded?: number;
    total?: number;
  }): void => {
    if (!p.file) return;
    if (p.status === "progress" && typeof p.total === "number") {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    } else if (p.status === "done") {
      const it = files.get(p.file);
      if (it) it.loaded = it.total;
    }
    let loaded = 0;
    let total = 0;
    for (const it of files.values()) {
      loaded += it.loaded;
      total += it.total;
    }
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    post({ type: "progress", pct, generation });
  };

  let lastErr: unknown;
  for (const cfg of configs) {
    try {
      const options = {
        device: cfg.device,
        dtype: cfg.dtype,
        progress_callback,
      };
      // pipeline()'s overload union in transformers.js 3.x blows past tsc's
      // complexity limit (TS2590) when options aren't a literal — call it
      // through a narrowed signature instead.
      const makePipeline = pipeline as unknown as (
        task: string,
        model: string,
        opts?: Record<string, unknown>,
      ) => Promise<AutomaticSpeechRecognitionPipeline>;
      const p = await makePipeline("automatic-speech-recognition", repo, options);
      // No warm-up inference: device/quant failures surface at model creation
      // above (caught by this loop), and a warm-up on a big model is so slow on
      // CPU it looks hung. Skipping it lets loading finish as soon as the model
      // is in memory.
      pipelines.set(repo, p);
      return p;
    } catch (err) {
      // Log the full error (with stack) so it's visible in DevTools even
      // though only the message crosses back to the toast.
      console.error(`[whisper-worker] ${repo} on ${cfg.device}/${cfg.dtype} failed:`, err);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Failed to load speech model");
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (!msg || (msg.type !== "prepare" && msg.type !== "transcribe")) return;
  const gen = msg.generation;
  try {
    if (msg.type === "prepare") {
      for (const repo of msg.repos) await ensureReady(repo, gen);
      post({ type: "ready", generation: gen });
      return;
    }
    const model = await ensureReady(msg.repo, gen);
    const kind = msg.kind ?? "final";
    // Don't flip the UI to "Transcribing…" for the frequent partial passes.
    if (kind === "final") post({ type: "status", status: "transcribing", generation: gen });
    const options: Record<string, unknown> = { chunk_length_s: 30, stride_length_s: 5 };
    if (msg.language && msg.language !== "auto") options.language = msg.language;
    const t0 = performance.now();
    const output = await model(msg.audio, options);
    // Strip Whisper's non-speech annotations / silence hallucinations
    // ("(applause)", "Thanks for watching") before they reach the prompt.
    const text = sanitizeTranscript(extractText(output));
    // Timing lands in the pane's DevTools console — the observability the
    // "why is it slow" investigations kept needing.
    console.log(
      `[whisper-worker] ${kind} ${msg.repo} ${(msg.audio.length / 16000).toFixed(1)}s audio → ` +
        `${Math.round(performance.now() - t0)}ms:`,
      JSON.stringify(text),
    );
    post({ type: "result", kind, text, generation: gen });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      generation: gen,
    });
  }
};

function extractText(output: unknown): string {
  if (Array.isArray(output)) return output.map((o) => extractText(o)).join(" ");
  if (output && typeof output === "object" && "text" in output) {
    const t = (output as { text: unknown }).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

type WorkerOut =
  | { type: "status"; status: "loading" | "transcribing"; generation: number }
  | { type: "progress"; pct: number; generation: number }
  | { type: "ready"; generation: number }
  | { type: "result"; kind: "partial" | "final"; text: string; generation: number }
  | { type: "error"; message: string; generation: number };

function post(m: WorkerOut): void {
  (self as unknown as Worker).postMessage(m);
}
