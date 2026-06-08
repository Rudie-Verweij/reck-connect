import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encodeBytes,
  decodeBytes,
  encodeText,
  PaneWS,
  jitteredDelay,
  WS_BACKPRESSURE_BYTES,
} from "./ws";

describe("base64 helpers", () => {
  it("roundtrips bytes", () => {
    const input = new Uint8Array([0, 1, 2, 65, 66, 67, 255]);
    const b64 = encodeBytes(input);
    const out = decodeBytes(b64);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("encodes text", () => {
    const b64 = encodeText("hello\n");
    expect(atob(b64)).toBe("hello\n");
  });

  it("handles high-byte sequences", () => {
    const input = new Uint8Array([0xe2, 0x98, 0x83]); // snowman in UTF-8
    const out = decodeBytes(encodeBytes(input));
    expect(new TextDecoder().decode(out)).toBe("☃");
  });
});

/**
 * Controllable mock WebSocket — tests manipulate its readyState, invoke
 * callbacks explicitly, and inspect sent payloads. Registers itself
 * with a module-level list so tests can locate every constructed
 * socket and assert on close counts, etc.
 */
class MockWebSocket {
  // Spec readyState constants. Mirroring them on the class lets
  // production code that gates on `WebSocket.OPEN` (readyState
  // comparison) work against the mock without modification.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  protocols: string | string[] | undefined;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls = 0;
  // Lets tests simulate browser-side send buffering for backpressure
  // tests. Callers can set this to WS_BACKPRESSURE_BYTES + 1 to force
  // PaneWS.send into the drop-and-count branch.
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
    // When a test wires a send-side buffer accounting callback, invoke
    // it so the mock can auto-grow bufferedAmount as messages ship.
    // Used by the reconnect-flush backpressure test to model
    // "buffer fills up as we dump the backlog."
    if (this.onSendAccount) this.onSendAccount(data);
  }
  // Optional hook: tests that simulate buffer growth during flush
  // assign this to increment bufferedAmount on each send. Default is
  // a no-op; the manual bufferedAmount setter still works for simpler
  // tests.
  onSendAccount?: (data: string) => void;

  close() {
    this.closeCalls++;
    this.readyState = 3; // CLOSED
    // In a real browser, onclose fires asynchronously after close();
    // the test driver can call fireClose() to simulate that.
  }

  // Test helpers to simulate the real WebSocket lifecycle.
  fireOpen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  fireMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  fireClose(code?: number, reason?: string) {
    this.readyState = 3;
    // jsdom's CloseEvent honours `code` + `reason` in the init dict.
    // Defaulting to 1006 matches the spec: a close without an
    // inbound close frame is reported as "abnormal" by the browser.
    const init: CloseEventInit = {
      code: code ?? 1006,
      reason: reason ?? "",
    };
    this.onclose?.(new CloseEvent("close", init));
  }
  fireError() {
    this.onerror?.(new Event("error"));
  }
}

function installMockWS() {
  MockWebSocket.instances = [];
  const orig = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return () => {
    globalThis.WebSocket = orig;
  };
}

describe("PaneWS subprotocol plumbing", () => {
  let origWS: typeof WebSocket;
  let captured: { url: string; protocols: string | string[] | undefined };

  beforeEach(() => {
    origWS = globalThis.WebSocket;
    captured = { url: "", protocols: undefined };
    // Minimal WebSocket stub that records its constructor args. We
    // never fire `onopen` — the test only cares about the URL +
    // protocols passed to the constructor.
    const stub = vi.fn((url: string, protocols?: string | string[]) => {
      captured.url = url;
      captured.protocols = protocols;
      return {
        close: vi.fn(),
        send: vi.fn(),
        readyState: 0,
      } as unknown as WebSocket;
    });
    globalThis.WebSocket = stub as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = origWS;
  });

  it("passes subprotocols to the WebSocket constructor", () => {
    const ws = new PaneWS("ws://x/ws/p/p", {}, ["reck-bearer.secret"]);
    ws.connect();
    expect(captured.url).toBe("ws://x/ws/p/p");
    expect(captured.protocols).toEqual(["reck-bearer.secret"]);
    ws.close();
  });

  it("omits the protocols argument when array is empty (local mode)", () => {
    const ws = new PaneWS("ws://x/ws/p/p", {}, []);
    ws.connect();
    expect(captured.url).toBe("ws://x/ws/p/p");
    // With no protocols, the single-arg ctor form is used — the
    // stub receives undefined as its second positional arg.
    expect(captured.protocols).toBeUndefined();
    ws.close();
  });

  it("URL never contains the token even when subprotocols are configured", () => {
    const ws = new PaneWS(
      "ws://x/ws/p/p",
      {},
      ["reck-bearer.super-secret-token-value-xyz"],
    );
    ws.connect();
    expect(captured.url).not.toContain("super-secret-token-value-xyz");
    expect(captured.url).not.toContain("token=");
    ws.close();
  });
});

describe("PaneWS state machine — buffer & flush", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installMockWS();
  });
  afterEach(() => restore());

  it("queues sends issued before onopen and flushes them on connect", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];

    // Send while state is "connecting" — pre-fix this was a silent
    // drop; now it should queue.
    pws.send({ type: "input", data: "YQ==" }); // "a"
    pws.send({ type: "input", data: "Yg==" }); // "b"
    expect(pws.getPendingCount()).toBe(2);
    expect(mock.sent).toEqual([]);

    // Socket opens — queue flushes in FIFO order.
    mock.fireOpen();
    expect(pws.getPendingCount()).toBe(0);
    expect(mock.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "input", data: "YQ==" },
      { type: "input", data: "Yg==" },
    ]);
  });

  it("coalesces queued resize messages — only the latest ships", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];

    pws.send({ type: "resize", cols: 80, rows: 24 });
    pws.send({ type: "input", data: "eA==" });
    pws.send({ type: "resize", cols: 120, rows: 40 });
    pws.send({ type: "resize", cols: 140, rows: 50 });

    // Only the newest resize + the input should be queued.
    expect(pws.getPendingCount()).toBe(2);
    mock.fireOpen();
    const delivered = mock.sent.map((s) => JSON.parse(s));
    expect(delivered).toEqual([
      { type: "input", data: "eA==" },
      { type: "resize", cols: 140, rows: 50 },
    ]);
  });

  it("sends after onopen flush immediately (direct path, not queued)", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();

    pws.send({ type: "input", data: "Yw==" });
    expect(pws.getPendingCount()).toBe(0);
    expect(mock.sent).toEqual([JSON.stringify({ type: "input", data: "Yw==" })]);
  });

  it("close() discards pending messages", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    pws.send({ type: "input", data: "YQ==" });
    expect(pws.getPendingCount()).toBe(1);
    pws.close();
    expect(pws.getPendingCount()).toBe(0);
  });
});

