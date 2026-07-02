// Round 8.6 Phase 3c — SSH `rg --files` worker.
//
// Same contract as the local rg worker, but executes `rg --files` on
// the Pi via `ssh`. Used as the last-resort fallback when the local
// walker / local-rg worker returns 0 matches AND the original click
// came from a station pane — catches files that are on the Pi but
// not yet reflected in the local sshfs mirror.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  createRgSshWorker,
  type SshSpawnFn,
  type SpawnedChild,
} from "./search-worker-rg-ssh";

type FakeChild = SpawnedChild & {
  emitStdout(chunk: string): void;
  emitExit(code: number | null): void;
  kill: ReturnType<typeof vi.fn>;
};

function makeFakeChild(): FakeChild {
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
    emitExit(code: number | null) {
      ev.emit("exit", code, null);
    },
  } as FakeChild;
}

function makeFakeSsh(): {
  spawnFn: SshSpawnFn;
  spawned: Array<{ args: readonly string[]; remoteCmd: string | undefined }>;
  child: () => FakeChild;
} {
  const spawned: Array<{
    args: readonly string[];
    remoteCmd: string | undefined;
  }> = [];
  let lastChild: FakeChild | null = null;
  const spawnFn: SshSpawnFn = (args) => {
    // The remote command is the last arg in the ssh args array.
    spawned.push({ args, remoteCmd: args[args.length - 1] });
    lastChild = makeFakeChild();
    return lastChild;
  };
  return {
    spawnFn,
    spawned,
    child: () => {
      if (!lastChild) throw new Error("ssh spawn not called");
      return lastChild;
    },
  };
}

