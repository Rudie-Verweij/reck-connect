// Speak-surface seam for the file viewer.
//
// The full text-to-speech subsystem (speak-aloud, word highlighting, the
// Speak control bar) is a separate feature ported in a later change. Until
// then the file viewer constructs an adapter and hands it to `initTts`,
// which is a no-op — so no Speak bar is shown. This interface captures only
// what the viewer touches (disposal); the real adapter adds the
// text/highlight surface the TTS engine drives.
export interface SpeakSurfaceAdapter {
  dispose(): void;
}