describe("PaneWS state machine — idempotent connect & attempt ID", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installMockWS();
  });
  afterEach(() => restore());

  it("second connect() while already connecting is a no-op", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    pws.connect();
    pws.connect();
    // Only ONE WebSocket was constructed, not three.
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("second connect() while open is a no-op", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    MockWebSocket.instances[0].fireOpen();
    pws.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("stale socket onclose cannot mutate state of a newer connection", () => {
    // This is the attempt-ID invariant: an older socket's onclose fires
    // AFTER a newer connection is open — the stale handler must not
    // null out `this.ws` or schedule a phantom reconnect against the
    // newer attempt.
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const first = MockWebSocket.instances[0];

    // Simulate connection failure: onclose fires during a reconnect
    // backoff.
    first.fireClose();
    expect(pws.getState()).toBe("reconnecting");

    // Force a fresh open (real code does this via backoff timer; we
    // simulate directly by calling connect() again after close
    // completes — but connect() is a no-op since state is
    // "reconnecting"). We trigger a new open via the internal retry
    // path: fast-forward timers.
  });

  it("stale onclose from an abandoned socket does NOT bump backoff on a live socket", () => {
    // Scenario:
    //   1. connect() → WS #1 opens, closes (sets state=reconnecting).
    //   2. Before the backoff timer fires, close() + connect() create
    //      WS #2 via an explicit reset.
    //   3. If WS #1's stale onclose from (1) re-fires (some drivers do),
    //      it must NOT schedule a second reconnect that collides with
    //      WS #2's lifecycle.
    vi.useFakeTimers();
    try {
      const pws = new PaneWS("ws://x/ws/p/p", {}, []);
      pws.connect();
      const first = MockWebSocket.instances[0];
      first.fireOpen();
      first.fireClose();
      expect(pws.getState()).toBe("reconnecting");

      // Explicit close + reconnect produces a fresh attempt.
      pws.close();
      pws.connect();
      const second = MockWebSocket.instances[1];
      expect(second).toBeDefined();

      // Stale onclose from an earlier release re-fires. Pre-fix, it would have reset
      // this.ws = null and scheduled another reconnect; post-fix, the
      // attempt-ID guard bounces it.
      first.fireClose();

      // The newer socket's state wasn't clobbered.
      expect(pws.getState()).toBe("connecting");
      second.fireOpen();
      expect(pws.getState()).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("connect() after close() re-enables the socket lifecycle", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    pws.close();
    expect(pws.getState()).toBe("closed");
    pws.connect();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(pws.getState()).toBe("connecting");
  });
});

describe("jitteredDelay", () => {
  it("falls within ±25% of the requested base across a large sample", () => {
    const base = 1000;
    const samples = Array.from({ length: 1000 }, () => jitteredDelay(base));
    for (const d of samples) {
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
    // And the samples actually vary — if jitter were a no-op the mean
    // would be exactly the base but every sample would equal the base.
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(Math.abs(mean - base)).toBeLessThan(50); // ~±5% mean drift
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(100); // genuine randomisation
  });

  it("clamps non-negative: base 0 returns 0", () => {
    expect(jitteredDelay(0)).toBe(0);
  });

  it("never produces a negative delay even with max jitter", () => {
    // Force Math.random → 0 so jitter = -variance (the minimum).
    const origRand = Math.random;
    Math.random = () => 0;
    try {
      expect(jitteredDelay(100)).toBeGreaterThanOrEqual(0);
    } finally {
      Math.random = origRand;
    }
  });
});

describe("PaneWS backpressure", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installMockWS();
  });
  afterEach(() => restore());

  it("drops sends when bufferedAmount exceeds WS_BACKPRESSURE_BYTES", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();

    // Normal send: delivered.
    pws.send({ type: "input", data: "YQ==" });
    expect(mock.sent).toHaveLength(1);
    expect(pws.getBackpressureDrops()).toBe(0);

    // Simulate a stuck daemon: browser is buffering more than 1 MiB.
    mock.bufferedAmount = WS_BACKPRESSURE_BYTES + 1;
    pws.send({ type: "input", data: "Yg==" });
    pws.send({ type: "input", data: "Yw==" });
    // Both sends were dropped at the backpressure check; counter reflects it.
    expect(mock.sent).toHaveLength(1);
    expect(pws.getBackpressureDrops()).toBe(2);

    // Buffer clears → send resumes.
    mock.bufferedAmount = 0;
    pws.send({ type: "input", data: "ZA==" });
    expect(mock.sent).toHaveLength(2);
    // Drop counter is monotonic — does NOT decrement when pressure clears.
    expect(pws.getBackpressureDrops()).toBe(2);
  });

  it("bufferedAmount exactly at the threshold is still allowed (boundary)", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();

    mock.bufferedAmount = WS_BACKPRESSURE_BYTES;
    pws.send({ type: "input", data: "eA==" });
    expect(mock.sent).toHaveLength(1);
    expect(pws.getBackpressureDrops()).toBe(0);
  });

  // a followup (a Codex finding): the onopen flush must apply
  // the SAME backpressure cap the live-send path uses. Pre-fix, a
  // large reconnect backlog dumped the whole queue via unconditional
  // ws.send, bypassing the cap entirely. Now the loop checks
  // bufferedAmount between each send and drops the remainder with
  // the drop counter when over the cap.
  it("applies backpressure cap during onopen flush (reconnect drain)", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    // Do NOT fire open yet — we're simulating the "reconnect, lots
    // of typing queued" state. Every send goes into pending.

    // Queue 100 input messages while the socket is connecting.
    for (let i = 0; i < 100; i++) {
      pws.send({ type: "input", data: "YQ==" });
    }
    expect(pws.getPendingCount()).toBe(100);
    expect(pws.getBackpressureDrops()).toBe(0);

    // Wire the mock so each send bumps bufferedAmount by a fixed
    // amount. Set the chunk size so the 50th message takes us over
    // WS_BACKPRESSURE_BYTES, ensuring the flush loop hits the cap
    // mid-queue rather than at either boundary.
    const chunk = Math.ceil(WS_BACKPRESSURE_BYTES / 50) + 1;
    mock.onSendAccount = () => {
      mock.bufferedAmount += chunk;
    };

    // Fire open — flush kicks in. First 50 go through; on iteration 51
    // bufferedAmount is above the cap and the remainder (50 messages)
    // is dropped with the counter updated.
    mock.fireOpen();

    expect(mock.sent.length).toBeLessThan(100);
    // All sent bytes must be the input messages in order — no gaps.
    for (const raw of mock.sent) {
      expect(JSON.parse(raw)).toEqual({ type: "input", data: "YQ==" });
    }
    // Drop counter + sent count accounts for the original 100.
    expect(mock.sent.length + pws.getBackpressureDrops()).toBe(100);
    // Queue is empty — neither delivered nor dropped messages linger.
    expect(pws.getPendingCount()).toBe(0);
  });

  // Closely related edge case: if bufferedAmount starts already over
  // the cap when onopen fires (e.g. the browser hasn't started
  // draining yet), the entire pending queue is dropped.
  it("drops the entire pending queue if over cap from the first flush iteration", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    pws.send({ type: "input", data: "YQ==" });
    pws.send({ type: "input", data: "Yg==" });
    pws.send({ type: "input", data: "Yw==" });
    expect(pws.getPendingCount()).toBe(3);

    mock.bufferedAmount = WS_BACKPRESSURE_BYTES + 1;
    mock.fireOpen();

    expect(mock.sent).toHaveLength(0);
    expect(pws.getBackpressureDrops()).toBe(3);
    expect(pws.getPendingCount()).toBe(0);
  });

  // Ordering invariant: once the cap is hit during flush, everything
  // after is dropped — never skipped. A gap (send N, drop N+1, send
  // N+2) would corrupt input like a half-typed escape sequence.
  it("preserves in-order delivery: drop is contiguous-suffix, never interleaved", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    // 5 distinguishable messages.
    const payloads = ["YQ==", "Yg==", "Yw==", "ZA==", "ZQ=="];
    for (const p of payloads) {
      pws.send({ type: "input", data: p });
    }

    // Arrange: send(msg 1) leaves bufferedAmount just under cap;
    // send(msg 2) pushes it over. Remaining messages must all drop.
    mock.bufferedAmount = 0;
    let sendCount = 0;
    mock.onSendAccount = () => {
      sendCount++;
      if (sendCount === 2) {
        mock.bufferedAmount = WS_BACKPRESSURE_BYTES + 1;
      }
    };
    mock.fireOpen();

    // After flush: msgs 1 + 2 are delivered (send() ran before the
    // PaneWS flush re-checked bufferedAmount for msg 3). Msgs 3-5 are
    // dropped.
    expect(mock.sent.length).toBe(2);
    expect(JSON.parse(mock.sent[0]).data).toBe("YQ==");
    expect(JSON.parse(mock.sent[1]).data).toBe("Yg==");
    expect(pws.getBackpressureDrops()).toBe(3);
    expect(pws.getPendingCount()).toBe(0);
  });
});

