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

// Ring geometry (viewBox 28×28, r=10 → circumference ≈ 62.83).
const RING_R = 10;
const RING_CIRC = 2 * Math.PI * RING_R;

// Live volume meter: a scrolling row of bars. Speech RMS is small, so scale
// it up for a lively display.
const METER_BARS = 16;
const LEVEL_GAIN = 8;

// Crystallization: each character of a new ghost word de-blurs in turn, so a
// word reads as sharpening left→right (h,e,l,l,o). Per-char delay, capped so
// a long batch doesn't stall.
const CHAR_STAGGER_MS = 24;
const MAX_CRYSTALLIZE_DELAY_MS = 500;

export class DictationBar implements DictationUI {
  private readonly el: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private readonly ringProgress: SVGCircleElement;
  private readonly label: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly meterEl: HTMLElement;
  private readonly tailEl: HTMLElement;
  private readonly blobsEl: HTMLElement;
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

  constructor(
    private readonly surface: HTMLElement,
    private readonly modelLabel: string | null = null,
    private readonly fluidMotion: boolean = true,
  ) {
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

    this.liveEl = document.createElement("div");
    this.liveEl.className = "dictation-live";
    this.liveEl.append(this.meterEl, this.tailEl, this.blobsEl);

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
    this.render();
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
    let delay = 0;
    for (let i = common; i < words.length; i++) {
      const wordSpan = document.createElement("span");
      wordSpan.className = "dictation-tail-word";
      for (const ch of [...words[i]]) {
        const charSpan = document.createElement("span");
        charSpan.className = "dictation-tail-char";
        charSpan.textContent = ch;
        charSpan.style.animationDelay = `${Math.min(delay, MAX_CRYSTALLIZE_DELAY_MS)}ms`;
        delay += CHAR_STAGGER_MS;
        wordSpan.appendChild(charSpan);
      }
      this.tailEl.appendChild(wordSpan);
    }
    this.tailEl.classList.toggle("has-text", words.length > 0);
    this.tailWords = words;
  }

  setPendingWords(count: number): void {
    if (count === this.pendingWords) return;
    this.pendingWords = count;
    while (this.blobsEl.children.length > count) this.blobsEl.lastElementChild?.remove();
    while (this.blobsEl.children.length < count) {
      const blob = document.createElement("span");
      blob.className = "dictation-blob";
      // Word-ish width variety so the row reads as language, not UI.
      blob.style.width = `${16 + ((this.blobsEl.children.length * 7) % 15)}px`;
      this.blobsEl.appendChild(blob);
    }
    // While finishing up, blob changes should re-evaluate pill visibility.
    if (this.state === "transcribing") this.render();
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
