// Minimal inline SVG icons. 16x16 viewBox, strokes use currentColor.
// Kept as strings so they're trivial to inline into tab bars / nav.

const base = (inner: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const iconSplitRight = base(
  `<rect x="1.5" y="2.5" width="5" height="11" rx="1"/><rect x="9.5" y="2.5" width="5" height="11" rx="1"/>`,
);

export const iconSplitDown = base(
  `<rect x="2.5" y="1.5" width="11" height="5" rx="1"/><rect x="2.5" y="9.5" width="11" height="5" rx="1"/>`,
);

export const iconPlus = base(
  `<line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/>`,
);

export const iconClose = base(
  `<line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>`,
);

export const iconRail = base(
  `<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><line x1="5.5" y1="2.5" x2="5.5" y2="13.5"/>`,
);

export const iconMic = base(
  `<rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0"/><line x1="8" y1="12" x2="8" y2="14.5"/><line x1="5.5" y1="14.5" x2="10.5" y2="14.5"/>`,
);

export const iconClear = base(
  `<path d="M3 5h10M5 5V3.5a1 1 0 011-1h4a1 1 0 011 1V5M4.5 5l.7 8a1 1 0 001 .9h3.6a1 1 0 001-.9l.7-8"/>`,
);

export const iconLightbulb = base(
  `<path d="M8 2a4 4 0 00-2.6 7.05c.35.3.6.73.6 1.2V11h4v-.75c0-.47.25-.9.6-1.2A4 4 0 008 2z"/><line x1="6.5" y1="13" x2="9.5" y2="13"/><line x1="7" y1="14.5" x2="9" y2="14.5"/>`,
);

export const iconMoon = base(
  `<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 107 6.5z"/>`,
);

export const iconRefresh = base(
  `<path d="M13.5 3.5v3.5h-3.5"/><path d="M2.5 12.5v-3.5h3.5"/><path d="M13 7a5.5 5.5 0 00-9.8-1.8M3 9a5.5 5.5 0 009.8 1.8"/>`,
);

// Pop-out / external-link glyph for the per-pane "Detach" action
// . Rectangle with an arrow leaving from the top-right.
export const iconDetach = base(
  `<path d="M9 3h4v4"/><path d="M13 3l-6 6"/><path d="M11 9.5V13a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1h3.5"/>`,
);

// Clock glyph for the per-pane "History" action (#51) — opens the
// Claude transcript overlay.
export const iconHistory = base(
  `<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2.2 1.6"/>`,
);

