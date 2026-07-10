// @vitest-environment node
// Tests for the station→local project-list translation (hybrid mode rev 3.1,
// phase 9). These are pure-function checks — the orchestrator that glues
// translation + the per-host ready flag + `apiForHost("local").putProjects(...)`
// lives in `boot.ts`, which is driven from the integration-shaped
// connection-for-host tests.

import { describe, expect, it, vi } from "vitest";
import type { Project, PutProjectsEntry } from "@proto/proto";
import {
  STATION_MANAGED_ROOT,
  buildPutProjectsPayload,
  fingerprintPayload,
  makePushState,
  pushStationProjectsToLocal,
  translateStationCwd,
  type PushState,
  type PutProjectsClient,
} from "./project-push";

function mkProject(id: string, cwd: string): Project {
  return {
    id,
    name: id,
    cwd,
    stoplight: "gray",
    pane_count: 0,
  };
}

const LOCAL_MOUNT = "/Users/alice/reck/projects";

describe("translateStationCwd", () => {
  it("swaps the station managed root for the local mount", () => {
    expect(
      translateStationCwd("/Users/reck-connect/projects/alpha", LOCAL_MOUNT),
    ).toBe("/Users/alice/reck/projects/alpha");
  });

  it("preserves sub-paths below the project id", () => {
    expect(
      translateStationCwd(
        "/Users/reck-connect/projects/alpha/sub/dir",
        LOCAL_MOUNT,
      ),
    ).toBe("/Users/alice/reck/projects/alpha/sub/dir");
  });

  it("returns null for cwds outside the managed root", () => {
    expect(
      translateStationCwd(
        "/Users/reck-connect/claude-code/alpha",
        LOCAL_MOUNT,
      ),
    ).toBeNull();
    expect(translateStationCwd("/tmp/elsewhere", LOCAL_MOUNT)).toBeNull();
  });

  it("rejects prefix matches that don't hit a segment boundary", () => {
    // `/Users/reck-connect/projects-evil/alpha` must NOT translate — the
    // literal prefix match would be a symlink-escape-style trap without
    // the trailing-slash check.
    expect(
      translateStationCwd(
        "/Users/reck-connect/projects-evil/alpha",
        LOCAL_MOUNT,
      ),
    ).toBeNull();
  });

  it("rejects the bare root (no project id)", () => {
    expect(
      translateStationCwd("/Users/reck-connect/projects", LOCAL_MOUNT),
    ).toBeNull();
    expect(
      translateStationCwd("/Users/reck-connect/projects/", LOCAL_MOUNT),
    ).toBeNull();
  });

  it("is trailing-slash-tolerant on the caller-supplied roots", () => {
    expect(
      translateStationCwd(
        "/Users/reck-connect/projects/alpha",
        "/Users/alice/reck/projects/",
        "/Users/reck-connect/projects/",
      ),
    ).toBe("/Users/alice/reck/projects/alpha");
  });

  it("returns null when any required input is empty", () => {
    expect(translateStationCwd("", LOCAL_MOUNT)).toBeNull();
    expect(
      translateStationCwd("/Users/reck-connect/projects/alpha", ""),
    ).toBeNull();
  });

  it("defaults the station root to STATION_MANAGED_ROOT", () => {
    // STATION_MANAGED_ROOT is build-time-injected from VITE_RECK_STATION_ROOT
    // (vitest.setup.ts seeds the historical default). Asserting the env-var
    // wiring rather than the literal so this test still passes when a
    // developer runs vitest with a non-default VITE_RECK_STATION_ROOT.
    expect(STATION_MANAGED_ROOT).toBe(
      (import.meta.env as Record<string, string | undefined>).VITE_RECK_STATION_ROOT,
    );
    expect(
      translateStationCwd(
        `${STATION_MANAGED_ROOT}/alpha`,
        LOCAL_MOUNT,
      ),
    ).toBe("/Users/alice/reck/projects/alpha");
  });
});

