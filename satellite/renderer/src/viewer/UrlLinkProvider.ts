// Registers an xterm link provider that underlines http/https URLs in
// terminal scrollback and routes ⌘-click to a host-provided handler
// (typically `window.open`, which main's setWindowOpenHandler forwards to
// shell.openExternal → the OS default browser).
//
// This is the URL sibling of PathLinkProvider. It reuses that module's
// wrap-run machinery (collectWrapRun + projectMatchOntoLines) so a URL
// that wraps onto a continuation row still linkifies as one logical link,
// but it is much simpler: there is no filesystem resolve/IPC — every
// syntactic URL is a link. It runs alongside the path provider; xterm
// supports multiple registered providers and a given token is either a
// path or a URL, not both.

import {
  collectWrapRun,
  projectMatchOntoLines,
  type XtermLinkProvider,
  type XtermLinkProviderTerminal,
} from "./PathLinkProvider";
import { detectUrlsInLine } from "./LinkDetector";
import { showLinkTooltip, hideLinkTooltip } from "./linkTooltip";

export interface UrlLinkProviderDeps {
  /**
   * Fires when the user ⌘-clicks an underlined URL. The host typically
   * calls `window.open(url)`, which is intercepted by the main process's
   * setWindowOpenHandler and forwarded to shell.openExternal.
   */
  onActivateUrl(url: string, event: MouseEvent): void;
}

export function installUrlLinkProvider(
  term: XtermLinkProviderTerminal,
  deps: UrlLinkProviderDeps,
): { dispose: () => void } {
  const provider: XtermLinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      // bufferLineNumber is 1-indexed per xterm; collectWrapRun is
      // 0-indexed.
      const hovered0 = bufferLineNumber - 1;
      const wrapRun = collectWrapRun(term, hovered0);
      if (!wrapRun || wrapRun.lines.length === 0) {
        callback(undefined);
        return;
      }
      const candidates = detectUrlsInLine(wrapRun.joinedText);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      const startLine1 = wrapRun.startLine0 + 1;
      const links: Array<{
        text: string;
        range: ReturnType<typeof projectMatchOntoLines>[number];
        activate: (event: MouseEvent, text: string) => void;
        hover: (event: MouseEvent, text: string) => void;
        leave: () => void;
      }> = [];
      for (const cand of candidates) {
        // Project the logical-line match back onto the physical rows it
        // spans; each row gets its own ILink sharing the same text +
        // activate so hover/click treat them as one link.
        const segments = projectMatchOntoLines(cand, wrapRun.lines, startLine1);
        for (const range of segments) {
          links.push({
            text: cand.text,
            range,
            activate(ev, textArg) {
              // ⌘-gated, matching the path linkifier — a plain click
              // must not hijack text selection or normal terminal clicks.
              if (!ev.metaKey) return;
              deps.onActivateUrl(textArg, ev);
            },
            hover(ev) {
              showLinkTooltip("⌘+click to open in browser", ev);
            },
            leave() {
              hideLinkTooltip();
            },
          });
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  };

  const disposable = term.registerLinkProvider(provider);
  return {
    dispose() {
      disposable.dispose();
    },
  };
}
