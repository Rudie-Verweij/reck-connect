// satellite/renderer/src/viewer/externalRefs.ts
//
// Email-client-style "load external data" gate for the static-HTML viewer.
// DOMPurify strips scripts but KEEPS <img>, <style>, media elements, so remote
// sub-resources (tracker pixels, remote CSS) would fetch the moment the
// sanitized markup lands in the DOM. These pure helpers neutralize every
// external-loading reference in a detached/mounted subtree — moving the live
// value into a parked `data-reck-blocked-<key>` attribute — so nothing fetches
// until the user explicitly consents, at which point `restoreExternalRefs`
// puts every value back exactly.
//
// An "external URL" is a trimmed value that starts with `http://`, `https://`,
// or `//` (protocol-relative). `data:` and relative (`./a.png`) URLs are left
// untouched — they never reach out to a third-party host.
//
// A SHARED vector table drives neutralize AND restore so the two can never
// drift out of sync: whatever we park, we know precisely how to un-park.

const PARK_PREFIX = "data-reck-blocked-";
const STYLE_PARK_ATTR = `${PARK_PREFIX}style`;
const STYLE_TEXT_PARK_ATTR = `${PARK_PREFIX}styletext`;

/**
 * How a given (element, attribute) pair carries a URL. `"url"` values are a
 * single URL; `"srcset"` values are a comma-separated candidate list;
 * `"cssurl"` values are a CSS-fragment whose external-ness is decided by an
 * embedded `url(...)` (e.g. an SVG paint attribute `fill="url(https://…#g)"`).
 */
type RefKind = "url" | "srcset" | "cssurl";

interface RefVector {
  /** CSS selector for candidate elements. When `localName` is also set this is
   *  a BROAD selector (`"*"`) and the real match is the `localName` filter — a
   *  camelCase/namespaced SVG type selector (`feImage`) is unreliable across
   *  DOM engines, so we never lean on it. */
  readonly selector: string;
  /** When set, only elements whose `.localName` equals this are considered.
   *  Robustly matches SVG elements (`image`, `feImage`) regardless of how a
   *  given engine handles camelCase/namespaced type selectors. */
  readonly localName?: string;
  /** Literal attribute name (qualified names like `xlink:href` allowed). */
  readonly attr: string;
  /** Suffix for the parked `data-reck-blocked-<parkKey>` attribute. Must be a
   *  valid `data-*` name fragment (no colon), so `xlink:href` parks as
   *  `xlinkhref`. */
  readonly parkKey: string;
  readonly kind: RefKind;
}

/**
 * SVG PRESENTATION attributes whose value is a CSS paint/resource reference
 * that may point at an EXTERNAL document via `url(https://…#id)` / `url(//…)`.
 * DOMPurify keeps these attributes, and the `style`-attribute neutralizer never
 * inspects them, so an external `url()` here would be un-parked. These are
 * same-document-only on Blink (inert on the Electron runtime) but leak on
 * Gecko, so we close them for defense-in-depth. Local `url(#id)` fragment refs
 * stay live — `"cssurl"` externality is decided by the embedded `url(...)`.
 * Each attr name doubles as its park key; all are valid `data-*` fragments
 * (hyphens allowed, no colon).
 */
const SVG_PRESENTATION_URL_ATTRS: readonly string[] = [
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
];

const SVG_PRESENTATION_VECTORS: readonly RefVector[] =
  SVG_PRESENTATION_URL_ATTRS.map((attr) => ({
    selector: `[${attr}]`,
    attr,
    parkKey: attr,
    kind: "cssurl" as const,
  }));

/**
 * Every external-loading attribute vector we neutralize. Reused verbatim by
 * `restoreExternalRefs` so a vector added here is automatically reversed.
 */
