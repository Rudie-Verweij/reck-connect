// Top-level boot logic for a file-viewer popup.
//
// Reads the `?path=` query param, asks main to read the file, picks a
// viewer (markdown vs. plain), mounts it inside the popup body. P1 ships
// the markdown + plain-text viewers and the chrome scaffolding (header
// with a top-right spinner slot, body container). Code viewer (CodeMirror)
// arrives in P3; editing + conflict UI arrives in P4.

import { createMarkdownRenderer } from "./MarkdownRenderer";
import { mountCodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { installCodeMirrorPathLinkifier } from "./CodeMirrorPathLinkifier";
import {
  setExtensionlessAllowlist,
  SEEDED_EXTENSIONLESS_FILENAMES,
} from "./LinkDetector";
import { loadLinkifierAllowlist } from "../config";
import { initTts, type TtsHandle } from "../tts/initTts";
import { MarkdownSurfaceAdapter } from "../tts/MarkdownSurfaceAdapter";
import { CodeMirrorSurfaceAdapter } from "../tts/CodeMirrorSurfaceAdapter";
import type { SpeakSurfaceAdapter } from "../tts/SpeakSurfaceAdapter";
import { mountSpinner, type SpinnerHandle } from "./Spinner";
import { showToast } from "./Toast";
import { createAutoSave, type AutoSaveHandle } from "./AutoSave";
import { mountConflictBanner, type ConflictBannerHandle } from "./ConflictBanner";
import {
  openInViewerWithToast,
  type ClickContext,
} from "./click-log";

interface FileBaseline {
  mtimeMs: number;
  sha256: string;
  size: number;
}

/**
 * Round 4 Phase S — session-level write adapter so the same conflict-
 * banner code path can write either through `files.write` (local) or
 * `files.writeStation` (SSH-backed station file). Shape mirrors the
 * preload return types; both backends use the same FileBaseline.
 */
type SessionWriteResult =
  | { ok: true; baseline: FileBaseline }
  | {
      ok: false;
      code: string;
      error: string;
      currentBaseline?: FileBaseline;
      currentContent?: string;
    };
type SessionWriteFn = (req: {
  path: string;
  content: string;
  baseline: FileBaseline;
  force?: boolean;
}) => Promise<SessionWriteResult>;

interface ActiveSession {
  resolvedPath: string;
  baseline: FileBaseline;
  spinner: SpinnerHandle;
  autoSave: AutoSaveHandle | null;
  editor: CodeEditorHandle | null;
  conflict: ConflictBannerHandle | null;
  unsubscribeWatch: (() => void) | null;
  /** Adapter that knows which IPC to call for this session's host. */
  write: SessionWriteFn;
  /** True when the session is backed by SSH (writeStation). No watcher,
   *  no live external-change detection — concurrent remote edits only
   *  surface on the next save attempt. */
  isStationRemote: boolean;
}

// Per-host session state. The root element is keyed so re-renders
// (auto-reload, create-flow re-mount) can tear down the previous
// session before installing a new one.
const sessions = new WeakMap<HTMLElement, ActiveSession>();

function disposeSession(root: HTMLElement): void {
  const s = sessions.get(root);
  if (!s) return;
  s.autoSave?.dispose();
  s.conflict?.dispose();
  s.editor?.dispose();
  s.unsubscribeWatch?.();
  // Spinner element is inside the shell; rebuilding the shell drops it.
  sessions.delete(root);
}

export interface MountFileViewerOptions {
  root: HTMLElement;
  params: URLSearchParams;
}

interface ViewerShell {
  header: HTMLElement;
  spinnerSlot: HTMLElement;
  titleEl: HTMLElement;
  body: HTMLElement;
  /** Phase 7 of linkifier-followups: per-markdown-file toggle slot.
   *  Only the markdown branch wires a button into this slot; code
   *  files leave it empty (and `display: none` via CSS). */
  modeToggleSlot: HTMLElement;
}

/**
 * Build the popup chrome inside `root`. Returns references to the header,
 * the reserved top-right slot for the loading spinner (P4 fills it in),
 * the title element, and the body container into which the viewer will
 * render. Layout is partitioned so the spinner (top-right of header) and
 * the Speak control bar (bottom-right of body, added in P3) cannot collide.
 */
function buildShell(root: HTMLElement): ViewerShell {
  root.innerHTML = "";
  root.classList.add("file-viewer-root");

  const header = document.createElement("div");
  header.className = "file-viewer-header";

  const titleEl = document.createElement("div");
  titleEl.className = "file-viewer-title";
  header.appendChild(titleEl);

  // Phase 7 of linkifier-followups — per-markdown-file mode toggle.
  // Lives left of the spinner slot so the spinner stays in the corner.
  // Only the markdown render branch populates this; code files leave it
  // empty so the header layout doesn't reserve unused width.
  const modeToggleSlot = document.createElement("div");
  modeToggleSlot.className = "file-viewer-mode-toggle-slot";
  header.appendChild(modeToggleSlot);

  // Reserved slot — 24x24 px in CSS so the layout doesn't reflow when the
  // spinner appears. P4 mounts the actual spinner here.
  const spinnerSlot = document.createElement("div");
  spinnerSlot.className = "file-viewer-spinner-slot";
  spinnerSlot.setAttribute("aria-hidden", "true");
  header.appendChild(spinnerSlot);

  const body = document.createElement("div");
  body.className = "file-viewer-body";

  root.appendChild(header);
  root.appendChild(body);

  return { header, spinnerSlot, titleEl, body, modeToggleSlot };
}

function renderErrorInto(target: HTMLElement, message: string): void {
  target.innerHTML = "";
  const err = document.createElement("div");
  err.className = "file-viewer-error";
  err.textContent = message;
  target.appendChild(err);
}

interface CreateBannerOptions {
  body: HTMLElement;
  filePath: string;
  /** Round 6 Phase DD1 — when provided, displayed in the banner text
   *  instead of `filePath`. Used to show the Pi-side path for station
   *  mount-mirror files; the underlying onCreate still works on the
   *  real filePath. */
  displayPath?: string;
  onCreate: () => Promise<void> | void;
}

/**
 * Render the "this file doesn't exist yet" banner with a Create button.
 * Used when `files.read` returns `not-found` — the user opened a path
 * referenced in a TODO/plan that hasn't been written yet.
 */
function renderCreateBanner(opts: CreateBannerOptions): void {
  opts.body.innerHTML = "";
  const banner = document.createElement("div");
  banner.className = "file-viewer-create-banner";

  const msg = document.createElement("div");
  msg.className = "file-viewer-create-message";
  msg.textContent = `This file doesn't exist yet: ${opts.displayPath ?? opts.filePath}`;
  banner.appendChild(msg);

  const actions = document.createElement("div");
  actions.className = "file-viewer-create-actions";

  const create = document.createElement("button");
  create.className = "file-viewer-create-action";
  create.textContent = "Create empty file";
  create.addEventListener("click", () => {
    void opts.onCreate();
  });
  actions.appendChild(create);

  banner.appendChild(actions);
  opts.body.appendChild(banner);
}

function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

/**
 * Round 5 Phase V — banner shown above the editor when the file is
 * read-only on disk (POSIX W_OK fails). Combined with mounting
 * CodeMirror in `readOnly: true`, the user gets a clear signal that
 * edits won't take and there's no editing affordance to misuse.
 */
function mountReadOnlyBanner(parent: HTMLElement): void {
  const banner = document.createElement("div");
  banner.className = "file-viewer-readonly-banner";
  banner.textContent =
    "⚠ Read-only on disk (no write permission). Edit elsewhere with elevated permissions.";
  parent.appendChild(banner);
}

interface RenderOptions {
  /**
   * Round 5 Phase W — when true, the source-mode CodeMirror mounts
   * UNLOCKED (lock banner shows green "Editing enabled"). Used by
   * the markdown mode toggle: clicking "Edit source" is an explicit
   * "I want to edit" gesture, so jumping into source mode and then
   * making the user click the lock pill a second time is just
   * friction. Defaults to undefined → locked (the safer default).
   */
  initialUnlocked?: boolean;
  /**
   * Round 6 Phase DD1 — when the resolved file path is a Mac mount-
   * mirror of a Pi file, the create banner should display the Pi path
   * (the user is mentally on the station). The underlying create still
   * uses the Mac path via sshfs.
   */
  displayPath?: string;
  /**
   * Round 8 Phase MM — the active project's cwd at the time of the
   * original click. Forwarded by every cascaded `openInViewer` call
   * inside this popup so main's multi-root suffix search stays
   * anchored to the originating project.
   */
  projectCwd?: string;
}

interface LockBannerOptions {
  parent: HTMLElement;
  initialLocked: boolean;
  onToggle: (locked: boolean) => void;
}

interface LockBannerHandle {
  setLocked(locked: boolean): void;
  dispose(): void;
}

/**
 * Round 5 Phase W — full-width lock banner (Variation D). Sits at the
 * top of the editor body. Orange "🔒 Editing locked" when locked,
 * green "✓ Editing enabled" when unlocked. Clicking the right-aligned
 * Unlock/Lock button flips state and calls `onToggle(newLocked)` so
 * the host can dispatch `editor.setReadOnly(...)`.
 */
function mountLockBanner(opts: LockBannerOptions): LockBannerHandle {
  const banner = document.createElement("div");
  banner.className = "file-viewer-lock-banner";

  const label = document.createElement("span");
  label.className = "file-viewer-lock-banner-label";

  const button = document.createElement("button");
  button.className = "file-viewer-lock-banner-button";
  button.type = "button";

  let locked = opts.initialLocked;
  const refresh = (): void => {
    banner.setAttribute("data-locked", String(locked));
    label.textContent = locked
      ? "🔒 Editing locked — click to enable"
      : "✓ Editing enabled — autosave on";
    button.textContent = locked ? "Unlock" : "Lock";
  };
  refresh();

  button.addEventListener("click", () => {
    locked = !locked;
    refresh();
    opts.onToggle(locked);
  });

  banner.appendChild(label);
  banner.appendChild(button);
  opts.parent.appendChild(banner);

  return {
    setLocked: (l) => {
      locked = l;
      refresh();
    },
    dispose: () => banner.remove(),
  };
}

// Phase 7 of linkifier-followups: per-file markdown view/edit mode,
// persisted under config key `fileViewerModePerPath` as a
// Record<resolvedPath, "rendered" | "source">. Missing entry → defaults
// to "rendered" (preserves the pre-P7 UX).
type MarkdownMode = "rendered" | "source";

async function readMarkdownMode(resolvedPath: string): Promise<MarkdownMode> {
  try {
    const raw = (await window.reckAPI.config.get("fileViewerModePerPath")) as
      | Record<string, MarkdownMode>
      | undefined
      | null;
    const v = raw && typeof raw === "object" ? raw[resolvedPath] : undefined;
    return v === "source" ? "source" : "rendered";
  } catch {
    return "rendered";
  }
}

async function writeMarkdownMode(
  resolvedPath: string,
  mode: MarkdownMode,
): Promise<void> {
  try {
    const raw = (await window.reckAPI.config.get("fileViewerModePerPath")) as
      | Record<string, MarkdownMode>
      | undefined
      | null;
    const next: Record<string, MarkdownMode> = {
      ...(raw && typeof raw === "object" ? raw : {}),
      [resolvedPath]: mode,
    };
    await window.reckAPI.config.set("fileViewerModePerPath", next);
  } catch {
    // Persisting mode is best-effort; failing to save just means the
    // file opens in the default ("rendered") mode next time.
  }
}

function mountModeToggle(
  slot: HTMLElement,
  current: MarkdownMode,
  onToggle: () => void,
): void {
  slot.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "file-viewer-mode-toggle";
  // Round 3 Issue C — `data-mode` lets the CSS treat the "Edit source"
  // state as a prominent call-to-action (accent background, bolder
  // text) while leaving "View rendered" as a quieter back-toggle.
  // The user reported the original button was not discoverable; the
  // shape stays the same to keep the click target stable.
  btn.setAttribute("data-mode", current);
  btn.textContent = current === "rendered" ? "Edit source" : "View rendered";
  btn.title =
    current === "rendered"
      ? "Switch to markdown source view"
      : "Switch to rendered markdown view";
  btn.addEventListener("click", onToggle);
  slot.appendChild(btn);
}

// The `window.reckAPI` global is declared in `../config.ts`; this file
// reuses it (including the `files` namespace and `paths.resolveAgainst`
// surface added there for the file-viewer feature).

export async function mountFileViewer(
  opts: MountFileViewerOptions,
): Promise<void> {
  // Round 8 Phase LL/PP — hydrate the in-popup linkifier allowlist
  // from the persisted config. Each popup is a separate renderer
  // process, so the main-window Preferences save doesn't propagate
  // live; instead we re-read on every popup mount. Fall back to the
  // seeded defaults if nothing is persisted yet (covers the rare
  // race where the popup opens before main has written the seed).
  try {
    const persisted = await loadLinkifierAllowlist();
    setExtensionlessAllowlist(
      persisted !== null && persisted.length > 0
        ? persisted
        : SEEDED_EXTENSIONLESS_FILENAMES,
    );
  } catch {
    // If config IPC fails for any reason, keep the module-level
    // default that LinkDetector's top-level binding already set.
  }

  const path = opts.params.get("path");
  if (!path) {
    renderErrorInto(opts.root, "Missing required ?path= query parameter.");
    return;
  }

  const shell = buildShell(opts.root);
  shell.titleEl.textContent = basenameOf(path);
  // the static <title> in file-viewer.html overwrites the
  // per-file BrowserWindow title on load (Electron's page-title-updated
  // default), so every popup read "Reck — File Viewer" in Mission
  // Control / zoom-out hover. Basename only — full paths are
  // unreadable at that size, and multiple popups must be tellable
  // apart at a glance.
  document.title = `Reck — File [${basenameOf(path)}]`;

  // Round 6 Phase CC — streaming suffix-search picker. When main
  // opens the popup with a search in flight, the URL carries
  // `suffixSearchPending=1`, `searchId`, and `suffix`. We mount a
  // spinner + counter + live list + Stop button, subscribe to the
  // streaming events, and on `done` either swap to the create banner
  // (0 matches) or freeze the list as a picker (>=1).
  // Round 8 Phase MM — the active project's cwd at click time, threaded
  // through `?projectCwd=` so cascaded clicks from this popup can pass
  // the same value back to main. Available throughout this function.
  const projectCwdParam = opts.params.get("projectCwd") ?? undefined;
  // Round 8 follow-up — when set, the picker displays each Mac-mount
  // matched path as its Pi-side form so station-context clicks read
  // in the user's mental conventions.
  const displayMountRoot = opts.params.get("displayMountRoot") ?? undefined;
  const displayStationRoot =
    opts.params.get("displayStationRoot") ?? undefined;
  const displayTranslation =
    displayMountRoot && displayStationRoot
      ? { mountRoot: displayMountRoot, stationRoot: displayStationRoot }
      : undefined;

  const suffixSearchPending = opts.params.get("suffixSearchPending") === "1";
  if (suffixSearchPending) {
    const searchId = opts.params.get("searchId") ?? "";
    const suffix = opts.params.get("suffix") ?? path;
    // backend progress capability, set by main from the
    // chosen search backend. Absent on URLs from older mains: treated
    // as "unknown" (legacy stall-banner behaviour preserved).
    const progressRaw = opts.params.get("searchProgressCapable");
    const searchProgressCapable =
      progressRaw === null ? undefined : progressRaw === "1";
    renderSuffixStreamingPicker({
      body: shell.body,
      titleEl: shell.titleEl,
      searchId,
      suffix,
      originalPath: path,
      projectCwd: projectCwdParam,
      displayTranslation,
      searchProgressCapable,
    });
    return;
  }

  // Round 5 Phase U — multi-match picker. When the suffix-fallback in
  // main found multiple candidates for the originally-clicked path,
  // they arrive as a JSON array in the `candidates` query param. Show
  // a picker instead of attempting to read the click target.
  const candidatesRaw = opts.params.get("candidates");
  if (candidatesRaw) {
    try {
      const candidates = JSON.parse(candidatesRaw) as unknown;
      if (Array.isArray(candidates) && candidates.every((c) => typeof c === "string")) {
        renderSuffixPicker({
          body: shell.body,
          suffix: path,
          candidates: candidates as string[],
          onPick: (picked) => {
            // Re-enter the viewer at the picked candidate. The new
            // popup will be a fresh load with `?path=<picked>`.
            void window.reckAPI.files.openInViewer(picked, {
              projectCwd: projectCwdParam,
            });
            // Close THIS popup — the registry now owns the new one.
            window.close();
          },
        });
        return;
      }
    } catch (e) {
      console.warn("[file-viewer] failed to parse candidates", e);
    }
  }

  // Phase 8 of linkifier-followups: when the popup is opened for a
  // station file outside the sshfs mount, the URL carries
  // `host=station-remote`. The render path here uses SSH-backed reads
  // and forces read-only mode (writes deferred).
  const host = opts.params.get("host");
  // Round 6 Phase DD1 — display-only path override carried by the URL
  // for station mount-mirror create banners.
  const displayPathParam = opts.params.get("displayPath") ?? undefined;
  if (host === "station-remote") {
    await renderStationRemote(opts.root, shell, path, {
      projectCwd: projectCwdParam,
    });
    return;
  }
  await renderForPath(opts.root, shell, path, {
    displayPath: displayPathParam,
    projectCwd: projectCwdParam,
  });
}

interface SuffixPickerOptions {
  body: HTMLElement;
  suffix: string;
  candidates: string[];
  onPick(picked: string): void;
}

/**
 * Round 5 Phase U — picker UI for ambiguous suffix matches. Mirrors
 * the `renderCreateBanner` structure: a title row + list of buttons,
 * one per candidate path, plus a Cancel button.
 */
function renderSuffixPicker(opts: SuffixPickerOptions): void {
  opts.body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "file-viewer-suffix-picker";

  const heading = document.createElement("div");
  heading.className = "file-viewer-suffix-picker-heading";
  heading.textContent = `Multiple matches for "${opts.suffix}"`;
  wrap.appendChild(heading);

  const sub = document.createElement("div");
  sub.className = "file-viewer-suffix-picker-sub";
  sub.textContent = "Pick which file to open:";
  wrap.appendChild(sub);

  const list = document.createElement("div");
  list.className = "file-viewer-suffix-picker-list";
  // Sort by path length so the shortest (most likely "root-ish") shows first.
  const sorted = [...opts.candidates].sort((a, b) => a.length - b.length);
  for (const candidate of sorted) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-viewer-suffix-picker-item";
    btn.textContent = candidate;
    btn.addEventListener("click", () => opts.onPick(candidate));
    list.appendChild(btn);
  }
  wrap.appendChild(list);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "file-viewer-suffix-picker-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => window.close());
  wrap.appendChild(cancel);

  opts.body.appendChild(wrap);
}

