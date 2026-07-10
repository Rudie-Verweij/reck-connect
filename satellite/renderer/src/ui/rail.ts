import type { Project, Stoplight } from "@proto/proto";
import { stoplightSeverity } from "@proto/proto";
import { iconPlus } from "./icons";
import { projectInitials, type RailMode } from "./rail-collapse";
import { computeReorder } from "./reorder";
import { createOverlayScrollbar, type OverlayScrollbar } from "../search/OverlayScrollbar";
import { domScrollSurface } from "../search/scrollSurfaces";

export interface RailProps {
  root: HTMLElement;
  onSelect: (projectId: string) => void;
  onAddProject: () => void;
  onRename?: (projectId: string, newName: string) => void;
  onReorder?: (newIds: string[]) => void;
  onRequestDelete?: (projectId: string, projectName: string) => void;
  onOpenInFinder?: (projectId: string) => void;
  /**
   * Toggle a project's archived state. `archived` is the DESIRED new state:
   * true to archive, false to unarchive. Invoked
   * from the context menu and from drag-into / drag-out-of the Archive
   * section. The confirm-before-restore prompt lives in the handler, not
   * here — the rail only reports intent.
   */
  onToggleArchive?: (projectId: string, archived: boolean) => void;
  /**
   * Expand the rail from mini. Fired by the footer's "»" chevron, which
   * only renders in mini mode (expanded mode has no collapse arrow —
   * collapse is the nav toggle / ⇧← / divider drag).
   */
  onExpand?: () => void;
  /**
   * an earlier release — return paneIds in the project's saved layout order
   * (left-to-right, top-to-bottom for stacked splits, same flatten as
   * the tab bar uses). Returning `null` skips reorder for that project
   * and the rail falls back to the daemon's creation-order
   * `pane_stoplights`. Called once per `setProjects` per project.
   *
   * Optional — when omitted, the rail behaves exactly as it did
   * Older. The reorder is also skipped when the daemon is Older
   * (no `pane_ids` field), or when the layout's paneIds don't overlap
   * with the daemon-emitted set (stale layout, daemon restart).
   */
  getLayoutPaneOrder?: (projectId: string) => string[] | null;
}

interface RailRow {
  el: HTMLElement;
  nameEl: HTMLElement;
  indicatorEl: HTMLElement;
  // Mini-rail avatar: initials label + aggregate stoplight badge. Both
  // exist in every row; CSS shows them only in .rail-mini.
  avatarEl: HTMLElement;
  avatarLabelEl: HTMLElement;
  avatarBadgeEl: HTMLElement;
  // Cached serialisation of the last rendered per-pane stoplight list.
  // Join-comparable so setProjects can skip DOM churn when the list is
  // unchanged. an earlier release: replaces the old `lastStoplight` / `lastPaneCount`
  // pair — per-pane color makes a single aggregate insufficient.
  lastStoplightsKey: string;
  lastName: string;
  lastArchived: boolean;
}

const MAX_INDICATOR_DOTS = 6;
const DOT_EXIT_MS = 220;

/**
 * Resolve the per-pane stoplight list for a project, applying the
 * Older daemon fallback and (when the caller supplies one) the
 * issue-#122 layout-order reorder.
 *
 * Fallback chain:
 *   1. Older daemon (no `pane_stoplights`): broadcast the project
 *      aggregate across `pane_count` dots, with a one-dot baseline for
 *      zero-pane projects.
 *   2. Older daemon, or `layoutOrder` not supplied: emit
 *      `pane_stoplights` as-is (creation order).
 *   3. Both `pane_ids` and `layoutOrder` present: rebuild the list in
 *      layout order. Build a paneId→stoplight map from the daemon
 *      payload, walk the layout's paneIds, drop any layout entries the
 *      daemon doesn't know about (closed panes still in the saved
 *      tree), append daemon panes the layout doesn't mention (newly
 *      created, layout not yet repainted) at the end. The append-at-end
 *      pass keeps every daemon-reported pane visible — losing one would
 *      under-report the dot count after a brand-new pane spawn.
 */