describe("createRgSshWorker", () => {
  let fake: ReturnType<typeof makeFakeSsh>;
  const sshConfig = {
    sshKey: "/Users/me/.ssh/reck_mount",
    sshHost: "reck-station",
    connectTimeoutSec: 5,
  };

  beforeEach(() => {
    fake = makeFakeSsh();
  });

  it("spawns ssh with BatchMode + ConnectTimeout + rg --files command", () => {
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.postMessage({
      type: "start",
      roots: ["/home/pi/projects/MyProject"],
      suffix: "hyperbolic.py",
    });
    expect(fake.spawned).toHaveLength(1);
    const args = fake.spawned[0].args;
    expect(args).toContain("-i");
    expect(args).toContain(sshConfig.sshKey);
    expect(args).toContain("-o");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=5");
    expect(args).toContain(sshConfig.sshHost);
    // Last arg is the remote shell command — must include rg --files
    // and the root, single-quoted so the remote shell parses it as
    // one argv.
    const remoteCmd = fake.spawned[0].remoteCmd;
    expect(remoteCmd).toContain("rg --files");
    expect(remoteCmd).toContain("'/home/pi/projects/MyProject'");
  });

  it("keeps the fast default remote command for non-dotfile suffixes", () => {
    // Same perf guard as the local worker: hidden/no-ignore listing is
    // pay-per-use, only when the suffix targets a dotfile.
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.postMessage({
      type: "start",
      roots: ["/home/pi/projects/MyProject"],
      suffix: "hyperbolic.py",
    });
    const remoteCmd = fake.spawned[0].remoteCmd ?? "";
    expect(remoteCmd).not.toContain("--hidden");
    expect(remoteCmd).not.toContain("--no-ignore");
    expect(remoteCmd).not.toContain("--glob");
  });

  it("remote command lists hidden + gitignored files with the walker blocklist excluded", () => {
    // Same dotfile story as the local rg worker: without --hidden
    // --no-ignore the station-side rg can never list `.env`-style
    // files, so the SSH fallback silently missed them too.
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.postMessage({
      type: "start",
      roots: ["/home/pi/projects/MyProject"],
      suffix: ".env",
    });
    const remoteCmd = fake.spawned[0].remoteCmd ?? "";
    expect(remoteCmd).toContain("--hidden");
    expect(remoteCmd).toContain("--no-ignore");
    expect(remoteCmd).toContain("--glob '!**/node_modules/**'");
    expect(remoteCmd).toContain("--glob '!**/.git/**'");
  });

  it("filters stdout lines by suffix and emits matches", async () => {
    const messages: unknown[] = [];
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/home/pi/projects/MyProject"],
      suffix: "providers/hyperbolic.py",
    });
    fake.child().emitStdout(
      "/home/pi/projects/MyProject/services/foo/providers/hyperbolic.py\n" +
        "/home/pi/projects/MyProject/services/foo/providers/other.py\n",
    );
    fake.child().emitExit(0);
    await new Promise((r) => setImmediate(r));
    const matches = messages.filter(
      (m): m is { type: "match"; path: string } =>
        typeof m === "object" && (m as { type?: unknown }).type === "match",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe(
      "/home/pi/projects/MyProject/services/foo/providers/hyperbolic.py",
    );
  });

  it("escapes single-quotes in root paths defensively", () => {
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.postMessage({
      type: "start",
      // A pathological root with a single quote — should be escaped
      // so it can't break out of the single-quoted remote command.
      roots: ["/home/pi/projects/odd's name"],
      suffix: "x.py",
    });
    const remoteCmd = fake.spawned[0].remoteCmd ?? "";
    // The single quote inside the path should be escaped via the
    // standard `'\''` sequence (close, escape, reopen).
    expect(remoteCmd).toContain("'\\''");
    expect(remoteCmd).not.toMatch(/^[^']*'[^'\\]*'[^']*$/); // not naively quoted
  });

  it("rejects unsafe root paths (no shell metacharacters allowed)", () => {
    const messages: unknown[] = [];
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      // `;` would let an attacker chain commands if quoting broke.
      roots: ["/safe/root; rm -rf ~"],
      suffix: "x.py",
    });
    // No ssh spawn happened.
    expect(fake.spawned).toHaveLength(0);
    // Finalised with done=0 so the orchestrator moves on.
    const done = messages.find(
      (m): m is { type: "done"; totalFound: number } =>
        typeof m === "object" && (m as { type?: unknown }).type === "done",
    );
    expect(done).toBeDefined();
    expect(done?.totalFound).toBe(0);
  });

  it("emits done on SSH exit non-zero (network failure) with totalFound so far", async () => {
    const messages: unknown[] = [];
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.on("message", (msg) => messages.push(msg));
    worker.postMessage({
      type: "start",
      roots: ["/home/pi/projects/X"],
      suffix: "x.py",
    });
    fake.child().emitStdout("/home/pi/projects/X/x.py\n");
    // ssh exit 255 = SSH connection-error code.
    fake.child().emitExit(255);
    await new Promise((r) => setImmediate(r));
    const done = messages.find(
      (m): m is { type: "done"; totalFound: number } =>
        typeof m === "object" && (m as { type?: unknown }).type === "done",
    );
    expect(done).toBeDefined();
    expect(done?.totalFound).toBe(1);
  });

  it("postMessage stop sends SIGTERM to the ssh child", () => {
    const worker = createRgSshWorker({
      sshSpawnFn: fake.spawnFn,
      sshConfig,
    });
    worker.postMessage({
      type: "start",
      roots: ["/home/pi/projects/X"],
      suffix: "x.py",
    });
    worker.postMessage({ type: "stop" });
    expect(fake.child().kill).toHaveBeenCalledWith("SIGTERM");
  });

  // same pay-per-use second pass as the local rg worker:
  // a 0-match first pass relaunches once with --hidden --no-ignore so
  // gitignored non-dot files on the Pi are still findable.
  describe("zero-match --no-ignore second pass", () => {
    it("re-runs the remote rg with --hidden --no-ignore after a 0-match first pass", () => {
      const messages: unknown[] = [];
      const worker = createRgSshWorker({
        sshSpawnFn: fake.spawnFn,
        sshConfig,
      });
      worker.on("message", (msg) => messages.push(msg));
      worker.postMessage({
        type: "start",
        roots: ["/home/pi/projects/X"],
        suffix: "next-env.d.ts",
      });
      expect(fake.spawned).toHaveLength(1);
      expect(fake.spawned[0].remoteCmd).not.toContain("--no-ignore");
      fake.child().emitExit(0); // pass 1: no output

      expect(fake.spawned).toHaveLength(2);
      const remoteCmd = fake.spawned[1].remoteCmd ?? "";
      expect(remoteCmd).toContain("--hidden");
      expect(remoteCmd).toContain("--no-ignore");
      expect(remoteCmd).toContain("!**/node_modules/**");
      expect(remoteCmd).toContain("'/home/pi/projects/X'");

      fake.child().emitStdout(
        "/home/pi/projects/X/frontend/next-env.d.ts\n",
      );
      fake.child().emitExit(0);
      expect(messages).toContainEqual({
        type: "match",
        path: "/home/pi/projects/X/frontend/next-env.d.ts",
      });
      expect(messages).toContainEqual({ type: "done", totalFound: 1 });
    });

    it("does not run a second pass when the first pass matched", () => {
      const messages: unknown[] = [];
      const worker = createRgSshWorker({
        sshSpawnFn: fake.spawnFn,
        sshConfig,
      });
      worker.on("message", (msg) => messages.push(msg));
      worker.postMessage({
        type: "start",
        roots: ["/home/pi/projects/X"],
        suffix: "x.py",
      });
      fake.child().emitStdout("/home/pi/projects/X/a/x.py\n");
      fake.child().emitExit(0);
      expect(fake.spawned).toHaveLength(1);
      expect(messages).toContainEqual({ type: "done", totalFound: 1 });
    });

    it("does not double-pass for dotfile suffixes (flags already on)", () => {
      const messages: unknown[] = [];
      const worker = createRgSshWorker({
        sshSpawnFn: fake.spawnFn,
        sshConfig,
      });
      worker.on("message", (msg) => messages.push(msg));
      worker.postMessage({
        type: "start",
        roots: ["/home/pi/projects/X"],
        suffix: ".env",
      });
      expect(fake.spawned[0].remoteCmd).toContain("--no-ignore");
      fake.child().emitExit(0);
      expect(fake.spawned).toHaveLength(1);
      expect(messages).toContainEqual({ type: "done", totalFound: 0 });
    });
  });
});
