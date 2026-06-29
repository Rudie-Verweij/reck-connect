// Non-modal banner shown when the file changed on disk while the
// viewer had unsaved edits. Three actions in v1:
//   - Force mine: overwrite disk with the viewer's content (one-shot
//     baseline-skipping save).
//   - Force theirs: discard the viewer's edits, load the disk version.
//   - Manual merge: open a side-by-side diff/merge surface so the user
//     can manually reconcile.
//
// The banner pins below the header (above the body content) and stays
// interactive — the editor underneath remains usable so the user can
// keep typing if they wish before resolving.

export interface ConflictBannerOptions {
  parent: HTMLElement;
  /** Stable message describing the conflict; rendered as-is. */
  message?: string;
  onForceMine: () => void;
  onForceTheirs: () => void;
  onOpenManualMerge: () => void;
  onDismiss?: () => void;
}

export interface ConflictBannerHandle {
  dispose(): void;
  /** True while the banner is mounted. */
  isMounted(): boolean;
}

export function mountConflictBanner(
  opts: ConflictBannerOptions,
): ConflictBannerHandle {
  const banner = document.createElement("div");
  banner.className = "file-viewer-conflict-banner";
  banner.setAttribute("role", "alert");

  const message = document.createElement("div");
  message.className = "file-viewer-conflict-message";
  message.textContent =
    opts.message ??
    "This file was changed on disk after you started editing. Choose how to resolve.";
  banner.appendChild(message);

  const actions = document.createElement("div");
  actions.className = "file-viewer-conflict-actions";

  const mkBtn = (label: string, kind: string, handler: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = `file-viewer-conflict-action file-viewer-conflict-${kind}`;
    b.addEventListener("click", handler);
    actions.appendChild(b);
    return b;
  };

  mkBtn("Force mine", "force-mine", opts.onForceMine);
  mkBtn("Force theirs", "force-theirs", opts.onForceTheirs);
  mkBtn("Open diff", "manual-merge", opts.onOpenManualMerge);
  if (opts.onDismiss) {
    mkBtn("Dismiss", "dismiss", opts.onDismiss);
  }

  banner.appendChild(actions);
  // Pin at the top of the parent so the body content remains visible
  // below.
  if (opts.parent.firstChild) {
    opts.parent.insertBefore(banner, opts.parent.firstChild);
  } else {
    opts.parent.appendChild(banner);
  }

  let mounted = true;
  return {
    dispose() {
      if (!mounted) return;
      mounted = false;
      banner.remove();
    },
    isMounted: () => mounted,
  };
}
