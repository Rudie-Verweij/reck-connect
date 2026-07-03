// Pure classifier for the file viewer's render mode. Centralises the
// path-type predicates and the (path, persisted-mode) -> ViewerMode
// decision that renderForPath and renderStationRemote both need, so the
// decision lives in exactly one place.

export type PersistedRenderMode = "rendered" | "source";

/** The concrete surface a viewer should mount for a file. */
export type ViewerMode = "markdown-rendered" | "source";

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

/** True for file types that offer a rendered view (and thus a
 *  rendered/source toggle). Extended in Phase A to include HTML. */
export function isRenderablePath(p: string): boolean {
  return isMarkdownPath(p);
}

/**
 * Decide the render mode. `persisted` is the per-path user preference
 * (`fileViewerModePerPath`); `undefined` means "no saved choice", which
 * defaults renderable files to their rendered view.
 */
export function pickViewerMode(
  path: string,
  persisted: PersistedRenderMode | undefined,
): ViewerMode {
  if (isMarkdownPath(path) && persisted !== "source") {
    return "markdown-rendered";
  }
  return "source";
}
