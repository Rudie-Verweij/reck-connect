import type {
  ClientMessage,
  ServerMessage,
  HelloMessage,
  OutputMessage,
  StatusMessage,
  ExitMessage,
  ErrorMessage,
} from "@proto/proto";

export type PaneWSState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Information attached to an `onStateChange` call when the transition was
 * driven by a WebSocket close frame. Populated only for transitions
 * triggered by `ws.onclose` (i.e. into `reconnecting` or `closed`); the
 * `connecting` and `open` transitions and explicit `close()` calls pass
 * `undefined`.
 *
 * `code` follows the standard WebSocket close-code numbering:
 *   - 1000  normal closure
 *   - 1001  going away (daemon shutdown)
 *   - 1006  abnormal — set by the browser when no close frame arrived
 *   - 1008  policy violation (auth failure)
 *   - 1011  internal server error
 *
 * `reason` is the UTF-8 string the peer attached to the close frame, or
 * `""` if none was supplied. Callers should treat both as best-effort
 * diagnostics — some browsers / proxies coerce close codes to 1006 and
 * drop the reason regardless of what the peer sent.
 */
export interface PaneWSCloseInfo {
  code: number;
  reason: string;
}

export interface PaneWSHandlers {
  onHello?: (m: HelloMessage) => void;
  onOutput?: (m: OutputMessage) => void;
  onStatus?: (m: StatusMessage) => void;
  onExit?: (m: ExitMessage) => void;
  onError?: (m: ErrorMessage) => void;
  /**
   * Called whenever the socket changes lifecycle state. `closeInfo` is
   * populated only for transitions caused by an inbound close frame —
   * usually `reconnecting` (transient) or `closed` (after explicit
   * `close()`). The optional second argument keeps existing callers
   * source-compatible: a `(state) => …` handler still works unchanged.
   */
  onStateChange?: (state: PaneWSState, closeInfo?: PaneWSCloseInfo) => void;
}

// Soft ceiling on browser-side WebSocket buffering. Above this, outbound
// sends are dropped + logged rather than let the browser buffer grow
// unbounded. 1 MiB is ~40 full-screen pastes at typical terminal sizes —
// unusual enough in legitimate use that hitting it signals a stuck
// server, not user typing. Exposed as a module-level const so callers
// can read the exact threshold from the caller's error surface.
export const WS_BACKPRESSURE_BYTES = 1024 * 1024;

// Jitter variance applied to the reconnect backoff. 0.25 = ±25% band,
// enough to decorrelate a wave of clients reconnecting after a station-
// wide network blip without making the backoff wildly unpredictable.
// See: AWS architecture "exponential backoff and jitter" (2015).
const JITTER_FRACTION = 0.25;

/**
 * Returns a jittered delay within [base * (1 - JITTER_FRACTION),
 * base * (1 + JITTER_FRACTION)]. Exported for testability only —
 * callers should not depend on the jitter shape, just that the value
 * sits within the band.
 */
export function jitteredDelay(baseMs: number): number {
  const variance = baseMs * JITTER_FRACTION;
  // Math.random() ∈ [0, 1) → jitter ∈ [-variance, +variance)
  const jitter = (Math.random() * 2 - 1) * variance;
  return Math.max(0, Math.round(baseMs + jitter));
}

export class PaneWS {
  private ws: WebSocket | null = null;
  private state: PaneWSState = "closed";
  private closed = false;
  private backoffMs = 500;
  private readonly maxBackoffMs = 15_000;
  // Set when the last send was refused due to backpressure. Cleared
  // the next time a send succeeds. Exposed via getBackpressureDrops
  // for callers to surface in the UI ("lost N keystrokes — station
  // is buffering, reconnect?"). Counter of DROPPED messages across
  // the lifetime of this PaneWS instance.
  private backpressureDrops = 0;

