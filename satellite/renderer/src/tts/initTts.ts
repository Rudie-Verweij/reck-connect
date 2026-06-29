import type { SpeakSurfaceAdapter } from "./SpeakSurfaceAdapter";

/** Handle returned by initTts; disposed when the viewer tears down. */
export interface TtsHandle {
  dispose(): void;
}

/**
 * Text-to-speech initialiser seam. The real implementation builds the Speak
 * control bar and wires the TTS engine to the active surface; this no-op
 * version lets the file viewer compile and run without speak-aloud until
 * that subsystem is ported. Returns a handle whose dispose() is a no-op, so
 * no Speak bar is shown.
 */
export async function initTts(_opts: {
  getActiveSpeakSurface: () => SpeakSurfaceAdapter;
}): Promise<TtsHandle> {
  return { dispose() {} };
}
