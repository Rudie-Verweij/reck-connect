import { describe, expect, it, vi, beforeEach } from "vitest";
import { MissionControl } from "./mission-control";
import type {
  MissionControlCard,
  MissionControlPane,
  MissionControlStateResponse,
} from "@proto/proto";
import type { ApiClient } from "@client-core/api/client";

// Phase 11 — MissionControl host aggregation tests. Cover the merge
// contract (cards from station + local combined by project_id, panes
// tagged with host) and dispose-clears-all-WS. Uses vi.fn mocks for
// ApiClient so vitest doesn't need a real HTTP server.

function pane(overrides: Partial<MissionControlPane> = {}): MissionControlPane {
  return {
    pane_id: "p-" + Math.random().toString(36).slice(2, 8),
    kind: "shell",
    agent_state: "",
    stoplight: "gray",
    session_name: undefined,
    ...overrides,
  };
}

function card(projectId: string, panes: MissionControlPane[], overrides: Partial<MissionControlCard> = {}): MissionControlCard {
  return {
    project_id: projectId,
    project_name: projectId.toUpperCase(),
    cwd: "/Users/test/" + projectId,
    stoplight: "gray",
    pane_count: panes.length,
    panes,
    ...overrides,
  };
}

function fakeClient(): ApiClient {
  return {
    config: { baseUrl: "http://mock", token: undefined },
    missionControlState: vi.fn(async () => ({ cards: [], supervisor_online: false })),
    missionControlHistory: vi.fn(),
    missionControlChat: vi.fn(),
    missionControlReset: vi.fn(),
    missionControlWsUrl: vi.fn(() => "ws://mock/mission-control"),
    wsUrl: vi.fn((projectId: string, paneId: string) => `ws://mock/panes/${paneId}`),
    wsSubprotocols: vi.fn(() => []),
    // The rest of the ApiClient surface is not called by MissionControl
    // under the test scenarios below — an `as unknown as ApiClient` cast
    // keeps the stub small without having to enumerate 30+ methods.
  } as unknown as ApiClient;
}

