// Round 6 Phase CC2 — orchestrator that owns the worker_threads lifecycle
// for the streaming suffix search. The function is tested with a fake
// worker so we don't depend on tsc having emitted dist/main/search-worker.js
// at test time.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSuffixSearchOrchestrator,
  type StreamingWorkerLike,
  type WorkerFactory,
} from "./suffix-search-orchestrator";

interface MessageRecord {
  type: string;
  [k: string]: unknown;
}

function makeFakeWorker(): {
  worker: StreamingWorkerLike;
  send: (msg: MessageRecord) => void;
  /** Emit a bare `exit` event. The real rg workers emit this right
   *  AFTER their `done` message (search-worker-rg-local.ts:89-90), so
   *  worker-faithful scenarios must replay both — the stale-worker
   *  defect was invisible while every fake stopped at `done`. */
  emitExit: (code: number) => void;
  terminate: ReturnType<typeof vi.fn>;
  inbox: MessageRecord[];
} {
  const handlers: Array<(msg: MessageRecord) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];
  const inbox: MessageRecord[] = [];
  const terminate = vi.fn(async () => {
    for (const h of exitHandlers) h(1);
  });
  const worker: StreamingWorkerLike = {
    postMessage(msg: unknown) {
      inbox.push(msg as MessageRecord);
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "message") handlers.push(cb as (msg: MessageRecord) => void);
      if (event === "exit") exitHandlers.push(cb as (code: number) => void);
      if (event === "error") {
        // ignore for tests
      }
    },
    terminate,
  };
  const send = (msg: MessageRecord) => {
    for (const h of handlers) h(msg);
  };
  const emitExit = (code: number) => {
    for (const h of exitHandlers) h(code);
  };
  return { worker, send, emitExit, terminate, inbox };
}