interface SuffixStreamingPickerOptions {
  body: HTMLElement;
  titleEl: HTMLElement;
  searchId: string;
  suffix: string;
  /** The originally-clicked path (with prepended project root) so the
   *  0-matches branch can swap to the create banner for that target. */
  originalPath: string;
  /** Round 8 Phase MM — active project's cwd, forwarded on every
   *  cascaded openInViewer click out of this picker. */
  projectCwd?: string;
  /** Round 8 follow-up — Mac-mount → Pi-side translation applied to
   *  each matched path for display ONLY. Click handler still uses
   *  the Mac path (main reads via the sshfs mount). */
  displayTranslation?: { mountRoot: string; stationRoot: string };
  /** whether the search backend emits per-readdir
   *  progress. The rg backends don't, so `scannedDirs` stays 0 for
   *  the whole search and MUST NOT be read as "couldn't read any
   *  root" at done-time. `undefined` = unknown (URL from an older
   *  main): keep the legacy stall-banner behaviour. */
  searchProgressCapable?: boolean;
}

/**
 * Round 6 Phase CC4 — streaming suffix-search picker.
 *
 * Renders a spinner + live counter ("scanned 1,243 dirs · found 2") +
 * a list that grows with every `file:suffix:match` event, plus a Stop
 * Searching button. On `done` (>= 1 match), freezes the list and
 * collapses the counter into "found N matches". On `done` with 0
 * matches, swaps to a "no matches found, [Create file at original path]"
 * banner. On `cancelled`, freezes with "Cancelled · found N so far".
 */