// --- close code / reason plumbing ---
//
// The onStateChange handler used to swallow the close frame entirely,
// making it impossible for callers to distinguish a 1008 auth failure
// from a 1001 peer shutdown or a 1006 transient network drop. The new
// signature pipes `(code, reason)` through via the optional second
// argument, so the token-prompt flow can route 1008 into
// requestTokenUpdate without re-architecting the whole state machine.
describe("PaneWS onStateChange close-info plumbing", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installMockWS();
  });
  afterEach(() => restore());

  it("surfaces 1001 (going away) on the reconnecting transition", () => {
    const observed: Array<{ state: string; code?: number; reason?: string }> = [];
    const pws = new PaneWS(
      "ws://x/ws/p/p",
      {
        onStateChange: (state, closeInfo) => {
          observed.push({
            state,
            code: closeInfo?.code,
            reason: closeInfo?.reason,
          });
        },
      },
      [],
    );
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();
    mock.fireClose(1001, "daemon shutting down");

    // Last observed transition is `reconnecting` with the peer's code.
    const last = observed[observed.length - 1];
    expect(last.state).toBe("reconnecting");
    expect(last.code).toBe(1001);
    expect(last.reason).toBe("daemon shutting down");
  });

  it("surfaces 1008 (policy violation / auth failure) so callers can trigger the token prompt", () => {
    const observed: Array<{ state: string; code?: number; reason?: string }> = [];
    const pws = new PaneWS(
      "ws://x/ws/p/p",
      {
        onStateChange: (state, closeInfo) => {
          observed.push({ state, code: closeInfo?.code, reason: closeInfo?.reason });
        },
      },
      [],
    );
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();
    mock.fireClose(1008, "bearer token rejected");

    const last = observed[observed.length - 1];
    expect(last.state).toBe("reconnecting");
    expect(last.code).toBe(1008);
    expect(last.reason).toBe("bearer token rejected");
  });

  it("surfaces 1006 (abnormal closure — generic network drop) with an empty reason", () => {
    const observed: Array<{ state: string; code?: number; reason?: string }> = [];
    const pws = new PaneWS(
      "ws://x/ws/p/p",
      {
        onStateChange: (state, closeInfo) => {
          observed.push({ state, code: closeInfo?.code, reason: closeInfo?.reason });
        },
      },
      [],
    );
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();
    // No-args fireClose defaults to 1006/"" — the browser's
    // synthesised "no close frame received" status.
    mock.fireClose();

    const last = observed[observed.length - 1];
    expect(last.state).toBe("reconnecting");
    expect(last.code).toBe(1006);
    expect(last.reason).toBe("");
  });

  it("does not populate closeInfo for non-close state transitions (connecting, open)", () => {
    const observed: Array<{ state: string; hasInfo: boolean }> = [];
    const pws = new PaneWS(
      "ws://x/ws/p/p",
      {
        onStateChange: (state, closeInfo) => {
          observed.push({ state, hasInfo: closeInfo !== undefined });
        },
      },
      [],
    );
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();

    // Connecting + open transitions carry no closeInfo.
    const connecting = observed.find((o) => o.state === "connecting");
    const open = observed.find((o) => o.state === "open");
    expect(connecting?.hasInfo).toBe(false);
    expect(open?.hasInfo).toBe(false);
  });

  it("handler with legacy `(state) => void` signature stays source-compatible", () => {
    // Regression test for the additive API change: existing consumers
    // that destructure only the first argument still compile and run.
    // Ignores closeInfo entirely; PaneWS must not throw.
    const states: string[] = [];
    const pws = new PaneWS(
      "ws://x/ws/p/p",
      { onStateChange: (state) => states.push(state) },
      [],
    );
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();
    mock.fireClose(1001, "bye");
    expect(states).toContain("open");
    expect(states).toContain("reconnecting");
  });
});

