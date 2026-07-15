// Detects Claude Code's own "voice input can't work here" failure in a
// pane's PTY output, so the renderer can surface a one-time hint pointing
// the user at reck's built-in dictation instead.
//
// Why this exists: Claude Code's `/voice` captures audio on the machine
// running the CLI — the headless Linux station — which has no microphone,
// so it fails (see docs/plans/voice-dictation-satellite.md). The failure
// prints one of a few recognizable phrases (Claude Code's own message, or
// the underlying ALSA error). We watch for those and, once, show a toast.
//
// The detector is pure and framework-free so it can be unit-tested: it
// takes decoded output text chunk by chunk and returns `true` exactly once
// — the first time a trigger phrase is seen. It latches after that so the
// hint never nags on repeated failures within a session.

/**
 * Substrings that indicate voice capture failed on the station. Matched
 * case-insensitively against ANSI-stripped, whitespace-collapsed output.
 * Kept specific to avoid firing on ordinary text that merely mentions a
 * microphone.
 */
const TRIGGER_PHRASES: readonly string[] = [
  // Claude Code's own messages.
  "voice input is failing repeatedly",
  "could not open an audio capture device",
  "voice mode requires a microphone",
  // The underlying ALSA error on a headless Linux host.
  "capture slave is not defined",
];

// Longest trigger phrase is ~40 chars; keep enough tail to catch a phrase
// split across output chunks, with generous margin for interspersed noise.
const MAX_BUFFER = 512;

// Strip ANSI/VT escape sequences so a phrase coloured or repositioned by a
// TUI still matches: CSI (ESC [ ... cmd), OSC (ESC ] ... BEL|ST), and the
// short two-char escapes (ESC c, ESC \, etc.). Also drops a lone ESC.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])?/g;

export interface VoiceErrorDetector {
  /**
   * Feed one chunk of decoded PTY text. Returns `true` the first time a
   * trigger phrase becomes visible in the rolling buffer; `false`
   * thereafter (the detector latches for the rest of its life).
   */
  push(chunk: string): boolean;
  /** Clear the buffer and un-latch (e.g. on pane reset/reconnect). */
  reset(): void;
}

export function createVoiceErrorDetector(): VoiceErrorDetector {
  let buffer = "";
  let latched = false;

  return {
    push(chunk: string): boolean {
      if (latched || chunk.length === 0) return false;
      const cleaned = chunk.replace(ANSI_RE, " ");
      buffer = `${buffer}${cleaned}`.replace(/\s+/g, " ").toLowerCase();
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      for (const phrase of TRIGGER_PHRASES) {
        if (buffer.includes(phrase)) {
          latched = true;
          buffer = "";
          return true;
        }
      }
      return false;
    },
    reset(): void {
      buffer = "";
      latched = false;
    },
  };
}
