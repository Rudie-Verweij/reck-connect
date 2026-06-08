import type { Project, Stoplight } from "@proto/proto";
import { stoplightSeverity } from "@proto/proto";
import { iconPlus } from "./icons";
import { computeReorder } from "./reorder";

export interface RailProps {
  root: HTMLElement;
  onSelect: (projectId: string) => void;
  onAddProject: () => void;
  onSelectMissionControl?: () => void;
  onRename?: (projectId: string, newName: string) => void;
  onReorder?: (newIds: string[]) => void;
  onRequestDelete?: (projectId: string, projectName: string) => void;
  onOpenInFinder?: (projectId: string) => void;
  onToggleDock?: (projectId: string, docked: boolean) => void;
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
  // Cached serialisation of the last rendered per-pane stoplight list.
  // Join-comparable so setProjects can skip DOM churn when the list is
  // unchanged. an earlier release: replaces the old `lastStoplight` / `lastPaneCount`
  // pair — per-pane color makes a single aggregate insufficient.
  lastStoplightsKey: string;
  lastName: string;
  lastDocked: boolean;
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

export class Rail {
  private listEl: HTMLElement;
  private footerCountEl: HTMLElement;
  private rows = new Map<string, RailRow>();
  private orderedIds: string[] = [];
  private draggedId: string | null = null;
  private currentSelected: string | null = null;

  constructor(private props: RailProps) {
    this.props.root.classList.add("rail");
    this.props.root.innerHTML = `
      <div class="rail-mission-control" id="rail-mc" title="Mission Control — dashboard + supervisor across docked projects">
        <span class="name">Mission Control</span>
        <span class="dot gray" id="rail-mc-dot" aria-label="Docked-project health"></span>
      </div>
      <div class="rail-header">Projects</div>
      <div class="rail-divider"></div>
      <div class="rail-list"></div>
      <div class="rail-footer">
        <span id="rail-count">0 projects</span>
        <button class="rail-add" id="rail-add" title="Add project">${iconPlus}<span>Add</span></button>
      </div>
    `;
    this.listEl = this.props.root.querySelector(".rail-list") as HTMLElement;
    this.footerCountEl = this.props.root.querySelector("#rail-count") as HTMLElement;
    (this.props.root.querySelector("#rail-add") as HTMLElement).addEventListener("click", () =>
      this.props.onAddProject(),
    );
    const mcEl = this.props.root.querySelector("#rail-mc") as HTMLElement;
    mcEl.addEventListener("click", () => this.props.onSelectMissionControl?.());
  }

  setMissionControlSelected(selected: boolean) {
    const mcEl = this.props.root.querySelector("#rail-mc") as HTMLElement | null;
    if (mcEl) mcEl.classList.toggle("selected", selected);
  }

  setMissionControlLight(stoplight: Stoplight) {
    const dot = this.props.root.querySelector("#rail-mc-dot") as HTMLElement | null;
    if (!dot) return;
    dot.className = `dot ${stoplight}`;
  }

  setProjects(projects: Project[]) {
    const nextIds = projects.map((p) => p.id);

    // Remove rows for projects that went away
    for (const [id, row] of this.rows) {
      if (!nextIds.includes(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }

    // Ensure rows exist in the correct order; create missing, reorder if needed
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      let row = this.rows.get(p.id);
      if (!row) {
        row = this.createRow(p);
        this.rows.set(p.id, row);
      }

      // Update changed fields in place (no DOM destruction).
      // Per-pane stoplights collapse the old (aggregate-color, pane-count)
      // pair into a single join-comparable key — a flip from
      // [green, orange] → [green, green] is a colour change, not a count
      // change, but both are handled by the same diff now.
      const layoutOrder = this.props.getLayoutPaneOrder?.(p.id) ?? null;
      const stoplights = resolvePaneStoplights(p, layoutOrder);
      const key = stoplights.join(",");
      if (row.lastStoplightsKey !== key) {
        syncIndicatorDots(row.indicatorEl, stoplights);
        row.lastStoplightsKey = key;
      }
      if (row.lastName !== p.name) {
        row.nameEl.textContent = p.name;
        row.lastName = p.name;
      }
      if (row.lastDocked !== p.docked) {
        row.el.classList.toggle("docked", p.docked);
        if (p.docked) row.el.title = "Docked in Mission Control";
        else row.el.removeAttribute("title");
        row.lastDocked = p.docked;
      }
      row.el.classList.toggle("selected", p.id === this.currentSelected);

      // Ensure position in the list matches the target index
      const expectedChild = this.listEl.children[i];
      if (expectedChild !== row.el) {
        this.listEl.insertBefore(row.el, expectedChild ?? null);
      }
    }

    this.orderedIds = nextIds;

    const count = projects.length;
    this.footerCountEl.textContent = count === 1 ? "1 project" : `${count} projects`;
  }

  select(projectId: string | null) {
    this.currentSelected = projectId;
    for (const [id, row] of this.rows) {
      row.el.classList.toggle("selected", id === projectId);
    }
  }

  private createRow(p: Project): RailRow {
    const el = document.createElement("div");
    el.className = "rail-item" + (p.docked ? " docked" : "");
    el.setAttribute("data-project-id", p.id);
    if (p.docked) el.title = "Docked in Mission Control";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    const indicator = document.createElement("span");
    indicator.className = "pane-indicator";
    const initialLayoutOrder = this.props.getLayoutPaneOrder?.(p.id) ?? null;
    const initialStoplights = resolvePaneStoplights(p, initialLayoutOrder);
    syncIndicatorDots(indicator, initialStoplights, { skipAnimation: true });
    el.appendChild(name);
    el.appendChild(indicator);
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).isContentEditable) return;
      this.props.onSelect(p.id);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = this.rows.get(p.id);
      const docked = row?.lastDocked ?? p.docked;
      const name = row?.lastName ?? p.name;
      showRailContextMenu(e.clientX, e.clientY, {
        docked,
        onOpen: () => this.props.onOpenInFinder?.(p.id),
        onDelete: () => this.props.onRequestDelete?.(p.id, name),
        onToggleDock: () => this.props.onToggleDock?.(p.id, !docked),
      });
    });
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      this.draggedId = p.id;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.id);
      }
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => {
      if (!this.draggedId || this.draggedId === p.id) return;
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
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const newIds = computeReorder(this.orderedIds, dragged, p.id, before ? "before" : "after");
      this.props.onReorder?.(newIds);
    });
    el.addEventListener("dragend", () => {
      this.draggedId = null;
      el.classList.remove("dragging");
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
    this.listEl.appendChild(el);
    return {
      el,
      nameEl: name,
      indicatorEl: indicator,
      lastStoplightsKey: initialStoplights.join(","),
      lastName: p.name,
      lastDocked: p.docked,
    };
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
    docked: boolean;
    onOpen: () => void;
    onDelete: () => void;
    onToggleDock: () => void;
  },
) {
  const existing = document.querySelector(".rail-context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "rail-context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const dockLabel = handlers.docked
    ? "Undock from Mission Control"
    : "Dock in Mission Control";
  menu.innerHTML = `
    <button type="button" data-action="open">Open in Finder</button>
    <button type="button" data-action="dock">${dockLabel}</button>
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
    if (action === "dock") handlers.onToggleDock();
    if (action === "delete") handlers.onDelete();
    close();
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    window.addEventListener("click", onAnyClick, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
}
