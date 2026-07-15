// Renderer glue: watch a pane's decoded PTY output for Claude Code's
// voice-capture failure and, once, show a toast explaining why and what to
// do instead. The detection logic is the pure `voiceErrorDetector`; this
// module owns the DOM side (decoding bytes → text, mounting the toast).
//
// See docs/plans/voice-dictation-satellite.md (Phase 0).

import { showToast, type ToastHandle } from "../viewer/Toast";
import { createVoiceErrorDetector } from "./voiceErrorDetector";

// Claude Code's /voice records on the station (no mic there); point the
// user at reck's own dictation, which captures the mic on this Mac.
const HINT_MESSAGE =
  "Voice input can't run on the station. Use reck dictation instead — " +
  "click the mic on this pane or press ⌘⇧V.";

// Longer than the default 2s toast: it's an explanatory hint, not a quick ack.
const HINT_DURATION_MS = 9000;

export interface VoiceErrorHint {
  /** Feed decoded PTY bytes; shows the hint toast once when a failure is seen. */
  onOutput(bytes: Uint8Array): void;
  dispose(): void;
}

/**
 * Install a voice-error hint that renders its toast into `parent` (the
 * pane wrapper). Returns a sink to wire to `TerminalPane.onDecodedOutput`.
 */
export function installVoiceErrorHint(parent: HTMLElement): VoiceErrorHint {
  const detector = createVoiceErrorDetector();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let toast: ToastHandle | null = null;
  let done = false;

  return {
    onOutput(bytes: Uint8Array): void {
      if (done) return;
      const text = decoder.decode(bytes, { stream: true });
      if (text.length === 0) return;
      if (detector.push(text)) {
        done = true; // latch: stop decoding once the hint has fired.
        toast = showToast(parent, HINT_MESSAGE, {
          kind: "info",
          durationMs: HINT_DURATION_MS,
        });
      }
    },
    dispose(): void {
      done = true;
      toast?.dispose();
      toast = null;
    },
  };
}
