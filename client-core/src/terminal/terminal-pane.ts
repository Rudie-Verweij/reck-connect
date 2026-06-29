import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  PaneWS,
  encodeBytes,
  decodeBytes,
  type PaneWSCloseInfo,
  type PaneWSState,
} from "../api/ws";
import { installOscFilter } from "./osc-filter";
import type { Stoplight } from "@proto/proto";

export type PaneTheme = "light" | "dark";

/**
 * MIME types the station accepts as image-paste uploads
 * (phase 1 — must match `allowedUploadMIMEs` in
 * `daemon/internal/http/uploads.go`). Kept as a Set for O(1)
 * membership checks in the paste handler's hot path; rebuilding it
 * per-event would churn GC for no reason.
 */
const IMAGE_PASTE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Callback shape for uploading a pasted image to the daemon.
 * Wired from the app layer (Satellite renderer) so the TerminalPane
 * stays decoupled from ApiClient — the host passes a thunk that knows
 * which pane + bearer to use.
 *
 * Two-path return shape (phase 2):
 *   - `{ kind: "path", path }` — Phase 1 fallback. Daemon wrote the
 *     file to disk; the TerminalPane types `path + " "` into the PTY
 *     so the user can reference it (or a Read tool can open it).
 *   - `{ kind: "chip" }` — Phase 2 sidecar path. Daemon already wrote
 *     0x16 into the pane PTY after the sidecar ACK'd the pasteboard
 *     write. The TerminalPane types nothing — Claude Code's paste
 *     handler turns the pasteboard contents into an [Image #N] chip.
 *
 * Either branch may fall through to `onPasteUploadError`; the chip
 * path can also degrade to the path path mid-call if the sidecar
 * returns 503, but that's the host's concern, not the pane's.
 *
 * `fallbackReason` (path branch only) explains *why* the chip path
 * was skipped, so the pane can surface a visible breadcrumb before
 * typing the path. Without this, the user can't distinguish a
 * deliberate phase-1 fallback (e.g. shell pane, no capability) from
 * a bug (e.g. daemon error). See the consumer in `handlePasteEvent`.
 */
export type PasteFallbackReason = "no-capability" | "daemon-error" | "upload-only";
export type PasteUploadResult =
  | { kind: "path"; path: string; fallbackReason?: PasteFallbackReason; fallbackDetail?: string }
  | { kind: "chip" };
export type PasteUploadFn = (blob: Blob, mime: string) => Promise<PasteUploadResult>;

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

// Fixed PTY geometry used on iOS. 33 cols at fontSize 17 renders in
// ~336px — fits every iPhone width with a small margin, and matches
// exactly how Claude Code lays out at "narrow desktop window" width.
// Earlier attempts to (a) auto-fit via FitAddon and (b) widen the
// layout viewport to 820 for pinch-zoom both produced ugly results:
// fit gave too-many cols (overflow), the widened viewport made every-
// thing too small until the user pinched in, and iOS kept snapping
// back. 33×24 just renders correctly at OS default zoom.
const IOS_COLS = 33;
const IOS_ROWS = 24;

export interface TerminalPaneProps {
  wsUrl: string;
  /**
   * Sec-WebSocket-Protocol entries offered on the WS upgrade. The
   * daemon expects `reck-bearer.<token>` to authenticate; use
   * `ApiClient.wsSubprotocols()` to build the list. Empty array for
   * unauthenticated local daemons.
   *
   * Accepts either a static array OR a thunk re-evaluated on every
   * reconnect. Pass a thunk (e.g. `() => client.wsSubprotocols()`)
   * when the bearer token can rotate during the pane's lifetime —
   * a stale captured array would otherwise pin reconnects to the
   * old token and loop on 1008. See `PaneWS` constructor for detail.
   */
  wsSubprotocols?: string[] | (() => string[]);
  onStoplight?: (s: Stoplight) => void;
  onExit?: (code: number) => void;
  /**
   * Connection-state observer. `closeInfo` is populated only for
   * transitions caused by an inbound WebSocket close frame; existing
   * `(s) => …` handlers stay source-compatible — the second argument is
   * optional and may be ignored.
   */
  onConnState?: (s: PaneWSState, closeInfo?: PaneWSCloseInfo) => void;
  theme?: PaneTheme;
  /**
   * Handler for pasted images (phase 1). When set, the
   * TerminalPane intercepts `paste` events on the xterm host element,
   * extracts any `image/*` clipboard items, POSTs each one to the
   * daemon via `onPasteUpload`, then types the returned absolute path
   * into the PTY (followed by a space — no newline, so the user
   * decides when to submit). Non-image clipboard items fall through
   * to xterm's default text paste.
   *
   * When unset (undefined), paste behaves exactly as before: xterm's
   * own handler runs unmodified, and image blobs silently drop on the
   * floor like they always did Older.
   *
   * The thunk is called once per image blob, serially, so the typed
   * paths arrive in clipboard order.
   */
  onPasteUpload?: PasteUploadFn;
  /**
   * Optional hook fired when a paste upload fails. The TerminalPane
   * swallows the error by default (no toast — keeping the plumbing
   * neutral on UX policy), but wiring a callback here lets the host
   * surface a toast / log entry. Called once per failed blob.
   */
  onPasteUploadError?: (err: unknown, mime: string) => void;
}

function themeFor(t: PaneTheme): ITheme {
  if (t === "light") {
    return {
      background: "#f7f4ed",
      foreground: "#2a2927",
      cursor: "#d4683a",
      cursorAccent: "#f7f4ed",
      selectionBackground: "rgba(212, 104, 58, 0.22)",
      black: "#2a2927",
      red: "#c8726e",
      green: "#7a9c6d",
      yellow: "#c9982e",
      blue: "#3d6b6b",
      magenta: "#b67a90",
      cyan: "#5d8a8a",
      white: "#e0ddd3",
      brightBlack: "#5a5850",
      brightRed: "#d4683a",
      brightGreen: "#8fae82",
      brightYellow: "#e0b045",
      brightBlue: "#5c8888",
      brightMagenta: "#d29cb3",
      brightCyan: "#7ba8a8",
      brightWhite: "#2a2927",
    };
  }
  return {
    background: "#141413",
    foreground: "#f5f2ea",
    cursor: "#d4683a",
    cursorAccent: "#141413",
    selectionBackground: "rgba(212, 104, 58, 0.28)",
  };
}

// Monotonic counter used to tag each TerminalPane with a stable debug ID.
// Surfaced in console logs so multiple panes can be told apart, and used
// as the key in the window.__reckPanes registry.
let nextDebugId = 1;

// Cached result of the scroll-debug gate check. `undefined` means "not yet
// evaluated"; the first call to `isScrollDebugEnabled()` resolves it from
// localStorage + URL query params and pins the value for the rest of the
// document's lifetime. See the comment block next to `attachDebugHooks`
// for the rationale + activation recipe.
let scrollDebugEnabledCache: boolean | undefined;

function isScrollDebugEnabled(): boolean {
  if (scrollDebugEnabledCache !== undefined) return scrollDebugEnabledCache;
  let enabled = false;
  try {
    if (typeof localStorage !== "undefined"
        && localStorage.getItem("reck.debug.scroll") === "1") {
      enabled = true;
    }
  } catch { /* Safari private mode / sandboxed iframe — treat as disabled */ }
  try {
    if (!enabled
        && typeof location !== "undefined"
        && typeof URLSearchParams !== "undefined") {
      const qp = new URLSearchParams(location.search).get("reckDebugScroll");
      if (qp === "1") enabled = true;
    }
  } catch { /* non-DOM env (node/worker) — treat as disabled */ }
  scrollDebugEnabledCache = enabled;
  return enabled;
}

// Test-only hook: reset the cached gate result so a test can toggle the
// underlying storage between cases. Not exported from the public API.
export function __resetScrollDebugCacheForTests() {
  scrollDebugEnabledCache = undefined;
}

export class TerminalPane {
  public readonly container: HTMLElement;
  // Stable handle for devtools use: a short label like "term-3" that shows
  // up in every [scroll-debug] log line from this pane. Also the key under
  // which this instance is registered on window.__reckPanes.
  public readonly debugId: string;
  private term: Terminal;
  private fit: FitAddon;
  private ws: PaneWS;
  private resizeObserver?: ResizeObserver;
  // MutationObserver watching the wrapper element (our container's
  // parent) for class changes — specifically the `.hidden` toggle driven
  // by the layout code when a pane is shown/hidden. Used only for
  // [scroll-debug] logging; the logic doesn't react to class changes.
  private hiddenClassObserver?: MutationObserver;
  private lastHiddenState?: boolean;
  // Last (cols, rows) we successfully sent to the daemon. -1 = never sent /
  // reset on hello. Dedupes redundant SIGWINCH churn during drags and
  // prevents re-sending an unchanged size every time a ResizeObserver fires.
  private lastSentCols = -1;
  private lastSentRows = -1;
  // Set once by dispose(). Guards post-teardown calls into xterm —
  // `refit()` + `scrollToBottom()` are scheduled via rAF by the
  // layout, and the RAF can fire after the pane has been closed
  // (rapid tab-switch → close, or layout.dispose() before the next
  // frame). Without this, xterm throws on the disposed instance.
  private disposed = false;

  // True while the container actually occupies pixels. Ancestor display:none
  // makes clientWidth/clientHeight both 0; fitting or sending resize in that
  // state ships a FitAddon-clamped 2x1 to the PTY, which scrambles the
  // backgrounded app's grid and wedges xterm's viewport on the next switch.
  private isLaidOut(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  // Send the current grid size, skipping when unchanged or when the socket
  // isn't open (so a silently-dropped send doesn't poison the dedupe state).
  // Caller is responsible for having called fit first.
  private sendResizeIfChanged() {
    const c = this.term.cols;
    const r = this.term.rows;
    if (c === this.lastSentCols && r === this.lastSentRows) return;
    if (this.ws.getState() !== "open") return;
    this.ws.send({ type: "resize", cols: c, rows: r });
    this.lastSentCols = c;
    this.lastSentRows = r;
  }

  /**
   * Public read-only access to the underlying xterm `Terminal`. Used by
   * features that need to interact with xterm directly — installing the
   * path linkifier on scrollback, registering decorations/markers for
   * live highlighting, querying selection state, etc.
   *
   * Callers MUST NOT dispose the returned terminal — its lifecycle is
   * owned by this `TerminalPane`.
   */
  public getXterm(): Terminal {
    return this.term;
  }

  /**
   * Return a shallow snapshot of this pane's xterm viewport/buffer state.
   * Matches the capture checklist from an earlier release so a developer with devtools
   * open can eyeball the numbers in one line without navigating
   * `term.buffer.active`. Safe to call at any time — read-only.
   */
  public debugSnapshot(): {
    rows: number;
    cols: number;
    bufferLength: number;
    viewportY: number;
    baseY: number;
    cursorY: number;
  } {
    const b = this.term.buffer.active;
    return {
      rows: this.term.rows,
      cols: this.term.cols,
      bufferLength: b.length,
      viewportY: b.viewportY,
      baseY: b.baseY,
      cursorY: b.cursorY,
    };
  }

  // Emit a tagged console line for the scroll-wedge diagnostic branch .
  // Prefix is grep-friendly: `[scroll-debug]` plus the debugId of the pane.
  // `extra` is merged into the snapshot so callers can add event-specific
  // context (e.g. refit phase, class-change direction).
  //
  // Gated behind `isScrollDebugEnabled()` — the hooks ship to main but stay
  // silent for regular users. Opt in via devtools before reproducing:
  //   localStorage.setItem("reck.debug.scroll", "1"); location.reload()
  // or ?reckDebugScroll=1 on the URL. see an earlier release for why this is worth the
  // effort: the raw log volume is ~40 lines/sec during active multi-pane
  // work and made the console unusable during normal development.
  private scrollDebug(event: string, extra: Record<string, unknown> = {}) {
    if (!isScrollDebugEnabled()) return;
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[scroll-debug] ${this.debugId} ${event}`,
        { event, ...this.debugSnapshot(), ...extra },
      );
    } catch { /* console may be stubbed out in tests */ }
  }

  constructor(private props: TerminalPaneProps) {
    this.debugId = `term-${nextDebugId++}`;
    this.container = document.createElement("div");
    this.container.className = "pane-terminal";
    // Tag the DOM so devtools hovering over the element shows the id.
    this.container.setAttribute("data-reck-pane", this.debugId);

    // fontSize 17 on iOS: 33 cols × cell ~10.2px ≈ 336px, fits any
    // iPhone width. Also ≥16px so iOS Safari doesn't auto-zoom on the
    // hidden textarea focus (the native mobile-Safari "zoom into input"
    // behaviour only fires for inputs smaller than 16px).
    const fontSize = isIOS() ? 17 : 13;
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize,
      lineHeight: 1.25,
      letterSpacing: 0,
      theme: themeFor(props.theme ?? "dark"),
      cursorBlink: false,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    if (!isIOS()) {
      try {
        const webgl = new WebglAddon();
        this.term.loadAddon(webgl);
      } catch {
        /* fallback to canvas */
      }
    }
    installOscFilter(this.term.parser);

    // Shift+Enter → ESC + CR (0x1B 0x0D). Same byte sequence Claude
    // Code's `/terminal-setup` programs into VS Code/iTerm2 (verified
    // in the Claude Code CLI source: `sendSequence` arg is `"\x1B\r"`).
    // Claude's TUI reads ESC+CR as "insert newline in prompt"; plain
    // CR submits. xterm.js doesn't differentiate Shift+Enter from
    // Enter on its own, so without a custom handler both would submit.
    //
    // preventDefault + stopPropagation are required: xterm.js's hidden
    // textarea would otherwise also receive the Shift+Enter and inject
    // a literal `\n` into the PTY via its input-event path, which
    // arrives *after* our ESC+CR and submits whatever's in the prompt.
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        const bytes = new TextEncoder().encode("\x1b\r");
        this.ws.send({ type: "input", data: encodeBytes(bytes) });
        return false;
      }
      return true;
    });

    this.term.onData((data) => {
      this.ws.send({ type: "input", data: encodeBytes(new TextEncoder().encode(data)) });
    });

    this.ws = new PaneWS(
      props.wsUrl,
      {
      onHello: (m) => {
        this.scrollDebug("onHello:enter", {
          helloCols: m.cols,
          helloRows: m.rows,
          hasReplay: !!m.replay,
        });
        // Reset dedupe: a fresh hello may be a reconnect to a new
        // daemon-side PTY (e.g. after daemon restart + --resume), so even
        // an unchanged cols/rows still needs to go through.
        this.lastSentCols = -1;
        this.lastSentRows = -1;

        let targetCols: number;
        let targetRows: number;
        if (isIOS()) {
          // Pin to phone geometry regardless of container size.
          targetCols = IOS_COLS;
          targetRows = IOS_ROWS;
          this.term.resize(targetCols, targetRows);
        } else if (this.isLaidOut()) {
          try { this.fit.fit(); } catch { /* container not measurable yet */ }
          targetCols = this.term.cols;
          targetRows = this.term.rows;
        } else {
          // Pane was hidden when the WS connected. Sync xterm's grid to
          // the daemon's recorded cols/rows so the replay and any
          // subsequent live output land on the matching grid, and defer
          // the fit + resize-send to the first refit() after the pane
          // becomes visible. Sending resize now would clamp to FitAddon's
          // 2x1 minimum (the container has zero pixels), scrambling the
          // backgrounded app's grid.
          if (m.cols > 0 && m.rows > 0) {
            this.term.resize(m.cols, m.rows);
            if (m.replay) this.term.write(decodeBytes(m.replay));
          }
          this.props.onStoplight?.(m.stoplight);
          this.scrollDebug("onHello:exit(hidden)", { hadReplay: !!m.replay });
          return;
        }
        // Replay bytes include cursor-positioning escape codes (\x1b[H,
        // \x1b[<n>;<n>H, etc.) that are grid-specific to the PTY width at
        // the time the output was produced. If our cols differ from that
        // width we can't reinterpret those coordinates — xterm's reflow
        // only handles soft-wrapped lines, not absolute cursor moves. So:
        //
        // - Same width: write replay as-is (the normal desktop-reconnect
        //   path — everything lines up).
        // - Different width: skip replay and trust SIGWINCH. The resize
        //   we send next makes the daemon call `pty.Setsize`, which fires
        //   SIGWINCH; Claude Code (and most TUI apps) respond by clearing
        //   and redrawing the full screen at the new width. The phone
        //   fills in cleanly from fresh output within a frame or two.
        // an earlier release: previously we skipped replay on width mismatch on the
        // theory that absolute-cursor escapes in the buffer would land at
        // wrong positions. In practice, "skip replay" leaves the new pane
        // *completely blank* until the user types — Claude's SIGWINCH-driven
        // redraw only repaints the prompt and status bar, not the
        // historical screen. Garbled-but-visible beats blank, so we now
        // write the replay regardless. xterm's reflow handles soft wraps,
        // and a Ctrl+L nudge below asks Claude to redraw cleanly at the
        // new width once SIGWINCH has propagated.
        const widthsMatch = m.cols > 0 && m.cols === targetCols;
        if (m.replay) {
          this.term.write(decodeBytes(m.replay));
        }
        this.sendResizeIfChanged();
        // On width mismatch, ask the foreground app to repaint at the new
        // width by writing a Ctrl+L (form feed) into the PTY. Done via
        // requestAnimationFrame + 100 ms timeout to give the daemon's
        // Setsize → SIGWINCH a chance to land before the nudge is read.
        // Gated on `m.replay && !widthsMatch` so the normal same-width
        // reconnect path stays untouched.
        if (m.replay && !widthsMatch) {
          setTimeout(() => {
            try {
              this.ws.send({ type: "input", data: encodeBytes(new Uint8Array([0x0c])) });
            } catch {
              // WS may have closed between the schedule and the fire.
            }
          }, 100);
        }
        this.props.onStoplight?.(m.stoplight);
        this.scrollDebug("onHello:exit", {
          widthsMatch,
          wroteReplay: !!m.replay,
          nudgedRedraw: !!(m.replay && !widthsMatch),
        });
      },
      onOutput: (m) => this.term.write(decodeBytes(m.data)),
      onStatus: (m) => this.props.onStoplight?.(m.stoplight),
      onExit: (m) => {
        this.term.write(`\r\n\x1b[90m[process exited: ${m.code}]\x1b[0m\r\n`);
        this.props.onExit?.(m.code);
      },
      onError: (m) => {
        this.term.write(`\r\n\x1b[31m[error: ${m.msg}]\x1b[0m\r\n`);
      },
      onStateChange: (s, closeInfo) => this.props.onConnState?.(s, closeInfo),
      },
      props.wsSubprotocols ?? [],
    );
  }

  mount() {
    this.term.open(this.container);
    if (isIOS()) {
      this.term.resize(IOS_COLS, IOS_ROWS);
    } else if (this.isLaidOut()) {
      try { this.fit.fit(); } catch { /* DOM not measurable yet */ }
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.container);
    }
    if (isIOS()) this.installIOSInputFix();
    this.installPasteImageHandler();
    // Register on the global debug registry so devtools can reach the
    // pane without spelunking the DOM. See attachDebugHooks() for the
    // accessor contract. Called after `term.open` so the xterm
    // instance is already backed by a real DOM.
    attachDebugHooks(this);
    // Watch the wrapper's class list for `.hidden` flips (driven by
    // PaneLayout.syncLeafView on tab switches). Pure logging — no
    // behavioural reaction. Observes `container.parentElement` because
    // the wrapper (class `pane-terminal` in pane-layout) is what the
    // layout toggles `.hidden` on.
    this.installHiddenClassObserver();
    this.ws.connect();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    detachDebugHooks(this);
    this.hiddenClassObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.ws.close();
    this.term.dispose();
    this.container.remove();
  }

  focus() {
    this.term.focus();
    // Mark this pane as the "active" one for devtools. The layout code
    // calls focus() whenever a leaf/tab becomes active, so this is a
    // reasonable proxy for "the pane the user is currently looking at".
    markActiveDebugPane(this);
  }

  refit() {
    if (this.disposed) return;
    this.scrollDebug("refit:enter", {
      laidOut: this.isLaidOut(),
      containerW: this.container.clientWidth,
      containerH: this.container.clientHeight,
    });
    try {
      if (isIOS()) {
        this.term.resize(IOS_COLS, IOS_ROWS);
      } else if (this.isLaidOut()) {
        this.fit.fit();
      } else {
        this.scrollDebug("refit:skip(not-laid-out)");
        return;
      }
      // refit() is the explicit "reassert geometry" hook — it runs on
      // window focus, visibility restore, and tab re-show, where another
      // client may have resized the shared PTY while we were
      // backgrounded. Reset the dedupe so the send always goes through
      // even when our local cols/rows match the last send.
      this.lastSentCols = -1;
      this.lastSentRows = -1;
      this.sendResizeIfChanged();
      this.scrollDebug("refit:exit");
    } catch (err) {
      this.scrollDebug("refit:error", { err: String(err) });
    }
  }

  setTheme(theme: PaneTheme) {
    this.term.options.theme = themeFor(theme);
  }

  /**
   * True when the viewport is scrolled all the way to the bottom of
   * the buffer (i.e. the user is "live-tailing" the output). Used by
   * the layout code to decide, on tab-switch or window-refocus,
   * whether to snap back to the tail after a `refit()` — we only want
   * to do that when the pane was already pinned, so a user who
   * scrolled up to read history isn't yanked away.
   *
   * `viewportY` is the scrollback row the top-left of the visible
   * area maps to; `baseY` is the row where the live buffer begins.
   * Equal → viewport is flush with the tail.
   */
  public isAtBottom(): boolean {
    const b = this.term.buffer.active;
    return b.viewportY === b.baseY;
  }

  /**
   * Snap the viewport to the bottom of the buffer. Thin wrapper over
   * xterm's `scrollToBottom()` so call-sites don't reach into the
   * private `term` field.
   */
  public scrollToBottom(): void {
    if (this.disposed) return;
    this.term.scrollToBottom();
  }

  /**
   * Number of rows the viewport currently sits *above* the live tail
   * (`baseY - viewportY`). 0 when pinned to the tail; positive when the
   * user has scrolled up to read history. Used by the layout code on the
   * active→hidden edge to remember a partial-scroll position so it can
   * be restored on hidden→active (an earlier release — the previous boolean-only
   * `wasAtBottom` snapshot lost partial-scroll state).
   */
  public getViewportOffsetFromBottom(): number {
    const b = this.term.buffer.active;
    return b.baseY - b.viewportY;
  }

  /**
   * Re-anchor the viewport `offset` rows above the current `baseY`.
   * Clamped to a non-negative absolute scroll position so output that
   * accumulated while the pane was hidden (which advances `baseY`) can
   * never push the restore target out of bounds. Equivalent to
   * `term.scrollToLine(baseY - offset)` clamped to `[0, baseY]`, but
   * uses the relative `scrollLines` API so no-op calls (offset 0,
   * already at tail) skip a redundant render tick.
   *
   * Counterpart to `getViewportOffsetFromBottom`. See an earlier release.
   */
  public restoreViewportOffsetFromBottom(offset: number): void {
    if (this.disposed) return;
    // Defensive: a NaN / Infinity offset can only land here through a
    // future caller bug (the layout code computes `baseY - viewportY`,
    // both finite), but `term.scrollLines(NaN)` would push xterm
    // somewhere undefined. Reject silently rather than propagate.
    if (!Number.isFinite(offset)) return;
    if (offset <= 0) return;
    const b = this.term.buffer.active;
    const target = Math.max(0, b.baseY - offset);
    const delta = target - b.viewportY;
    if (delta === 0) return;
    this.term.scrollLines(delta);
  }


  private onResize() {
    this.scrollDebug("onResize:enter", {
      laidOut: this.isLaidOut(),
      containerW: this.container.clientWidth,
      containerH: this.container.clientHeight,
    });
    try {
      // iOS stays pinned to IOS_COLS×IOS_ROWS; only the desktop path lets
      // the container's pixel size drive cols/rows through fit(). Skip
      // entirely when the container isn't laid out — otherwise FitAddon
      // clamps to 2x1 and we ship that to the PTY.
      if (isIOS()) {
        this.term.resize(IOS_COLS, IOS_ROWS);
      } else if (this.isLaidOut()) {
        this.fit.fit();
      } else {
        this.scrollDebug("onResize:skip(not-laid-out)");
        return;
      }
      this.sendResizeIfChanged();
      this.scrollDebug("onResize:exit");
    } catch (err) {
      this.scrollDebug("onResize:error", { err: String(err) });
    }
  }

  // MutationObserver set up in mount(): watch for the `.hidden` class
  // toggle on the wrapper element (our container's parent, which
  // PaneLayout uses to show/hide terminals on tab switch). Purely
  // diagnostic — the pane still reacts to layout changes via refit()
  // and ResizeObserver. Skipped when the scroll-debug gate is off so
  // regular users don't pay for an observer whose only effect is a
  // silenced console.log.
  private installHiddenClassObserver() {
    if (!isScrollDebugEnabled()) return;
    if (typeof MutationObserver === "undefined") return;
    const wrapper = this.container.parentElement;
    if (!wrapper) return;
    const readHidden = () => wrapper.classList.contains("hidden");
    this.lastHiddenState = readHidden();
    this.hiddenClassObserver = new MutationObserver(() => {
      const now = readHidden();
      if (now === this.lastHiddenState) return;
      this.lastHiddenState = now;
      this.scrollDebug("hiddenClassChange", {
        hidden: now,
        containerW: this.container.clientWidth,
        containerH: this.container.clientHeight,
      });
    });
    this.hiddenClassObserver.observe(wrapper, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  /**
   * iOS Safari held-Backspace workaround. The soft keyboard only fires
   * one `deleteContentBackward` before xterm's hidden textarea is cleared
   * — after that iOS treats the (empty) textarea as "nothing to delete"
   * and held-backspace silently stops. We intercept `beforeinput`,
   * preventDefault the browser mutation, and forward a real DEL byte
   * (0x7f) to the PTY ourselves so held-backspace repeats correctly.
   */
  private installIOSInputFix() {
    const ta = (this.term as unknown as { textarea?: HTMLTextAreaElement }).textarea;
    if (!ta) return;
    ta.addEventListener("beforeinput", (ev: Event) => {
      const e = ev as InputEvent;
      if (e.inputType === "deleteContentBackward") {
        e.preventDefault();
        this.ws.send({ type: "input", data: encodeBytes(new Uint8Array([0x7f])) });
      }
    });
  }

  /**
   * Image-paste → upload → type-path-into-PTY flow (phase 1).
   *
   * xterm's own paste handler only deals with text — it reads
   * `clipboardData.getData("text/plain")` and writes that into the PTY.
   * An `image/png` blob in the clipboard never touches stdin. We wire a
   * capture-phase listener on the xterm root so we see paste events
   * before xterm's handler runs, check for image blobs, and if any are
   * present intercept the event.
   *
   * Behaviour:
   *   - At least one image item → `preventDefault()` (blocking xterm's
   *     text path), then serially upload each image and type the
   *     returned absolute path into the PTY followed by a single space.
   *     The space means the user can immediately type continuation text
   *     without a merged token, and it also prevents the model / shell
   *     from reading a trailing char from whatever the user types next.
   *     We deliberately don't send a newline — the user decides when to
   *     submit.
   *   - No image items (plain text, files drag-dropped later, etc.) →
   *     the handler is a no-op; xterm's default paste runs untouched.
   *   - Non-image items mixed with image items → the image items get
   *     uploaded; the text items are dropped. Trying to forward both
   *     would produce unpredictable interleaving with typing during an
   *     in-flight upload.
   *
   * No handler wired when `onPasteUpload` is undefined — keeps the
   * Mini PWA / any other client-core consumer that doesn't want
   * image paste from breaking.
   *
   * Error handling: a failed upload fires `onPasteUploadError` and is
   * otherwise swallowed. We do NOT fall back to xterm's text path
   * after a failed image upload — the image data isn't text, so
   * nothing useful would be pasted, and mixing modes would surprise
   * the user.
   */
  private installPasteImageHandler() {
    if (!this.props.onPasteUpload) return;
    const root = this.container;
    // Capture phase so we run before xterm's own listener (which is
    // attached to the hidden textarea inside `root`). Without capture
    // our handler would fire after xterm has already consumed the
    // paste event, and `preventDefault()` would be a no-op.
    root.addEventListener("paste", (ev: ClipboardEvent) => {
      this.handlePasteEvent(ev).catch(() => {
        // Per-image errors are reported via onPasteUploadError from
        // inside handlePasteEvent; any exception that escapes here is
        // a programmer error (e.g. the handler threw synchronously
        // before hitting its own try/catch). Swallow silently so a
        // single buggy paste doesn't brick the pane.
      });
    }, true);
  }

  private async handlePasteEvent(ev: ClipboardEvent): Promise<void> {
    const upload = this.props.onPasteUpload;
    if (!upload) return;
    const items = ev.clipboardData?.items;
    if (!items || items.length === 0) return;
    // Collect image blobs before any async work — `items` is a live
    // view that can go away once we yield. `getAsFile()` synchronously
    // captures the blob into a local reference we can keep.
    const images: { blob: Blob; mime: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const mime = item.type.toLowerCase();
      if (!IMAGE_PASTE_MIMES.has(mime)) continue;
      const blob = item.getAsFile();
      if (blob) images.push({ blob, mime });
    }
    if (images.length === 0) return;
    // At least one image — block xterm's text-paste path. We still
    // uploaded-then-typed the paths, but xterm would have pasted a
    // text-flavoured fallback (often a file URL or empty string) on
    // top of our path, which the user definitely doesn't want.
    ev.preventDefault();
    // Serial uploads so the paths arrive in clipboard order. Parallel
    // would be faster but the ordering matters: when the user pastes
    // two screenshots back-to-back they expect the first one to
    // reference the first image.
    for (const { blob, mime } of images) {
      try {
        const result = await upload(blob, mime);
        if (result.kind === "path") {
          // Phase 1 path: type the absolute path into the PTY exactly
          // like the user typing it. Trailing space so a follow-up
          // keystroke doesn't merge with the path.
          //
          // Before typing, emit a yellow inline breadcrumb when the
          // host classified *why* we fell off the chip path. Otherwise
          // the user just sees a path appear in the prompt with no
          // explanation, which looks identical to a bug. Same shape
          // as the existing `[process exited]` / `[error]` lines.
          if (result.fallbackReason) {
            const detail = result.fallbackDetail ? ` (${result.fallbackDetail})` : "";
            this.term.write(
              `\r\n\x1b[33m[paste fell back to /uploads — reason: ${result.fallbackReason}${detail}]\x1b[0m\r\n`,
            );
          }
          const payload = new TextEncoder().encode(result.path + " ");
          this.ws.send({ type: "input", data: encodeBytes(payload) });
        }
        // Phase 2 chip path: daemon already wrote 0x16 into the PTY
        // after the sidecar ACK; nothing for the renderer to type.
      } catch (err) {
        this.props.onPasteUploadError?.(err, mime);
      }
    }
  }
}

// --- Devtools debug hooks for scroll-wedge diagnostics ------------------
//
// These globals are intentionally unguarded in the Satellite: the app isn't
// exposed to end users, it only runs in Electron on developer machines, and
// the whole point is to let whoever has devtools open pop straight into a
// live TerminalPane without spelunking the DOM. The registry itself is cheap
// (one entry per pane, cleaned up on dispose) and carries no user-observable
// side effect, so it stays always-on — what matters is that the noisy
// `[scroll-debug]` logging path is gated via `isScrollDebugEnabled()`.
//
// Contract (stable enough for an earlier release but not a public API):
//
//   window.__reckActivePane       → the TerminalPane most recently focused,
//                                    or null if none yet.
//   window.__reckPanes            → Record<debugId, TerminalPane> of every
//                                    live pane (dispose() removes itself).
//   window.__reckPaneSnapshot(p?) → returns the snapshot object matching the
//                                    capture checklist in the issue. When
//                                    called with no arg, operates on
//                                    __reckActivePane. Returns null if none.
//
// If browsers / test envs don't have `window`, all these calls are no-ops.
//
// Gate activation (from the Satellite's Electron devtools console):
//
//   localStorage.setItem("reck.debug.scroll", "1"); location.reload()
//
// Or append `?reckDebugScroll=1` to the URL once (query-param form survives a
// single session without mutating localStorage — handy for one-off reprod
// attempts). Turn off with `localStorage.removeItem("reck.debug.scroll")` +
// reload.
//
// The gate is evaluated once per document load and cached; toggling
// localStorage mid-session has no effect until the next reload. This is
// intentional — avoids a localStorage read on every refit/onResize tick
// during active multi-pane work where the logging fires thousands of times.

export interface ReckPaneDebugSnapshot {
  rows: number;
  cols: number;
  bufferLength: number;
  viewportY: number;
  baseY: number;
  cursorY: number;
}

declare global {
  interface Window {
    __reckActivePane?: TerminalPane | null;
    __reckPanes?: Record<string, TerminalPane>;
    __reckPaneSnapshot?: (p?: TerminalPane) => ReckPaneDebugSnapshot | null;
  }
}

function debugWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

function attachDebugHooks(pane: TerminalPane) {
  const w = debugWindow();
  if (!w) return;
  if (!w.__reckPanes) w.__reckPanes = {};
  w.__reckPanes[pane.debugId] = pane;
  if (!w.__reckPaneSnapshot) {
    w.__reckPaneSnapshot = (p?: TerminalPane): ReckPaneDebugSnapshot | null => {
      const target = p ?? w.__reckActivePane;
      return target ? target.debugSnapshot() : null;
    };
  }
}

function detachDebugHooks(pane: TerminalPane) {
  const w = debugWindow();
  if (!w) return;
  if (w.__reckPanes) delete w.__reckPanes[pane.debugId];
  if (w.__reckActivePane === pane) w.__reckActivePane = null;
}

function markActiveDebugPane(pane: TerminalPane) {
  const w = debugWindow();
  if (!w) return;
  w.__reckActivePane = pane;
}
