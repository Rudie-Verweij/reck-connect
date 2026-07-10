/**
 * Hover-to-focus controller .
 *
 * `term.focus()` on a pane-leaf `mouseenter` is not a free action — it
 * targets xterm's hidden textarea, so it steals DOM focus from whatever
 * the user was actually typing into (tab-rename input, token dialog,
 * launch-args textarea, …). A bare `mouseenter → focusLeaf` would flip
 * keyboard focus mid-drag, mid-selection, mid-dialog — a regression,
 * not a feature.
 *
 * This controller centralizes the invariants that gate hover-focus.
 * Each gate lives in one place so they're testable in isolation and
 * future additions (e.g. "suppress while some overlay is open")
 * plug into a single request path rather than the per-leaf listener.
 *
 * Gates (ALL must hold before `apply` fires):
 *
 *   1. Preference enabled.
 *   2. No mouse button held. Covers xterm selection drag crossing a
 *      pane boundary, split-handle resize, tab drag, anything where the
 *      pointer is "captured" by an in-progress gesture.
 *   3. `document.hasFocus()`. The window itself must have OS focus.
 *   4. No modal/dialog open. All satellite overlays share the CSS
 *      class `new-pane-dialog`, observed via `MutationObserver` on
 *      `document.body`.
 *   5. No context menu open (`.rail-context-menu`) + short cooldown
 *      after `contextmenu` dismissal.
 *   6. `document.activeElement` is not a non-terminal editable element
 *      (input / textarea / contentEditable outside xterm's own hidden
 *      textarea).
 *   7. Post-window-blur armed state. After the window regains focus,
 *      the controller requires one `mouseleave` → `mouseenter` cycle
 *      before the next `request` can fire, so Cmd-Tab back to the app
 *      with the cursor already parked on a different pane doesn't
 *      silently flip focus.
 *   8. Leaf is not already active (caller passes `isAlreadyActive`).
 *   9. Dwell (~60ms) elapses without a `cancel`. Reduces transit
 *      thrash across narrow splits and lets rapid A→B→C movement
 *      resolve deterministically on the final pane.
 */

/**
 * Constructor options. All host-observable state (modal observer,
 * context-menu observer, window listeners) is installed in `attach()`
 * so tests can bring a fresh controller online inside jsdom without
 * leaking timers / observers between cases.
 */
export interface HoverFocusControllerOpts {
  /**
   * Read the current pref. Called on every `request` so a future
   * Preferences toggle takes effect without re-instantiating the
   * controller.
   */
  isEnabled: () => boolean;
  /**
   * Callback: is `leafId` the currently-active leaf? Controller skips
   * the dwell + apply path for already-active leaves.
   */
  isAlreadyActive: (leafId: string) => boolean;
  /**
   * Dwell in ms. Default 60ms. Callers pass 0 from unit tests to run
   * synchronously; the production call site takes the default.
   */
  dwellMs?: number;
  /**
   * Injection seams so tests can swap in fakes. Default to the real
   * `document` / `window`.
   */
  documentRef?: Document;
  windowRef?: Window;
}

export class HoverFocusController {
  private readonly opts: Required<
    Pick<HoverFocusControllerOpts, "isEnabled" | "isAlreadyActive" | "dwellMs">
  > & {
    documentRef: Document;
    windowRef: Window;
  };

  // Mouse-button-held state. We track a small counter (not just a
  // boolean) because `mousedown` can fire for multiple buttons before
  // any `mouseup`, and we want to release the gate only when *all*
  // buttons are back up. Bounded at 0 on the low end to survive
  // mismatched mouseup events the browser occasionally drops (e.g. a
  // `mouseup` that happens outside the window).
  private mouseButtonsDown = 0;

  // True while any `.new-pane-dialog` overlay is attached to the
  // document. Maintained by a MutationObserver installed in `attach()`.
  private modalOpen = false;