function renderSuffixStreamingPicker(opts: SuffixStreamingPickerOptions): void {
  opts.body.innerHTML = "";
  opts.titleEl.textContent = opts.suffix;

  const wrap = document.createElement("div");
  wrap.className = "file-viewer-suffix-streaming";

  const heading = document.createElement("div");
  heading.className = "file-viewer-suffix-streaming-heading";
  heading.textContent = `Looking for "${opts.suffix}"…`;
  wrap.appendChild(heading);

  // Round 8.7 — the rg backend (commit a3b843f) doesn't emit per-readdir
  // progress, so "scanned N dirs" was permanently stuck at 0. Replaced
  // with a spinner element + "Searching project tree…" label; the
  // foundCount tally is appended as " · found N" only when N > 0.
  const status = document.createElement("div");
  status.className = "file-viewer-suffix-streaming-status";
  status.setAttribute("aria-live", "polite");
  const spinnerEl = document.createElement("span");
  spinnerEl.className = "file-viewer-suffix-streaming-spinner";
  spinnerEl.setAttribute("aria-hidden", "true");
  status.appendChild(spinnerEl);
  const statusText = document.createElement("span");
  statusText.className = "file-viewer-suffix-streaming-status-text";
  statusText.textContent = "Searching project tree…";
  status.appendChild(statusText);
  wrap.appendChild(status);

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "file-viewer-suffix-streaming-stop";
  stopBtn.textContent = "Stop searching";
  wrap.appendChild(stopBtn);

  const list = document.createElement("div");
  list.className = "file-viewer-suffix-streaming-list";
  wrap.appendChild(list);

  opts.body.appendChild(wrap);

  let foundCount = 0;
  let scannedDirs = 0;
  let frozen = false;
  // roots reported by the done payload; rendered in the
  // no-match banner so a misdirected search is diagnosable on sight.
  let searchedRoots: string[] = [];
  // Round 8.7 — guard against double-open when the user clicks the row
  // before onDone arrives. Set by the row click handler; checked in the
  // auto-open branch of freeze("done").
  let openedManually = false;
  const seen = new Set<string>();

  // Round 8.7 — extracted from the row click handler so freeze("done")
  // can reuse it for the auto-open-on-single-match path. Round 8.7
  // follow-up — await the IPC before closing. Fire-and-forget +
  // synchronous window.close() raced: the renderer started tearing
  // down before main finished spawning the new BrowserWindow, and the
  // freshly-opened file viewer briefly appeared then closed. Awaiting
  // pins the close to AFTER main has constructed the new window and
  // resolved the IPC.
  const openMatchAndClose = async (matchedPath: string): Promise<void> => {
    await window.reckAPI.files.openInViewer(matchedPath, {
      projectCwd: opts.projectCwd,
    });
    window.close();
  };

  // Round 8.7 — writeStatus now updates the text-span child (the status
  // div also holds the spinner). On freeze, the spinner is removed and
  // writeStatus replaces the text-span content with the frozen label.
  const writeStatus = (text: string): void => {
    statusText.textContent = text;
  };
  const updateLive = (): void => {
    writeStatus(
      foundCount > 0
        ? `Searching project tree… · found ${foundCount}`
        : "Searching project tree…",
    );
  };

  // Round 8 follow-up — translate Mac mount-mirror paths to their
  // Pi-side form when the popup carries displayTranslation. Display
  // only; the click still calls openInViewer with the Mac path
  // (main resolves via the local mount).
  const displayFor = (matchedPath: string): string => {
    if (!opts.displayTranslation) return matchedPath;
    const mount = opts.displayTranslation.mountRoot.replace(/\/+$/, "");
    const station = opts.displayTranslation.stationRoot.replace(/\/+$/, "");
    if (matchedPath === mount) return station;
    if (matchedPath.startsWith(mount + "/")) {
      return station + matchedPath.slice(mount.length);
    }
    return matchedPath;
  };

  const appendMatch = (matchedPath: string): void => {
    if (seen.has(matchedPath)) return;
    seen.add(matchedPath);
    foundCount += 1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-viewer-suffix-picker-item";
    btn.textContent = displayFor(matchedPath);
    btn.addEventListener("click", () => {
      // Round 8.7 — mark the click as manual so the done-handler's
      // auto-open branch doesn't fire openInViewer a second time.
      openedManually = true;
      void openMatchAndClose(matchedPath);
    });
    list.appendChild(btn);
    if (!frozen) updateLive();
  };

  const freeze = (kind: "done" | "cancelled"): void => {
    frozen = true;
    stopBtn.style.display = "none";
    // Round 8.7 — once we've stopped streaming there's no further work
    // to indicate; drop the spinner so the frozen status reads as plain
    // text. Safe to call repeatedly: remove() on a detached node is a
    // no-op.
    spinnerEl.remove();
    if (foundCount === 0 && kind === "done") {
      // Round 8.1 Phase RR — distinguish "search reached 0 dirs" from
      // "search walked the tree but found nothing". The former almost
      // always means the sshfs mount is stalled / unreachable; surfacing
      // a different message lets the user actually diagnose it instead
      // of clicking Create on a path that won't survive a remount.
      // that heuristic only holds for the readdir walker:
      // the rg backends never emit progress, so scannedDirs===0 is
      // meaningless there and falsely blamed a healthy mount. An
      // explicit progressCapable=false suppresses the stall branch.
      const unreadable =
        scannedDirs === 0 && opts.searchProgressCapable !== false;
      // Swap the whole body to a "no matches + create" banner.
      opts.body.innerHTML = "";
      const noMatch = document.createElement("div");
      noMatch.className = "file-viewer-suffix-streaming";
      const h = document.createElement("div");
      h.className = "file-viewer-suffix-streaming-heading";
      h.textContent = unreadable
        ? "Couldn't read any search root"
        : `No matches for "${opts.suffix}"`;
      noMatch.appendChild(h);
      const sub = document.createElement("div");
      sub.className = "file-viewer-suffix-streaming-status";
      sub.textContent = unreadable
        ? "The sshfs mount may be stalled, or this project isn't synced via sshfs."
        : "The file you clicked wasn't found in the project tree.";
      noMatch.appendChild(sub);
      // name the roots the search actually walked.
      // A search silently confined to the wrong subtree (the
      // 2026-06-06 projectCwd-absent failure) is undiagnosable
      // without this line. Pi-form via displayFor for station popups.
      if (searchedRoots.length > 0) {
        const rootsLine = document.createElement("div");
        rootsLine.className = "file-viewer-suffix-streaming-status";
        rootsLine.textContent = `Searched: ${searchedRoots
          .map(displayFor)
          .join(" · ")}`;
        noMatch.appendChild(rootsLine);
      }
      const createBtn = document.createElement("button");
      createBtn.type = "button";
      createBtn.className = "file-viewer-suffix-picker-item";
      // Round 8 follow-up — display Pi path for station-context clicks
      // so the user sees the same conventions they were working in.
      createBtn.textContent = `Create empty file at ${displayFor(opts.originalPath)}`;
      createBtn.addEventListener("click", () => {
        void (async () => {
          const created = await window.reckAPI.files.create(opts.originalPath);
          if (created.ok) {
            void window.reckAPI.files.openInViewer(created.resolvedPath, {
              projectCwd: opts.projectCwd,
            });
            window.close();
          }
        })();
      });
      noMatch.appendChild(createBtn);
      opts.body.appendChild(noMatch);
      return;
    }
    // Round 8.7 — auto-open when the search resolves to exactly one
    // match. Skipped on `cancelled` (the user explicitly aborted) and
    // when the user has already clicked the row (openedManually). The
    // single `seen` entry is the canonical match path.
    if (kind === "done" && foundCount === 1 && !openedManually) {
      const onlyMatch = Array.from(seen)[0];
      if (onlyMatch) {
        for (const u of unsubs) u();
        void openMatchAndClose(onlyMatch);
        return;
      }
    }
    if (kind === "cancelled") {
      writeStatus(
        `Cancelled · found ${foundCount} match${foundCount === 1 ? "" : "es"} so far`,
      );
    } else {
      writeStatus(`found ${foundCount} match${foundCount === 1 ? "" : "es"}`);
    }
  };

  // Subscribe to the streaming events. Each handler filters on searchId
  // because every popup shares the same ipcRenderer + channel set.
  const unsubs: Array<() => void> = [];
  unsubs.push(
    window.reckAPI.files.suffixSearch.onMatch((ev) => {
      if (frozen) return;
      if (ev.searchId !== opts.searchId) return;
      appendMatch(ev.path);
    }),
  );
  unsubs.push(
    window.reckAPI.files.suffixSearch.onProgress((ev) => {
      if (frozen) return;
      if (ev.searchId !== opts.searchId) return;
      scannedDirs = ev.scannedDirs;
      // Don't overwrite a higher found count — the renderer's own count
      // is authoritative (we tally onMatch deduped against `seen`).
      updateLive();
    }),
  );
  unsubs.push(
    window.reckAPI.files.suffixSearch.onDone((ev) => {
      if (ev.searchId !== opts.searchId) return;
      searchedRoots = ev.searchedRoots ?? [];
      freeze("done");
      for (const u of unsubs) u();
    }),
  );
  unsubs.push(
    window.reckAPI.files.suffixSearch.onCancelled((ev) => {
      if (ev.searchId !== opts.searchId) return;
      freeze("cancelled");
      for (const u of unsubs) u();
    }),
  );

  stopBtn.addEventListener("click", () => {
    if (frozen) return;
    void window.reckAPI.files.suffixSearch.cancel(opts.searchId);
    // freeze immediately as well — main's cancelled event still arrives
    // but `frozen` is already true, so it's a no-op.
    freeze("cancelled");
    for (const u of unsubs) u();
  });
}