  // Monotonic attempt ID assigned to each socket opened by this class.
  // Every event handler (onopen, onmessage, onclose, onerror) captures
  // the ID at attach time and checks `attemptId === currentAttemptId`
  // before mutating shared state. Without this, a late `onclose` from
  // an older socket (after an explicit reconnect via connect()) can
  // clear this.ws or schedule a reconnect that fights with the new
  // socket's lifecycle. The attempt ID turns every stale callback
  // into a no-op. see an earlier release Section 4.1.
  private currentAttemptId = 0;

  // Outbound-message queue for sends that arrive before onopen. xterm
  // wires `onData` to ws.send the instant the terminal is typed-into,
  // and TerminalPane.refit() emits a resize message inside onHello's
  // synchronous handler — both can fire while state is "connecting" or
  // "reconnecting". Before an earlier release Section 4.1 those sends were silently
  // discarded; now they queue up and flush on the next successful
  // open. Resize messages are coalesced so only the most recent
  // dimensions ship (no need to replay every intermediate size).
  //
  // Soft cap: if the socket stays down long enough for the queue to
  // exceed maxPendingInputs, we drop the OLDEST input to keep memory
  // bounded. 4096 entries * ~50 bytes avg = ~200 KiB worst case,
  // which is fine for a desktop renderer but still bounded.
  private pending: ClientMessage[] = [];
  private readonly maxPendingInputs = 4096;

  // Resolved fresh on every open() call so a token rotation that
  // landed mid-session is picked up on the next reconnect attempt.
  // A static array is wrapped at construction time; a thunk is stored
  // verbatim. See the constructor doc for why this matters for the
  // 1008 → token-update → auto-reconnect flow.
  private readonly subprotocolsProvider: () => string[];

  /**
   * @param url           Pane WebSocket URL — MUST NOT include the
   *                      bearer token in the query string. URLs end up
   *                      in access logs, devtools panels, and crash
   *                      reports, so the token goes via
   *                      `Sec-WebSocket-Protocol` instead.
   * @param handlers      Incoming-message callbacks.
   * @param subprotocols  Sec-WebSocket-Protocol entries offered on each
   *                      connect. The daemon expects `reck-bearer.<token>`
   *                      for authenticated mode and echoes the matching
   *                      one back in the 101 response. Pass `[]` for
   *                      unauthenticated local daemons.
   *
   *                      Accepts either a static array (legacy callers)
   *                      OR a thunk `() => string[]` re-evaluated on
   *                      every reconnect. The thunk form is required
   *                      for the 1008 → token-update flow: when a
   *                      mid-session token rotation happens, the next
   *                      `open()` must resolve a fresh subprotocol
   *                      array reflecting the new token. With a static
   *                      array, every reconnect would replay the
   *                      stale token and loop on 1008 indefinitely.
   *                      A static array is wrapped internally as
   *                      `() => arr` so it remains source-compatible
   *                      with all existing callers.
   */
  constructor(
    public readonly url: string,
    private readonly handlers: PaneWSHandlers,
    subprotocols: string[] | (() => string[]) = [],
  ) {
    this.subprotocolsProvider =
      typeof subprotocols === "function" ? subprotocols : () => subprotocols;
  }

  /** Connect (or reconnect) to the daemon. Idempotent — calling while
   * already connecting/open is a no-op. Re-enables the socket lifecycle
   * after an explicit close(). */
  connect() {
    this.closed = false;
    // Idempotent: a second connect() while already connecting or open
    // is a no-op. Pre-fix, it would construct a second WebSocket and
    // the old socket's onclose would corrupt the new one's state.
    if (this.state === "connecting" || this.state === "open") return;
    this.open();
  }

  close() {
    this.closed = true;
    this.setState("closed");
    // Bumping the attempt ID ensures any pending onclose/onerror from
    // the current socket (fired after we called ws.close()) is treated
    // as stale and can't mutate our state.
    this.currentAttemptId++;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // Explicit close discards any queued unsent messages — caller is
    // tearing the socket down intentionally and doesn't want a next
    // connect() to replay stale input.
    this.pending.length = 0;
  }

