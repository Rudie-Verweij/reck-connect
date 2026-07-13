// Per-session dictation UI. Mounts into the floating mic's pill slot (or
// straight onto the surface when no fab exists, e.g. popouts) and shows:
//   - while the model loads: a circular progress ring (download %, pulsing
//     glow) + the model name, morphing into a checkmark when ready;
//   - while listening: the live volume meter + the GHOST TAIL — the words
//     still settling, blurred, kept out of the real prompt. Stable words are
//     typed into the terminal; only this pill ever shows unstable text.
// Also mirrors the dictation state onto the floating mic button and surfaces
// errors as a toast. Created for one dictation session, disposed at its end.

import { setMicButtonState } from "../ui/paneControls";
import { showToast } from "../viewer/Toast";
import { dictationFabFor } from "./micOverlay";
import type { DictationState } from "./TranscriptionEngine";
import type { DictationUI } from "./TranscriptionController";
import type { TranscriberStatus } from "./providers/types";
import type { Segment } from "./chunkModel";
import { DEFAULT_APPEARANCE, type DictationAppearance } from "./transcriptionSettings";

// Ring geometry (viewBox 28×28, r=10 → circumference ≈ 62.83).
const RING_R = 10;
const RING_CIRC = 2 * Math.PI * RING_R;

// Live volume meter: a scrolling row of bars. Speech RMS is small, so scale
// it up for a lively display.
const METER_BARS = 16;
const LEVEL_GAIN = 8;

export class DictationBar implements DictationUI {
  private readonly el: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private readonly ringProgress: SVGCircleElement;
  private readonly label: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly meterEl: HTMLElement;
  private readonly tailEl: HTMLElement;
  private readonly blobsEl: HTMLElement;
  private readonly chunkEl: HTMLElement;
  // Rendered chunk segments, keyed by id, so only new/changed words re-animate.
  private readonly chunkNodes = new Map<number, { el: HTMLElement; text: string | null }>();
  private pendingWords = 0;
  private readonly bars: HTMLElement[] = [];
  private readonly levels: number[] = new Array(METER_BARS).fill(0);
  private state: DictationState = "idle";
  private status: TranscriberStatus | null = null;
  private pct = 0;
  private sawProgress = false;
  private ready = false;

  // Words currently rendered in the ghost tail — diffed against each update
  // so only NEWLY-appended words get the crystallize animation (revisions
  // just re-render, avoiding a whole-tail re-animate every flush).
  private tailWords: string[] = [];
  private appearance: DictationAppearance;

  constructor(
    private readonly surface: HTMLElement,
    private readonly modelLabel: string | null = null,
    private readonly fluidMotion: boolean = true,
    appearance: DictationAppearance = DEFAULT_APPEARANCE,
  ) {
    this.appearance = appearance;
    this.el = document.createElement("div");
    this.el.className = "dictation-bar";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");

    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "dictation-ring");
    svg.setAttribute("viewBox", "0 0 28 28");
    const track = document.createElementNS(svgNs, "circle");
    track.setAttribute("class", "dictation-ring-track");
    track.setAttribute("cx", "14");
    track.setAttribute("cy", "14");
    track.setAttribute("r", String(RING_R));
    this.ringProgress = document.createElementNS(svgNs, "circle");
    this.ringProgress.setAttribute("class", "dictation-ring-progress");
    this.ringProgress.setAttribute("cx", "14");
    this.ringProgress.setAttribute("cy", "14");
    this.ringProgress.setAttribute("r", String(RING_R));
    this.ringProgress.style.strokeDasharray = String(RING_CIRC);
    this.ringProgress.style.strokeDashoffset = String(RING_CIRC);
    const check = document.createElementNS(svgNs, "path");
    check.setAttribute("class", "dictation-ring-check");
    check.setAttribute("d", "M8.5 14.5 l3 3 l6 -7");
    svg.append(track, this.ringProgress, check);

    this.label = document.createElement("span");
    this.label.className = "dictation-loader-label";

