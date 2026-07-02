// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SearchController } from "./SearchController";
import type { SearchBar, SearchBarCallbacks, SearchToggles, MatchInfo } from "./SearchBar";
import type { SearchSurfaceAdapter } from "./SearchSurfaceAdapter";

function fakeSurface(text: string) {
  const container = document.createElement("div");
  return {
    kind: "codemirror" as const,
    getContainerEl: () => container,
    getText: vi.fn(() => text),
    highlightMatches: vi.fn(),
    scrollToMatch: vi.fn(),
    clearHighlights: vi.fn(),
    dispose: vi.fn(),
  };
}

const asSurface = (s: ReturnType<typeof fakeSurface>): SearchSurfaceAdapter =>
  s as unknown as SearchSurfaceAdapter;

function fakeBar() {
  let captured: SearchBarCallbacks | null = null;
  const matchInfos: MatchInfo[] = [];
  const bar = {
    show: vi.fn(),
    hide: vi.fn(),
    isVisible: vi.fn(() => true),
    focus: vi.fn(),
    getQuery: vi.fn(() => ""),
    setQuery: vi.fn(),
    setMatchInfo: vi.fn((i: MatchInfo) => {
      matchInfos.push(i);
    }),
    setOptions: vi.fn(),
    dispose: vi.fn(),
  } satisfies SearchBar;
  const factory = (opts: {
    parent: HTMLElement;
    callbacks: SearchBarCallbacks;
    initialOptions: SearchToggles;
  }): SearchBar => {
    captured = opts.callbacks;
    return bar;
  };
  return {
    factory,
    bar,
    matchInfos,
    cb: () => captured!,
  };
}

let surface: ReturnType<typeof fakeSurface>;
let bars: ReturnType<typeof fakeBar>;
let controller: SearchController;

function makeController(text: string): void {
  surface = fakeSurface(text);
  bars = fakeBar();
  controller = new SearchController({
    barFactory: bars.factory,
    getActiveSurface: () => asSurface(surface),
    debounceMs: 0, // synchronous search in tests
  });
}

beforeEach(() => {
  makeController("foo bar foo baz foo");
});

describe("SearchController — open/close", () => {
  it("open() mounts the bar in the surface container and shows it", () => {
    controller.open();
    expect(bars.bar.show).toHaveBeenCalled();
    expect(controller.isOpen()).toBe(true);
  });

  it("close() hides the bar and clears highlights", () => {
    controller.open();
    controller.close();
    expect(bars.bar.hide).toHaveBeenCalled();
    expect(surface.clearHighlights).toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
  });

  it("open() is a no-op when no surface is focused", () => {
    const c = new SearchController({
      barFactory: bars.factory,
      getActiveSurface: () => null,
      debounceMs: 0,
    });
    c.open();
    expect(controller.isOpen()).toBe(false);
  });
});

describe("SearchController — searching", () => {
  beforeEach(() => controller.open());

  it("highlights all matches and selects the first as active", () => {
    bars.cb().onQueryChange("foo");
    expect(surface.getText).toHaveBeenCalled();
    const [ranges, activeIndex] = surface.highlightMatches.mock.calls.at(-1)!;
    expect(ranges).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ]);
    expect(activeIndex).toBe(0);
    expect(surface.scrollToMatch).toHaveBeenCalledWith({ start: 0, end: 3 });
    expect(bars.matchInfos.at(-1)).toEqual({ total: 3, current: 1 });
  });

  it("reports 'no results' for a query with no matches", () => {
    bars.cb().onQueryChange("zzz");
    expect(bars.matchInfos.at(-1)).toEqual({ total: 0, current: 0 });
    expect(surface.clearHighlights).toHaveBeenCalled();
  });

  it("surfaces a regex error without throwing", () => {
    bars.cb().onToggleOption("regex", true);
    bars.cb().onQueryChange("a(");
    const last = bars.matchInfos.at(-1)!;
    expect(typeof last.error).toBe("string");
    expect(last.total).toBe(0);
  });
});

describe("SearchController — navigation", () => {
  beforeEach(() => {
    controller.open();
    bars.cb().onQueryChange("foo"); // 3 matches, active = 0
  });

  it("next advances the active match and scrolls to it", () => {
    bars.cb().onNext();
    const [, activeIndex] = surface.highlightMatches.mock.calls.at(-1)!;
    expect(activeIndex).toBe(1);
    expect(surface.scrollToMatch).toHaveBeenLastCalledWith({ start: 8, end: 11 });
    expect(bars.matchInfos.at(-1)).toEqual({ total: 3, current: 2 });
  });

  it("next wraps from the last match back to the first", () => {
    bars.cb().onNext(); // 2
    bars.cb().onNext(); // 3
    bars.cb().onNext(); // wrap -> 1
    expect(bars.matchInfos.at(-1)).toEqual({ total: 3, current: 1 });
  });

  it("previous wraps from the first match to the last", () => {
    bars.cb().onPrevious();
    expect(bars.matchInfos.at(-1)).toEqual({ total: 3, current: 3 });
    expect(surface.scrollToMatch).toHaveBeenLastCalledWith({ start: 16, end: 19 });
  });

  it("next/previous are no-ops when there are no matches", () => {
    bars.cb().onQueryChange("zzz");
    surface.scrollToMatch.mockClear();
    bars.cb().onNext();
    bars.cb().onPrevious();
    expect(surface.scrollToMatch).not.toHaveBeenCalled();
  });
});

describe("SearchController — options re-run search", () => {
  beforeEach(() => controller.open());

  it("toggling case sensitivity re-filters matches", () => {
    makeController("Foo foo FOO");
    controller.open();
    bars.cb().onQueryChange("foo"); // case-insensitive -> 3
    expect(bars.matchInfos.at(-1)!.total).toBe(3);
    bars.cb().onToggleOption("caseSensitive", true); // -> 1
    expect(bars.matchInfos.at(-1)!.total).toBe(1);
  });
});

describe("SearchController — match-tick fractions", () => {
  it("emits a fraction per match via onMatchesChanged", () => {
    const surfaceObj = fakeSurface("foo bar foo");
    const withFraction = {
      ...surfaceObj,
      fractionForOffset: (offset: number) => offset / 100,
    };
    const fractionCalls: number[][] = [];
    const c = new SearchController({
      barFactory: bars.factory,
      getActiveSurface: () => withFraction as unknown as SearchSurfaceAdapter,
      debounceMs: 0,
      onMatchesChanged: (f) => fractionCalls.push(f),
    });
    c.open();
    bars.cb().onQueryChange("foo"); // matches at 0 and 8
    expect(fractionCalls.at(-1)).toEqual([0, 0.08]);
  });
});

describe("SearchController — dispose", () => {
  it("disposes the bar and clears highlights, idempotently", () => {
    controller.open();
    controller.dispose();
    expect(bars.bar.dispose).toHaveBeenCalled();
    expect(surface.clearHighlights).toHaveBeenCalled();
    expect(() => controller.dispose()).not.toThrow();
  });
});
