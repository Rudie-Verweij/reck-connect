// Per-pane dictation UI. While the model loads it shows a circular progress
// ring (filled by download %, with a pulsing glow) next to the model name,
// which morphs into a checkmark once loaded; while recording it shows a
// status label + the live interim text. Created for one dictation session
// and disposed when it ends.

import { setMicButtonState } from "../ui/paneControls";
import { showToast } from "../viewer/Toast";
import type { DictationState } from "./TranscriptionEngine";
import type { DictationUI } from "./TranscriptionController";
import type { TranscriberStatus } from "./providers/types";

// Ring geometry (viewBox 28×28, r=10 → circumference ≈ 62.83).
const RING_R = 10;
const RING_CIRC = 2 * Math.PI * RING_R;

export class DictationBar implements DictationUI {
  private readonly el: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private readonly ringProgress: SVGCircleElement;
  private readonly loaderLabel: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly interimEl: HTMLElement;
  private state: DictationState = "idle";
  private status: TranscriberStatus | null = null;
  private pct = 0;
  private sawProgress = false;
  private ready = false;

  constructor(
    private readonly surface: HTMLElement,
    private readonly modelLabel: string | null = null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "dictation-bar";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");

    // Loading component: circular ring (track + progress + checkmark) + label.
    this.loaderEl = document.createElement("div");
    this.loaderEl.className = "dictation-loader";
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

    this.loaderLabel = document.createElement("span");
    this.loaderLabel.className = "dictation-loader-label";
    this.loaderEl.append(svg, this.loaderLabel);

    // Recording status: a coloured dot + label, plus the live interim text.
    this.statusLabel = document.createElement("span");
    this.statusLabel.className = "dictation-bar-label";
    this.interimEl = document.createElement("span");
    this.interimEl.className = "dictation-bar-interim";

    this.el.append(this.loaderEl, this.statusLabel, this.interimEl);
    this.surface.appendChild(this.el);
    this.render();
  }

  setState(state: DictationState): void {
    // Leaving "preparing" for real recording means the model is ready.
    if (state !== "preparing" && this.state === "preparing") this.ready = true;
    this.state = state;
    setMicButtonState(this.surface, state);
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

  setInterim(text: string): void {
    this.interimEl.textContent = text;
    // Keep the most-recent words in view as the transcript grows.
    this.interimEl.scrollLeft = this.interimEl.scrollWidth;
  }

  setError(message: string): void {
    showToast(this.surface, message, { kind: "error", durationMs: 6000 });
  }

  private isLoading(): boolean {
    return this.state === "preparing" || this.status === "loading";
  }

  private render(): void {
    this.el.dataset.state = this.state;
    const loading = this.isLoading();
    // The download completed (ring full) OR the model is warm/ready → check.
    const complete = this.ready || this.pct >= 100;
    this.loaderEl.hidden = !loading;
    this.loaderEl.dataset.mode = !this.sawProgress && !complete
      ? "indeterminate"
      : complete
        ? "complete"
        : "determinate";
    if (loading) {
      const name = this.modelLabel ?? "speech model";
      this.loaderLabel.textContent = complete
        ? `${name} ready`
        : this.sawProgress
          ? `Loading ${name}… ${this.pct}%`
          : `Loading ${name}…`;
    }
    this.statusLabel.textContent = loading ? "" : this.recordingLabel();
    this.statusLabel.hidden = loading || this.statusLabel.textContent === "";
  }

  private recordingLabel(): string {
    if (this.state === "listening") return "Listening…";
    if (this.state === "transcribing" || this.status === "transcribing") return "Transcribing…";
    return "";
  }

  dispose(): void {
    setMicButtonState(this.surface, "idle");
    this.el.remove();
  }
}