/**
 * Render a file fetched via SSH from the station (Phase 8 of
 * linkifier-followups). Always read-only; the popup shows a banner
 * indicating this is a station file. No watcher / no auto-save — the
 * baseline + content are a single snapshot.
 */
async function renderStationRemote(
  root: HTMLElement,
  shell: ViewerShell,
  filePath: string,
  renderOpts: RenderOptions = {},
): Promise<void> {
  speakHandles.get(root)?.dispose();
  speakHandles.delete(root);
  disposeSession(root);
  // Round 3 follow-up — the mode toggle re-enters this function after
  // writing the new mode. Without clearing the body here, the previous
  // render's DOM (e.g. the rendered markdown HTML) stays mounted and
  // the new render appends BELOW it. User sees "nothing happened" even
  // though the source CodeMirror is mounted out of view. Same fix
  // pattern as renderForPath's source branch.
  shell.body.innerHTML = "";

  const spinner = mountSpinner(shell.spinnerSlot);
  spinner.show();
  const result = await window.reckAPI.files.readStation(filePath);
  spinner.hide();
  if (!result.ok) {
    // Round 6 Phase DD2 — station-remote create flow. When the file
    // doesn't exist on the Pi, surface the create banner instead of a
    // dead-end error. Path-safety is re-validated inside `createStation`
    // before the SSH command runs.
    if (
      result.code === "not-found" &&
      window.reckAPI.files.createStation
    ) {
      renderCreateBanner({
        body: shell.body,
        filePath,
        onCreate: async () => {
          const createResult =
            await window.reckAPI.files.createStation!(filePath);
          if (!createResult.ok) {
            renderErrorInto(shell.body, createResult.error);
            return;
          }
          // Re-enter renderStationRemote — the second readStation hits
          // the now-existing empty file.
          await renderStationRemote(root, shell, filePath, renderOpts);
        },
      });
      return;
    }
    renderErrorInto(
      shell.body,
      `Station file read failed: ${result.error || result.code}`,
    );
    return;
  }

  await mountTitleAndBadge({
    titleEl: shell.titleEl,
    resolvedPath: filePath,
    isStationRemote: true,
  });

  // Round 4 Phase S — station files are EDITABLE now. The previous
  // "Read-only — station file:" banner is gone; the STATION badge in
  // the title carries the same "this lives on the Pi" signal. There's
  // no chokidar / sshfs watcher for SSH-only files, so concurrent
  // remote edits only surface as a conflict on the next save attempt.

  // Markdown files honour the user's view/source preference (same
  // config key as renderForPath). Both modes are now editable via
  // SSH-backed writeStation; source mode is the keystroke-edit path,
  // rendered mode falls through to the toggle for actual editing.
  const isMd = isMarkdownPath(filePath);
  const markdownMode: MarkdownMode = isMd
    ? await readMarkdownMode(filePath)
    : "source";
  let codeEditor: CodeEditorHandle | null = null;
  let baseline: FileBaseline = result.baseline;

  // Save closure routes through files.writeStation. Shape matches the
  // local save closure in renderForPath so the autoSave/conflict
  // machinery is reusable verbatim.
  const save = async (content: string): Promise<void> => {
    spinner.show();
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    console.log(
      `[autosave] save-start path=${basenameForLog(filePath)} ` +
        `baselineSha=${String(baseline.sha256).slice(0, 8)} ` +
        `bytes=${content.length} host=station`,
    );
    try {
      const writeResult = await window.reckAPI.files.writeStation({
        path: filePath,
        content,
        baseline,
      });
      const ms = typeof performance !== "undefined"
        ? Math.round(performance.now() - t0)
        : 0;
      if (writeResult.ok) {
        baseline = writeResult.baseline;
        console.log(
          `[autosave] save-ok path=${basenameForLog(filePath)} ` +
            `newSha=${String(writeResult.baseline.sha256).slice(0, 8)} ms=${ms} host=station`,
        );
        return;
      }
      if (
        writeResult.code === "conflict" &&
        writeResult.currentBaseline &&
        writeResult.currentContent !== undefined
      ) {
        console.log(
          `[autosave] save-conflict path=${basenameForLog(filePath)} ` +
            `baselineSha=${String(baseline.sha256).slice(0, 8)} ` +
            `diskSha=${String(writeResult.currentBaseline.sha256).slice(0, 8)} ms=${ms} host=station`,
        );
        showConflictBanner({
          root,
          shell,
          filePath,
          resolvedPath: filePath,
          theirsBaseline: writeResult.currentBaseline,
          theirsContent: writeResult.currentContent,
        });
        return;
      }
      console.warn(
        `[autosave] save-error path=${basenameForLog(filePath)} ` +
          `code=${writeResult.code ?? "unknown"} ` +
          `msg=${writeResult.error ?? "<none>"} host=station`,
      );
    } finally {
      spinner.hide();
    }
  };

  const autoSave = createAutoSave({
    save,
    onStateChange: (s) => {
      if (s === "saving") spinner.show();
      else if (s === "idle") spinner.hide();
    },
  });

  if (isMd) {
    mountModeToggle(shell.modeToggleSlot, markdownMode, async () => {
      const next: MarkdownMode = markdownMode === "rendered" ? "source" : "rendered";
      await writeMarkdownMode(filePath, next);
      // Round 5 Phase W — when the user clicked "Edit source" to
      // jump out of rendered mode, the intent is clearly to edit.
      // Pass `initialUnlocked: true` so the new source-mode view
      // skips the default-locked friction step.
      await renderStationRemote(root, shell, filePath, {
        initialUnlocked: next === "source",
        projectCwd: renderOpts.projectCwd,
      });
    });
  } else {
    shell.modeToggleSlot.innerHTML = "";
  }

  if (isMd && markdownMode === "rendered") {
    const md = createMarkdownRenderer({
      onLinkActivate: (href) => {
        // Resolve relative hrefs against the station path. The
        // resulting target may itself be a station file — pass through
        // the same sourceHost so the next click also routes via SSH.
        const target = href.startsWith("/")
          ? href
          : window.reckAPI.paths.resolveAgainst(filePath, href);
        const ctx: ClickContext = {
          surface: "popup-markdown",
          href,
          opener: filePath,
          target,
          sourceHost: "station",
          projectCwd: renderOpts.projectCwd,
        };
        void openInViewerWithToast({
          ctx,
          openInViewer: () =>
            window.reckAPI.files.openInViewer(target, {
              sourceHost: "station",
              opener: filePath,
              originalText: href,
              projectCwd: renderOpts.projectCwd,
            }) as Promise<{ ok?: boolean; code?: string; error?: string } | undefined>,
          showToast: (msg, o) =>
            showToast(shell.body, msg, { durationMs: o?.ttl, kind: o?.kind }),
        });
      },
    });
    md.mount(shell.body, md.render(result.content));
  } else {
    // Source mode (markdown source OR non-markdown code) — EDITABLE
    // CodeMirror. mountCodeEditor's onChange feeds autoSave.markDirty
    // which fires writeStation 400ms after the last keystroke.
    // Round 5 Phase V — when the SSH user can't write the file, mount
    // a banner above the editor and lock CodeMirror into readOnly.
    if (!result.writable) {
      mountReadOnlyBanner(shell.body);
    }
    // Round 5 Phase W — full-width lock banner. Same logic as in
    // renderForPath: default LOCKED unless `initialUnlocked: true`.
    let lockBannerRef: LockBannerHandle | null = null;
    const startLocked = result.writable && renderOpts.initialUnlocked !== true;
    if (result.writable) {
      lockBannerRef = mountLockBanner({
        parent: shell.body,
        initialLocked: startLocked,
        onToggle: (locked) => {
          codeEditor?.setReadOnly(locked);
        },
      });
    }
    const wrapper = document.createElement("div");
    wrapper.className = "file-viewer-code-editor";
    shell.body.appendChild(wrapper);
    codeEditor = mountCodeEditor({
      initialContent: result.content,
      filePath,
      theme:
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "dark"
          : "light",
      parent: wrapper,
      readOnly: !result.writable || startLocked,
      onChange: (content) => {
        autoSave.markDirty(content);
      },
    });
    // Round 6 Phase BB1 — install path linkifier so Cmd-clicking on a
    // path token in the source view opens a new popup. Station-remote
    // popups pass sourceHost="station" so recursive clicks stay on the
    // station side.
    //
    // Round 8.6 Phase 9 — same toast + error handling as the markdown
    // surface via openInViewerWithToast. Pre-fix: fire-and-forget meant
    // no toast on same-file clicks and no error message on failures.
    installCodeMirrorPathLinkifier(codeEditor.view, {
      onActivate: (target) => {
        const ctx: ClickContext = {
          surface: "popup-source",
          href: target,
          opener: filePath,
          target,
          sourceHost: "station",
          projectCwd: renderOpts.projectCwd,
        };
        void openInViewerWithToast({
          ctx,
          openInViewer: () =>
            window.reckAPI.files.openInViewer(target, {
              sourceHost: "station",
              opener: filePath,
              originalText: target,
              projectCwd: renderOpts.projectCwd,
            }) as Promise<{ ok?: boolean; code?: string; error?: string } | undefined>,
          showToast: (msg, o) =>
            showToast(shell.body, msg, { durationMs: o?.ttl, kind: o?.kind }),
        });
      },
    });
    void lockBannerRef;
  }

  // Register the session so showConflictBanner can find it.
  const sessionRef: ActiveSession = {
    resolvedPath: filePath,
    baseline,
    spinner,
    autoSave,
    editor: codeEditor,
    conflict: null,
    unsubscribeWatch: null,
    write: (req) => window.reckAPI.files.writeStation(req) as Promise<SessionWriteResult>,
    isStationRemote: true,
  };
  sessions.set(root, sessionRef);

  // Round 3 follow-up — TTS for station-remote popups. The original
  // v1 deliberately skipped this; the user pointed out that listening
  // to plans on the station is a real workflow. Mounts the same
  // adapter pair as renderForPath; no write coupling because station
  // popups stay read-only.
  const surface: SpeakSurfaceAdapter = codeEditor
    ? new CodeMirrorSurfaceAdapter({
        container: root,
        view: codeEditor.view,
      })
    : new MarkdownSurfaceAdapter({
        container: root,
        body: shell.body,
      });
  let ttsHandle: TtsHandle | null = null;
  void (async () => {
    try {
      ttsHandle = await initTts({
        getActiveSpeakSurface: () => surface,
      });
    } catch (e) {
      console.warn("[file-viewer] TTS disabled:", e);
    }
  })();
  speakHandles.set(root, {
    surface,
    dispose: () => {
      ttsHandle?.dispose();
      surface.dispose();
    },
  });
}