    this.loaderEl = document.createElement("div");
    this.loaderEl.className = "dictation-loader";
    this.loaderEl.append(svg, this.label);

    // Live volume meter (shown while listening): a scrolling row of bars.
    this.meterEl = document.createElement("div");
    this.meterEl.className = "dictation-meter";
    this.meterEl.setAttribute("aria-hidden", "true");
    for (let i = 0; i < METER_BARS; i++) {
      const bar = document.createElement("span");
      bar.className = "dictation-meter-bar";
      this.bars.push(bar);
      this.meterEl.append(bar);
    }

    // Ghost tail: the unstable words, blurred, next to the meter.
    this.tailEl = document.createElement("span");
    this.tailEl.className = "dictation-tail";

    // Ghost blobs: one placeholder per word HEARD (voice energy) but not yet
    // transcribed — instant feedback that crystallizes into words.
    this.blobsEl = document.createElement("span");
    this.blobsEl.className = "dictation-blobs";
    this.blobsEl.setAttribute("aria-hidden", "true");

    // Phase-2 chunk row: the rolling sub-sentence — a mix of blurred blobs
    // (heard, not yet transcribed) and crystallizing words — that commits into
    // the terminal phrase-by-phrase. Used in the default "onset" ghost mode;
    // the separate tail/blobs above serve the legacy "estimate" mode.
    this.chunkEl = document.createElement("span");
    this.chunkEl.className = "dictation-chunk";

    this.liveEl = document.createElement("div");
    this.liveEl.className = "dictation-live";
    this.liveEl.append(this.meterEl, this.tailEl, this.blobsEl, this.chunkEl);