describe("createSuffixSearchOrchestrator", () => {
  it("posts a `start` message to the worker on startSearch", () => {
    const { worker, inbox } = makeFakeWorker();
    const factory: WorkerFactory = () => worker;
    const orch = createSuffixSearchOrchestrator({ workerFactory: factory });
    orch.startSearch({
      roots: ["/tmp/project"],
      suffix: "providers/ovh.py",
      onMatch: vi.fn(),
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onCancelled: vi.fn(),
    });
    expect(inbox.length).toBe(1);
    expect(inbox[0]).toMatchObject({
      type: "start",
      roots: ["/tmp/project"],
      suffix: "providers/ovh.py",
    });
  });

  it("forwards `match` messages from the worker to onMatch", () => {
    const { worker, send } = makeFakeWorker();
    const onMatch = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    orch.startSearch({
      roots: ["/tmp/project"],
      suffix: "x.py",
      onMatch,
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onCancelled: vi.fn(),
    });
    send({ type: "match", path: "/tmp/project/a/x.py" });
    send({ type: "match", path: "/tmp/project/b/x.py" });
    expect(onMatch).toHaveBeenCalledTimes(2);
    expect(onMatch).toHaveBeenNthCalledWith(1, "/tmp/project/a/x.py");
    expect(onMatch).toHaveBeenNthCalledWith(2, "/tmp/project/b/x.py");
  });

  it("forwards `progress` messages to onProgress", () => {
    const { worker, send } = makeFakeWorker();
    const onProgress = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch: vi.fn(),
      onProgress,
      onDone: vi.fn(),
      onCancelled: vi.fn(),
    });
    send({ type: "progress", scannedDirs: 42, foundCount: 1 });
    expect(onProgress).toHaveBeenCalledWith({
      scannedDirs: 42,
      foundCount: 1,
    });
  });

  it("fires onDone with totalFound when worker emits `done`", () => {
    const { worker, send } = makeFakeWorker();
    const onDone = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch: vi.fn(),
      onProgress: vi.fn(),
      onDone,
      onCancelled: vi.fn(),
    });
    send({ type: "done", totalFound: 3 });
    expect(onDone).toHaveBeenCalledWith(3);
  });

  it("fires onCancelled when worker emits `cancelled`", () => {
    const { worker, send } = makeFakeWorker();
    const onCancelled = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch: vi.fn(),
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onCancelled,
    });
    send({ type: "cancelled", totalFound: 2 });
    expect(onCancelled).toHaveBeenCalledWith(2);
  });

  it("cancel() posts a `stop` to the worker AND calls terminate as a fallback", () => {
    const { worker, inbox, terminate } = makeFakeWorker();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    const handle = orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch: vi.fn(),
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onCancelled: vi.fn(),
    });
    handle.cancel();
    expect(inbox.length).toBe(2);
    expect(inbox[1]).toMatchObject({ type: "stop" });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("cancel() fires onCancelled exactly once even if worker also emits cancelled", () => {
    const { worker, send } = makeFakeWorker();
    const onCancelled = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    const handle = orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch: vi.fn(),
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onCancelled,
    });
    handle.cancel();
    // Simulate the worker also posting cancelled (race we want to dedupe).
    send({ type: "cancelled", totalFound: 0 });
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onDone after cancel was called (race protection)", () => {
    const { worker, send } = makeFakeWorker();
    const onDone = vi.fn();
    const onCancelled = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    const handle = orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch: vi.fn(),
      onProgress: vi.fn(),
      onDone,
      onCancelled,
    });
    handle.cancel();
    // Worker hadn't seen the stop yet, sends a stale "done".
    send({ type: "done", totalFound: 0 });
    expect(onDone).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("handles `match` messages while still finishing — onMatch fires through to terminal events", () => {
    const { worker, send } = makeFakeWorker();
    const onMatch = vi.fn();
    const onDone = vi.fn();
    const orch = createSuffixSearchOrchestrator({ workerFactory: () => worker });
    orch.startSearch({
      roots: ["/tmp"],
      suffix: "x.py",
      onMatch,
      onProgress: vi.fn(),
      onDone,
      onCancelled: vi.fn(),
    });
    send({ type: "match", path: "/tmp/a/x.py" });
    send({ type: "match", path: "/tmp/b/x.py" });
    send({ type: "done", totalFound: 2 });
    expect(onMatch).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledWith(2);
  });

  // Round 8.6 Phase 2 — root-anchored stat fast-path.
  //
  // Before spawning the streaming walker, the orchestrator can take an
  // optional `anchoredStat.absolutePath` hint and try a single stat()
  // against it. On hit (file exists), it fires onMatch + onDone
  // synchronously and never spawns the worker. On miss or timeout, it
  // falls through to the normal streaming search. Caller is the IPC
  // handler, which constructs the absolute path from projectCwd + the
  // raw clicked suffix.
  describe("Phase 2 anchoredStat fast-path", () => {
    let tmpDir: string;
    let realFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reck-orch-"));
      realFile = path.join(tmpDir, "exists.py");
      fs.writeFileSync(realFile, "print('hi')\n", "utf8");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("HIT — fires onMatch+onDone, does not spawn the worker", async () => {
      const factory = vi.fn(() => makeFakeWorker().worker);
      const onMatch = vi.fn();
      const onDone = vi.fn();
      const orch = createSuffixSearchOrchestrator({ workerFactory: factory });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "exists.py",
        anchoredStat: { absolutePath: realFile },
        onMatch,
        onProgress: vi.fn(),
        onDone,
        onCancelled: vi.fn(),
      });
      // Stat resolves async — wait one tick.
      await new Promise((r) => setTimeout(r, 30));
      expect(factory).not.toHaveBeenCalled();
      expect(onMatch).toHaveBeenCalledTimes(1);
      expect(onMatch).toHaveBeenCalledWith(realFile);
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledWith(1);
    });

    it("MISS — does not fire synthetic events, spawns the worker normally", async () => {
      const { worker, inbox } = makeFakeWorker();
      const factory = vi.fn(() => worker);
      const onMatch = vi.fn();
      const onDone = vi.fn();
      const orch = createSuffixSearchOrchestrator({ workerFactory: factory });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "missing.py",
        anchoredStat: {
          absolutePath: path.join(tmpDir, "does-not-exist.py"),
        },
        onMatch,
        onProgress: vi.fn(),
        onDone,
        onCancelled: vi.fn(),
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(factory).toHaveBeenCalledTimes(1);
      expect(inbox[0]).toMatchObject({ type: "start" });
      expect(onMatch).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    });

    it("no anchoredStat — spawns the worker immediately (legacy behavior)", () => {
      const { worker, inbox } = makeFakeWorker();
      const factory = vi.fn(() => worker);
      const orch = createSuffixSearchOrchestrator({ workerFactory: factory });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled: vi.fn(),
      });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(inbox[0]).toMatchObject({ type: "start" });
    });

    it("cancel() during pending stat — no worker spawn, onCancelled fires once", async () => {
      const factory = vi.fn(() => makeFakeWorker().worker);
      const onCancelled = vi.fn();
      const orch = createSuffixSearchOrchestrator({ workerFactory: factory });
      const handle = orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        anchoredStat: {
          absolutePath: path.join(tmpDir, "does-not-exist.py"),
          timeoutMs: 100,
        },
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled,
      });
      // Cancel before stat resolves.
      handle.cancel();
      await new Promise((r) => setTimeout(r, 50));
      expect(factory).not.toHaveBeenCalled();
      expect(onCancelled).toHaveBeenCalledTimes(1);
    });

    it("stat timeout — falls through to walker, no double-fire", async () => {
      const { worker, inbox } = makeFakeWorker();
      const factory = vi.fn(() => worker);
      const onMatch = vi.fn();
      const onDone = vi.fn();
      const orch = createSuffixSearchOrchestrator({ workerFactory: factory });
      // Use a /dev path that should not exist; with a 1ms timeout the
      // race timer wins regardless of stat behavior.
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        anchoredStat: {
          absolutePath: "/nonexistent/very/deep/x.py",
          timeoutMs: 1,
        },
        onMatch,
        onProgress: vi.fn(),
        onDone,
        onCancelled: vi.fn(),
      });
      await new Promise((r) => setTimeout(r, 30));
      // On miss OR timeout, the worker spawns.
      expect(factory).toHaveBeenCalledTimes(1);
      expect(inbox[0]).toMatchObject({ type: "start" });
    });
  });

  // Round 8.6 Phase 3d — primary + fallback chain.
  //
  // When the primary worker finishes with 0 matches AND the fallback's
  // `when()` predicate returns true, the orchestrator transparently
  // spawns a fallback worker as a second wave. The caller's onMatch /
  // onDone receive the fallback's events; an optional onFallbackStart
  // callback fires once between waves so the renderer can show a
  // "checking station…" interstitial.
  describe("Phase 3d primary + fallback chain", () => {
    it("per-call workerFactory override beats the orchestrator default", () => {
      const defaultFactory = vi.fn(() => makeFakeWorker().worker);
      const overrideFactory = vi.fn(() => makeFakeWorker().worker);
      const orch = createSuffixSearchOrchestrator({
        workerFactory: defaultFactory,
      });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: overrideFactory,
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled: vi.fn(),
      });
      expect(defaultFactory).not.toHaveBeenCalled();
      expect(overrideFactory).toHaveBeenCalledTimes(1);
    });

    it("primary done with 0 matches + when()=true → fallback spawns", () => {
      const primary = makeFakeWorker();
      const fallback = makeFakeWorker();
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      const onFallbackStart = vi.fn();
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: () => fallback.worker,
          when: () => true,
          onStart: onFallbackStart,
        },
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled: vi.fn(),
      });
      primary.send({ type: "done", totalFound: 0 });
      expect(onFallbackStart).toHaveBeenCalledTimes(1);
      expect(fallback.inbox[0]).toMatchObject({ type: "start" });
    });

    it("primary done with N>0 matches → fallback NOT spawned", () => {
      const primary = makeFakeWorker();
      const fallbackFactory = vi.fn(() => makeFakeWorker().worker);
      const onFallbackStart = vi.fn();
      const onDone = vi.fn();
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: fallbackFactory,
          when: () => true,
          onStart: onFallbackStart,
        },
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone,
        onCancelled: vi.fn(),
      });
      primary.send({ type: "match", path: "/tmp/x.py" });
      primary.send({ type: "done", totalFound: 1 });
      expect(fallbackFactory).not.toHaveBeenCalled();
      expect(onFallbackStart).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledWith(1);
    });

    it("primary done with 0 + when()=false → fallback NOT spawned", () => {
      const primary = makeFakeWorker();
      const fallbackFactory = vi.fn(() => makeFakeWorker().worker);
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: fallbackFactory,
          when: () => false, // e.g. sourceHost !== "station"
        },
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled: vi.fn(),
      });
      primary.send({ type: "done", totalFound: 0 });
      expect(fallbackFactory).not.toHaveBeenCalled();
    });

    it("fallback matches reach onMatch + onDone", () => {
      const primary = makeFakeWorker();
      const fallback = makeFakeWorker();
      const onMatch = vi.fn();
      const onDone = vi.fn();
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: () => fallback.worker,
          when: () => true,
        },
        onMatch,
        onProgress: vi.fn(),
        onDone,
        onCancelled: vi.fn(),
      });
      primary.send({ type: "done", totalFound: 0 });
      fallback.send({ type: "match", path: "/station/a/x.py" });
      fallback.send({ type: "match", path: "/station/b/x.py" });
      fallback.send({ type: "done", totalFound: 2 });
      expect(onMatch).toHaveBeenCalledTimes(2);
      expect(onDone).toHaveBeenCalledWith(2);
    });

    it("cancel() during fallback kills the fallback worker", () => {
      const primary = makeFakeWorker();
      const fallback = makeFakeWorker();
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      const handle = orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: () => fallback.worker,
          when: () => true,
        },
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled: vi.fn(),
      });
      primary.send({ type: "done", totalFound: 0 });
      handle.cancel();
      expect(
        fallback.inbox.some((m) => m.type === "stop"),
      ).toBe(true);
      expect(fallback.terminate).toHaveBeenCalled();
    });
  });

  // defects found by the openInViewer pipeline harness.
  describe(" fallback-chain fixes", () => {
    // D6 — both real rg workers emit `exit` immediately after `done`.
    // The primary's trailing exit used to land while done===false
    // (the done-handler returned early after arming the fallback),
    // finalize "cancelled", and terminate the just-spawned fallback.
    it("D6: primary done(0)+exit (real worker contract) does not cancel the fallback wave", () => {
      const primary = makeFakeWorker();
      const fallback = makeFakeWorker();
      const onMatch = vi.fn();
      const onDone = vi.fn();
      const onCancelled = vi.fn();
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      orch.startSearch({
        roots: ["/tmp"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: () => fallback.worker,
          when: () => true,
        },
        onMatch,
        onProgress: vi.fn(),
        onDone,
        onCancelled,
      });
      primary.send({ type: "done", totalFound: 0 });
      primary.emitExit(0); // ← the line every earlier test omitted
      expect(fallback.terminate).not.toHaveBeenCalled();
      expect(onCancelled).not.toHaveBeenCalled();

      fallback.send({ type: "match", path: "/station/a/x.py" });
      fallback.send({ type: "done", totalFound: 1 });
      fallback.emitExit(0);
      expect(onMatch).toHaveBeenCalledWith("/station/a/x.py");
      expect(onDone).toHaveBeenCalledWith(1);
      expect(onCancelled).not.toHaveBeenCalled();
    });

    // D3 (orchestrator half) — the ssh fallback walks the Pi, so it
    // needs Pi-side roots; the primary's Mac mirror roots don't exist
    // there. Callers pass the translated set via fallback.roots.
    it("D3: fallback.roots override is posted to the fallback worker", () => {
      const primary = makeFakeWorker();
      const fallback = makeFakeWorker();
      const orch = createSuffixSearchOrchestrator({
        workerFactory: () => makeFakeWorker().worker,
      });
      orch.startSearch({
        roots: ["/Users/me/reck/projects/Foo"],
        suffix: "x.py",
        workerFactory: () => primary.worker,
        fallback: {
          factory: () => fallback.worker,
          when: () => true,
          roots: ["/home/pi/projects/Foo"],
        },
        onMatch: vi.fn(),
        onProgress: vi.fn(),
        onDone: vi.fn(),
        onCancelled: vi.fn(),
      });
      primary.send({ type: "done", totalFound: 0 });
      primary.emitExit(0);
      const start = fallback.inbox.find((m) => m.type === "start");
      expect(start).toBeDefined();
      expect(start).toMatchObject({
        type: "start",
        roots: ["/home/pi/projects/Foo"],
        suffix: "x.py",
      });
    });
  });
});
