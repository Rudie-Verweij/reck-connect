// Subset of xterm's IParser surface that installOscFilter needs — lets
// tests inject a minimal mock without pulling the full Terminal class,
// and keeps the filter logic out of terminal-pane.ts (which imports
// @xterm/xterm and can't run in a plain Node/jsdom test env).

export interface OscParserLike {
  registerOscHandler(
    ident: number,
    callback: (data: string) => boolean | Promise<boolean>,
  ): { dispose(): void };
}

/**
 * Blocks known exfil/side-channel OSC sequences at the renderer. A
 * remote daemon (or a compromised agent running inside a pane) can
 * emit these through normal PTY output; we can't trust a sequence
 * just because it arrived on the authenticated WebSocket.
 *
 * Returning `true` from the handler tells xterm the OSC was consumed
 * and its default behaviour (clipboard write, notification) never
 * runs.
 *
 *   OSC 52 — clipboard write. Classic exfil vector: a pane can
 *            smuggle data into the user's clipboard with no visible
 *            indication.
 *   OSC 9  — iTerm2 / ConEmu notification. Minor: lets a pane fire
 *            desktop notifications without the user's consent.
 *
 * Terminal title (OSC 0, 2), hyperlinks (OSC 8), colour-setting
 * codes (10, 11, 12, 104, …) and other benign sequences are
 * deliberately NOT filtered — they're ubiquitous in normal TUI
 * apps and carry no secret material.
 *
 * Returns the list of disposables so tests + callers can verify the
 * handlers were installed and clean up if needed.
 */
export function installOscFilter(parser: OscParserLike): { dispose(): void }[] {
  const blockedCodes = [52, 9];
  return blockedCodes.map((code) => parser.registerOscHandler(code, () => true));
}
