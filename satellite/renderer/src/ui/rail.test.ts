// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { Rail } from "./rail";
import type { Project } from "@proto/proto";

function mkProject(
  id: string,
  name: string,
  stoplight: Project["stoplight"],
  paneCount = 0,
): Project {
  return { id, name, cwd: "/", stoplight, pane_count: paneCount, docked: false };
}

describe("Rail", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("renders a row per project", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray"), mkProject("b", "Bravo", "orange")]);
    const rows = root.querySelectorAll(".rail-item");
    expect(rows.length).toBe(2);
    expect(rows[1].querySelector(".name")?.textContent).toBe("Bravo");
    expect(rows[1].querySelector(".pane-indicator-dot")?.classList.contains("orange")).toBe(true);
  });

  it("fires onSelect when a row is clicked", () => {
    let got: string | null = null;
    const r = new Rail({ root, onSelect: (id) => (got = id), onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray")]);
    const row = root.querySelector(".rail-item") as HTMLElement;
    row.click();
    expect(got).toBe("a");
  });

  it("highlights the selected row", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray"), mkProject("b", "Bravo", "orange")]);
    r.select("b");
    const rows = root.querySelectorAll(".rail-item");
    expect(rows[0].classList.contains("selected")).toBe(false);
    expect(rows[1].classList.contains("selected")).toBe(true);
  });

  it("re-renders when projects update", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray")]);
    r.setProjects([mkProject("a", "Alpha", "orange")]);
    const dot = root.querySelector(".rail-item .pane-indicator-dot");
    expect(dot?.classList.contains("orange")).toBe(true);
    expect(dot?.classList.contains("gray")).toBe(false);
  });

  it("renders pane_count dots, clamped to 1..6", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([
      mkProject("a", "Alpha", "green", 0),
      mkProject("b", "Bravo", "green", 3),
      mkProject("c", "Charlie", "green", 20),
    ]);
    const rows = root.querySelectorAll(".rail-item");
    expect(rows[0].querySelectorAll(".pane-indicator-dot").length).toBe(1);
    expect(rows[1].querySelectorAll(".pane-indicator-dot").length).toBe(3);
    expect(rows[2].querySelectorAll(".pane-indicator-dot").length).toBe(6);
  });

  it("grows and shrinks the cluster when pane_count changes", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "green", 2)]);
    expect(root.querySelectorAll(".pane-indicator-dot:not(.leaving)").length).toBe(2);
    r.setProjects([mkProject("a", "Alpha", "green", 5)]);
    expect(root.querySelectorAll(".pane-indicator-dot:not(.leaving)").length).toBe(5);
    r.setProjects([mkProject("a", "Alpha", "green", 1)]);
    expect(root.querySelectorAll(".pane-indicator-dot:not(.leaving)").length).toBe(1);
  });

  it("recolors all dots in a cluster on stoplight change", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "green", 3)]);
    r.setProjects([mkProject("a", "Alpha", "red", 3)]);
    const live = root.querySelectorAll(".pane-indicator-dot:not(.leaving)");
    expect(live.length).toBe(3);
    for (const d of live) {
      expect(d.classList.contains("red")).toBe(true);
      expect(d.classList.contains("green")).toBe(false);
    }
  });

  it("marks rail items as draggable", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray"), mkProject("b", "Bravo", "gray")]);
    const rows = root.querySelectorAll<HTMLElement>(".rail-item");
    expect(rows[0].draggable).toBe(true);
    expect(rows[1].draggable).toBe(true);
  });

  it("contextmenu on a rail item opens the context menu", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray")]);
    const row = root.querySelector<HTMLElement>(".rail-item")!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    const menu = document.querySelector(".rail-context-menu");
    expect(menu).not.toBeNull();
    menu?.remove();
  });

  it("adds .docked class on the rail item when project is docked", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    const docked = { ...mkProject("a", "Alpha", "gray"), docked: true };
    r.setProjects([docked, mkProject("b", "Bravo", "gray")]);
    const rows = root.querySelectorAll<HTMLElement>(".rail-item");
    expect(rows[0].classList.contains("docked")).toBe(true);
    expect(rows[1].classList.contains("docked")).toBe(false);
  });

  it("toggles .docked when a project's docked flag changes", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setProjects([mkProject("a", "Alpha", "gray")]);
    r.setProjects([{ ...mkProject("a", "Alpha", "gray"), docked: true }]);
    const row = root.querySelector<HTMLElement>(".rail-item")!;
    expect(row.classList.contains("docked")).toBe(true);
    r.setProjects([{ ...mkProject("a", "Alpha", "gray"), docked: false }]);
    expect(row.classList.contains("docked")).toBe(false);
  });

  it("context menu dock toggle uses the latest docked state after setProjects updates", () => {
    let toggled: { id: string; docked: boolean } | null = null;
    const r = new Rail({
      root,
      onSelect: () => {},
      onAddProject: () => {},
      onToggleDock: (id, docked) => {
        toggled = { id, docked };
      },
    });
    r.setProjects([mkProject("a", "Alpha", "gray")]);
    r.setProjects([{ ...mkProject("a", "Alpha", "gray"), docked: true }]);

    const row = root.querySelector<HTMLElement>(".rail-item")!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    const dockButton = document.querySelector<HTMLButtonElement>(
      '.rail-context-menu button[data-action="dock"]',
    )!;
    expect(dockButton.textContent).toBe("Undock from Mission Control");
    dockButton.click();

    expect(toggled).toEqual({ id: "a", docked: false });
    document.querySelector(".rail-context-menu")?.remove();
  });

  it("updates the MC rail light via setMissionControlLight", () => {
    const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
    r.setMissionControlLight("orange");
    const dot = root.querySelector<HTMLElement>("#rail-mc-dot")!;
    expect(dot.classList.contains("orange")).toBe(true);
    expect(dot.classList.contains("green")).toBe(false);
    r.setMissionControlLight("green");
    expect(dot.classList.contains("green")).toBe(true);
    expect(dot.classList.contains("orange")).toBe(false);
  });

  // an earlier release: per-pane dot colors.
  describe("pane_stoplights ", () => {
    it("colours each dot independently when pane_stoplights is supplied", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "orange",
        pane_count: 2,
        pane_stoplights: ["orange", "green"],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(2);
      expect(dots[0].classList.contains("orange")).toBe(true);
      expect(dots[1].classList.contains("green")).toBe(true);
    });

    it("recolours existing dots in place without replaying the enter animation", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      const before: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "green",
        pane_count: 2,
        pane_stoplights: ["green", "green"],
        docked: false,
      };
      r.setProjects([before]);
      const firstDot = root.querySelector<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      )!;
      const originalRef = firstDot;

      const after: Project = { ...before, pane_stoplights: ["orange", "green"] };
      r.setProjects([after]);

      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      // Same DOM node kept — colour swapped in place.
      expect(dots[0]).toBe(originalRef);
      expect(dots[0].classList.contains("orange")).toBe(true);
      expect(dots[0].classList.contains("entering")).toBe(false);
    });

    it("falls back to broadcasting aggregate across pane_count dots when pane_stoplights is absent (Older daemon)", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      // No pane_stoplights — simulates an older daemon.
      r.setProjects([mkProject("a", "Alpha", "orange", 3)]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(3);
      for (const d of dots) {
        expect(d.classList.contains("orange")).toBe(true);
      }
    });

    it("zero panes with an empty pane_stoplights renders one gray placeholder dot", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "gray",
        pane_count: 0,
        pane_stoplights: [],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(1);
      expect(dots[0].classList.contains("gray")).toBe(true);
    });

    it("clamps pane_stoplights to MAX_INDICATOR_DOTS (6)", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "green",
        pane_count: 10,
        pane_stoplights: [
          "green",
          "orange",
          "green",
          "red",
          "green",
          "green",
          "orange",
          "orange",
          "red",
          "red",
        ],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(6);
      // First 6 colours preserved; 7..10 dropped.
      expect(dots[3].classList.contains("red")).toBe(true);
      expect(dots[5].classList.contains("green")).toBe(true);
    });
  });

  // an earlier release: rail dots ordered by saved-layout position rather than
  // daemon creation order. Reorder is opt-in via `getLayoutPaneOrder`;
  // when the prop is omitted (or returns null) the rail behaves
  // identically to the Older path.
  describe("layout-order reorder ", () => {
    it("reorders dots by layout order when both pane_ids and getLayoutPaneOrder are present", () => {
      // Daemon creation order: P1, P2, P3 → ["red", "green", "orange"].
      // Saved layout (left-to-right): P3, P1, P2 → ["orange", "red", "green"].
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        getLayoutPaneOrder: (id) => (id === "a" ? ["P3", "P1", "P2"] : null),
      });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "red",
        pane_count: 3,
        pane_stoplights: ["red", "green", "orange"],
        pane_ids: ["P1", "P2", "P3"],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(3);
      expect(dots[0].classList.contains("orange")).toBe(true);
      expect(dots[1].classList.contains("red")).toBe(true);
      expect(dots[2].classList.contains("green")).toBe(true);
    });

    it("falls back to creation order when getLayoutPaneOrder returns null", () => {
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        getLayoutPaneOrder: () => null,
      });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "red",
        pane_count: 2,
        pane_stoplights: ["red", "green"],
        pane_ids: ["P1", "P2"],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots[0].classList.contains("red")).toBe(true);
      expect(dots[1].classList.contains("green")).toBe(true);
    });

    it("falls back to creation order when daemon omits pane_ids (Older daemon)", () => {
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        // Layout exists but the daemon doesn't tell us which pane is which —
        // we can't safely reorder, so we don't.
        getLayoutPaneOrder: () => ["X", "Y"],
      });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "red",
        pane_count: 2,
        pane_stoplights: ["red", "green"],
        // pane_ids absent.
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots[0].classList.contains("red")).toBe(true);
      expect(dots[1].classList.contains("green")).toBe(true);
    });

    it("appends daemon panes that the layout doesn't know about (newly spawned)", () => {
      // Daemon: P1, P2, P3 — layout only knows P1, P3 (P2 spawned after
      // last layout repaint). The unknown P2 must still get a dot, on
      // the end, so the indicator count stays honest.
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        getLayoutPaneOrder: () => ["P3", "P1"],
      });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "red",
        pane_count: 3,
        pane_stoplights: ["green", "orange", "red"],
        pane_ids: ["P1", "P2", "P3"],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(3);
      // Layout-known panes first (P3 then P1), then the newcomer P2 last.
      expect(dots[0].classList.contains("red")).toBe(true);
      expect(dots[1].classList.contains("green")).toBe(true);
      expect(dots[2].classList.contains("orange")).toBe(true);
    });

    it("drops layout entries the daemon no longer knows about (closed pane)", () => {
      // Layout still references P_GONE; daemon's pane_ids reflects the
      // current set. The stale layout entry should not contribute a dot.
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        getLayoutPaneOrder: () => ["P_GONE", "P1", "P2"],
      });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "green",
        pane_count: 2,
        pane_stoplights: ["green", "orange"],
        pane_ids: ["P1", "P2"],
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      expect(dots.length).toBe(2);
      expect(dots[0].classList.contains("green")).toBe(true);
      expect(dots[1].classList.contains("orange")).toBe(true);
    });

    it("falls back when pane_ids and pane_stoplights have mismatched lengths (defensive)", () => {
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        getLayoutPaneOrder: () => ["P2", "P1"],
      });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "green",
        pane_count: 2,
        pane_stoplights: ["green", "orange"],
        pane_ids: ["P1"], // length mismatch
        docked: false,
      };
      r.setProjects([p]);
      const dots = root.querySelectorAll<HTMLElement>(
        ".pane-indicator-dot:not(.leaving)",
      );
      // No reorder — render in creation order.
      expect(dots[0].classList.contains("green")).toBe(true);
      expect(dots[1].classList.contains("orange")).toBe(true);
    });
  });

  describe("archive section", () => {
    it("renders archived projects in the archive list, not the active list", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      r.setProjects([
        mkProject("a", "Alpha", "gray"),
        { ...mkProject("b", "Bravo", "gray"), archived: true },
      ]);
      const activeRows = root.querySelectorAll(".rail-list > .rail-item");
      const archivedRows = root.querySelectorAll(".rail-archive-list > .rail-item");
      expect(activeRows.length).toBe(1);
      expect(activeRows[0].querySelector(".name")?.textContent).toBe("Alpha");
      expect(archivedRows.length).toBe(1);
      expect(archivedRows[0].querySelector(".name")?.textContent).toBe("Bravo");
      expect(archivedRows[0].classList.contains("archived")).toBe(true);
    });

    it("always shows the archive section, with an empty-state when there are none", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      const section = root.querySelector<HTMLElement>("#rail-archive")!;
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      // Visible even with zero archived, showing a placeholder + count 0.
      expect(section.hidden).toBe(false);
      expect(root.querySelector("#rail-archive-count")?.textContent).toBe("0");
      expect(root.querySelector(".rail-archive-empty")?.textContent).toBe("Nothing in archive");
      // With an archived project, the placeholder is gone and the row shows.
      r.setProjects([
        mkProject("a", "Alpha", "gray"),
        { ...mkProject("b", "Bravo", "gray"), archived: true },
      ]);
      expect(section.hidden).toBe(false);
      expect(root.querySelector("#rail-archive-count")?.textContent).toBe("1");
      expect(root.querySelector(".rail-archive-empty")).toBeNull();
      expect(root.querySelectorAll(".rail-archive-list > .rail-item").length).toBe(1);
    });

    it("moves a row between zones when its archived flag flips", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      expect(root.querySelectorAll(".rail-list > .rail-item").length).toBe(1);
      r.setProjects([{ ...mkProject("a", "Alpha", "gray"), archived: true }]);
      expect(root.querySelectorAll(".rail-list > .rail-item").length).toBe(0);
      expect(root.querySelectorAll(".rail-archive-list > .rail-item").length).toBe(1);
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      expect(root.querySelectorAll(".rail-list > .rail-item").length).toBe(1);
      expect(root.querySelectorAll(".rail-archive-list > .rail-item").length).toBe(0);
    });

    it("context menu shows Archive for an active project and calls onToggleArchive(true)", () => {
      let toggled: { id: string; archived: boolean } | null = null;
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        onToggleArchive: (id, archived) => {
          toggled = { id, archived };
        },
      });
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      const row = root.querySelector<HTMLElement>(".rail-item")!;
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
      const btn = document.querySelector<HTMLButtonElement>(
        '.rail-context-menu button[data-action="archive"]',
      )!;
      expect(btn.textContent).toBe("Archive");
      btn.click();
      expect(toggled).toEqual({ id: "a", archived: true });
      document.querySelector(".rail-context-menu")?.remove();
    });

    it("context menu shows Unarchive for an archived project and calls onToggleArchive(false)", () => {
      let toggled: { id: string; archived: boolean } | null = null;
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        onToggleArchive: (id, archived) => {
          toggled = { id, archived };
        },
      });
      r.setProjects([{ ...mkProject("a", "Alpha", "gray"), archived: true }]);
      const row = root.querySelector<HTMLElement>(".rail-archive-list .rail-item")!;
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
      const btn = document.querySelector<HTMLButtonElement>(
        '.rail-context-menu button[data-action="archive"]',
      )!;
      expect(btn.textContent).toBe("Unarchive");
      btn.click();
      expect(toggled).toEqual({ id: "a", archived: false });
      document.querySelector(".rail-context-menu")?.remove();
    });

    it("toggles the archive list open/closed via the header", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      r.setProjects([{ ...mkProject("a", "Alpha", "gray"), archived: true }]);
      const list = root.querySelector<HTMLElement>("#rail-archive-list")!;
      const header = root.querySelector<HTMLElement>("#rail-archive-header")!;
      expect(list.hidden).toBe(true); // collapsed by default
      header.click();
      expect(list.hidden).toBe(false);
      header.click();
      expect(list.hidden).toBe(true);
    });
  });
});