const REF_VECTORS: readonly RefVector[] = [
  { selector: "img", attr: "src", parkKey: "src", kind: "url" },
  { selector: "img", attr: "srcset", parkKey: "srcset", kind: "srcset" },
  { selector: "source", attr: "src", parkKey: "src", kind: "url" },
  { selector: "source", attr: "srcset", parkKey: "srcset", kind: "srcset" },
  { selector: "video", attr: "src", parkKey: "src", kind: "url" },
  { selector: "video", attr: "poster", parkKey: "poster", kind: "url" },
  { selector: "audio", attr: "src", parkKey: "src", kind: "url" },
  { selector: "track", attr: "src", parkKey: "src", kind: "url" },
  // <input type="image" src="…"> loads its image eagerly, exactly like <img>.
  // DOMPurify keeps <input src>, so an external src here is a live beacon.
  { selector: "input", attr: "src", parkKey: "src", kind: "url" },
  // A legacy `background` attribute on ANY element (e.g. <body|table|td
  // background="https://…">) is a live background-image fetch that survives
  // DOMPurify's default allowlist. Selector matches only elements that carry
  // one; `isExternalUrl` keeps it external-only.
  {
    selector: "[background]",
    attr: "background",
    parkKey: "background",
    kind: "url",
  },
  // SVG <image> loads a remote raster via the modern `href` or the legacy
  // `xlink:href`. Matched by localName (robust across engines), then handled
  // by literal-name get/set/remove.
  { selector: "*", localName: "image", attr: "href", parkKey: "href", kind: "url" },
  {
    selector: "*",
    localName: "image",
    attr: "xlink:href",
    parkKey: "xlinkhref",
    kind: "url",
  },
  // SVG <feImage> fetches its href/xlink:href when a <filter> is applied —
  // same shape as <image>, same localName-robust matching. `feImage` is
  // camelCase so a type selector cannot be trusted; the localName filter can.
  {
    selector: "*",
    localName: "feImage",
    attr: "href",
    parkKey: "href",
    kind: "url",
  },
  {
    selector: "*",
    localName: "feImage",
    attr: "xlink:href",
    parkKey: "xlinkhref",
    kind: "url",
  },
  // SVG paint/resource PRESENTATION attributes (fill/stroke/filter/mask/
  // clip-path/marker[-start|-mid|-end]) carrying an external `url(https://…)`.
  // `"cssurl"` kind → externality decided by the embedded `url(...)`, so
  // `url(#localRef)` stays live.
  ...SVG_PRESENTATION_VECTORS,
];

// ── CSS normalization for detection ───────────────────────────────────────
// The browser resolves a CSS URL only AFTER stripping `/* … */` comments and
// decoding backslash escapes (`\68`→`h`, `\2f`→`/`). Matching raw bytes lets an
// attacker hide an external scheme (`url(\68ttps://…)`, `url(/*x*/'https://…')`)
// past a literal check while Blink/Gecko still fetch it. `normalizeCssForMatch`
// produces a DETECTION-ONLY copy that mirrors that resolution so the existing
// external checks see the real scheme. It is NEVER parked/restored — parking
// always uses the ORIGINAL bytes, so restore reproduces the input exactly.

// Strip CSS comments (slash-star … star-slash), including an unterminated
// trailing "slash-star" which CSS treats as running to end-of-input. This is
// detection-only, so treating a comment-like sequence inside a string as a
// comment is acceptable — we never write this copy back.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\*[\s\S]*$/, "");
}

/** Map a CSS hex-escape code point to a string, following the CSS rule that
 *  null, out-of-range, and surrogate code points become U+FFFD. */