describe("buildPutProjectsPayload", () => {
  it("translates every in-root project into an id/cwd entry", () => {
    const projects = [
      mkProject("alpha", "/Users/reck-connect/projects/alpha"),
      mkProject("beta", "/Users/reck-connect/projects/beta"),
    ];
    expect(buildPutProjectsPayload(projects, LOCAL_MOUNT)).toEqual([
      { id: "alpha", cwd: "/Users/alice/reck/projects/alpha" },
      { id: "beta", cwd: "/Users/alice/reck/projects/beta" },
    ]);
  });

  it("silently drops projects whose cwd isn't under the managed root", () => {
    const projects = [
      mkProject("alpha", "/Users/reck-connect/projects/alpha"),
      mkProject("customcwd", "/Users/reck-connect/claude-code/customcwd"),
      mkProject("beta", "/Users/reck-connect/projects/beta"),
    ];
    const payload = buildPutProjectsPayload(projects, LOCAL_MOUNT);
    expect(payload.map((e) => e.id)).toEqual(["alpha", "beta"]);
  });

  it("preserves input order (so fingerprint-after-sort is stable)", () => {
    const projects = [
      mkProject("zeta", "/Users/reck-connect/projects/zeta"),
      mkProject("alpha", "/Users/reck-connect/projects/alpha"),
    ];
    const payload = buildPutProjectsPayload(projects, LOCAL_MOUNT);
    expect(payload.map((e) => e.id)).toEqual(["zeta", "alpha"]);
  });

  it("skips entries without an id", () => {
    const projects = [
      { ...mkProject("", "/Users/reck-connect/projects/empty-id") },
      mkProject("alpha", "/Users/reck-connect/projects/alpha"),
    ];
    expect(buildPutProjectsPayload(projects, LOCAL_MOUNT)).toEqual([
      { id: "alpha", cwd: "/Users/alice/reck/projects/alpha" },
    ]);
  });

  it("returns an empty array when nothing survives translation", () => {
    const projects = [
      mkProject("custom", "/Users/reck-connect/claude-code/custom"),
    ];
    expect(buildPutProjectsPayload(projects, LOCAL_MOUNT)).toEqual([]);
  });
});

