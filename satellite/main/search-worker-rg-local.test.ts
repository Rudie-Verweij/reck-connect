// Round 8.6 Phase 3b — local `rg --files` worker.
//
// Implements the StreamingWorkerLike contract by wrapping a single
// `rg --files <root> [<root>...]` child process. Streams stdout line
// by line and filters paths whose tail matches the suffix using the
// same `endsWith` rule as the readdir walker (no partial-basename
// matches; `foo.py` does not match `super_foo.py`).
//
// Spawn is injected so tests don't fork real subprocesses.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  createRgLocalWorker,
  type SpawnFn,
  type SpawnedChild,
} from "./search-worker-rg-local";

type FakeChild = SpawnedChild & {
  /** Push a stdout chunk; trailing newlines are honored. */
  emitStdout(chunk: string): void;
  /** Push a stderr chunk. */
  emitStderr(chunk: string): void;
  /** Resolve the exit event with the given code/signal. */
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Trigger an error event. */
  emitError(err: Error): void;
  kill: ReturnType<typeof vi.fn>;
};

function makeFakeChild(): FakeChild {
  // Use plain EventEmitters for stdout/stderr so the test controls
  // exactly when 'data' fires — no Readable buffer-flushing async.
  const stdout = new EventEmitter() as EventEmitter & NodeJS.ReadableStream;
  const stderr = new EventEmitter() as EventEmitter & NodeJS.ReadableStream;
  const ev = new EventEmitter();
  const kill = vi.fn(() => true);
  return {
    stdout,
    stderr,
    kill,
    on(event: string, cb: (...args: unknown[]) => void) {
      ev.on(event, cb);
      return this;
    },
    emitStdout(chunk: string) {
      stdout.emit("data", Buffer.from(chunk, "utf8"));
    },
    emitStderr(chunk: string) {
      stderr.emit("data", Buffer.from(chunk, "utf8"));
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
      ev.emit("exit", code, signal);
    },
    emitError(err: Error) {
      ev.emit("error", err);
    },
  } as FakeChild;
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
}

function makeFakeSpawn(): {
  spawnFn: SpawnFn;
  spawned: SpawnRecord[];
  child: () => FakeChild;
} {
  const spawned: SpawnRecord[] = [];
  let lastChild: FakeChild | null = null;
  const spawnFn: SpawnFn = (command, args) => {
    spawned.push({ command, args });
    lastChild = makeFakeChild();
    return lastChild;
  };
  return {
    spawnFn,
    spawned,
    child: () => {
      if (!lastChild) throw new Error("spawn not called");
      return lastChild;
    },
  };
}