function codePointToString(codePoint: number): string {
  if (
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
}

const CSS_HEX_ESCAPE = /^[0-9a-fA-F]{1,6}/;
const CSS_WHITESPACE = /\s/;

/** Decode CSS backslash escapes: `\` + 1–6 hex digits (plus an optional single
 *  trailing whitespace, consumed as the delimiter) → the code point; `\` + any
 *  non-hex char → that literal char. A trailing lone `\` is kept literal. */
function decodeCssEscapes(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const hex = CSS_HEX_ESCAPE.exec(css.slice(i + 1));
    if (hex !== null) {
      out += codePointToString(Number.parseInt(hex[0], 16));
      i += hex[0].length; // advance onto the last hex digit
      const delimiter = css[i + 1];
      if (delimiter !== undefined && CSS_WHITESPACE.test(delimiter)) {
        i += 1; // consume the single trailing whitespace delimiter
      }
      continue;
    }
    const next = css[i + 1];
    if (next === undefined) {
      out += "\\"; // trailing backslash with nothing to escape
      continue;
    }
    out += next; // `\` + non-hex → the literal char
    i += 1;
  }
  return out;
}

/**
 * Produce a DETECTION-ONLY normalization of `css`: comments stripped first,
 * then escapes decoded (matching the browser's resolve order). Callers run the
 * external checks against this copy but PARK the original bytes.
 */
function normalizeCssForMatch(css: string): string {
  return decodeCssEscapes(stripCssComments(css));
}

/** External = trimmed value starts with http://, https://, or // (protocol-
 *  relative). `data:` and relative URLs are intentionally NOT external. */
function isExternalUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    v.startsWith("http://") || v.startsWith("https://") || v.startsWith("//")
  );
}

/** A `srcset` is external if ANY of its comma-separated candidates' URL part
 *  (the token before the optional descriptor) is external. */
function srcsetHasExternal(value: string): boolean {
  return value
    .split(",")
    .some((candidate) => isExternalUrl(candidate.trim().split(/\s+/)[0] ?? ""));
}