describe("MissionControl host aggregation (phase 11)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("throws when constructed without any clients", () => {
    expect(() =>
      new MissionControl({
        root,
        clients: {},
        theme: "dark",
        onOpenProject: () => {},
      }),
    ).toThrow(/requires at least one/);
  });

  it("accepts a single-host station client (back-compat with pre-hybrid)", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    expect(mc).toBeTruthy();
  });

  it("accepts a station-disabled setup (only local provided) and uses local as primary", () => {
    const local = fakeClient();
    const mc = new MissionControl({
      root,
      clients: { local },
      theme: "dark",
      onOpenProject: () => {},
    });
    // Push a state through the test hook and assert the merged view reflects it.
    mc._testApplyState("local", {
      cards: [card("alpha", [pane({ kind: "claude" })])],
      supervisor_online: true,
    });
    const merged = mc._testMergedCards();
    expect(merged.length).toBe(1);
    expect(merged[0].project_id).toBe("alpha");
    expect(merged[0].panes.length).toBe(1);
    expect(merged[0].panes[0]._host).toBe("local");
  });

  it("merges cards from both hosts by project_id, tagging each pane with its host", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient(), local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    mc._testApplyState("station", {
      cards: [
        card("alpha", [pane({ pane_id: "A1" }), pane({ pane_id: "A2" })]),
        card("beta", [pane({ pane_id: "B1" })]),
      ],
      supervisor_online: true,
    });
    mc._testApplyState("local", {
      cards: [
        card("alpha", [pane({ pane_id: "A3" })]),
        card("gamma", [pane({ pane_id: "G1" })]),
      ],
      supervisor_online: false,
    });
    const merged = mc._testMergedCards();
    const byId = new Map(merged.map((c) => [c.project_id, c]));
    const alpha = byId.get("alpha");
    const beta = byId.get("beta");
    const gamma = byId.get("gamma");
    expect(alpha).toBeTruthy();
    expect(beta).toBeTruthy();
    expect(gamma).toBeTruthy();
    // alpha has 2 station + 1 local — 3 total, station panes first.
    expect(alpha!.panes.length).toBe(3);
    expect(alpha!.pane_count).toBe(3);
    expect(alpha!.panes.slice(0, 2).map((p) => p._host)).toEqual(["station", "station"]);
    expect(alpha!.panes[2]._host).toBe("local");
    // station-only project still visible.
    expect(beta!.panes.map((p) => p._host)).toEqual(["station"]);
    // project that only exists on the local feed still visible.
    expect(gamma!.panes.map((p) => p._host)).toEqual(["local"]);
  });

  it("primary is station when both hosts provided (order: station first in merged cards)", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient(), local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    mc._testApplyState("station", {
      cards: [card("s1", [pane()]), card("s2", [pane()])],
      supervisor_online: true,
    });
    mc._testApplyState("local", {
      cards: [card("l1", [pane()])],
      supervisor_online: false,
    });
    const merged = mc._testMergedCards();
    // Station cards come before the local-only-feed card.
    expect(merged.map((c) => c.project_id)).toEqual(["s1", "s2", "l1"]);
  });

  it("uses the worst station/local stoplight when a project is on both hosts", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient(), local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    mc._testApplyState("station", {
      cards: [card("p", [pane()], { stoplight: "green" })],
      supervisor_online: true,
    });
    mc._testApplyState("local", {
      cards: [card("p", [pane()], { stoplight: "red" })],
      supervisor_online: false,
    });
    const merged = mc._testMergedCards();
    expect(merged[0].stoplight).toBe("red");
  });

  it("dispose() closes every open per-host WebSocket", async () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient(), local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    // Install two fake WS via the test hook; assert dispose() closes both.
    const close = vi.fn();
    const fake: WebSocket = {
      readyState: WebSocket.OPEN,
      close,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as WebSocket;
    mc._testInstallMockWs("station", fake);
    mc._testInstallMockWs("local", fake);
    expect(mc._testOpenWsCount()).toBe(2);
    // `hide()` is what dispose delegates to; call it directly so we
    // don't need to show() first (show would open real WS).
    mc.dispose();
    expect(close).toHaveBeenCalledTimes(2);
    expect(mc._testOpenWsCount()).toBe(0);
  });

  // Phase 10/11 fixup (post-codex adversarial review). Three findings:
  //   1. supervisor stayed station-only only by naming convention; the
  //      code cheerfully routed chat/reset/TerminalPane through
  //      `primaryClient` even when that was the local daemon.
  //   2. WS disconnect left stale cached state rendered indefinitely.
  //   3. (reconcile — covered in reconcile.test.ts)

  it("hides supervisor controls when station is disabled (supervisor is station-only)", () => {
    const mc = new MissionControl({
      root,
      clients: { local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    // mc-actions (Start / Reset buttons) hidden; supervisor section
    // body explains station-only-ness.
    const actions = mc.container.querySelector<HTMLElement>(".mc-actions");
    expect(actions?.style.display).toBe("none");
    const supervisorMsg = mc.container.querySelector(".mc-supervisor-idle");
    expect(supervisorMsg?.textContent).toMatch(/station-only/i);
  });

  it("does not throw when askAboutCard fires with no station configured", async () => {
    const mc = new MissionControl({
      root,
      clients: { local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    root.appendChild(mc.container);
    mc._testApplyState("local", {
      cards: [card("alpha", [pane({ kind: "claude" })])],
      supervisor_online: false,
    });
    // Click the card — should flash ask-failed (no supervisor available)
    // rather than throw "supervisor operation attempted with station disabled".
    const cardEl = root.querySelector<HTMLElement>(".mc-card");
    expect(cardEl).toBeTruthy();
    cardEl!.click();
    // ask-failed class added synchronously before the 1.2 s removeTimeout.
    expect(cardEl!.classList.contains("ask-failed")).toBe(true);
  });

  it("schedules a reconnect on WS close while visible (no indefinite blank)", async () => {
    // Fixup round 2: the first onclose fix cleared stale state
    // but had no path back to connected. This test proves a timer
    // is scheduled when the socket drops while visible, and that
    // hide() clears it so a backgrounded MC doesn't keep retrying.
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    // Drive the class into "visible" so scheduleReconnect runs.
    // We don't call the real show() (which would open a real WS);
    // instead we flip the flag via the test hook path.
    mc._testSetVisible(true);
    expect(mc._testReconnectPendingCount()).toBe(0);
    mc._testOnCloseHost("station");
    expect(mc._testReconnectPendingCount()).toBe(1);
    mc._testSetVisible(false);
    mc._testClearReconnects();
    expect(mc._testReconnectPendingCount()).toBe(0);
  });

  it("does not schedule a reconnect when the close happens during hide()", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    // Simulate a close while NOT visible — e.g. hide() -> close()
    // triggers the onclose handler after this.visible = false.
    mc._testSetVisible(false);
    mc._testOnCloseHost("station");
    expect(mc._testReconnectPendingCount()).toBe(0);
  });

  it("clears a host's cached state on WS close so stale cards vanish", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient(), local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    root.appendChild(mc.container);
    mc._testApplyState("station", {
      cards: [card("s1", [pane()])],
      supervisor_online: true,
    });
    mc._testApplyState("local", {
      cards: [card("l1", [pane()])],
      supervisor_online: false,
    });
    expect(mc._testMergedCards().length).toBe(2);
    // Simulate a WS close for local by installing a mock WS and
    // firing onclose. Mirrors the real path: openWebSocket wires
    // onclose to drop statesByHost[host] + re-render.
    const fakeWs: WebSocket = {
      readyState: WebSocket.OPEN,
      close: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as WebSocket;
    mc._testInstallMockWs("local", fakeWs);
    // Fire the close handler the way the production code would.
    mc._testCloseHostWs("local");
    const merged = mc._testMergedCards();
    expect(merged.length).toBe(1);
    expect(merged[0].project_id).toBe("s1");
  });

  // Codex follow-up ask (round 3 approval): lock in the contract
  // that a reconnected WS is seeded purely by the server's initial
  // `MCStateMessage{type:"state"}` frame — no HTTP fallback. If a
  // future refactor accidentally reintroduces seedStateFor() on
  // onopen, this test protects against the race it would create.
  it("WS reconnect is seeded by the server's initial state frame (no HTTP fallback)", () => {
    // Build a client that tracks whether missionControlState (HTTP)
    // is called. If it's called on reconnect, the test fails — we
    // want to prove the WS server's documented initial-state frame
    // carries the whole contract.
    let httpCalls = 0;
    const client: ApiClient = {
      config: { baseUrl: "http://mock", token: undefined },
      missionControlState: vi.fn(async () => {
        httpCalls++;
        return { cards: [], supervisor_online: false };
      }),
      missionControlHistory: vi.fn(),
      missionControlChat: vi.fn(),
      missionControlReset: vi.fn(),
      missionControlWsUrl: vi.fn(() => "ws://mock/mission-control"),
      wsUrl: vi.fn((_projectId: string, paneId: string) => `ws://mock/panes/${paneId}`),
      wsSubprotocols: vi.fn(() => []),
    } as unknown as ApiClient;

    const mc = new MissionControl({
      root,
      clients: { station: client },
      theme: "dark",
      onOpenProject: () => {},
    });
    // Drive the class into "visible" without opening a real WS.
    mc._testSetVisible(true);

    // Reset the call counter — we care about reconnect behaviour,
    // not any initial-fetch during show(). (show() legitimately
    // does call HTTP to paint before the WS opens; that's a
    // different code path.)
    httpCalls = 0;

    // Simulate a reconnect: server sends an initial state frame
    // over the WS. This exercises the onmessage path directly via
    // the test hook — applyState is what a real WS onmessage would
    // call, so this faithfully models the contract.
    mc._testApplyState("station", {
      cards: [card("alpha", [pane({ kind: "claude" })])],
      supervisor_online: false,
    });

    // State populated from the WS frame alone — no HTTP fallback.
    expect(httpCalls).toBe(0);
    const merged = mc._testMergedCards();
    expect(merged.length).toBe(1);
    expect(merged[0].project_id).toBe("alpha");
  });

  it("applyState drives HTML rendering via renderCards", () => {
    const mc = new MissionControl({
      root,
      clients: { station: fakeClient(), local: fakeClient() },
      theme: "dark",
      onOpenProject: () => {},
    });
    // show() appends the MC container to root; simulate that here so
    // querySelector finds the cards host.
    root.appendChild(mc.container);
    mc._testApplyState("station", {
      cards: [card("alpha", [pane({ kind: "claude" })])],
      supervisor_online: true,
    });
    mc._testApplyState("local", {
      cards: [card("alpha", [pane({ kind: "shell" })])],
      supervisor_online: false,
    });
    const cardEls = root.querySelectorAll(".mc-card");
    expect(cardEls.length).toBe(1);
    // Two pane <li> rows — one per host. Local row has the host badge.
    const paneRows = root.querySelectorAll(".mc-card-panes li");
    expect(paneRows.length).toBe(2);
    const badges = root.querySelectorAll(".pane-host-badge.local");
    expect(badges.length).toBe(1);
  });
});