  // True while any `.rail-context-menu` is attached. Separate from
  // modalOpen so a short cooldown can apply to the context menu
  // specifically (contextmenu dismissal + instant hover re-fire is
  // the common regression path — see codex review).
  private contextMenuOpen = false;

  // Monotonic timestamp after which context-menu-related suppression
  // lifts. We add a 150ms cooldown after the menu closes so a pointer
  // movement that dismissed the menu doesn't instantly hover-focus an
  // adjacent pane.
  private contextMenuCooldownUntil = 0;

  // Arming state after window-blur (gate 7). `needsMouseleaveAfterBlur`
  // goes true on `window blur` IFF the pointer was over a pane at
  // blur time. If the user task-switched while the cursor was on the
  // rail / app bar / outside the pane area, there's no parked-on-a-
  // pane risk to guard against and the flag stays false. Otherwise,
  // it only clears when a `mouseleave` arrives while the window is
  // focused. Until it clears, `request` suppresses.
  private needsMouseleaveAfterBlur = false;
  // Tracks whether the mouse is currently over any leaf. Updated from
  // `request()` (entered a pane) and `cancel()` (left a pane). Read
  // at window-blur time to decide whether to arm the post-blur gate.
  // see an earlier release.
  private pointerOverAnyPane = false;

  // Dwell timer handle (gate 9). Cleared in `cancel` and re-started on
  // each `request`. Using `window.setTimeout` so the tests' jsdom
  // fake-timer harness can control it.
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;

  // Listener references held for `detach()` so the controller can be
  // torn down cleanly in tests and hot-reload paths.
  private listeners: Array<{
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    opts?: AddEventListenerOptions;
  }> = [];
  private mutationObserver: MutationObserver | null = null;
  private attached = false;

  constructor(options: HoverFocusControllerOpts) {
    this.opts = {
      isEnabled: options.isEnabled,
      isAlreadyActive: options.isAlreadyActive,
      dwellMs: options.dwellMs ?? 60,
      documentRef: options.documentRef ?? document,
      windowRef: options.windowRef ?? window,
    };
  }