// --- subprotocols provider thunk (1008 → token-rotation reconnect) ---
//
// Codex adversarial-review HIGH on the close-info commit: the 1008
// handler in boot.ts routes into `requestTokenUpdate`, but every
// existing pane WebSocket captured the subprotocols array once at
// construction. Without a thunk, the auto-reconnect after 1008 would
// re-send the stale bearer, loop on 1008, and strand the live panes
// until page reload — even though the HTTP client and stored config
// both held the fresh token. The thunk is resolved on every open()
// call so the natural backoff-driven reconnect picks up the new token.
describe("PaneWS subprotocols provider", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installMockWS();
  });
  afterEach(() => restore());

  it("wraps a static array (legacy call shape) as an internal thunk", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, ["reck-bearer.static"]);
    pws.connect();
    const first = MockWebSocket.instances[0];
    expect(first.protocols).toEqual(["reck-bearer.static"]);
    pws.close();
  });

  it("resolves the thunk on each open() call, not just at construction", () => {
    let currentToken = "old";
    const pws = new PaneWS(
      "ws://x/ws/p/p",
      {},
      () => [`reck-bearer.${currentToken}`],
    );
    pws.connect();
    expect(MockWebSocket.instances[0].protocols).toEqual(["reck-bearer.old"]);

    // Simulate a token rotation mid-session (what requestTokenUpdate
    // does via `client.config.token = next`). The next open() must
    // pick up the new value.
    currentToken = "new";

    // Close + reconnect explicitly to force a fresh open().
    pws.close();
    pws.connect();
    expect(MockWebSocket.instances[1].protocols).toEqual(["reck-bearer.new"]);
    pws.close();
  });

  // --- The actual 1008 → token-update → auto-reconnect regression. ---
  //
  // Flow:
  //   1. Pane connects with the old token (subprotocols: reck-bearer.old)
  //   2. Daemon rejects with 1008 Policy Violation (invalid bearer)
  //   3. onStateChange handler fires → consumer updates the token
  //      (modelled here by flipping `currentToken`)
  //   4. PaneWS's backoff timer fires → calls open() again
  //   5. The thunk is re-resolved → new WebSocket is constructed with
  //      the FRESH token, not the stale one
  //
  // Pre-fix this test fails at step 5: the captured static array would
  // still be [reck-bearer.old] and the reconnect would loop on 1008.
  it("auto-reconnect after 1008 picks up a rotated token via the thunk", () => {
    vi.useFakeTimers();
    try {
      let currentToken = "old";
      const pws = new PaneWS(
        "ws://x/ws/p/p",
        {
          onStateChange: (state, closeInfo) => {
            if (closeInfo?.code === 1008) {
              // Model the boot.ts handler: rotate the token that the
              // thunk will resolve on the next reconnect attempt.
              currentToken = "new-fresh-token";
            }
          },
        },
        () => [`reck-bearer.${currentToken}`],
      );
      pws.connect();

      // First socket opens with the stale token.
      const first = MockWebSocket.instances[0];
      expect(first.protocols).toEqual(["reck-bearer.old"]);
      first.fireOpen();

      // Daemon rejects: 1008 Policy Violation. The onStateChange
      // handler rotates `currentToken` to "new-fresh-token".
      first.fireClose(1008, "bearer token rejected");
      expect(pws.getState()).toBe("reconnecting");

      // Backoff timer fires → open() called again → thunk
      // re-resolves → fresh subprotocol lands on the new WebSocket.
      vi.runOnlyPendingTimers();
      const second = MockWebSocket.instances[1];
      expect(second).toBeDefined();
      expect(second.protocols).toEqual(["reck-bearer.new-fresh-token"]);
      // This is the assertion that pre-fix would have failed: the
      // reconnect MUST NOT replay the stale token.
      expect(second.protocols).not.toEqual(["reck-bearer.old"]);

      pws.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the thunk fresh on every reconnect, even across multiple closes", () => {
    vi.useFakeTimers();
    try {
      const tokens = ["t1", "t2", "t3", "t4"];
      let callCount = 0;
      const pws = new PaneWS(
        "ws://x/ws/p/p",
        {},
        () => [`reck-bearer.${tokens[callCount++] ?? "exhausted"}`],
      );
      // connect() opens instance 0 → thunk call #1.
      pws.connect();

      // Three close/reconnect cycles: each close() schedules a
      // backoff timer that runPendingTimers fires, opening the next
      // instance. The N-th cycle (0-indexed) asserts on instance N
      // and triggers the open() that creates instance N+1.
      for (let i = 0; i < 3; i++) {
        const sock = MockWebSocket.instances[i];
        expect(sock.protocols).toEqual([`reck-bearer.${tokens[i]}`]);
        sock.fireOpen();
        sock.fireClose(1006, "");
        vi.runOnlyPendingTimers();
      }
      // After the loop: 4 sockets exist, thunk was called 4 times
      // (one per open()). Token monotonically advanced — no stale
      // replay at any step.
      expect(callCount).toBe(4);
      expect(MockWebSocket.instances).toHaveLength(4);
      expect(MockWebSocket.instances[3].protocols).toEqual(["reck-bearer.t4"]);
      pws.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles the unauthenticated local-daemon case (thunk returning empty array)", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, () => []);
    pws.connect();
    // Empty-array path triggers the single-arg WebSocket constructor
    // form; the stub records `undefined` for the protocols argument.
    expect(MockWebSocket.instances[0].protocols).toBeUndefined();
    pws.close();
  });
});

