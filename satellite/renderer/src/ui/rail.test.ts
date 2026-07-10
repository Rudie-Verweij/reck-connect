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
  return { id, name, cwd: "/", stoplight, pane_count: paneCount };
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

  // Rail collapse redesign: 48px mini state with initials avatars.
  // Visibility of names/indicators/chevron is CSS-driven off .rail-mini,
  // so these tests assert the class contract + avatar content rather
  // than computed styles (jsdom doesn't load the stylesheet).
  describe("mini mode", () => {
    it("setMode toggles the rail-mini class", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      expect(root.classList.contains("rail-mini")).toBe(false);
      r.setMode("mini");
      expect(root.classList.contains("rail-mini")).toBe(true);
      r.setMode("expanded");
      expect(root.classList.contains("rail-mini")).toBe(false);
    });

    it("every row carries an initials avatar", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      r.setProjects([
        mkProject("a", "reck-connect", "gray"),
        mkProject("b", "docs", "gray"),
      ]);
      const labels = root.querySelectorAll<HTMLElement>(".rail-item .rail-avatar-label");
      expect(labels.length).toBe(2);
      expect(labels[0].textContent).toBe("rc");
      expect(labels[1].textContent).toBe("do");
    });

    it("avatar badge reflects the aggregate (max-severity) stoplight", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      const p: Project = {
        id: "a",
        name: "Alpha",
        cwd: "/",
        stoplight: "green",
        pane_count: 2,
        pane_stoplights: ["green", "red"],
      };
      r.setProjects([p]);
      const badge = root.querySelector<HTMLElement>(".rail-avatar-badge")!;
      expect(badge.classList.contains("red")).toBe(true);
      // Severity drops → badge follows.
      r.setProjects([{ ...p, pane_stoplights: ["green", "gray"] }]);
      expect(badge.classList.contains("red")).toBe(false);
      expect(badge.classList.contains("green")).toBe(true);
    });

    it("rename updates the avatar initials and tooltip", () => {
      const r = new Rail({ root, onSelect: () => {}, onAddProject: () => {} });
      r.setProjects([mkProject("a", "old name", "gray")]);
      r.setProjects([mkProject("a", "new title", "gray")]);
      const avatar = root.querySelector<HTMLElement>(".rail-avatar")!;
      expect(avatar.querySelector(".rail-avatar-label")?.textContent).toBe("nt");
      expect(avatar.title).toBe("new title");
    });

    it("footer has the expand chevron and it fires onExpand", () => {
      let expanded = 0;
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        onExpand: () => expanded++,
      });
      r.setMode("mini");
      const chip = root.querySelector<HTMLElement>(".rail-collapse-chip")!;
      expect(chip).not.toBeNull();
      expect(chip.closest(".rail-footer")).not.toBeNull();
      chip.click();
      expect(expanded).toBe(1);
    });

    it("clicking empty rail area in mini mode fires onExpand", () => {
      let expanded = 0;
      const r = new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        onExpand: () => expanded++,
      });
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      r.setMode("mini");
      (root.querySelector(".rail-list") as HTMLElement).click();
      expect(expanded).toBe(1);
      (root.querySelector(".rail-header") as HTMLElement).click();
      expect(expanded).toBe(2);
    });

    it("empty-area click does nothing while expanded", () => {
      let expanded = 0;
      new Rail({
        root,
        onSelect: () => {},
        onAddProject: () => {},
        onExpand: () => expanded++,
      });
      (root.querySelector(".rail-list") as HTMLElement).click();
      expect(expanded).toBe(0);
    });

    it("row and button clicks in mini mode do not also fire onExpand", () => {
      let expanded = 0;
      let selected = 0;
      const r = new Rail({
        root,
        onSelect: () => selected++,
        onAddProject: () => {},
        onExpand: () => expanded++,
      });
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      r.setMode("mini");
      (root.querySelector(".rail-item") as HTMLElement).click();
      expect(selected).toBe(1);
      const chip = root.querySelector<HTMLElement>(".rail-collapse-chip")!;
      chip.click();
      // Only the chevron's own handler fired — not the delegated one too.
      expect(expanded).toBe(1);
    });

    it("rows still fire onSelect in mini mode (avatar click selects)", () => {
      let got: string | null = null;
      const r = new Rail({ root, onSelect: (id) => (got = id), onAddProject: () => {} });
      r.setProjects([mkProject("a", "Alpha", "gray")]);
      r.setMode("mini");
      (root.querySelector(".rail-item .rail-avatar") as HTMLElement).click();
      expect(got).toBe("a");
    });
  });
});