  /**
   * Install global listeners: mousedown/mouseup counting, window
   * blur/focus arming, contextmenu cooldown stamping, and the modal /
   * context-menu MutationObserver. Idempotent so tests that re-attach
   * don't double-register.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const { documentRef, windowRef } = this.opts;

    // Count buttons via mousedown / mouseup on the window. `window`
    // (not `document`) so drags that end outside the window still fire
    // mouseup — on macOS + Electron that path generally holds; mouseup
    // on document would miss releases over overlay elements.
    this.on(windowRef, "mousedown", () => {
      this.mouseButtonsDown++;
    });
    this.on(windowRef, "mouseup", () => {
      // Clamp at 0 so a stray mouseup (e.g. native menu eats the
      // mousedown, browser still fires mouseup) doesn't go negative
      // and unlock the gate on a future mousedown.
      this.mouseButtonsDown = Math.max(0, this.mouseButtonsDown - 1);
    });

    // Window-activation gate. On blur: arm. On focus: keep armed
    // until a mouseleave arrives (so Cmd-Tab back with the cursor
    // already over a different pane doesn't silently flip focus).
    this.on(windowRef, "blur", () => {
      // Only arm the post-blur gate when the pointer was actually
      // parked on a pane at blur time . If the cursor was
      // elsewhere (rail / outside panes), a re-focus + hover is the
      // user deliberately engaging a pane and should work on the
      // first mouseenter — no need to force a mouseleave/re-enter.
      if (this.pointerOverAnyPane) {
        this.needsMouseleaveAfterBlur = true;
      }
      // Reset the held-button counter . A drag that started in
      // Satellite and ended outside the window (cross-app Cmd-Tab +
      // release-over-other-app) never fires our matching `mouseup`,
      // so `mouseButtonsDown` would stay positive forever and gate 2
      // would suppress every subsequent hover until some unrelated
      // mouseup fired inside the window. Any ongoing drag is, for our
      // purposes, finished once the window loses focus.
      this.mouseButtonsDown = 0;
      // Also cancel any in-flight dwell; the user may be in a hurry
      // to task-switch and we don't want a delayed apply to race a
      // now-incorrect activeLeafId. Call `abortDwell` rather than
      // `cancel` because `cancel` is also the mouseleave hook and
      // doubles as the arming-flag-release path; we don't want a
      // blur to immediately undo the arming we just did.
      this.abortDwell();
    });

    // Context-menu cooldown. Native `contextmenu` fires on right-click
    // regardless of whether the app shows a custom menu; stamp the
    // cooldown so even if no visible menu renders (e.g. Electron
    // default context menu is suppressed) the immediate hover re-fire
    // is still dampened.
    this.on(documentRef, "contextmenu", () => {
      // 150ms: long enough to cover the menu-dismiss pointer movement
      // users make when clicking outside the menu; short enough that
      // a deliberate later hover still feels responsive. Matches the
      // dwell's order of magnitude.
      this.contextMenuCooldownUntil = Date.now() + 150;
    });

    // MutationObserver on body to detect modal overlays
    // (`.new-pane-dialog`) and rail context menus
    // (`.rail-context-menu`). All existing dialogs share the
    // `new-pane-dialog` class (add-project, confirm-delete,
    // token-prompt, claude-launch, new-pane, copy-progress, etc.).
    // Whenever a new modal class is introduced, add it to
    // MODAL_SELECTORS below — the observer's single recount pass
    // keeps the gate consistent.
    const MODAL_SELECTORS = ".new-pane-dialog";
    const recount = () => {
      const modal = documentRef.querySelector(MODAL_SELECTORS) !== null;
      const ctxMenu = documentRef.querySelector(".rail-context-menu") !== null;
      if (modal !== this.modalOpen) {
        this.modalOpen = modal;
        // Closing a modal shouldn't instantly refocus a terminal —
        // stamp the cooldown so the first hover after dismissal has
        // to dwell. Reuses the contextMenuCooldown clock because a
        // single combined "recent-dismissal" stamp is simpler than
        // tracking two.
        if (!modal) this.contextMenuCooldownUntil = Date.now() + 150;
      }
      if (ctxMenu !== this.contextMenuOpen) {
        this.contextMenuOpen = ctxMenu;
        if (!ctxMenu) this.contextMenuCooldownUntil = Date.now() + 150;
      }
    };
    // Initial snapshot — a modal that was already open when we
    // attached should register.
    recount();
    this.mutationObserver = new MutationObserver(recount);
    this.mutationObserver.observe(documentRef.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Tear down global listeners. Tests call this in `afterEach`;
   * production wiring calls it from `PaneLayout.dispose()`.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const { target, type, handler, opts } of this.listeners) {
      target.removeEventListener(type, handler, opts);
    }
    this.listeners = [];
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.cancel();
  }

  /**
   * Entry point from `PaneLayout`'s per-leaf mouseenter. Evaluates the
   * gates and — if all pass — starts the dwell timer, at the end of
   * which it invokes `apply`. If a second `request` arrives during the
   * dwell (fast pointer transit A→B→C), it replaces the pending apply
   * so the controller lands on the final pane only.
   *
   * Note: `apply` is the caller's "actually do the focus change" thunk
   * (typically `() => paneLayout.focusLeaf(leafId)`). Keeping the focus
   * primitive in the caller means the controller has zero knowledge of
   * PaneLayout internals — easier to reason about, easier to test.
   */
  request(leafId: string, apply: () => void): void {
    // Track pointer location for the post-blur gate. Set BEFORE the
    // canFocus check so a gate-rejected hover still informs the blur
    // handler (the pointer really is over a pane; we just can't focus
    // right now). Paired clear lives in `cancel()`.
    this.pointerOverAnyPane = true;
    if (!this.canFocus(leafId)) return;

    // Replace any pending dwell: rapid A→B→C transit lands on C only.
    if (this.dwellTimer !== null) clearTimeout(this.dwellTimer);
    const dwell = this.opts.dwellMs;
    if (dwell <= 0) {
      // Synchronous path: mostly for tests. Still runs through the
      // same gates above.
      this.dwellTimer = null;
      apply();
      return;
    }
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      // Re-run the FULL gate set at fire time. A modal open, pref
      // toggle, keyboard-focus change, context-menu dismissal, or
      // window blur can all happen during the dwell, and each would
      // independently prohibit focus steal. Previous code only
      // re-checked a subset (modalOpen/buttons/hasFocus/blur-arm/
      // already-active), missing pref-toggled-off, context menu,
      // and keyboard-focus transitions.
      if (!this.canFocus(leafId)) return;
      apply();
    }, dwell);
  }

  /**
   * Gate predicate. Returns true iff every invariant holds for focusing
   * `leafId`. Extracted from the request path so request-time and
   * dwell-fire-time share a single definition — drift between the two
   * was an earlier release 3a finding.
   */
  private canFocus(leafId: string): boolean {
    // Gate 1: pref.
    if (!this.opts.isEnabled()) return false;
    // Gate 8 (cheap): already active → no-op.
    if (this.opts.isAlreadyActive(leafId)) return false;
    // Gate 2: button held.
    if (this.mouseButtonsDown > 0) return false;
    // Gate 3: window focused.
    if (!this.opts.documentRef.hasFocus()) return false;
    // Gate 4: modal overlay open (observed via MutationObserver).
    if (this.modalOpen) return false;
    // Gate 5: context menu open (or recent cooldown).
    if (this.contextMenuOpen) return false;
    if (Date.now() < this.contextMenuCooldownUntil) return false;
    // Gate 6: a focused, non-xterm element is keyboard-active.
    if (this.isNonTerminalEditableActive()) return false;
    // Gate 7: window re-focused but no `mouseleave` has fired yet.
    if (this.needsMouseleaveAfterBlur) return false;
    return true;
  }

  /**
   * External ally for callers that want to abort a pending hover on
   * tree churn (e.g. PaneLayout.setTree). Public form of `cancel`
   * that's semantically clearer at the call site.
   */
  cancelPending(): void {
    this.abortDwell();
  }

  /**
   * Cancel any pending dwell. Called from the leaf's `mouseleave`. A
   * `mouseleave` while the window is focused also disarms the
   * post-blur gate, so the next `mouseenter` can fire.
   */
  cancel(): void {
    this.abortDwell();
    // Pointer left a pane — paired with the `pointerOverAnyPane = true`
    // in `request()`. Safe to flip unconditionally: `cancel()` fires
    // from leaf mouseleave only, not from any other path.
    this.pointerOverAnyPane = false;
    // The window-activation gate lifts on the first real mouseleave
    // after focus returns. We check `hasFocus()` so an Electron-level
    // mouseleave generated by window blur itself doesn't prematurely
    // disarm the gate before focus/blur round-trip.
    if (this.needsMouseleaveAfterBlur && this.opts.documentRef.hasFocus()) {
      this.needsMouseleaveAfterBlur = false;
    }
  }

  private abortDwell(): void {
    if (this.dwellTimer !== null) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  // --- test seams ---------------------------------------------------

  /** Test-only: inspect the arming state. */
  _isArmedAfterBlur(): boolean {
    return this.needsMouseleaveAfterBlur;
  }
  /** Test-only: inspect dwell pending. */
  _hasPendingDwell(): boolean {
    return this.dwellTimer !== null;
  }
  /** Test-only: force modalOpen to a specific value (bypasses the
   *  MutationObserver path for scenarios that are awkward to simulate
   *  in jsdom). The observer will overwrite this on the next DOM
   *  mutation — tests either disable the observer or make their
   *  assertions before any further mutation. */
  _setModalOpenForTest(v: boolean): void {
    this.modalOpen = v;
  }

  // --- internals ----------------------------------------------------

  private on<K extends string>(
    target: EventTarget,
    type: K,
    handler: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, handler, opts);
    // Store opts so `detach`'s removeEventListener passes the same
    // reference — EventTarget matches listeners on (type, handler,
    // capture), so a {capture:true} registration won't unregister via
    // a bare removeEventListener call. Today no caller passes opts,
    // but this keeps the helper correct-by-construction for future
    // callers.
    this.listeners.push({ target, type, handler, opts });
  }

  /**
   * Gate 6: is a focused element (not the xterm helper textarea) the
   * current `document.activeElement`? Broad by design — any focused
   * element (button, link, input, tabindex div, contenteditable, …)
   * means the user has keyboard investment in it. The earlier
   * INPUT/TEXTAREA/SELECT/contentEditable-only check missed cases
   * like "Tab-focused the New Project button → hover a pane" which
   * then stole focus from the button and dropped the user's in-flight
   * keyboard path.
   *
   * Explicit skips:
   *   - `document.body` is the default parking spot when nothing
   *     is focused — never a "user is typing here" signal.
   *   - xterm's hidden textarea (`.xterm-helper-textarea`) is the
   *     TARGET of hover-focus, not a reason to suppress.
   */
  private isNonTerminalEditableActive(): boolean {
    const doc = this.opts.documentRef;
    const active = doc.activeElement as HTMLElement | null;
    if (!active) return false;
    if (active === doc.body) return false;
    if (active === doc.documentElement) return false;
    if (active.classList?.contains("xterm-helper-textarea")) return false;
    // Keyboard-reached focus gates hover-steal even on non-editable
    // elements . If the user tabbed to a button (tab `+`,
    // split/close, rail Add) and then moved the mouse across panes,
    // redirecting focus to the terminal would make the next
    // Space/Enter type into the shell instead of activating the
    // control they were aiming at. `:focus-visible` is the browser
    // heuristic for keyboard-reached focus: matches after Tab,
    // doesn't match after a pointer click — exactly the distinction
    // we need here.
    //
    // The `matches` call is wrapped in try/catch because
    // `:focus-visible` is a CSS Selectors 4 pseudo-class and not every
    // test harness (jsdom) implements it; in that case we fall
    // through to the narrow text-edit checks below, which preserve
    // an earlier release fix behaviour. Real Electron/Chromium always supports
    // it.
    try {
      if (active.matches(":focus-visible")) return true;
    } catch {
      /* fall through */
    }
    // Only real text-editing contexts gate hover-focus . Buttons,
    // links, and focusable divs commonly retain DOM focus after a
    // click (tab `+`, split/close pane buttons, rail Add); treating
    // them as editable would stop hover-focus for the rest of the
    // session after any routine UI action.
    if (active.isContentEditable) return true;
    // Attribute-level fallback: jsdom's `isContentEditable` getter
    // doesn't always reflect a `contenteditable="true"` attribute on
    // a non-natively-editable tag (e.g. a <div> with tabindex). Check
    // the attribute directly so the gate behaves identically across
    // Electron renderer and the vitest/jsdom test environment.
    const ce = active.getAttribute("contenteditable");
    if (ce === "true" || ce === "") return true;
    const tag = active.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      // Only text-like inputs host an edit surface. Checkbox /
      // radio / button / submit / range etc. don't.
      const type = (active as HTMLInputElement).type.toLowerCase();
      return (
        type === "text" ||
        type === "search" ||
        type === "email" ||
        type === "url" ||
        type === "tel" ||
        type === "password" ||
        type === "number" ||
        type === ""
      );
    }
    return false;
  }
}
