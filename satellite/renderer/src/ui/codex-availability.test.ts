import { describe, it, expect } from "vitest";
import { codexUnavailableMessage } from "./codex-availability";

describe("codexUnavailableMessage", () => {
  it("names the station daemon and the fix when the station lacks codex", () => {
    const msg = codexUnavailableMessage("station");
    expect(msg).toContain("codex"); // names the missing CLI
    expect(msg).toContain("reck-stationd"); // the station daemon to restart
    expect(msg.toLowerCase()).toContain("path"); // why it's missing
    expect(msg.toLowerCase()).toContain("install"); // how to fix
  });

  it("refers to the local daemon when the local host lacks codex", () => {
    const msg = codexUnavailableMessage("local");
    expect(msg.toLowerCase()).toContain("local daemon");
    expect(msg.toLowerCase()).toContain("install");
  });
});