describe("fingerprintPayload", () => {
  it("matches for identical content", () => {
    const a = [
      { id: "alpha", cwd: "/mount/alpha" },
      { id: "beta", cwd: "/mount/beta" },
    ];
    const b = [
      { id: "alpha", cwd: "/mount/alpha" },
      { id: "beta", cwd: "/mount/beta" },
    ];
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it("is order-independent (sort by id internally)", () => {
    const a = [
      { id: "alpha", cwd: "/mount/alpha" },
      { id: "beta", cwd: "/mount/beta" },
    ];
    const b = [
      { id: "beta", cwd: "/mount/beta" },
      { id: "alpha", cwd: "/mount/alpha" },
    ];
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it("changes when a cwd changes", () => {
    const a = [{ id: "alpha", cwd: "/mount/alpha" }];
    const b = [{ id: "alpha", cwd: "/mount/alpha-v2" }];
    expect(fingerprintPayload(a)).not.toBe(fingerprintPayload(b));
  });

  it("changes when an id is added or removed", () => {
    const a = [{ id: "alpha", cwd: "/mount/alpha" }];
    const b = [
      { id: "alpha", cwd: "/mount/alpha" },
      { id: "beta", cwd: "/mount/beta" },
    ];
    expect(fingerprintPayload(a)).not.toBe(fingerprintPayload(b));
  });

  it("distinguishes empty from single-entry payloads", () => {
    expect(fingerprintPayload([])).not.toBe(
      fingerprintPayload([{ id: "alpha", cwd: "/mount/alpha" }]),
    );
  });
});

// --- Orchestrator: the Phase 9 plan's test bullets ----------------------
//
// "Mock station event → local PUT happens" — `push()` with a fresh
//   payload triggers the client call and flips ready=true.
// "ready flag false pre-ack → ... true post-ack → ... Local disconnect
//   → false again." — the callback sequence is recorded and asserted.
// "PUT failure → error state in UI." — a rejecting mock client surfaces
//   a describe-push-error message via onStatusChange.
// "Pane-create clicked during push in-flight → waits, doesn't 404." —
//   we drive a concurrent call and assert ready NEVER flips true while
//   the outer PUT is in flight (the gate stays closed).

function mockClient(impl?: PutProjectsClient["putProjects"]): {
  client: PutProjectsClient;
  calls: PutProjectsEntry[][];
} {
  const calls: PutProjectsEntry[][] = [];
  const defaultImpl: PutProjectsClient["putProjects"] = async (entries) => ({
    ok: true,
    count: entries.length,
  });
  return {
    client: {
      putProjects: vi.fn(async (entries) => {
        calls.push(entries);
        return (impl ?? defaultImpl)(entries);
      }),
    },
    calls,
  };
}

function harness(
  projects: readonly Project[],
  clientImpl?: PutProjectsClient["putProjects"],
) {
  const { client, calls } = mockClient(clientImpl);
  const ready: boolean[] = [];
  const status: Array<string | null> = [];
  const state: PushState = makePushState();
  const invoke = (p: readonly Project[] = projects) =>
    pushStationProjectsToLocal(
      {
        state,
        client,
        projects: p,
        localMount: "/Users/alice/reck/projects",
        onReadyChange: (r) => ready.push(r),
        onStatusChange: (s) => status.push(s),
      },
      () => invoke(),
    );
  return { invoke, calls, ready, status, state };
}

describe("pushStationProjectsToLocal", () => {
  const projects: Project[] = [
    {
      id: "alpha",
      name: "Alpha",
      cwd: "/Users/reck-connect/projects/alpha",
      stoplight: "gray",
      pane_count: 0,
    },
  ];

  it("PUTs the translated payload and flips ready=true on ack (station event → local PUT)", async () => {
    const h = harness(projects);
    await h.invoke();
    expect(h.calls).toEqual([
      [{ id: "alpha", cwd: "/Users/alice/reck/projects/alpha" }],
    ]);
    expect(h.ready).toEqual([true]);
    // No error reported on a clean push; onStatusChange only fires
    // when the message actually changes, so zero entries here.
    expect(h.status).toEqual([]);
  });

  it("skips re-push when the payload fingerprint is unchanged", async () => {
    const h = harness(projects);
    await h.invoke();
    await h.invoke();
    await h.invoke();
    expect(h.calls).toHaveLength(1);
    // No duplicate ready=true transitions either — a no-op push doesn't
    // re-fire the callback.
    expect(h.ready).toEqual([true]);
  });

  it("re-pushes when the catalog changes", async () => {
    const h = harness(projects);
    await h.invoke();
    const updated: Project[] = [
      ...projects,
      {
        id: "beta",
        name: "Beta",
        cwd: "/Users/reck-connect/projects/beta",
        stoplight: "gray",
        pane_count: 0,
      },
    ];
    await h.invoke(updated);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].map((e) => e.id)).toEqual(["alpha", "beta"]);
  });

  it("after a simulated disconnect (lastPushedFingerprint cleared), re-pushes even for an unchanged catalog", async () => {
    const h = harness(projects);
    await h.invoke();
    expect(h.calls).toHaveLength(1);
    // Simulate local-disconnect path in boot.ts: clear the fingerprint.
    h.state.lastPushedFingerprint = null;
    await h.invoke();
    expect(h.calls).toHaveLength(2);
    // ready=true fires on each successful ack (transition false→true
    // happens after the caller flipped it false on disconnect; the
    // orchestrator itself always calls onReadyChange(true) on ack).
    expect(h.ready).toEqual([true, true]);
  });

  it("PUT failure surfaces an error message and keeps ready=false", async () => {
    const err = Object.assign(new Error("nope"), { status: 401, body: "" });
    const h = harness(projects, async () => {
      throw err;
    });
    await h.invoke();
    expect(h.calls).toHaveLength(1);
    // ready flipped false (error path); never true.
    expect(h.ready).toEqual([false]);
    // Exactly one status transition: null → typed error string.
    expect(h.status).toHaveLength(1);
    expect(h.status[0]).toContain("auth rejected");
  });

  it("PUT failure in station-mode (409) surfaces the right message", async () => {
    const err = Object.assign(new Error("wrong mode"), { status: 409, body: "" });
    const h = harness(projects, async () => {
      throw err;
    });
    await h.invoke();
    expect(h.status[0]).toContain("station mode");
  });

  it("clears the error message on a subsequent successful push", async () => {
    let calls = 0;
    const impl: PutProjectsClient["putProjects"] = async (entries) => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("boom"), { status: 500, body: "" });
      }
      return { ok: true, count: entries.length };
    };
    const h = harness(projects, impl);
    await h.invoke();
    // Force re-run: fingerprint was cleared on failure, so same
    // projects input triggers another PUT.
    await h.invoke();
    expect(h.calls).toHaveLength(2);
    // Status transitions: null → error → null. First entry is the
    // error message; second is the clear (null).
    expect(h.status).toHaveLength(2);
    expect(h.status[0]).toMatch(/HTTP 500/);
    expect(h.status[1]).toBeNull();
    // Ready transitions: false (error) → true (success).
    expect(h.ready).toEqual([false, true]);
  });

  it("concurrent call during in-flight PUT is coalesced into a single queued retry (ready stays false mid-push)", async () => {
    // Block the first PUT on a promise we control so we can observe
    // the mid-flight state. The second concurrent invoke() must NOT
    // fire a second PUT; it just flips state.queued. After the first
    // resolves, the finally block re-invokes once.
    let releaseFirst!: () => void;
    const firstCompleted = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let callIdx = 0;
    const impl: PutProjectsClient["putProjects"] = async (entries) => {
      callIdx++;
      if (callIdx === 1) {
        await firstCompleted;
      }
      return { ok: true, count: entries.length };
    };
    const h = harness(projects, impl);

    const first = h.invoke();
    // While the first PUT is still in flight, issue a concurrent call.
    // Mid-flight: exactly one PUT should be recorded, and ready should
    // NOT be true yet (the gate stays closed until the ack lands).
    const second = h.invoke();
    expect(h.calls).toHaveLength(1);
    expect(h.ready).toEqual([]);
    expect(h.state.inFlight).toBe(true);
    expect(h.state.queued).toBe(true);

    releaseFirst();
    await first;
    await second;
    // The coalesced retry fires on a microtask after the first ack;
    // since the fingerprint matches the now-acked value the retry
    // becomes a no-op. Total calls stays at 1.
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls).toHaveLength(1);
    expect(h.ready).toEqual([true]);
  });

  it("does nothing when localMount is empty", async () => {
    const { client, calls } = mockClient();
    const ready: boolean[] = [];
    await pushStationProjectsToLocal({
      state: makePushState(),
      client,
      projects,
      localMount: "",
      onReadyChange: (r) => ready.push(r),
      onStatusChange: () => {},
    });
    expect(calls).toEqual([]);
    expect(ready).toEqual([]);
  });

  it("an empty translated payload is still a valid push (wholesale clear semantics)", async () => {
    // Custom-cwd projects that don't translate → empty payload. First
    // push must still run so the local daemon sees "empty list" and
    // drops any stale entries from a previous session.
    const customCwd: Project[] = [
      {
        id: "custom",
        name: "Custom",
        cwd: "/Users/reck-connect/elsewhere/custom",
        stoplight: "gray",
        pane_count: 0,
      },
    ];
    const h = harness(customCwd);
    await h.invoke();
    expect(h.calls).toEqual([[]]);
    expect(h.ready).toEqual([true]);
  });
});