// Per-host state for the active Speak handle so re-renders (auto-reload,
// create-flow re-mount) tear down the old bar before installing a new one.
// The handle wraps the unified TtsController plus the surface adapter we
// constructed for this viewer (markdown overlay or CodeMirror decoration).
interface SpeakHandle {
  dispose(): void;
  surface: SpeakSurfaceAdapter;
}
const speakHandles = new WeakMap<HTMLElement, SpeakHandle>();

async function renderForPath(
  root: HTMLElement,
  shell: ViewerShell,
  filePath: string,
  renderOpts: RenderOptions = {},
): Promise<void> {
  // Tear down any previously-installed Speak bar + P4 session before
  // re-rendering.
  speakHandles.get(root)?.dispose();
  speakHandles.delete(root);
  disposeSession(root);

  const spinner = mountSpinner(shell.spinnerSlot);
  spinner.show();
  const result = await window.reckAPI.files.read(filePath);
  spinner.hide();
  if (!result.ok) {
    // Intended-path / create-on-click flow: a Cmd+click on a dashed-underline
    // path in scrollback lands here when the file doesn't yet exist. Offer
    // an explicit Create button rather than dead-ending on an error.
    if (result.code === "not-found" && window.reckAPI.files.create) {
      renderCreateBanner({
        body: shell.body,
        filePath,
        // Round 6 Phase DD1 — when the URL carried a displayPath
        // (station-pane click on a mount-mirror missing file), the
        // banner shows that Pi-side path. The actual create still
        // writes through the Mac mount via sshfs.
        displayPath: renderOpts.displayPath,
        onCreate: async () => {
          const createResult = await window.reckAPI.files.create!(filePath);
          if (!createResult.ok) {
            renderErrorInto(shell.body, createResult.error);
            return;
          }
          // Re-enter the render path. The second files.read will succeed
          // and the content (empty) will land in the body.
          await renderForPath(root, shell, filePath, {
            projectCwd: renderOpts.projectCwd,
          });
        },
      });
      return;
    }
    renderErrorInto(shell.body, result.error);
    return;
  }

  await mountTitleAndBadge({
    titleEl: shell.titleEl,
    resolvedPath: result.resolvedPath,
    isStationRemote: false,
  });

  let codeEditor: CodeEditorHandle | null = null;
  let baseline: FileBaseline = result.baseline;

  // Per-edit save through the optimistic-concurrency IPC. On conflict,
  // we surface the ConflictBanner; on success we update the baseline.
  const save = async (content: string): Promise<void> => {
    spinner.show();
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    // Phase P log — fires once per save attempt. baselineSha is the
    // sha we're sending so the user can correlate with [file-viewer]
    // write / watch / echo-suppressed lines on the main side.
    console.log(
      `[autosave] save-start path=${basenameForLog(result.resolvedPath)} ` +
        `baselineSha=${String(baseline.sha256).slice(0, 8)} ` +
        `bytes=${content.length}`,
    );
    try {
      const writeResult = await window.reckAPI.files.write({
        path: result.resolvedPath,
        content,
        baseline,
      });
      const ms = typeof performance !== "undefined"
        ? Math.round(performance.now() - t0)
        : 0;
      if (writeResult.ok) {
        baseline = writeResult.baseline;
        console.log(
          `[autosave] save-ok path=${basenameForLog(result.resolvedPath)} ` +
            `newSha=${String(writeResult.baseline.sha256).slice(0, 8)} ms=${ms}`,
        );
        return;
      }
      if (
        writeResult.code === "conflict" &&
        writeResult.currentBaseline &&
        writeResult.currentContent !== undefined
      ) {
        console.log(
          `[autosave] save-conflict path=${basenameForLog(result.resolvedPath)} ` +
            `baselineSha=${String(baseline.sha256).slice(0, 8)} ` +
            `diskSha=${String(writeResult.currentBaseline.sha256).slice(0, 8)} ms=${ms}`,
        );
        showConflictBanner({
          root,
          shell,
          filePath,
          resolvedPath: result.resolvedPath,
          theirsBaseline: writeResult.currentBaseline,
          theirsContent: writeResult.currentContent,
        });
        return;
      }
      console.warn(
        `[autosave] save-error path=${basenameForLog(result.resolvedPath)} ` +
          `code=${writeResult.code ?? "unknown"} ` +
          `msg=${writeResult.error ?? "<none>"}`,
      );
    } finally {
      spinner.hide();
    }
  };

  const autoSave = createAutoSave({
    save,
    onStateChange: (s) => {
      // The spinner is already toggled in `save()`. For "scheduled"
      // state (typing but no save in flight yet), keep the spinner
      // off so it only reflects in-flight I/O.
      if (s === "saving") spinner.show();
      else if (s === "idle") spinner.hide();
    },
  });

  // Phase 7 of linkifier-followups: for markdown files, branch on the
  // persisted mode. Default "rendered" preserves the existing UX; the
  // user can toggle to "source" via the header button (mounts CodeMirror
  // with markdown grammar; all P4 auto-save + conflict-banner plumbing
  // re-runs). Code files don't show the toggle.
  const isMd = isMarkdownPath(filePath);
  const markdownMode: MarkdownMode = isMd
    ? await readMarkdownMode(result.resolvedPath)
    : "source";
  if (isMd) {
    mountModeToggle(shell.modeToggleSlot, markdownMode, async () => {
      const next: MarkdownMode = markdownMode === "rendered" ? "source" : "rendered";
      await writeMarkdownMode(result.resolvedPath, next);
      // Re-enter the render path so the new mode mounts with all the
      // associated machinery (auto-save in source mode, link interception
      // in rendered mode). The file is re-read from disk — one cheap
      // round-trip but avoids state-swap bugs mid-session.
      // Round 5 Phase W — clicking "Edit source" is an explicit
      // "I want to edit" gesture, so source mode mounts UNLOCKED.
      await renderForPath(root, shell, filePath, {
        initialUnlocked: next === "source",
        projectCwd: renderOpts.projectCwd,
      });
    });
  } else {
    shell.modeToggleSlot.innerHTML = "";
  }

  if (isMd && markdownMode === "rendered") {
    const md = createMarkdownRenderer({
      onLinkActivate: (href) => {
        // Resolve relative hrefs against the file we're currently viewing.
        const target = href.startsWith("/")
          ? href
          : window.reckAPI.paths.resolveAgainst(result.resolvedPath, href);
        console.log("[click:popup-recursive] resolving (local)", {
          href,
          opener: result.resolvedPath,
          target,
          sourceHost: undefined,
        });
        window.reckAPI.files
          .openInViewer(target, {
            opener: result.resolvedPath,
            originalText: href,
            projectCwd: renderOpts.projectCwd,
          })
          .then((r) => {
            const res = r as
              | { ok?: boolean; code?: string; error?: string }
              | undefined;
            if (!res || res.ok !== true) {
              console.warn(
                "[click:popup-recursive] openInViewer rejected (local)",
                { target, result: res },
              );
              showToast(
                shell.body,
                res?.error
                  ? `Could not open: ${res.error}`
                  : "Could not open file.",
                3500,
              );
              return;
            }
            if (res.code === "same-popup") {
              showToast(shell.body, "Already viewing this file.");
            }
          })
          .catch((err: unknown) => {
            console.warn(
              "[click:popup-recursive] openInViewer threw (local)",
              { target, error: err },
            );
          });
      },
    });
    md.mount(shell.body, md.render(result.content));
  } else {
    // P4: editable CodeMirror surface. `onChange` feeds the auto-save
    // coordinator, which debounces and flushes to `file:write`.
    shell.body.innerHTML = "";
    // Round 5 Phase V — when the file is read-only on disk, mount a
    // banner above the editor body and force CodeMirror into readOnly
    // mode. The onChange handler still wires to autoSave, but since
    // CodeMirror suppresses edits, markDirty never fires.
    if (!result.writable) {
      mountReadOnlyBanner(shell.body);
    }
    // Round 5 Phase W — lock banner (Variation D, full-width). Only
    // when the file is writable (read-only files have their own
    // banner and need no toggle). Default LOCKED unless the caller
    // passed `initialUnlocked: true` (markdown rendered → source
    // mode toggle is the only current caller that does this).
    let lockBannerRef: LockBannerHandle | null = null;
    const startLocked = result.writable && renderOpts.initialUnlocked !== true;
    if (result.writable) {
      lockBannerRef = mountLockBanner({
        parent: shell.body,
        initialLocked: startLocked,
        onToggle: (locked) => {
          codeEditor?.setReadOnly(locked);
        },
      });
    }
    const theme: "light" | "dark" =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : "light";
    codeEditor = mountCodeEditor({
      initialContent: result.content,
      filePath: filePath,
      theme,
      parent: shell.body,
      readOnly: !result.writable || startLocked,
      onChange: (content) => autoSave.markDirty(content),
    });
    // Round 6 Phase BB1 — install path linkifier so Cmd-clicking on a
    // path token in the source view opens a new popup. Local-host
    // popups don't carry sourceHost; the resolver runs default-host
    // logic on the resulting path.
    //
    // Round 8.6 Phase 9 — same toast + error handling as the markdown
    // surface via openInViewerWithToast.
    installCodeMirrorPathLinkifier(codeEditor.view, {
      onActivate: (target) => {
        const ctx: ClickContext = {
          surface: "popup-source",
          href: target,
          opener: result.resolvedPath,
          target,
          projectCwd: renderOpts.projectCwd,
        };
        void openInViewerWithToast({
          ctx,
          openInViewer: () =>
            window.reckAPI.files.openInViewer(target, {
              opener: result.resolvedPath,
              originalText: target,
              projectCwd: renderOpts.projectCwd,
            }) as Promise<{ ok?: boolean; code?: string; error?: string } | undefined>,
          showToast: (msg, o) =>
            showToast(shell.body, msg, { durationMs: o?.ttl, kind: o?.kind }),
        });
      },
    });
    // Track the banner on the session so dispose tears it down.
    void lockBannerRef;
  }

  // Phase 1 (linkifier-followups): install the unified TTS subsystem
  // with a surface adapter matching the active viewer kind. Same
  // engine, same control bar, same shortcuts as terminal panes —
  // including per-word highlighting via the adapter's own decoration
  // path. Disposing this handle tears down the engine + bar + listeners.
  const surface: SpeakSurfaceAdapter = codeEditor
    ? new CodeMirrorSurfaceAdapter({
        container: root,
        view: codeEditor.view,
      })
    : new MarkdownSurfaceAdapter({
        container: root,
        body: shell.body,
      });
  let ttsHandle: TtsHandle | null = null;
  void (async () => {
    try {
      ttsHandle = await initTts({
        getActiveSpeakSurface: () => surface,
      });
    } catch (e) {
      console.warn("[file-viewer] TTS disabled:", e);
    }
  })();
  speakHandles.set(root, {
    surface,
    dispose: () => {
      ttsHandle?.dispose();
      surface.dispose();
    },
  });

  // P4: watch the file on disk. When the viewer is clean we silently
  // reload; when it's dirty (CodeMirror content has diverged from
  // baseline) we show the conflict banner.
  const sessionRef: ActiveSession = {
    resolvedPath: result.resolvedPath,
    baseline,
    spinner,
    autoSave,
    editor: codeEditor,
    conflict: null,
    unsubscribeWatch: null,
    write: (req) => window.reckAPI.files.write(req) as Promise<SessionWriteResult>,
    isStationRemote: false,
  };
  sessions.set(root, sessionRef);

  const onWatchEvent = (ev: { path: string; kind: "change" | "unlink" }): void => {
    if (ev.path !== sessionRef.resolvedPath) return;
    if (ev.kind === "unlink") {
      // P5 polish — for now, surface a banner equivalent to the conflict
      // banner so the user knows the file is gone.
      showFileGoneBanner(shell, filePath);
      return;
    }
    void handleExternalChange(root, shell, filePath, sessionRef);
  };
  const unsubscribe = window.reckAPI.files.onWatchEvent(onWatchEvent);
  void window.reckAPI.files.watchSubscribe(result.resolvedPath);
  sessionRef.unsubscribeWatch = () => {
    unsubscribe();
    void window.reckAPI.files.watchUnsubscribe(result.resolvedPath);
  };
}

