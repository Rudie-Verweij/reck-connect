import { describe, it, expect } from "vitest";
import { HttpError } from "@client-core/api/client";
import { decidePollFailureAction } from "./poll-failure-policy";

const http401 = new HttpError(401, "Unauthorized", "");
const http500 = new HttpError(500, "Server Error", "");

describe("decidePollFailureAction", () => {
  it("heals a local 401 even when the station is primary (the greyed-out regression)", () => {
    // The core fix: local's per-spawn bearer rotates on every daemon
    // restart. When the station is primary, the local host is a
    // background connection — the self-heal must still run, or local
    // 401-loops and greys out until the whole app is restarted.
    expect(decidePollFailureAction("local", "station", http401)).toBe(
      "refresh-local-token",
    );
  });

  it("heals a local 401 when local is the primary host too", () => {
    expect(decidePollFailureAction("local", "local", http401)).toBe(
      "refresh-local-token",
    );
  });

  it("prompts for a fresh station token when the station is primary", () => {
    expect(decidePollFailureAction("station", "station", http401)).toBe(
      "prompt-station-token",
    );
  });

  it("ignores a background station 401 (local is primary — no surface to prompt)", () => {
    expect(decidePollFailureAction("station", "local", http401)).toBe("ignore");
  });

  it("ignores non-401 HTTP errors", () => {
    expect(decidePollFailureAction("local", "station", http500)).toBe("ignore");
    expect(decidePollFailureAction("station", "station", http500)).toBe(
      "ignore",
    );
  });

  it("ignores non-HttpError failures (network / timeout / undefined)", () => {
    expect(
      decidePollFailureAction("station", "station", new TypeError("boom")),
    ).toBe("ignore");
    expect(
      decidePollFailureAction(
        "local",
        "station",
        new DOMException("aborted", "AbortError"),
      ),
    ).toBe("ignore");
    expect(decidePollFailureAction("local", "station", undefined)).toBe(
      "ignore",
    );
  });
});