function resolvePaneStoplights(
  p: Project,
  layoutOrder: string[] | null,
): Stoplight[] {
  if (p.pane_stoplights === undefined) {
    const n = Math.max(1, p.pane_count);
    return new Array(n).fill(p.stoplight);
  }
  const stoplights = p.pane_stoplights;
  if (!layoutOrder || !p.pane_ids || p.pane_ids.length !== stoplights.length) {
    return stoplights;
  }
  const byId = new Map<string, Stoplight>();
  for (let i = 0; i < p.pane_ids.length; i++) {
    byId.set(p.pane_ids[i], stoplights[i]);
  }
  const out: Stoplight[] = [];
  const seen = new Set<string>();
  for (const id of layoutOrder) {
    if (seen.has(id)) continue;
    const s = byId.get(id);
    if (s === undefined) continue;
    out.push(s);
    seen.add(id);
  }
  for (let i = 0; i < p.pane_ids.length; i++) {
    if (!seen.has(p.pane_ids[i])) out.push(stoplights[i]);
  }
  return out;
}

function aggregateStoplight(stoplights: Stoplight[]): Stoplight {
  let best: Stoplight = "gray";
  for (const s of stoplights) {
    if (stoplightSeverity(s) > stoplightSeverity(best)) best = s;
  }
  return best;
}

function syncIndicatorDots(
  container: HTMLElement,
  stoplights: Stoplight[],
  opts: { skipAnimation?: boolean } = {},
) {
  // Preserve Older minimum: a zero-pane project still renders one
  // dot so the indicator has a fixed shape. Colour it gray — there are
  // no panes to aggregate, so the Older aggregate of the project
  // stoplight doesn't apply once a post-rollout daemon explicitly sends an
  // empty list.
  const target: Stoplight[] =
    stoplights.length === 0
      ? (["gray"] as Stoplight[])
      : stoplights.slice(0, MAX_INDICATOR_DOTS);

  container.dataset.stoplight = aggregateStoplight(target);

  const liveDots = Array.from(container.children).filter(
    (c) => !(c as HTMLElement).classList.contains("leaving"),
  ) as HTMLElement[];

  // Recolour existing dots in place so a pane flipping orange↔green
  // doesn't churn the DOM node (and doesn't replay the enter animation).
  for (let i = 0; i < liveDots.length && i < target.length; i++) {
    const dot = liveDots[i];
    const entering = dot.classList.contains("entering");
    const desired = `pane-indicator-dot ${target[i]}${entering ? " entering" : ""}`;
    if (dot.className !== desired) {
      dot.className = desired;
    }
  }

  if (target.length > liveDots.length) {
    for (let i = liveDots.length; i < target.length; i++) {
      const dot = document.createElement("span");
      dot.className = `pane-indicator-dot ${target[i]}`;
      if (!opts.skipAnimation) dot.classList.add("entering");
      container.appendChild(dot);
      if (!opts.skipAnimation) {
        requestAnimationFrame(() => dot.classList.remove("entering"));
      }
    }
  } else if (target.length < liveDots.length) {
    const victims = liveDots.slice(target.length);
    for (const dot of victims) {
      if (opts.skipAnimation) {
        dot.remove();
      } else {
        dot.classList.add("leaving");
        setTimeout(() => dot.remove(), DOT_EXIT_MS);
      }
    }
  }
}

// Mirror the indicator's aggregate stoplight (written by syncIndicatorDots
// via aggregateStoplight into dataset.stoplight) onto the mini avatar's
// badge. Deliberately NOT .pane-indicator-dot — several dot-count code
// paths (and tests) select on that class and must not count the badge.
function syncAvatarBadge(row: RailRow) {
  const agg = row.indicatorEl.dataset.stoplight ?? "gray";
  row.avatarBadgeEl.className = `rail-avatar-badge ${agg}`;
}