async function handleExternalChange(
  root: HTMLElement,
  shell: ViewerShell,
  filePath: string,
  session: ActiveSession,
): Promise<void> {
  // Round 4 Phase O — sha-based echo detection. Round 3 D1 added a
  // 500ms write-suppression window, but the sshfs polling watcher fires
  // at 1500ms intervals; a poll tick after a self-write can slip past
  // the time window and reach this function. Round 3 D3 added a sha
  // guard, but only INSIDE the clean branch. When the user was
  // continuously typing the autoSave stayed in "scheduled"/"saving"
  // and we hit the dirty branch — showing a bogus conflict banner for
  // bytes we ourselves wrote. Move the sha-equality check ABOVE the
  // clean/dirty branching so echoes are suppressed regardless of
  // autoSave state. The disk reread is unavoidable (we need its sha
  // to compare) but otherwise this is the same logic that previously
  // gated the clean-branch reload.
  session.spinner.show();
  const reread = await window.reckAPI.files.read(filePath);
  session.spinner.hide();
  if (!reread.ok) return;
  const sameSha = reread.baseline.sha256 === session.baseline.sha256;
  if (sameSha) {
    console.log(
      `[file-viewer] echo-suppressed path=${basenameForLog(filePath)} ` +
        `sha=${String(reread.baseline.sha256).slice(0, 8)} ` +
        `autoSaveState=${session.autoSave?.getState() ?? "n/a"}`,
    );
    // Refresh mtime baseline (the file was touched, sha just stayed
    // equal) so the next stat-only fast path inside the IPC layer can
    // skip a redundant content read.
    session.baseline = reread.baseline;
    return;
  }

  // Real external change. Branch by clean/dirty.
  const clean = session.autoSave?.getState() === "idle";
  if (!clean) {
    showConflictBanner({
      root,
      shell,
      filePath,
      resolvedPath: session.resolvedPath,
      theirsBaseline: reread.baseline,
      theirsContent: reread.content,
    });
    return;
  }
  // Clean → silently reload, preserving cursor by line/col where possible.
  console.log(
    `[file-viewer] reload path=${basenameForLog(filePath)} ` +
      `source=watcher setContentSkipped=false ` +
      `bytes=${reread.content.length}`,
  );
  session.baseline = reread.baseline;
  if (session.editor) {
    const view = session.editor.view;
    // Capture cursor position before swap.
    const anchor = view.state.selection.main.anchor;
    const lineBefore = view.state.doc.lineAt(anchor);
    const col = anchor - lineBefore.from;
    const lineNum = lineBefore.number;
    // Round 3 D2 — `silent: true` tags the dispatch with the
    // `reck.silent-load` userEvent so the editor's updateListener
    // suppresses onChange for this transaction. Belt-and-braces with
    // the main-side write suppression (D1).
    session.editor.setContent(reread.content, { silent: true });
    // Restore cursor at the same line+col when in bounds.
    const newDoc = view.state.doc;
    if (lineNum <= newDoc.lines) {
      const line = newDoc.line(lineNum);
      const newAnchor = Math.min(line.from + col, line.to);
      view.dispatch({ selection: { anchor: newAnchor } });
    }
  } else {
    // Markdown viewer — rebuild the rendered body from the new content.
    // Easiest path is re-entering renderForPath which tears down and
    // rebuilds.
    await renderForPath(root, shell, filePath);
  }
  showToast(shell.body, "Reloaded from disk");
}

