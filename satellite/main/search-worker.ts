// worker_threads entry for streaming suffix search.
//
// Round 6 Phase CC1. The orchestrator in file-viewer.ts spawns this
// script with `new Worker(__dirname + "/search-worker.js")` after
// tsc emits it to `dist/main/search-worker.js`. Messages flow:
//
//   main → worker:
//     { type: "start", roots: string[], suffix: string,
//       opts: { maxMatches?, maxDepth?, timeoutMs? } }
//     { type: "stop" }    // cooperative cancellation; harsh
//                          // `worker.terminate()` is also OK
//
//   worker → main:
//     { type: "match", path: string }
//     { type: "progress", scannedDirs: number, foundCount: number }
//     { type: "done", totalFound: number }
//     { type: "cancelled", totalFound: number }
//
// The walker has zero Electron / IPC awareness; it just emits
// callbacks against `parentPort.postMessage`.

import { parentPort } from "node:worker_threads";
import { searchTreeBySuffix } from "./search-walk";

if (!parentPort) {
  throw new Error("search-worker must run as a worker_threads child");
}

type StartMessage = {
  type: "start";
  roots: string[];
  suffix: string;
  opts?: {
    maxMatches?: number;
    maxDepth?: number;
    timeoutMs?: number;
  };
};

type StopMessage = { type: "stop" };
type IncomingMessage = StartMessage | StopMessage;

let cancelled = false;

parentPort.on("message", async (msg: IncomingMessage) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "stop") {
    cancelled = true;
    return;
  }
  if (msg.type !== "start") return;
  try {
    const result = await searchTreeBySuffix(msg.roots, msg.suffix, {
      ...msg.opts,
      onMatch: (matchedPath) =>
        parentPort!.postMessage({ type: "match", path: matchedPath }),
      onProgress: (info) =>
        parentPort!.postMessage({
          type: "progress",
          scannedDirs: info.scannedDirs,
          foundCount: info.foundCount,
        }),
      isCancelled: () => cancelled,
    });
    if (cancelled || !result.done) {
      parentPort!.postMessage({
        type: "cancelled",
        totalFound: result.matches.length,
      });
    } else {
      parentPort!.postMessage({
        type: "done",
        totalFound: result.matches.length,
      });
    }
  } catch (err) {
    parentPort!.postMessage({
      type: "done",
      totalFound: 0,
      error: String(err),
    });
  }
});