function setAvatarName(row: RailRow, name: string) {
  row.avatarLabelEl.textContent = projectInitials(name);
  // In mini mode the avatar is the whole row; the tooltip carries the
  // full project name the initials abbreviate.
  row.avatarEl.title = name;
}

export class Rail {
  private listEl: HTMLElement;
  private archiveSectionEl: HTMLElement;
  private archiveListEl: HTMLElement;
  private archiveCountEl: HTMLElement;
  private footerCountEl: HTMLElement;
  private rows = new Map<string, RailRow>();
  private orderedIds: string[] = [];
  private draggedId: string | null = null;
  // Archived state of the row currently being dragged. Reorder only happens
  // within a zone (active↔active); a cross-zone drag is an archive/unarchive
  // intent handled by the list / archive drop zones instead.
  private draggedArchived = false;
  private archivedCount = 0;
  private archiveCollapsed = true;
  private currentSelected: string | null = null;
  // Themed auto-hiding overlay scrollbars — the same reusable orange fade-bar
  // the terminal / markdown / transcript panes use — so the sidebar's projects
  // list and Archive folder scroll with the app-consistent affordance instead
  // of the OS-native gutter.
  private listScrollbar: OverlayScrollbar;
  private archiveScrollbar: OverlayScrollbar;

  constructor(private props: RailProps) {
    this.props.root.classList.add("rail");
    this.props.root.innerHTML = `
      <div class="rail-header">Projects</div>
      <div class="rail-divider"></div>
      <div class="rail-list-scroll">
        <div class="rail-list"></div>
      </div>
      <div class="rail-archive collapsed" id="rail-archive">
        <button class="rail-archive-header" id="rail-archive-header" type="button" aria-expanded="false" title="Archived projects — asleep, using no memory. Click a project to restore it.">
          <span class="rail-archive-caret" aria-hidden="true">▸</span>
          <span class="rail-archive-title">Archive</span>
          <span class="rail-archive-count" id="rail-archive-count">0</span>
        </button>
        <div class="rail-archive-scroll">
          <div class="rail-archive-list" id="rail-archive-list" hidden></div>
        </div>
      </div>
      <div class="rail-footer">
        <span id="rail-count">0 projects</span>
        <button class="rail-add" id="rail-add" title="Add project">${iconPlus}<span>Add</span></button>
        <button class="rail-collapse-chip" id="rail-collapse-chip" type="button" title="Expand rail (⇧→)" aria-label="Expand rail">»</button>
      </div>
    `;
    this.listEl = this.props.root.querySelector(".rail-list") as HTMLElement;
    this.archiveSectionEl = this.props.root.querySelector("#rail-archive") as HTMLElement;
    this.archiveListEl = this.props.root.querySelector("#rail-archive-list") as HTMLElement;
    this.archiveCountEl = this.props.root.querySelector("#rail-archive-count") as HTMLElement;
    this.footerCountEl = this.props.root.querySelector("#rail-count") as HTMLElement;
    (this.props.root.querySelector("#rail-add") as HTMLElement).addEventListener("click", () =>
      this.props.onAddProject(),
    );
    (this.props.root.querySelector("#rail-collapse-chip") as HTMLElement).addEventListener(
      "click",
      () => this.props.onExpand?.(),
    );
    // In mini mode the whole rail is a big expand target: clicking any
    // empty (non-row, non-button) area springs it open. Rows and buttons
    // keep their own handlers.
    this.props.root.addEventListener("click", (e) => {
      if (!this.props.root.classList.contains("rail-mini")) return;
      if ((e.target as HTMLElement).closest(".rail-item, button")) return;
      this.props.onExpand?.();
    });
    (this.props.root.querySelector("#rail-archive-header") as HTMLElement).addEventListener(
      "click",
      () => this.toggleArchiveCollapsed(),
    );
    // Mount the overlay onto the non-scrolling wrapper (host) and drive it from
    // the inner scroller (surface). An absolutely-positioned bar mounted INTO
    // the scroller would scroll away with the content, so the host must be the
    // wrapper — the same split TranscriptView / the file viewer use.
    this.listScrollbar = createOverlayScrollbar({
      host: this.props.root.querySelector(".rail-list-scroll") as HTMLElement,
      surface: domScrollSurface(this.listEl),
    });
    this.archiveScrollbar = createOverlayScrollbar({
      host: this.props.root.querySelector(".rail-archive-scroll") as HTMLElement,
      surface: domScrollSurface(this.archiveListEl),
    });
    this.wireArchiveDropZone();
    this.wireActiveDropZone();
  }

