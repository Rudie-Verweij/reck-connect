import type { SpeakSurfaceAdapter } from "./SpeakSurfaceAdapter";

/**
 * Placeholder Markdown speak-surface. Replaced by the real implementation
 * when the text-to-speech subsystem is ported. Constructs cleanly and
 * disposes to nothing so the file viewer compiles and runs without
 * speak-aloud.
 */
export class MarkdownSurfaceAdapter implements SpeakSurfaceAdapter {
  constructor(_opts: { container: HTMLElement; body: HTMLElement }) {}
  dispose(): void {}
}
