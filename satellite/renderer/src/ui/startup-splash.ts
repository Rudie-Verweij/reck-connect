export interface StartupSplashController {
  step(name: string): void;
  markFirstLaunch(): void;
  dismiss(): Promise<void>;
}

const STEP_COPY: Record<string, { label: string; progress: number }> = {
  station: { label: "Connecting to station", progress: 30 },
  local: { label: "Starting local daemon", progress: 30 },
  projects: { label: "Loading projects", progress: 65 },
  layout: { label: "Restoring layout", progress: 90 },
  ready: { label: "Ready", progress: 100 },
};

const FADE_MS = 360;
// Minimum time the splash stays fully visible from `attachStartupSplash()`
// to the start of the fade. Fixes #110: on an already-configured station,
// `station → projects → layout → ready` can fire in well under 100 ms, and
// on the first-launch branch `markFirstLaunch() → dismiss()` runs back-to-
// back — both cases were dismissing before the user could perceive the
// splash. 900 ms is long enough to register as intentional without feeling
// like an artificial wait.
const MIN_DISPLAY_MS = 900;

export function attachStartupSplash(): StartupSplashController {
  const root = document.getElementById("boot-splash");
  if (!root) {
    return {
      step: () => {},
      markFirstLaunch: () => {},
      dismiss: async () => {},
    };
  }

  const mountedAt = Date.now();
  const labelEl = root.querySelector<HTMLElement>(".boot-splash-step-label");
  const fillEl = root.querySelector<HTMLElement>(".boot-splash-progress-fill");
  let dismissed = false;

  function step(name: string) {
    const copy = STEP_COPY[name];
    if (!copy) return;
    if (labelEl) labelEl.textContent = copy.label;
    if (fillEl) fillEl.style.width = `${copy.progress}%`;
  }

  function markFirstLaunch() {
    if (labelEl) labelEl.textContent = "Opening setup";
    if (fillEl) fillEl.style.width = "100%";
  }

  function dismiss(): Promise<void> {
    if (dismissed) return Promise.resolve();
    dismissed = true;
    if (!root) return Promise.resolve();
    const heldMs = Date.now() - mountedAt;
    const waitMs = Math.max(0, MIN_DISPLAY_MS - heldMs);
    return new Promise((resolve) => {
      const startFade = () => {
        const done = () => {
          root.removeEventListener("transitionend", onEnd);
          root.parentNode?.removeChild(root);
          resolve();
        };
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target === root && ev.propertyName === "opacity") done();
        };
        root.addEventListener("transitionend", onEnd);
        // Safety: if the transition never fires (reduced-motion override,
        // element detached early, zero-duration override, or styles.css
        // not yet loaded so the `.boot-splash-dismissed` rule is missing),
        // fall back to a hard remove.
        window.setTimeout(done, FADE_MS + 80);
        root.classList.add("boot-splash-dismissed");
      };
      if (waitMs === 0) {
        startFade();
      } else {
        window.setTimeout(startFade, waitMs);
      }
    });
  }

  // Seed progress so the bar starts with motion before boot() emits
  // its first `step()` — avoids a visible "stuck at 0%" beat.
  if (fillEl) fillEl.style.width = "12%";

  return { step, markFirstLaunch, dismiss };
}