    this.el.append(this.loaderEl, this.liveEl);
    // Prefer the floating mic's pill slot; fall back to the pane corner for
    // surfaces without a fab.
    const fab = dictationFabFor(surface);
    if (fab) {
      this.el.classList.add("in-fab");
      fab.pillSlot.appendChild(this.el);
    } else {
      this.surface.appendChild(this.el);
    }
    this.applyAppearance(appearance);
    this.render();
  }

  /** Apply the appearance knobs — CSS vars for the animation/blur/font, plus
   *  the outline, pill theme, and blob visibility. Safe to call live. */
  applyAppearance(a: DictationAppearance): void {
    this.appearance = a;
    const s = this.el.style;
    s.setProperty("--dict-crystallize-ms", `${a.crystallizeMs}ms`);
    s.setProperty("--dict-blur-start", `${a.blurStartPx}px`);
    s.setProperty("--dict-blur-rest", `${a.blurRestPx}px`);
    s.setProperty("--dict-tail-font", `${a.tailFontPx}px`);
    s.setProperty("--dict-placeholder-blur", `${a.placeholderBlurPx}px`);
    this.el.classList.toggle("outline", a.textOutline);
    this.el.dataset.pill = a.pillTheme;
    // Blob visibility is a hard gate — clear them immediately when turned off.
    if (!a.showBlobs) this.setPendingWords(0);
  }

  setState(state: DictationState): void {
    // Leaving "preparing" for real recording means the model is ready — and
    // the sticky "loading" status must clear with it, or the "<model> ready"
    // label squats in the pill for the whole session (masking the meter,
    // ghosts, and the Transcribing… message).
    if (state !== "preparing" && this.state === "preparing") {
      this.ready = true;
      this.status = null;
    }
    this.state = state;
    setMicButtonState(this.surface, state);
    dictationFabFor(this.surface)?.setState(state);
    // Keep the ghost tail/blobs visible through "transcribing" — the final
    // pass is the slow part and the ghosts ARE the "still working" feedback.
    if (state === "idle") {
      this.setTail("");
      this.setPendingWords(0);
      this.clearChunk();
    }
    this.render();
  }

  setStatus(status: TranscriberStatus | null): void {
    this.status = status;
    this.render();
  }

  setProgress(pct: number): void {
    this.sawProgress = true;
    this.pct = Math.max(0, Math.min(100, pct));
    this.ringProgress.style.strokeDashoffset = String(RING_CIRC * (1 - this.pct / 100));
    this.render();
  }

  setLevel(level: number): void {
    this.levels.shift();
    this.levels.push(Math.max(0, Math.min(1, level * LEVEL_GAIN)));
    if (this.state === "listening") {
      for (let i = 0; i < this.bars.length; i++) {
        this.bars[i].style.transform = `scaleY(${0.08 + this.levels[i] * 0.92})`;
      }
    }
  }

  setTail(text: string): void {
    const words = text.trim() === "" ? [] : text.trim().split(/\s+/);
    if (words.length === this.tailWords.length && words.every((w, i) => w === this.tailWords[i])) {
      return; // unchanged
    }
    if (!this.fluidMotion) {
      // Snappy: one plain span, no per-word animation.
      this.tailEl.classList.remove("fluid");
      this.tailEl.textContent = words.join(" ");
      this.tailEl.classList.toggle("has-text", words.length > 0);
      this.tailWords = words;
      return;
    }
    // Fluid: keep spans for the unchanged leading prefix; the appended words
    // (the leading ghost edge) crystallize in — already present as blurred
    // text, then de-blurring character by character, left→right. On a
    // revision (prefix differs) we rebuild that suffix so only changed words
    // re-animate, not the whole tail every flush.
    this.tailEl.classList.add("fluid");
    let common = 0;
    const max = Math.min(words.length, this.tailWords.length);
    while (common < max && words[common] === this.tailWords[common]) common++;
    while (this.tailEl.children.length > common) this.tailEl.lastElementChild?.remove();
    // Each NEW word crystallizes on its own left→right sweep (delay resets per
    // word), so a burst of words doesn't cascade into a long stall — every
    // word resolves in ~word-length × stagger + crystallizeMs, fast.
    const stagger = this.appearance.charStaggerMs;
    for (let i = common; i < words.length; i++) {
      const wordSpan = document.createElement("span");
      wordSpan.className = "dictation-tail-word";
      let charIndex = 0;
      for (const ch of [...words[i]]) {
        const charSpan = document.createElement("span");
        charSpan.className = "dictation-tail-char";
        charSpan.textContent = ch;
        charSpan.style.animationDelay = `${charIndex * stagger}ms`;
        charIndex++;
        wordSpan.appendChild(charSpan);
      }
      this.tailEl.appendChild(wordSpan);
    }
    this.tailEl.classList.toggle("has-text", words.length > 0);
    this.tailWords = words;
  }

  setPendingWords(count: number): void {
    // Placeholders for words HEARD (a word onset was detected) but not yet
    // transcribed. Rendered as heavily-blurred glyph runs — an even-more-
    // blurred version of the ghost text, like diffusion noise — that get
    // replaced + crystallized once the real word arrives.
    if (!this.appearance.showBlobs) count = 0;
    if (count === this.pendingWords) return;
    this.pendingWords = count;
    while (this.blobsEl.children.length > count) this.blobsEl.lastElementChild?.remove();
    while (this.blobsEl.children.length < count) {
      const ph = document.createElement("span");
      ph.className = "dictation-blob";
      // Word-ish blurred glyph run (block chars) with a little length variety,
      // so the row reads as unresolved text, not UI dots.
      const len = 3 + ((this.blobsEl.children.length * 2) % 4);
      ph.textContent = "▓".repeat(len);
      this.blobsEl.appendChild(ph);
    }
    // While finishing up, placeholder changes should re-evaluate visibility.
    if (this.state === "transcribing") this.render();
  }

  /**
   * Render the current chunk (Phase-2 onset mode): an ordered row of segments —
   * blurred `▓` placeholders for heard-but-untranscribed words, and per-char
   * crystallizing spans for resolved ones. Keyed by segment id so only new or
   * revised words re-animate; unchanged words keep their settled node.
   */
  setChunk(segments: readonly Segment[]): void {
    const seen = new Set<number>();
    let prevEl: HTMLElement | null = null;
    for (const seg of segments) {
      seen.add(seg.id);
      const entry = this.chunkNodes.get(seg.id);
      // Rebuild when brand new, when the resolved word changed, or when a
      // blurred placeholder just gained its word (null → text).
      if (!entry || entry.text !== seg.text) {
        const el = this.buildSegmentEl(seg);
        if (entry) {
          entry.el.replaceWith(el);
        } else if (prevEl) {
          prevEl.after(el);
        } else {
          this.chunkEl.prepend(el);
        }
        this.chunkNodes.set(seg.id, { el, text: seg.text });
        prevEl = el;
      } else {
        prevEl = entry.el;
      }
    }
    for (const [id, entry] of this.chunkNodes) {
      if (!seen.has(id)) {
        entry.el.remove();
        this.chunkNodes.delete(id);
      }
    }
  }

  /** Build one segment's DOM: a blurred blob, or a crystallizing/plain word. */
  private buildSegmentEl(seg: Segment): HTMLElement {
    if (seg.text === null) {
      const blob = document.createElement("span");
      blob.className = "dictation-blob";
      // A soft smoke puff sized like a word (length variety from the id). The
      // cloud look + edge-fade come from CSS; here we only set its width.
      const len = 3 + ((Math.abs(seg.id) * 2) % 4);
      blob.style.setProperty("--blob-ch", String(len));
      return blob;
    }
    const word = document.createElement("span");
    word.className = "dictation-chunk-word";
    if (!this.fluidMotion || seg.state === "sharp") {
      // Snappy mode, or an already-settled word — plain text, no (re)animation.
      word.textContent = seg.text;
      return word;
    }
    // Crystallize: the word is already blurred text that de-blurs left→right,
    // first letter first (the delay resets per word so a burst doesn't stall).
    let charIndex = 0;
    for (const ch of [...seg.text]) {
      const c = document.createElement("span");
      c.className = "dictation-tail-char";
      c.textContent = ch;
      c.style.animationDelay = `${charIndex * this.appearance.charStaggerMs}ms`;
      charIndex++;
      word.appendChild(c);
    }
    return word;
  }

  /** Drop the whole chunk row (utterance ended or was committed+cleared). */
  clearChunk(): void {
    for (const entry of this.chunkNodes.values()) entry.el.remove();
    this.chunkNodes.clear();
  }

  setError(message: string): void {
    showToast(this.surface, message, { kind: "error", durationMs: 6000 });
  }

  private isLoading(): boolean {
    return this.state === "preparing" || this.status === "loading";
  }

  private render(): void {
    const loading = this.isLoading();
    const listening = this.state === "listening";
    const transcribing = this.state === "transcribing";
    // The pill appears while the model loads (ring), while listening (meter
    // + ghosts), and while the final pass runs (spinner + remaining ghosts) —
    // the mic never just sits amber with no explanation.
    this.el.hidden = !(loading || listening || transcribing);
    this.loaderEl.hidden = !(loading || transcribing);
    this.liveEl.hidden = !(listening || transcribing);
    this.meterEl.hidden = !listening; // no audio flows while finishing
    if (transcribing && !loading) {
      this.loaderEl.dataset.mode = "indeterminate";
      this.label.textContent = "Transcribing…";
      return;
    }
    if (!loading) return;
    const complete = this.ready || this.pct >= 100;
    this.loaderEl.dataset.mode = !this.sawProgress && !complete
      ? "indeterminate"
      : complete
        ? "complete"
        : "determinate";
    const name = this.modelLabel ?? "speech model";
    this.label.textContent = complete
      ? `${name} ready`
      : this.sawProgress
        ? `Loading ${name}… ${this.pct}%`
        : `Loading ${name}…`;
  }

  dispose(): void {
    setMicButtonState(this.surface, "idle");
    dictationFabFor(this.surface)?.setState("idle");
    this.el.remove();
  }
}
