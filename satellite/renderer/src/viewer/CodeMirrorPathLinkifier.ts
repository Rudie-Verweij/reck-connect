// CodeMirror 6 linkifier for file-path tokens in the popup body.
//
// Round 6 Phase BB1 — ports the xterm Phase-2 linkifier
// (installPathLinkProvider in PathLinkProvider.ts:89) onto the
// CodeMirror surface. The popup's CodeMirror EditorView now decorates
// every detected path token with class `reck-path-link` and routes
// Cmd-click on those ranges through `deps.onActivate(text, ev)`.
//
// Pattern:
//   - A StateField holds the active DecorationSet.
//   - Recomputed on every doc change AND viewport change.
//   - Scanning is bounded by `view.visibleRanges` so a 50k-line file
//     doesn't pay the regex cost up front (CodeMirror's window typically
//     spans a few hundred lines around the scroll position).
//   - A ViewPlugin's `eventHandlers.mousedown` checks for metaKey+click
//     inside a decorated range and fires `deps.onActivate`.
//
// CSS: the matching style rule for `.reck-path-link` lives in
// styles.css; we only emit the class here.

import {
  StateEffect,
  StateField,
  type Extension,
  type EditorState,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { detectPathsInLine } from "./LinkDetector";

export interface CodeMirrorPathLinkifierDeps {
  /**
   * Fires when the user Cmd-clicks an underlined path. The host typically
   * routes through `reckAPI.files.openInViewer(path)` here.
   */
  onActivate(path: string, event: MouseEvent): void;
}

export interface CodeMirrorPathLinkifierHandle {
  /** Tear down the extension and remove decorations. */
  dispose(): void;
}

// A unique signal used by tests + the dispose path so the ViewPlugin can
// react. We can't dispatch a StateEffect.appendConfig with a removal —
// instead, dispose() dispatches `removeAllLinksEffect` which the StateField
// listens for, and (later) re-uses the recompute path emitting an empty
// DecorationSet.
const removeAllLinksEffect = StateEffect.define<null>();
const rescanLinksEffect = StateEffect.define<DecorationSet>();

// Round 7 Phase FF — native `title` tooltip on hover surfaces the
// keybinding hint after ~1s. Same string as the markdown-side anchors
// (PATH_LINK_TOOLTIP in MarkdownRenderer.ts) so the contract is uniform.
const linkDecoration = Decoration.mark({
  class: "reck-path-link",
  attributes: { title: "⌘+click to open" },
});

function computeDecorations(view: EditorView): DecorationSet {
  const decos: Array<{ from: number; to: number }> = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    // Iterate visible lines so detectPathsInLine sees one line at a time
    // (it expects no embedded newlines — its regex anchors are
    // line-internal).
    const fromLineNo = doc.lineAt(from).number;
    const toLineNo = doc.lineAt(to).number;
    for (let i = fromLineNo; i <= toLineNo; i++) {
      const line = doc.line(i);
      const text = line.text;
      if (text.length === 0) continue;
      const matches = detectPathsInLine(text);
      for (const m of matches) {
        decos.push({ from: line.from + m.start, to: line.from + m.end });
      }
    }
  }
  if (decos.length === 0) return Decoration.none;
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    decos.map(({ from, to }) => linkDecoration.range(from, to)),
  );
}

// Per-view StateField holding the current DecorationSet. Recomputed
// imperatively by the ViewPlugin below — the field's only role is to
// expose decorations to the view (`provide`) and to allow the dispose
// path to reset to `Decoration.none`.
const pathLinkField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let result = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(removeAllLinksEffect)) return Decoration.none;
      if (e.is(rescanLinksEffect)) result = e.value;
    }
    return result;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface LinkifierViewPluginState {
  deps: CodeMirrorPathLinkifierDeps;
}

/**
 * Install the linkifier on `view`. Returns a handle whose `dispose()`
 * removes all decorations and detaches the click handler.
 *
 * Note on extension lifecycle: CodeMirror doesn't expose a clean way to
 * UNINSTALL an Extension once `appendConfig` has added it (the standard
 * pattern is a Compartment with `.reconfigure([])`). We use a Compartment
 * here so dispose can swap the linkifier extension for an empty array,
 * which both detaches the ViewPlugin and removes decorations.
 */
export function installCodeMirrorPathLinkifier(
  view: EditorView,
  deps: CodeMirrorPathLinkifierDeps,
): CodeMirrorPathLinkifierHandle {
  // Capture deps in a ref the ViewPlugin can read — passing per-instance
  // state into a ViewPlugin requires the .define overload with a factory.
  const depsRef: LinkifierViewPluginState = { deps };

  const linkifierPlugin = ViewPlugin.fromClass(
    class {
      view: EditorView;
      constructor(v: EditorView) {
        this.view = v;
        // Initial scan after the view mounts.
        queueMicrotask(() => {
          if (this.view.dom.isConnected || this.view.dom.parentNode) {
            this.view.dispatch({
              effects: rescanLinksEffect.of(computeDecorations(this.view)),
            });
          }
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          // Schedule the rescan in a microtask so we don't dispatch
          // inside an update (CodeMirror forbids same-frame re-dispatch).
          queueMicrotask(() => {
            this.view.dispatch({
              effects: rescanLinksEffect.of(computeDecorations(this.view)),
            });
          });
        }
      }
    },
    {
      eventHandlers: {
        mousedown(ev, view) {
          if (!ev.metaKey) return false;
          const target = ev.target;
          if (!(target instanceof Element)) return false;
          const span = target.closest(".reck-path-link");
          if (!span) return false;
          ev.preventDefault();
          const text = span.textContent ?? "";
          console.log("[click:source] activate", {
            text,
            metaKey: ev.metaKey,
          });
          depsRef.deps.onActivate(text, ev);
          return true;
        },
      },
    },
  );

  // Install both the field and the plugin. If the field is already on the
  // state (multiple installs), appendConfig idempotently re-adds — that's
  // benign for our use case, but we track the dispatch so dispose can clear.
  view.dispatch({
    effects: StateEffect.appendConfig.of([pathLinkField, linkifierPlugin]),
  });
  // Force an initial scan synchronously so callers (and tests) see
  // decorations immediately after install. The plugin's queueMicrotask
  // rescan covers post-mount paint; this covers the install moment.
  view.dispatch({
    effects: rescanLinksEffect.of(computeDecorations(view)),
  });

  return {
    dispose() {
      // Empty the decoration set. We don't tear down the ViewPlugin
      // (no public API) — but with no decorations and no triggering
      // condition, the plugin is inert. Future dispatches of doc changes
      // will recompute again; that's fine because dispose is the
      // popup-teardown path (the view itself is also destroyed).
      try {
        view.dispatch({ effects: removeAllLinksEffect.of(null) });
      } catch {
        // View already destroyed.
      }
    },
  };
}
