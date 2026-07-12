// Embedded Whisper transcription worker. Runs off the UI thread; lazily
// imports transformers.js (so its ~large bundle + ONNX runtime only load
// when the local engine is first used) and fetches the model from the HF
// hub on first use. Prefers WebGPU, falls back to WASM.
//
// Protocol:
//   main → worker: { type: "transcribe", audio: Float32Array(16k), repo: string }
//   worker → main: { type: "status", status: "loading" | "transcribing" }
//                  { type: "result", text: string }
//                  { type: "error", message: string }

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

// Always fetch from the Hugging Face hub (no local model files bundled).
env.allowLocalModels = false;

type TranscribeMessage = {
  type: "transcribe";
  audio: Float32Array;
  repo: string;
  /** Echoed back on every reply so the caller can drop cancelled results. */
  generation: number;
};

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedRepo: string | null = null;

async function loadPipeline(
  repo: string,
  generation: number,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr && loadedRepo === repo) return asr;
  post({ type: "status", status: "loading", generation });
  // Try WebGPU first (fast on Apple Silicon); fall back to WASM if the
  // adapter or a fused kernel is unavailable in this Chromium build.
  try {
    asr = (await pipeline("automatic-speech-recognition", repo, {
      device: "webgpu",
      dtype: "fp16",
    })) as AutomaticSpeechRecognitionPipeline;
  } catch {
    asr = (await pipeline("automatic-speech-recognition", repo, {
      device: "wasm",
      dtype: "q8",
    })) as AutomaticSpeechRecognitionPipeline;
  }
  loadedRepo = repo;
  return asr;
}

self.onmessage = async (e: MessageEvent<TranscribeMessage>) => {
  const msg = e.data;
  if (msg?.type !== "transcribe") return;
  const gen = msg.generation;
  try {
    const model = await loadPipeline(msg.repo, gen);
    post({ type: "status", status: "transcribing", generation: gen });
    const output = await model(msg.audio, { chunk_length_s: 30, stride_length_s: 5 });
    const text = extractText(output);
    post({ type: "result", text: text.trim(), generation: gen });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      generation: gen,
    });
  }
};

function extractText(output: unknown): string {
  if (Array.isArray(output)) {
    return output.map((o) => extractText(o)).join(" ");
  }
  if (output && typeof output === "object" && "text" in output) {
    const t = (output as { text: unknown }).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

type WorkerOut =
  | { type: "status"; status: "loading" | "transcribing"; generation: number }
  | { type: "result"; text: string; generation: number }
  | { type: "error"; message: string; generation: number };

function post(m: WorkerOut): void {
  (self as unknown as Worker).postMessage(m);
}