/** Stable basename for log lines without leaking the full path. */
function basenameForLog(p: string): string {
  if (typeof p !== "string" || p.length === 0) return "<unknown>";
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

interface ShowConflictArgs {
  root: HTMLElement;
  shell: ViewerShell;
  filePath: string;
  resolvedPath: string;
  theirsBaseline: FileBaseline;
  theirsContent: string;
}

function showConflictBanner(args: ShowConflictArgs): void {
  const session = sessions.get(args.root);
  if (!session) return;
  // Tear down any previously-shown banner before re-mounting.
  session.conflict?.dispose();
  const banner = mountConflictBanner({
    parent: args.shell.body,
    onForceMine: async () => {
      const content = session.editor?.getContent() ?? "";
      session.spinner.show();
      try {
        const writeResult = await session.write({
          path: args.resolvedPath,
          content,
          baseline: session.baseline,
          force: true,
        });
        if (writeResult.ok) {
          session.baseline = writeResult.baseline;
          session.conflict?.dispose();
          session.conflict = null;
          showToast(args.shell.body, "Saved (forced).");
        }
      } finally {
        session.spinner.hide();
      }
    },
    onForceTheirs: () => {
      session.baseline = args.theirsBaseline;
      if (session.editor) {
        // D2 silent — see handleExternalChange for the rationale.
        session.editor.setContent(args.theirsContent, { silent: true });
      }
      session.conflict?.dispose();
      session.conflict = null;
      showToast(args.shell.body, "Reloaded from disk.");
    },
    onOpenManualMerge: () => {
      // v1: simple inline diff. The user sees both side-by-side and can
      // edit the right-hand pane to produce the merged result, then
      // click Accept which triggers a force write. Full @codemirror/merge
      // integration is a P5 polish item.
      openInlineMerge({
        shell: args.shell,
        theirs: args.theirsContent,
        ours: session.editor?.getContent() ?? "",
        onAccept: async (merged) => {
          session.spinner.show();
          try {
            const writeResult = await session.write({
              path: args.resolvedPath,
              content: merged,
              baseline: session.baseline,
              force: true,
            });
            if (writeResult.ok) {
              session.baseline = writeResult.baseline;
              // D2 silent — the merge content is already what we wrote
              // to disk; setContent must NOT re-enter the auto-save
              // pipeline as a fresh edit.
              session.editor?.setContent(merged, { silent: true });
              session.conflict?.dispose();
              session.conflict = null;
              showToast(args.shell.body, "Merge saved.");
            }
          } finally {
            session.spinner.hide();
          }
        },
      });
    },
  });
  session.conflict = banner;
}

interface InlineMergeOptions {
  shell: ViewerShell;
  theirs: string;
  ours: string;
  onAccept(merged: string): void | Promise<void>;
}

/**
 * Minimal inline diff: side-by-side `<pre>` panels, with the right one
 * editable via contenteditable. Returns when the user clicks Accept or
 * Cancel. v1 placeholder for the full `@codemirror/merge` integration.
 */
function openInlineMerge(opts: InlineMergeOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "file-viewer-merge-overlay";
  const panes = document.createElement("div");
  panes.className = "file-viewer-merge-panes";

  const theirsEl = document.createElement("pre");
  theirsEl.className = "file-viewer-merge-pane file-viewer-merge-theirs";
  theirsEl.textContent = opts.theirs;
  const theirsLabel = document.createElement("div");
  theirsLabel.className = "file-viewer-merge-label";
  theirsLabel.textContent = "Disk version (read-only)";
  const theirsWrap = document.createElement("div");
  theirsWrap.appendChild(theirsLabel);
  theirsWrap.appendChild(theirsEl);

  const oursEl = document.createElement("textarea");
  oursEl.className = "file-viewer-merge-pane file-viewer-merge-ours";
  oursEl.value = opts.ours;
  const oursLabel = document.createElement("div");
  oursLabel.className = "file-viewer-merge-label";
  oursLabel.textContent = "Your merged result (editable)";
  const oursWrap = document.createElement("div");
  oursWrap.appendChild(oursLabel);
  oursWrap.appendChild(oursEl);

  panes.appendChild(theirsWrap);
  panes.appendChild(oursWrap);

  const actions = document.createElement("div");
  actions.className = "file-viewer-merge-actions";
  const accept = document.createElement("button");
  accept.textContent = "Accept merged";
  accept.className = "file-viewer-merge-action";
  accept.addEventListener("click", () => {
    void opts.onAccept(oursEl.value);
    overlay.remove();
  });
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.className = "file-viewer-merge-action";
  cancel.addEventListener("click", () => {
    overlay.remove();
  });
  actions.appendChild(accept);
  actions.appendChild(cancel);

  overlay.appendChild(panes);
  overlay.appendChild(actions);
  opts.shell.body.appendChild(overlay);
}

function showFileGoneBanner(shell: ViewerShell, filePath: string): void {
  showToast(shell.body, `${basenameOf(filePath)} was deleted on disk.`, 6000);
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Round 3 Issue B — derive the popup title from a resolved path:
 * `<parent>/<basename>` for a nested path, just `<basename>` when
 * there's no parent directory above the file.
 *
 * Examples:
 *   `/home/pi/projects/repo/notes.md` → `repo/notes.md`
 *   `/tmp/foo.md` → `tmp/foo.md`
 *   `/foo.md` → `foo.md`
 *   `foo.md` (relative) → `foo.md`
 */
export function parentAndBasenameOf(p: string): string {
  if (typeof p !== "string" || p.length === 0) return "";
  const clean = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const i = clean.lastIndexOf("/");
  if (i < 0) return clean;
  const basename = clean.slice(i + 1);
  const before = clean.slice(0, i);
  if (before.length === 0) return basename; // path was "/foo"
  const j = before.lastIndexOf("/");
  if (j < 0) return `${before}/${basename}`;
  return `${before.slice(j + 1)}/${basename}`;
}

type ViewerHostKind = "STATION" | "SATELLITE";

/**
 * Round 3 Issue B — decide which host chip to show in the popup
 * header. The mount-point prefix check uses a trailing `/` so a path
 * like `/mount/projectsfoo/...` isn't misclassified as living under
 * `/mount/projects`.
 */
export function decideHostBadge(opts: {
  isStationRemote: boolean;
  resolvedPath: string;
  mountPoint: string | null;
}): ViewerHostKind {
  if (opts.isStationRemote) return "STATION";
  if (opts.mountPoint && opts.mountPoint.length > 0) {
    const root = opts.mountPoint.endsWith("/")
      ? opts.mountPoint
      : `${opts.mountPoint}/`;
    if (opts.resolvedPath === opts.mountPoint || opts.resolvedPath.startsWith(root)) {
      return "STATION";
    }
  }
  return "SATELLITE";
}

/**
 * Replace the current title + badge content inside `titleEl` with a
 * fresh `<span class="file-viewer-title-text">` and a
 * `<span class="file-viewer-host-badge" data-host="station|satellite">`.
 * Called after every successful read because the resolved path (used
 * for both pieces) isn't known until then.
 */
async function mountTitleAndBadge(opts: {
  titleEl: HTMLElement;
  resolvedPath: string;
  isStationRemote: boolean;
}): Promise<void> {
  let mountPoint: string | null = null;
  try {
    mountPoint = await window.reckAPI.paths.localMountPoint();
  } catch {
    mountPoint = null;
  }
  const kind = decideHostBadge({
    isStationRemote: opts.isStationRemote,
    resolvedPath: opts.resolvedPath,
    mountPoint,
  });
  opts.titleEl.innerHTML = "";
  const titleText = document.createElement("span");
  titleText.className = "file-viewer-title-text";
  titleText.textContent = parentAndBasenameOf(opts.resolvedPath);
  opts.titleEl.appendChild(titleText);
  const badge = document.createElement("span");
  badge.className = "file-viewer-host-badge";
  badge.setAttribute("data-host", kind.toLowerCase());
  badge.textContent = kind;
  opts.titleEl.appendChild(badge);
}
