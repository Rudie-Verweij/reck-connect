import type { SpeakSurfaceAdapter } from "./SpeakSurfaceAdapter";

/**
 * Placeholder CodeMirror speak-surface. Replaced by the real implementation
 * when the text-to-speech subsystem is ported. Constructs cleanly and
 * disposes to nothing so the file viewer compiles and runs without
 * speak-aloud. `view` is the popup's CodeMirror EditorView; the stub keeps
 * it untyped to avoid coupling to @codemirror/view before the real adapter
 * lands.
 */
export class CodeMirrorSurfaceAdapter implements SpeakSurfaceAdapter {
  constructor(_opts: { container: HTMLElement; view: unknown }) {}
  dispose(): void {}
}