  send(msg: ClientMessage) {
    // Flush the message immediately if the LIVE socket is OPEN;
    // otherwise queue it so the next successful open() delivers it.
    //
    // an audit finding: pre-fix this gated on `this.state === "open"`,
    // which is a wrapper-cached field updated only when our onclose
    // handler runs. The browser flips ws.readyState to CLOSING /
    // CLOSED synchronously when the underlying socket dies, but our
    // onclose can fire asynchronously (next microtask / task tick).
    // A keystroke or resize handler racing with that gap would call
    // ws.send() on a CLOSING socket and the browser throws
    // InvalidStateError synchronously — that exception bubbled out of
    // TerminalPane's onData handler and crashed the renderer during
    // reconnect storms. The fix is two-fold: check the live
    // readyState (== WebSocket.OPEN) so we never call send on a
    // closing socket, AND wrap ws.send in try/catch so any future
    // race that slips through still ends up queued for replay
    // instead of throwing into the caller.
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Backpressure check: if the browser is already buffering more
      // than WS_BACKPRESSURE_BYTES of outbound data, the server is
      // stuck or the network path is saturated. Dropping is better
      // than letting the browser's heap balloon — and the UI can
      // surface the drop count to the user.
      if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        this.backpressureDrops++;
        return;
      }
      try {
        ws.send(JSON.stringify(msg));
        return;
      } catch {
        // Defence in depth: even with the readyState gate above, the
        // socket can transition mid-call (browsers report state
        // changes asynchronously to JS but the underlying transport
        // is racing the network). Falling through to the queue path
        // means the caller (xterm onData / resize) never sees a
        // synchronous throw, and the message will replay on the
        // next successful open().
      }
    }
    if (this.closed) return;
    if (msg.type === "resize") {
      // Replace any prior queued resize; only the latest matters.
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].type === "resize") {
          this.pending.splice(i, 1);
        }
      }
    }
    this.pending.push(msg);
    // Soft cap: under a sustained outage with heavy typing, drop the
    // oldest queued input rather than grow unbounded. Resize coalescing
    // above keeps the cap from being hit by size churn alone.
    if (this.pending.length > this.maxPendingInputs) {
      this.pending.splice(0, this.pending.length - this.maxPendingInputs);
    }
  }

  /** Count of outbound sends dropped because the browser-side
   * WebSocket buffer exceeded WS_BACKPRESSURE_BYTES. Monotonically
   * increasing; does not reset on reconnect. */
  getBackpressureDrops(): number {
    return this.backpressureDrops;
  }

  getState(): PaneWSState {
    return this.state;
  }

  /** Number of messages currently queued for send-after-open. Exposed
   * for tests; not part of the normal caller contract. */
  getPendingCount(): number {
    return this.pending.length;
  }

  private open() {
    const attemptId = ++this.currentAttemptId;
    this.setState("connecting");
    // Re-resolve subprotocols on every open() so a mid-session token
    // rotation (1008 → user pastes new token → ApiClient.config.token
    // updated) flows through to the next reconnect. Resolving once at
    // construction time would pin every retry to the stale token.
    const subprotocols = this.subprotocolsProvider();
    // new WebSocket(url, protocols) — the only browser-standard way to
    // put auth material on a WS upgrade. Passing [] is equivalent to
    // the single-arg form; unauthenticated daemons go through that path.
    const ws =
      subprotocols.length > 0
        ? new WebSocket(this.url, subprotocols)
        : new WebSocket(this.url);
    this.ws = ws;

    // Every handler captures attemptId at attach time. If the PaneWS
    // has since moved on to a newer socket (attemptId !== currentAttemptId),
    // the handler is a stale callback from a defunct WebSocket and must
    // NOT mutate `this.ws`, `this.state`, or schedule reconnects —
    // doing so would corrupt the newer socket's lifecycle.
    ws.onopen = () => {
      if (attemptId !== this.currentAttemptId) return;
      this.backoffMs = 500;
      this.setState("open");
      // Flush anything queued while we were connecting/reconnecting.
      // Send failures fall through to onclose → reconnect, no special
      // handling needed here.
      //
      // Backpressure policy on flush (Codex review follow-up #3):
      // apply the SAME cap the live-send path uses. A large reconnect
      // backlog (long outage + heavy typing) could otherwise dump
      // megabytes of input in one go, bypassing the cap entirely
      // and hiding the loss — bufferedAmount isn't checked in the
      // flush loop, and the drop counter stays at 0. Now we check
      // before each send; once over the cap, we drop the remainder
      // and increment the drop counter. In-order semantics are
      // preserved: if message N is dropped, N+1..end are also
      // dropped (rather than shipping a gap).
      const toFlush = this.pending;
      this.pending = [];
      for (let i = 0; i < toFlush.length; i++) {
        const msg = toFlush[i];
        if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
          // Drop this and everything after it. Matches live-send
          // drop-with-counter semantics: bytes past the cap are
          // discarded silently to preserve heap/liveness.
          this.backpressureDrops += toFlush.length - i;
          break;
        }
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // If flushing itself throws, re-queue the remainder
          // (including this one) and let onclose trigger a
          // reconnect. Distinct from the backpressure-drop path:
          // here the send system failed, not the cap.
          this.pending.push(...toFlush.slice(i));
          break;
        }
      }
    };
    ws.onmessage = (ev) => {
      if (attemptId !== this.currentAttemptId) return;
      let data: ServerMessage;
      try {
        data = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      switch (data.type) {
        case "hello":
          this.handlers.onHello?.(data);
          break;
        case "output":
          this.handlers.onOutput?.(data);
          break;
        case "status":
          this.handlers.onStatus?.(data);
          break;
        case "exit":
          this.handlers.onExit?.(data);
          break;
        case "error":
          this.handlers.onError?.(data);
          break;
      }
    };
    ws.onerror = () => {
      // onclose will handle state transition. Stale-attempt guard
      // isn't strictly needed here but is cheap insurance.
      if (attemptId !== this.currentAttemptId) return;
    };
    ws.onclose = (ev: CloseEvent) => {
      // Stale close from a prior socket must not fight with the
      // current one — it was replaced by a newer open() and its
      // teardown is irrelevant to our state machine.
      if (attemptId !== this.currentAttemptId) return;
      this.ws = null;
      // Surface the standard close code/reason so callers can
      // distinguish auth failure (1008) from peer shutdown (1001) from
      // generic network drop. The browser fills in 1006/"" when no
      // close frame arrived, so callers should treat 1006 as "unknown
      // network drop" rather than a daemon-sent code.
      const closeInfo: PaneWSCloseInfo = {
        code: ev.code,
        reason: ev.reason ?? "",
      };
      if (this.closed) return;
      this.setState("reconnecting", closeInfo);
      // Apply ±JITTER_FRACTION randomisation to the scheduled delay
      // BEFORE waiting — without this, a whole Satellite deployment
      // reconnecting after a station-wide blip fires in lockstep and
      // hammers the daemon the moment it comes back up. With jitter
      // the reconnect wave is spread across the backoff window.
      const delay = jitteredDelay(this.backoffMs);
      setTimeout(() => {
        if (this.closed) return;
        if (attemptId !== this.currentAttemptId) return;
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        this.open();
      }, delay);
    };
  }

  private setState(s: PaneWSState, closeInfo?: PaneWSCloseInfo) {
    if (this.state === s) return;
    this.state = s;
    this.handlers.onStateChange?.(s, closeInfo);
  }
}

/** Base64 helpers (for PTY byte data). */
export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeText(s: string): string {
  return encodeBytes(new TextEncoder().encode(s));
}
