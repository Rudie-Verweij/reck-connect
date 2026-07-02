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

export interface OscFilterOptions {
  /**
   * Performs the clipboard write for an allowed OSC 52 write. Injectable so
   * tests can assert without a real clipboard; defaults to the renderer's
   * `navigator.clipboard.writeText`. Never awaited — OSC handling is sync.
   */
  writeClipboard?: (text: string) => void;
  /**
   * Maximum base64 payload length accepted for an OSC 52 write. Writes
   * larger than this are dropped to bound abuse by a noisy/hostile pane.
   */
  maxClipboardBytes?: number;
}

const DEFAULT_MAX_CLIPBOARD_BYTES = 100_000;

function defaultWriteClipboard(text: string): void {
  // OSC 52 handling runs in the renderer, where `navigator.clipboard` is
  // available (Electron grants clipboard-write without a prompt). Guard
  // with `typeof` so the module is import-safe in plain Node/jsdom envs.
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  try {
    void navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable / denied — drop silently */
  }
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Filters OSC sequences a pane emits through normal PTY output. A remote
 * daemon (or a compromised agent inside a pane) can emit these, so we
 * can't trust a sequence just because it arrived on the authenticated
 * WebSocket.
 *
 * Returning `true` from a handler tells xterm the OSC was consumed, so
 * xterm's own default (if any) never runs.
 *
 *   OSC 9  — iTerm2 / ConEmu desktop notification. Blocked: a pane
 *            shouldn't fire notifications without the user's consent.
 *   OSC 52 — clipboard access. WRITE is allowed (copy-on-select, e.g.
 *            Claude Code) and performed explicitly here — xterm.js has no
 *            native OSC 52 clipboard handler. READ queries (`Pd === "?"`)
 *            stay blocked: a read response would have the terminal send
 *            the user's clipboard contents back to the pane, an
 *            exfiltration channel. Writes are size-capped.
 *
 * Terminal title (OSC 0, 2), hyperlinks (OSC 8), colour-setting codes
 * (10, 11, 12, 104, …) and other benign sequences are deliberately NOT
 * filtered — they're ubiquitous in normal TUI apps and carry no secret
 * material.
 *
 * Returns the list of disposables so callers/tests can verify the
 * handlers were installed and clean up.
 */
export function installOscFilter(
  parser: OscParserLike,
  opts: OscFilterOptions = {},
): { dispose(): void }[] {
  const writeClipboard = opts.writeClipboard ?? defaultWriteClipboard;
  const maxBytes = opts.maxClipboardBytes ?? DEFAULT_MAX_CLIPBOARD_BYTES;

  const disposables: { dispose(): void }[] = [];

  // OSC 9 — notifications: always block.
  disposables.push(parser.registerOscHandler(9, () => true));

  // OSC 52 — clipboard: allow write, block read. `data` is "Pc;Pd"; the
  // clipboard selection Pc never contains ';' and the base64 payload Pd
  // never does either, so the last ';'-segment is Pd regardless of how
  // many selection chars or empty leading fields precede it.
  disposables.push(
    parser.registerOscHandler(52, (data) => {
      const parts = data.split(";");
      const pd = parts[parts.length - 1] ?? "";
      if (pd === "?") return true; // read query → block (no clipboard exfil)
      if (pd.length > maxBytes) return true; // oversized write → block
      try {
        writeClipboard(decodeBase64Utf8(pd));
      } catch {
        /* malformed base64 — ignore, never throw out of xterm's parser */
      }
      return true; // consumed (the write is handled here)
    }),
  );

  return disposables;
}