// CSS `url(...)` pointing at an external host, e.g. `background:url(https://…)`.
const STYLE_URL_EXTERNAL = /url\(\s*['"]?(?:https?:|\/\/)/i;
// `@import` of an external stylesheet, e.g. `@import "https://…"` or
// `@import url(https://…)`.
const STYLE_IMPORT_EXTERNAL = /@import\s+(?:url\(\s*)?['"]?(?:https?:|\/\/)/i;
// CSS `image-set()` BARE-STRING form as a FAST-PATH / malformed-input fallback,
// e.g. `image-set('https://…' 1x)` — no `url(` token, so `STYLE_URL_EXTERNAL`
// misses it. Only catches the FIRST candidate; a non-first bare-string external
// (`image-set(url(./a) 1x, 'https://…' 2x)`) is caught by the positional
// `imageSetHasExternalRef` scanner below, which this regex backstops when the
// parens are unbalanced.
const STYLE_IMAGE_SET_EXTERNAL = /image-set\(\s*['"]?(?:https?:|\/\/)/i;

// Head of an `image-set(` / `-webkit-image-set(` function. Global so
// `imageSetHasExternalRef` can walk every occurrence in the CSS text.
const IMAGE_SET_HEAD = /(?:-webkit-)?image-set\(/gi;

// A single- or double-quoted CSS string; the delimiter is captured in group 1
// and matched again at the end, with `\\.` allowing escaped chars inside. The
// string CONTENT is captured in group 2 — used to scan image-set() bare-string
// candidates for an external URL.
const QUOTED_STRING = /(['"])((?:\\.|(?!\1).)*)\1/g;

/**
 * From `css` and the index of an opening `(`, return the substring strictly
 * INSIDE the matching `)`, correctly skipping parens that live inside quoted
 * strings and nested `url(...)` groups. Returns `null` when unbalanced.
 */
function extractBalancedGroup(css: string, openIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < css.length; i += 1) {
    const ch = css[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1; // skip the escaped character
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * True when an `image-set(...)` argument list contains an external candidate in
 * ANY position — either an external `url(...)` OR a BARE quoted string that is
 * an external URL. Bare quoted strings are treated as URL candidates ONLY here
 * (inside image-set), never as generic CSS text, so we don't over-block e.g.
 * `content:'https://…'`. Relative / `#fragment` / `data:` candidates are not
 * external, so an all-relative list returns false and stays live.
 */
function argsHaveExternalCandidate(args: string): boolean {
  // External `url(...)` anywhere in the candidate list (incl. quoted inner).
  if (STYLE_URL_EXTERNAL.test(args)) return true;
  // Any BARE quoted string whose content is an external URL.
  QUOTED_STRING.lastIndex = 0;
  for (
    let m = QUOTED_STRING.exec(args);
    m !== null;
    m = QUOTED_STRING.exec(args)
  ) {
    if (isExternalUrl(m[2] ?? "")) return true;
  }
  return false;
}

/**
 * Positional scanner for `image-set()` / `-webkit-image-set()`: finds every
 * occurrence, isolates its balanced argument list, and reports whether ANY
 * candidate (not just the first) is external — closing the bare-string
 * non-first-candidate leak that the first-arg-only regex missed. Defense in
 * depth: when a token's argument list cannot be balanced
 * (`extractBalancedGroup` returns `null`), FAIL SAFE and treat it as external
 * so a malformed/truncated payload parks rather than leaks.
 */
function imageSetHasExternalRef(css: string): boolean {
  IMAGE_SET_HEAD.lastIndex = 0;
  for (
    let head = IMAGE_SET_HEAD.exec(css);
    head !== null;
    head = IMAGE_SET_HEAD.exec(css)
  ) {
    const openIndex = head.index + head[0].length - 1; // index of the '('
    const group = extractBalancedGroup(css, openIndex);
    if (group === null) return true; // unparseable → fail safe (park it)
    if (argsHaveExternalCandidate(group)) return true;
  }
  return false;
}

/**
 * True when CSS text (an inline `style` value OR a `<style>` element body)
 * references an external sub-resource via `url(…)`, an `image-set(…)` candidate
 * in ANY position (quoted-bare or `url()`), or `@import`. External-only:
 * `url(#id)` fragment refs and `url(data:…)` URIs do NOT match, so they stay
 * live (they never fetch).
 */
function cssHasExternalRef(css: string): boolean {
  // Detection runs against a normalized copy (comments stripped, escapes
  // decoded) so an obfuscated scheme is caught the way the browser resolves it.
  // The CALLER still parks the ORIGINAL, un-normalized bytes.
  const normalized = normalizeCssForMatch(css);
  return (
    STYLE_URL_EXTERNAL.test(normalized) ||
    STYLE_IMAGE_SET_EXTERNAL.test(normalized) ||
    imageSetHasExternalRef(normalized) ||
    STYLE_IMPORT_EXTERNAL.test(normalized)
  );
}

function parkAttrFor(parkKey: string): string {
  return `${PARK_PREFIX}${parkKey}`;
}

/**
 * Candidate elements for a vector. When `localName` is set we scan broadly and
 * filter by `.localName` so camelCase/namespaced SVG tags (`feImage`) match on
 * every DOM engine; otherwise the CSS `selector` is authoritative.
 */
function selectVectorTargets(root: HTMLElement, vector: RefVector): Element[] {
  const nodes = Array.from(root.querySelectorAll(vector.selector));
  if (vector.localName === undefined) return nodes;
  return nodes.filter((el) => el.localName === vector.localName);
}

/**
 * Neutralize every external-loading reference under `root`. For each match the
 * live value is moved into a parked `data-reck-blocked-<key>` attribute and the
 * live attribute is removed, so no sub-resource fetches until consent.
 *
 * @returns the number of individual references neutralized (an element with
 *   both an external `src` and `srcset` contributes 2). Use
 *   `countBlockedExternalRefs` for a per-element tally.
 */
export function neutralizeExternalRefs(root: HTMLElement): number {
  let count = 0;

  // Element/attribute vectors (img/source/video/audio/track/input/background/
  // svg-image/svg-feImage).
  for (const vector of REF_VECTORS) {
    for (const el of selectVectorTargets(root, vector)) {
      const live = el.getAttribute(vector.attr);
      if (live === null) continue;
      // `cssurl` (SVG paint attrs like `fill="url(...)"`) is CSS, so detect on
      // a normalized copy — an escaped/commented `url(\68ttps://…)` resolves to
      // an external scheme in the browser. `url`/`srcset` are plain HTML URL
      // attributes that do NOT CSS-decode, so they keep literal matching.
      const external =
        vector.kind === "srcset"
          ? srcsetHasExternal(live)
          : vector.kind === "cssurl"
            ? STYLE_URL_EXTERNAL.test(normalizeCssForMatch(live))
            : isExternalUrl(live);
      if (!external) continue;
      el.setAttribute(parkAttrFor(vector.parkKey), live);
      el.removeAttribute(vector.attr);
      count += 1;
    }
  }

  // Inline `style` attribute referencing an external `url(...)`, bare-string
  // `image-set(...)`, or `@import`. Park the WHOLE value — a single declaration
  // may mix relative and external URLs, and we restore it verbatim, so
  // all-or-nothing keeps neutralize/restore lossless.
  root.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style");
    if (style === null || !cssHasExternalRef(style)) return;
    el.setAttribute(STYLE_PARK_ATTR, style);
    el.removeAttribute("style");
    count += 1;
  });

  // <style> element whose CSS text loads an external `url(...)`, bare-string
  // `image-set(...)`, or `@import`. Park the whole textContent and clear it so
  // the stylesheet is inert.
  root.querySelectorAll("style").forEach((el) => {
    const text = el.textContent ?? "";
    if (!cssHasExternalRef(text)) return;
    el.setAttribute(STYLE_TEXT_PARK_ATTR, text);
    el.textContent = "";
    count += 1;
  });

  return count;
}

/** True when `el` carries at least one `data-reck-blocked-*` parked attribute. */
function hasParkedAttr(el: Element): boolean {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith(PARK_PREFIX)) return true;
  }
  return false;
}

/**
 * Count elements under `root` that carry any parked `data-reck-blocked-*`
 * attribute. Each element is counted ONCE even if it parked several vectors
 * (e.g. both `src` and `srcset`) — this is the "N external resources" the
 * consent banner reports to the user.
 */
export function countBlockedExternalRefs(root: HTMLElement): number {
  let count = 0;
  root.querySelectorAll("*").forEach((el) => {
    if (hasParkedAttr(el)) count += 1;
  });
  return count;
}

/**
 * Exact reverse of `neutralizeExternalRefs`: restore every parked live
 * attribute / `<style>` textContent and drop the `data-reck-blocked-*` markers.
 * Idempotent and driven by the same vector table, so it can never restore a
 * value into the wrong attribute.
 */
export function restoreExternalRefs(root: HTMLElement): void {
  for (const vector of REF_VECTORS) {
    const parkAttr = parkAttrFor(vector.parkKey);
    root.querySelectorAll(`[${parkAttr}]`).forEach((el) => {
      const parked = el.getAttribute(parkAttr);
      if (parked === null) return;
      el.setAttribute(vector.attr, parked);
      el.removeAttribute(parkAttr);
    });
  }

  root.querySelectorAll(`[${STYLE_PARK_ATTR}]`).forEach((el) => {
    const parked = el.getAttribute(STYLE_PARK_ATTR);
    if (parked === null) return;
    el.setAttribute("style", parked);
    el.removeAttribute(STYLE_PARK_ATTR);
  });

  root.querySelectorAll(`[${STYLE_TEXT_PARK_ATTR}]`).forEach((el) => {
    const parked = el.getAttribute(STYLE_TEXT_PARK_ATTR);
    if (parked === null) return;
    el.textContent = parked;
    el.removeAttribute(STYLE_TEXT_PARK_ATTR);
  });
}
