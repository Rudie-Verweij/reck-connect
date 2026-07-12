// Boot entry for voice dictation (issue #67). Loads settings, wires the
// controller to the active pane, installs the hybrid hold/tap hotkey, and
// attaches the right-click Language/Hide menu to the floating mic. Invoked
// non-fatally from boot.ts beside initTts — a failure here must never take
// down the app.

import {
  TranscriptionController,
  type DictationSession,
} from "./TranscriptionController";
import { showDictationContextMenu } from "./languageMenu";
import { setDictationFabsVisible } from "./micOverlay";
import { installTranscriptionShortcuts } from "./transcriptionShortcuts";
import {
  loadTranscriptionSettings,
  saveTranscriptionSettings,
} from "./transcriptionSettings";
import { confirmDialog } from "../ui/new-pane-dialog";

// A ⌘⇧V press held at least this long is push-to-talk (record while held,
// stop on release); anything shorter is a tap that toggles.
const HOLD_TO_TALK_MS = 400;

export interface InitTranscriptionDeps {
  /** Resolve the target pane + UI surface when dictation starts. */
  resolveSession: () => DictationSession | null;
  /** Surface an error with no active dictation bar (e.g. a toast). */
  onError: (message: string) => void;
}

export interface TranscriptionHandle {
  /** Start/stop dictation (mic button and hotkey both route here). */
  toggle(): void;
  dispose(): void;
}

export async function initTranscription(
  deps: InitTranscriptionDeps,
): Promise<TranscriptionHandle> {
  const settings = await loadTranscriptionSettings();
  const controller = new TranscriptionController({
    settings,
    resolveSession: deps.resolveSession,
    onError: deps.onError,
  });

  const toggle = (): void => {
    if (!settings.enabled) {
      deps.onError("Voice dictation is off — enable it in Settings → Voice dictation.");
      return;
    }
    void controller.toggle();
  };

  // Hybrid hotkey: a press that STARTED dictation and is held past the
  // threshold is push-to-talk — release stops it. A short tap leaves it
  // running (toggle); pressing while already listening stops it either way.
  let pressStartedDictation = false;
  const uninstallShortcut = settings.enabled
    ? installTranscriptionShortcuts({
        onPressStart: () => {
          pressStartedDictation = controller.getState() === "idle";
          toggle();
        },
        onPressEnd: (heldMs) => {
          if (!pressStartedDictation) return;
          pressStartedDictation = false;
          if (heldMs < HOLD_TO_TALK_MS) return; // tap → stay recording
          const state = controller.getState();
          if (state === "listening" || state === "preparing") void controller.toggle();
        },
      })
    : () => {};

  // Right-click on any floating mic → Language ▸ / Hide. Delegated so mics
  // created later (new panes/splits) are covered automatically.
  const onMicContextMenu = (e: MouseEvent): void => {
    const mic = (e.target as HTMLElement | null)?.closest?.(".dictation-fab");
    if (!mic) return;
    e.preventDefault();
    e.stopPropagation();
    showDictationContextMenu(e.clientX, e.clientY, {
      currentCode: controller.getSettings().language,
      onPick: (code) => {
        const next = { ...controller.getSettings(), language: code };
        controller.updateSettings(next);
        void saveTranscriptionSettings(next);
      },
      onHide: () => {
        void (async () => {
          const ok = await confirmDialog(document.body, {
            title: "Hide the dictation button?",
            body:
              "The floating mic disappears from every pane. Dictation still works with " +
              "⌘⇧V. Re-enable the button in Settings → Voice dictation → " +
              "“Show dictation button”.",
            confirmLabel: "Hide",
            cancelLabel: "Keep",
          });
          if (!ok) return;
          const next = { ...controller.getSettings(), showMicButton: false };
          controller.updateSettings(next);
          await saveTranscriptionSettings(next);
          setDictationFabsVisible(false);
        })();
      },
    });
  };
  document.addEventListener("contextmenu", onMicContextMenu, true);

  return {
    toggle,
    dispose: () => {
      uninstallShortcut();
      document.removeEventListener("contextmenu", onMicContextMenu, true);
      controller.dispose();
    },
  };
}