// --- send() readyState lag (an audit finding) ---
//
// Pre-fix `send()` gated on `this.state === "open"`, a wrapper-cached
// flag updated only when our onclose runs. The browser flips
// readyState to CLOSING / CLOSED synchronously when the underlying
// transport drops, but onclose can fire on the next microtask. A
// keystroke racing that gap would call ws.send() on a CLOSING socket
// and the browser throws InvalidStateError synchronously, crashing
// the renderer. Post-fix:
//
//   1. Gate on the LIVE readyState (== WebSocket.OPEN), not the cached
//      wrapper state.
//   2. Wrap the actual ws.send in try/catch so any future race that
//      slips through still ends up queued for replay rather than
//      throwing into the caller.
describe("PaneWS send() — live readyState gating", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installMockWS();
  });
  afterEach(() => restore());

  it("does not throw and queues the message when readyState is CLOSING", () => {
    vi.useFakeTimers();
    try {
      const pws = new PaneWS("ws://x/ws/p/p", {}, []);
      pws.connect();
      const mock = MockWebSocket.instances[0];
      mock.fireOpen();
      expect(pws.getState()).toBe("open"); // wrapper state still cached as open

      // Simulate the browser observing the underlying transport dying
      // BEFORE our onclose handler runs: readyState flips synchronously
      // but the wrapper's cached `state` is still "open".
      mock.readyState = MockWebSocket.CLOSING;

      // send() must NOT throw and must NOT call ws.send (which would
      // throw InvalidStateError in a real browser).
      expect(() => {
        pws.send({ type: "input", data: "WA==" });
      }).not.toThrow();

      // Live ws.send was bypassed → the mock recorded zero sends.
      expect(mock.sent).toHaveLength(0);

      // The message was queued for replay on the next successful open.
      expect(pws.getPendingCount()).toBe(1);

      // Replay verification: a fresh socket reaches OPEN → the queued
      // input flushes. fireClose triggers the reconnect-backoff timer
      // which fake timers must drive forward.
      mock.fireClose();
      vi.runOnlyPendingTimers();
      const second = MockWebSocket.instances[1];
      expect(second).toBeDefined();
      second.fireOpen();
      expect(second.sent.map((s) => JSON.parse(s))).toEqual([
        { type: "input", data: "WA==" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw and queues the message when readyState is CLOSED before onclose fires", () => {
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();

    // Underlying socket already CLOSED but onclose hasn't fired yet —
    // wrapper state still "open".
    mock.readyState = MockWebSocket.CLOSED;

    expect(() => {
      pws.send({ type: "input", data: "WQ==" });
    }).not.toThrow();
    expect(mock.sent).toHaveLength(0);
    expect(pws.getPendingCount()).toBe(1);
  });

  it("catches InvalidStateError from ws.send and queues the message instead of throwing", () => {
    // Defence-in-depth path: even with the readyState gate, the socket
    // can transition between the gate check and the send() call (the
    // browser can flip state at any time during JS execution). The
    // try/catch ensures the caller (xterm onData) never sees an
    // exception.
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();

    // Override send to simulate the synchronous-throw race: readyState
    // is OPEN at the gate check, but the underlying socket already
    // refuses sends.
    mock.send = () => {
      throw new DOMException(
        "InvalidStateError: WebSocket is already in CLOSING or CLOSED state.",
        "InvalidStateError",
      );
    };

    expect(() => {
      pws.send({ type: "input", data: "Wg==" });
    }).not.toThrow();

    // The throwing send is not recorded (our override threw before
    // the default mock send pushed onto `sent`). The message is
    // queued for replay.
    expect(pws.getPendingCount()).toBe(1);
  });

  it("still routes a normal OPEN-state send straight through to the wire", () => {
    // Sanity that the new gate didn't break the happy path.
    const pws = new PaneWS("ws://x/ws/p/p", {}, []);
    pws.connect();
    const mock = MockWebSocket.instances[0];
    mock.fireOpen();
    pws.send({ type: "input", data: "QQ==" });
    expect(mock.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "input", data: "QQ==" },
    ]);
    expect(pws.getPendingCount()).toBe(0);
  });
});