describe("createRgLocalWorker", () => {
  let fake: ReturnType<typeof makeFakeSpawn>;

  beforeEach(() => {
    fake = makeFakeSpawn();
  });

  it("spawns `rg --files <root>` on start message", () => {
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.postMessage({
      type: "start",
      roots: ["/Users/me/reck/projects/MyProject"],
      suffix: "hyperbolic.py",
    });
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0].command).toBe("rg");
    expect(fake.spawned[0].args).toContain("--files");
    expect(fake.spawned[0].args).toContain(
      "/Users/me/reck/projects/MyProject",
    );
  });

  it("keeps the fast default args for non-dotfile suffixes (no --hidden/--no-ignore)", () => {
    // Perf regression guard: unconditional --no-ignore made rg list
    // every previously-gitignored tree (release/, venvs, …) — ages on
    // the sshfs mount. Mirror the walker exactly (search-walk.ts:183-188):
    // the expensive listing only happens when the clicked path actually
    // targets a dotfile.
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "providers/hyperbolic.py",
    });
    const args = fake.spawned[0].args;
    expect(args).not.toContain("--hidden");
    expect(args).not.toContain("--no-ignore");
    expect(args).not.toContain("--glob");
    expect(args[0]).toBe("--files");
    expect(args[args.length - 1]).toBe("/r");
  });

  it("a dotfile inside a subdir suffix (frontend/.env.local) also enables hidden listing", () => {
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "frontend/.env.local",
    });
    const args = fake.spawned[0].args;
    expect(args).toContain("--hidden");
    expect(args).toContain("--no-ignore");
  });

  it("lists hidden + gitignored files, with the walker blocklist excluded", () => {
    // `rg --files` skips dotfiles AND .gitignored files by default —
    // and `.env`/`frontend/.env.local` is both, so the suffix-search
    // could never find them. The walker (search-walk.ts) has its own
    // dotfile affordance and a static dir blocklist; the rg args must
    // mirror that: --hidden --no-ignore plus one --glob exclusion per
    // SUFFIX_SEARCH_BLOCKLIST entry.
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: ".env",
    });
    const args = fake.spawned[0].args;
    expect(args).toContain("--hidden");
    expect(args).toContain("--no-ignore");
    expect(args).toContain("--glob");
    expect(args).toContain("!**/node_modules/**");
    expect(args).toContain("!**/.git/**");
    // Roots stay last so rg parses every flag.
    expect(args[args.length - 1]).toBe("/r");
  });

  it("emits one match per stdout line whose path ends with the suffix", async () => {
    const messages: unknown[] = [];
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "providers/hyperbolic.py",
    });
    fake.child().emitStdout(
      "/r/services/foo/providers/hyperbolic.py\n" +
        "/r/services/bar/something_else.py\n" +
        "/r/services/baz/providers/hyperbolic.py\n",
    );
    fake.child().emitExit(0);
    // Allow stream events to flush.
    await new Promise((r) => setImmediate(r));
    const matches = messages.filter(
      (m): m is { type: "match"; path: string } =>
        typeof m === "object" && (m as { type?: unknown }).type === "match",
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.path)).toEqual([
      "/r/services/foo/providers/hyperbolic.py",
      "/r/services/baz/providers/hyperbolic.py",
    ]);
  });

  it("does NOT match partial basenames (super_foo.py != foo.py)", async () => {
    const messages: unknown[] = [];
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "foo.py",
    });
    fake.child().emitStdout(
      "/r/a/foo.py\n" +
        "/r/a/super_foo.py\n" +
        "/r/b/foo.py\n",
    );
    fake.child().emitExit(0);
    await new Promise((r) => setImmediate(r));
    const matches = messages.filter(
      (m): m is { type: "match"; path: string } =>
        typeof m === "object" && (m as { type?: unknown }).type === "match",
    );
    expect(matches.map((m) => m.path)).toEqual([
      "/r/a/foo.py",
      "/r/b/foo.py",
    ]);
  });

  it("handles stdout chunks that split lines across reads", async () => {
    const messages: unknown[] = [];
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "x.py",
    });
    fake.child().emitStdout("/r/a/x");
    fake.child().emitStdout(".py\n/r/b/y");
    fake.child().emitStdout(".py\n/r/c/x.py\n");
    fake.child().emitExit(0);
    await new Promise((r) => setImmediate(r));
    const matches = messages.filter(
      (m): m is { type: "match"; path: string } =>
        typeof m === "object" && (m as { type?: unknown }).type === "match",
    );
    expect(matches.map((m) => m.path)).toEqual([
      "/r/a/x.py",
      "/r/c/x.py",
    ]);
  });

  it("emits a `done` message with totalFound on exit code 0", async () => {
    const messages: unknown[] = [];
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "x.py",
    });
    fake.child().emitStdout("/r/a/x.py\n/r/b/x.py\n");
    fake.child().emitExit(0);
    await new Promise((r) => setImmediate(r));
    const done = messages.find(
      (m): m is { type: "done"; totalFound: number } =>
        typeof m === "object" && (m as { type?: unknown }).type === "done",
    );
    expect(done).toBeDefined();
    expect(done?.totalFound).toBe(2);
  });

  it("emits a `done` even on non-zero exit code (degrades gracefully)", async () => {
    const messages: unknown[] = [];
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "x.py",
    });
    // rg exits with code 1 when no files matched (its own filter,
    // not ours). We don't use rg's filter, but be defensive anyway.
    fake.child().emitStdout("/r/a/x.py\n");
    fake.child().emitExit(1);
    await new Promise((r) => setImmediate(r));
    const done = messages.find(
      (m): m is { type: "done"; totalFound: number } =>
        typeof m === "object" && (m as { type?: unknown }).type === "done",
    );
    expect(done).toBeDefined();
    expect(done?.totalFound).toBe(1);
  });

  it("postMessage stop sends SIGTERM to the child", () => {
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.postMessage({ type: "start", roots: ["/r"], suffix: "x.py" });
    worker.postMessage({ type: "stop" });
    expect(fake.child().kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("terminate() sends SIGKILL to the child and emits exit", async () => {
    const exitFn = vi.fn();
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("exit", exitFn);
    worker.postMessage({ type: "start", roots: ["/r"], suffix: "x.py" });
    worker.terminate();
    expect(fake.child().kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("respects maxMatches and emits done early", async () => {
    const messages: unknown[] = [];
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/r"],
      suffix: "x.py",
      opts: { maxMatches: 2 },
    });
    fake.child().emitStdout(
      "/r/a/x.py\n/r/b/x.py\n/r/c/x.py\n/r/d/x.py\n",
    );
    fake.child().emitExit(0);
    await new Promise((r) => setImmediate(r));
    const matches = messages.filter(
      (m): m is { type: "match"; path: string } =>
        typeof m === "object" && (m as { type?: unknown }).type === "match",
    );
    expect(matches).toHaveLength(2);
    // Worker should also have killed the child once cap was reached.
    expect(fake.child().kill).toHaveBeenCalled();
  });

  it("forwards stderr chunks to a single console.error (debugging)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
    worker.postMessage({ type: "start", roots: ["/r"], suffix: "x.py" });
    fake.child().emitStderr("rg: /r/no-such-root: No such file\n");
    fake.child().emitExit(2);
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // gitignored non-dot files (next-env.d.ts in the field
  // failure) are invisible to the fast pass. On a 0-match exit the
  // worker relaunches ONCE with --hidden --no-ignore + the blocklist
  // globs; matches stream from the second pass. Pay-per-use: a hit in
  // pass 1 never pays for pass 2.
  describe("zero-match --no-ignore second pass", () => {
    it("relaunches with --hidden --no-ignore + blocklist globs after a 0-match first pass", () => {
      const messages: unknown[] = [];
      const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
      worker.on("message", (msg) => messages.push(msg));
      worker.postMessage({
        type: "start",
        roots: ["/r"],
        suffix: "next-env.d.ts",
      });
      expect(fake.spawned).toHaveLength(1);
      fake.child().emitExit(0); // pass 1: nothing on stdout

      expect(fake.spawned).toHaveLength(2);
      const secondArgs = fake.spawned[1].args;
      expect(secondArgs).toContain("--hidden");
      expect(secondArgs).toContain("--no-ignore");
      expect(secondArgs).toContain("!**/node_modules/**");
      expect(secondArgs[secondArgs.length - 1]).toBe("/r");

      fake.child().emitStdout("/r/frontend/next-env.d.ts\n");
      fake.child().emitExit(0);
      expect(messages).toContainEqual({
        type: "match",
        path: "/r/frontend/next-env.d.ts",
      });
      expect(messages).toContainEqual({ type: "done", totalFound: 1 });
    });

    it("does not run a second pass when the first pass matched", () => {
      const messages: unknown[] = [];
      const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
      worker.on("message", (msg) => messages.push(msg));
      worker.postMessage({ type: "start", roots: ["/r"], suffix: "x.py" });
      fake.child().emitStdout("/r/a/x.py\n");
      fake.child().emitExit(0);
      expect(fake.spawned).toHaveLength(1);
      expect(messages).toContainEqual({ type: "done", totalFound: 1 });
    });

    it("does not double-pass for dotfile suffixes (flags already on)", () => {
      const messages: unknown[] = [];
      const worker = createRgLocalWorker({ spawnFn: fake.spawnFn });
      worker.on("message", (msg) => messages.push(msg));
      worker.postMessage({ type: "start", roots: ["/r"], suffix: ".env" });
      expect(fake.spawned[0].args).toContain("--no-ignore");
      fake.child().emitExit(0);
      expect(fake.spawned).toHaveLength(1);
      expect(messages).toContainEqual({ type: "done", totalFound: 0 });
    });
  });
});
