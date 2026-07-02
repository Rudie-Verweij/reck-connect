// `SearchController` — the surface-agnostic orchestrator. Consumes only
// the `SearchSurfaceAdapter` contract and a `SearchBar`, so the same logic
// drives find-in-terminal, find-in-markdown and find-in-source. Mirrors
// the TTS subsystem's `TtsController`.
//
// Responsibilities: own the query + option state, run the pure matcher
// over the active surface's flat text, push highlights / scroll / counter
// updates, and handle next/previous navigation with wrap-around.

import { findMatches, type OffsetRange } from "./matcher";
import type {
  SearchBar,
  SearchBarCallbacks,
  SearchToggles,
  MatchInfo,
} from "./SearchBar";
import type { SearchSurfaceAdapter } from "./SearchSurfaceAdapter";

export interface SearchControllerOptions {
  barFactory: (opts: {
    parent: HTMLElement;
    callbacks: SearchBarCallbacks;
    initialOptions: SearchToggles;
  }) => SearchBar;
  /** Resolves the currently-focused searchable surface, or null. */
  getActiveSurface: () => SearchSurfaceAdapter | null;
  /** Debounce for live search on input. <=0 runs synchronously (tests). */
  debounceMs?: number;
  /** Optional hook fired whenever the match set changes, with each match's
   *  fractional vertical position (0..1) for the overlay scrollbar ticks.
   *  Wired in Phase 6; harmless when omitted. */
  onMatchesChanged?: (fractions: number[]) => void;
}

const DEFAULT_DEBOUNCE_MS = 120;

export class SearchController {
  private opts: SearchControllerOptions;
  private debounceMs: number;

  private query = "";
  private options: SearchToggles = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };

  private matches: OffsetRange[] = [];
  private activeIndex = -1;
  private lastError: string | undefined;

  private currentSurface: SearchSurfaceAdapter | null = null;
  private currentBar: SearchBar | null = null;
  private currentBarContainer: HTMLElement | null = null;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private open_ = false;
  private disposed = false;

  constructor(opts: SearchControllerOptions) {
    this.opts = opts;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Cmd/Ctrl+F entry. Mounts (or re-focuses) the bar on the active
   *  surface and re-runs the current query. No-op when no surface is
   *  focused. */
  open(): void {
    const surface = this.opts.getActiveSurface();
    if (!surface) return;

    // Moving to a different surface: drop the old surface's highlights.
    if (this.currentSurface && this.currentSurface !== surface) {
      this.currentSurface.clearHighlights();
    }
    this.currentSurface = surface;

    this.ensureBar(surface);
    this.open_ = true;
    this.currentBar?.show();
    this.runSearch();
  }

  close(): void {
    this.open_ = false;
    this.currentBar?.hide();
    this.currentSurface?.clearHighlights();
  }

  isOpen(): boolean {
    return this.open_;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.currentBar?.dispose();
    this.currentBar = null;
    this.currentBarContainer = null;
    this.currentSurface?.clearHighlights();
    this.currentSurface = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  private ensureBar(surface: SearchSurfaceAdapter): void {
    const container = surface.getContainerEl();
    if (this.currentBar && this.currentBarContainer === container) return;
    this.currentBar?.dispose();
    this.currentBarContainer = container;
    this.currentBar = this.opts.barFactory({
      parent: container,
      initialOptions: { ...this.options },
      callbacks: {
        onQueryChange: (q) => this.setQuery(q),
        onNext: () => this.next(),
        onPrevious: () => this.previous(),
        onToggleOption: (key, value) => this.setOption(key, value),
        onClose: () => this.close(),
      },
    });
  }

  private setQuery(query: string): void {
    this.query = query;
    this.scheduleSearch();
  }

  private setOption(key: keyof SearchToggles, value: boolean): void {
    this.options = { ...this.options, [key]: value };
    this.runSearch(); // option changes apply immediately
  }

  private scheduleSearch(): void {
    if (this.debounceMs <= 0) {
      this.runSearch();
      return;
    }
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.runSearch();
    }, this.debounceMs);
  }

  private runSearch(): void {
    const surface = this.currentSurface;
    if (!surface) return;

    if (this.query === "") {
      this.matches = [];
      this.activeIndex = -1;
      this.lastError = undefined;
      surface.clearHighlights();
      this.publishMatches();
      this.updateCounter();
      return;
    }

    const result = findMatches(surface.getText(), this.query, this.options);
    this.lastError = result.error;
    this.matches = result.ranges;
    this.activeIndex = this.matches.length > 0 ? 0 : -1;

    if (this.matches.length === 0) {
      surface.clearHighlights();
    } else {
      surface.highlightMatches(this.matches, this.activeIndex);
      surface.scrollToMatch(this.matches[this.activeIndex]);
    }
    this.publishMatches();
    this.updateCounter();
  }

  private next(): void {
    this.step(1);
  }

  private previous(): void {
    this.step(-1);
  }

  private step(delta: number): void {
    const surface = this.currentSurface;
    if (!surface || this.matches.length === 0) return;
    const count = this.matches.length;
    this.activeIndex = (this.activeIndex + delta + count) % count;
    surface.highlightMatches(this.matches, this.activeIndex);
    surface.scrollToMatch(this.matches[this.activeIndex]);
    this.updateCounter();
  }

  private updateCounter(): void {
    const info: MatchInfo = {
      total: this.matches.length,
      current: this.activeIndex >= 0 ? this.activeIndex + 1 : 0,
    };
    if (this.lastError) info.error = this.lastError;
    this.currentBar?.setMatchInfo(info);
  }

  private publishMatches(): void {
    if (!this.opts.onMatchesChanged) return;
    const surface = this.currentSurface;
    const fractions: number[] = [];
    if (surface?.fractionForOffset) {
      for (const m of this.matches) {
        const f = surface.fractionForOffset(m.start);
        if (f !== null && f !== undefined) fractions.push(f);
      }
    }
    this.opts.onMatchesChanged(fractions);
  }
}
