import type { HostRef } from "../host";

/**
 * User-facing guidance shown (as an `info` toast) when someone picks Codex
 * on a host whose daemon reported no `codex` binary (`/health`
 * `codex_available === false`). We keep the Codex button visible — hiding
 * it silently leaves the user with no idea the feature exists or why it's
 * inert — and explain, on click, exactly what's missing and how to fix it,
 * per host. Deliberately does not name a specific install command/package
 * (the codex CLI's distribution isn't asserted here); "put `codex` on the
 * daemon's PATH" is the honest, actionable instruction.
 */
export function codexUnavailableMessage(host: HostRef): string {
  const daemon =
    host === "station"
      ? "the station daemon (reck-stationd)"
      : "the local daemon";
  return (
    `Codex isn't available here — the \`codex\` CLI wasn't found on PATH ` +
    `when ${daemon} started. Install \`codex\` so it's on that daemon's ` +
    `PATH, then restart ${daemon} and reopen New Pane.`
  );
}