  setProjects(projects: Project[]) {
    const active = projects.filter((p) => !p.archived);
    const archived = projects.filter((p) => p.archived);
    const nextIds = projects.map((p) => p.id);

    // Remove rows for projects that went away entirely.
    for (const [id, row] of this.rows) {
      if (!nextIds.includes(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }

    this.renderZone(active, this.listEl);
    // Drop any stale empty-state placeholder before positioning archived
    // rows (renderZone indexes container.children), then render the rows.
    this.archiveListEl.querySelector(".rail-archive-empty")?.remove();
    this.renderZone(archived, this.archiveListEl);

    // Reorder acts on the whole set (active first, then archived) so an
    // active↔active move never drops archived projects from the persisted
    // order.
    this.orderedIds = active.map((p) => p.id).concat(archived.map((p) => p.id));

    this.archivedCount = archived.length;
    this.archiveCountEl.textContent = String(this.archivedCount);
    // The Archive section is ALWAYS visible so it's a permanent drop target.
    // When empty, a placeholder inside the (expandable) folder says so.
    if (this.archivedCount === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-archive-empty";
      empty.textContent = "Nothing in archive";
      this.archiveListEl.appendChild(empty);
    }
    this.applyArchiveCollapsed();

    const count = active.length;
    this.footerCountEl.textContent = count === 1 ? "1 project" : `${count} projects`;

    // Rows just changed the scroll extent; recompute both thumbs (no scroll or
    // resize event fires on a pure content change, so update() must be manual).
    this.listScrollbar.update();
    this.archiveScrollbar.update();
  }

  select(projectId: string | null) {
    this.currentSelected = projectId;
    for (const [id, row] of this.rows) {
      row.el.classList.toggle("selected", id === projectId);
    }
  }

  /**
   * Flip the rail between expanded rows and the 48px mini rail. Purely a
   * class toggle — the boot layer owns the width animation and drives
   * this alongside it. CSS keyed off .rail-mini swaps names/indicators
   * for initials avatars and reveals the footer chevron.
   */
  setMode(mode: RailMode) {
    this.props.root.classList.toggle("rail-mini", mode === "mini");
  }

  private renderZone(projects: Project[], container: HTMLElement) {
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      let row = this.rows.get(p.id);
      if (!row) {
        row = this.createRow(p);
        this.rows.set(p.id, row);
      }
      this.updateRow(row, p);

      // Move the row into its zone if it just switched (active↔archived).
      if (row.el.parentElement !== container) {
        container.appendChild(row.el);
      }
      const expectedChild = container.children[i];
      if (expectedChild !== row.el) {
        container.insertBefore(row.el, expectedChild ?? null);
      }
    }
  }

  private updateRow(row: RailRow, p: Project) {
    const layoutOrder = this.props.getLayoutPaneOrder?.(p.id) ?? null;
    const stoplights = resolvePaneStoplights(p, layoutOrder);
    const key = stoplights.join(",");
    if (row.lastStoplightsKey !== key) {
      syncIndicatorDots(row.indicatorEl, stoplights);
      syncAvatarBadge(row);
      row.lastStoplightsKey = key;
    }
    if (row.lastName !== p.name) {
      row.nameEl.textContent = p.name;
      setAvatarName(row, p.name);
      row.lastName = p.name;
    }
    const archived = p.archived ?? false;
    if (row.lastArchived !== archived) {
      row.el.classList.toggle("archived", archived);
      row.lastArchived = archived;
    }
    if (archived) row.el.title = "Archived — click to restore";
    else row.el.removeAttribute("title");
    row.el.classList.toggle("selected", p.id === this.currentSelected);
  }

  private toggleArchiveCollapsed() {
    this.archiveCollapsed = !this.archiveCollapsed;
    this.applyArchiveCollapsed();
  }

  private applyArchiveCollapsed() {
    this.archiveListEl.hidden = this.archiveCollapsed;
    this.archiveSectionEl.classList.toggle("collapsed", this.archiveCollapsed);
    const header = this.props.root.querySelector("#rail-archive-header") as HTMLElement | null;
    if (header) header.setAttribute("aria-expanded", String(!this.archiveCollapsed));
    // Expanding/collapsing changes whether the archive list is scrollable.
    this.archiveScrollbar.update();
  }

  // Dragging an ACTIVE row onto the Archive section archives it.
  private wireArchiveDropZone() {
    const zone = this.archiveSectionEl;
    zone.addEventListener("dragover", (e) => {
      if (!this.draggedId || this.draggedArchived) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      zone.classList.add("drop-target");
    });
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove("drop-target");
    });
    zone.addEventListener("drop", (e) => {
      zone.classList.remove("drop-target");
      if (!this.draggedId || this.draggedArchived) return;
      e.preventDefault();
      e.stopPropagation();
      this.props.onToggleArchive?.(this.draggedId, true);
    });
  }

  // Dragging an ARCHIVED row onto the active project list unarchives it.
  private wireActiveDropZone() {
    const zone = this.listEl;
    zone.addEventListener("dragover", (e) => {
      if (!this.draggedId || !this.draggedArchived) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      zone.classList.add("drop-target");
    });
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove("drop-target");
    });
    zone.addEventListener("drop", (e) => {
      zone.classList.remove("drop-target");
      if (!this.draggedId || !this.draggedArchived) return;
      e.preventDefault();
      e.stopPropagation();
      this.props.onToggleArchive?.(this.draggedId, false);
    });
  }

  private createRow(p: Project): RailRow {
    const archived = p.archived ?? false;
    const el = document.createElement("div");
    el.className = "rail-item" + (archived ? " archived" : "");
    el.setAttribute("data-project-id", p.id);
    if (archived) el.title = "Archived — click to restore";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    const indicator = document.createElement("span");
    indicator.className = "pane-indicator";
    const initialLayoutOrder = this.props.getLayoutPaneOrder?.(p.id) ?? null;
    const initialStoplights = resolvePaneStoplights(p, initialLayoutOrder);
    syncIndicatorDots(indicator, initialStoplights, { skipAnimation: true });
    const avatar = document.createElement("span");
    avatar.className = "rail-avatar";
    const avatarLabel = document.createElement("span");
    avatarLabel.className = "rail-avatar-label";
    const avatarBadge = document.createElement("span");
    avatar.appendChild(avatarLabel);
    avatar.appendChild(avatarBadge);
    el.appendChild(avatar);
    el.appendChild(name);
    el.appendChild(indicator);
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).isContentEditable) return;
      this.props.onSelect(p.id);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = this.rows.get(p.id);
      const isArchived = row?.lastArchived ?? archived;
      const rowName = row?.lastName ?? p.name;
      showRailContextMenu(e.clientX, e.clientY, {
        archived: isArchived,
        onOpen: () => this.props.onOpenInFinder?.(p.id),
        onDelete: () => this.props.onRequestDelete?.(p.id, rowName),
        onToggleArchive: () => this.props.onToggleArchive?.(p.id, !isArchived),
      });
    });
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      this.draggedId = p.id;
      this.draggedArchived = this.rows.get(p.id)?.lastArchived ?? archived;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.id);
      }
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => {
      if (!this.draggedId || this.draggedId === p.id) return;
      const targetArchived = this.rows.get(p.id)?.lastArchived ?? archived;
      // Reorder only within the active zone; cross-zone drags are
      // archive/unarchive intents handled by the drop zones.
      if (this.draggedArchived || targetArchived) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle("drop-before", before);
      el.classList.toggle("drop-after", !before);
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("drop-before", "drop-after");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const dragged = this.draggedId;
      el.classList.remove("drop-before", "drop-after");
      if (!dragged || dragged === p.id) return;
      const targetArchived = this.rows.get(p.id)?.lastArchived ?? archived;
      if (this.draggedArchived || targetArchived) return; // cross-zone → zone handler
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const newIds = computeReorder(this.orderedIds, dragged, p.id, before ? "before" : "after");
      this.props.onReorder?.(newIds);
    });
    el.addEventListener("dragend", () => {
      this.draggedId = null;
      this.draggedArchived = false;
      el.classList.remove("dragging");
      this.listEl.classList.remove("drop-target");
      this.archiveSectionEl.classList.remove("drop-target");
      for (const row of this.rows.values()) {
        row.el.classList.remove("drop-before", "drop-after");
      }
    });
    // Double-click name → rename in place
    name.addEventListener("dblclick", (e) => {
      if (!this.props.onRename) return;
      e.stopPropagation();
      this.startRename(p.id, name);
    });
    // NOTE: placement into the active/archive zone is done by renderZone.
    const row: RailRow = {
      el,
      nameEl: name,
      indicatorEl: indicator,
      avatarEl: avatar,
      avatarLabelEl: avatarLabel,
      avatarBadgeEl: avatarBadge,
      lastStoplightsKey: initialStoplights.join(","),
      lastName: p.name,
      lastArchived: archived,
    };
    setAvatarName(row, p.name);
    syncAvatarBadge(row);
    return row;
  }

  private startRename(projectId: string, nameEl: HTMLElement) {
    const original = nameEl.textContent ?? "";
    const row = this.rows.get(projectId);
    if (!row) return;

    const wasDraggable = row.el.draggable;
    row.el.draggable = false;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "name-edit";
    input.value = original;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      row.el.draggable = wasDraggable;
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      const next = input.value.trim();
      const newName = document.createElement("span");
      newName.className = "name";
      const commitName = commit && next && next !== original ? next : original;
      newName.textContent = commitName;
      newName.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.startRename(projectId, newName);
      });
      input.replaceWith(newName);
      row.nameEl = newName;
      row.lastName = commitName;
      setAvatarName(row, commitName);
      if (commit && next && next !== original) {
        this.props.onRename?.(projectId, next);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    };
    const onBlur = () => finish(true);
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }
}

function showRailContextMenu(
  x: number,
  y: number,
  handlers: {
    archived: boolean;
    onOpen: () => void;
    onDelete: () => void;
    onToggleArchive: () => void;
  },
) {
  const existing = document.querySelector(".rail-context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "rail-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const archiveLabel = handlers.archived ? "Unarchive" : "Archive";
  menu.innerHTML = `
    <button type="button" data-action="open">Open in Finder</button>
    <button type="button" data-action="archive">${archiveLabel}</button>
    <button type="button" data-action="delete" class="danger">Delete Project…</button>
  `;
  const close = () => {
    menu.remove();
    window.removeEventListener("click", onAnyClick, true);
    window.removeEventListener("keydown", onKey, true);
  };
  const onAnyClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  menu.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).dataset.action;
    if (action === "open") handlers.onOpen();
    if (action === "archive") handlers.onToggleArchive();
    if (action === "delete") handlers.onDelete();
    close();
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    window.addEventListener("click", onAnyClick, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
}
