// Download dialog for the usage view. One form, seeded from whatever the
// chart is currently showing, so the default action is "export what's on
// screen" and every field is there to be changed if it isn't.
//
// Chrome reuses the app's existing modal vocabulary (.confirm-overlay /
// .confirm-card / .confirm-btn) rather than introducing a second dialog
// look — see reuse-shared-components. All option logic lives in
// usage-export.ts so it can be tested without a DOM; this file is wiring.

import type { ApiClient, UsageExportDataset, UsageHistogramBucket } from "@client-core/api/client";
import { binOptionLabel, defaultWidthForSpan, widthsForSpan } from "./usage-range";
import {
  buildAdvancedParams,
  datasetDescription,
  isRawDataset,
  localMidnight,
  supportsProjectFilter,
  toDateInputValue,
  type CurrentView,
} from "./usage-export";

export interface UsageExportDialogOpts {
  api: ApiClient;
  /** What the chart is showing right now. */
  view: CurrentView;
  /** Project filter options, mirroring the usage view's own select.
   *  The first entry is expected to be the "" = all-projects row. */
  projects: Array<{ id: string; name: string }>;
}

const DATASETS: UsageExportDataset[] = ["binned", "turns", "quota"];

const DATASET_LABELS: Record<UsageExportDataset, string> = {
  binned: "Chart data (binned)",
  turns: "Raw turns",
  quota: "Raw quota readings",
};

/** Opens the export dialog. Resolves when it closes, whether or not a
 *  file was written — the dialog reports its own outcome inline. */
export function openUsageExportDialog(opts: UsageExportDialogOpts): Promise<void> {
  return new Promise((resolve) => {
    const { view } = opts;
    let busy = false;

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-card usage-export-card" role="dialog" aria-modal="true" aria-label="Export usage data">
        <div class="confirm-title">Export usage data</div>

        <div class="usage-export-form">
          <label class="usage-export-field">
            <span>Data</span>
            <select class="usage-export-dataset"></select>
          </label>
          <div class="usage-export-hint"></div>

          <div class="usage-export-row">
            <label class="usage-export-field">
              <span>From</span>
              <input type="date" class="usage-export-from" />
            </label>
            <label class="usage-export-field">
              <span>To</span>
              <input type="date" class="usage-export-to" />
            </label>
          </div>

          <label class="usage-export-field usage-export-interval-field">
            <span>Interval</span>
            <select class="usage-export-interval"></select>
          </label>

          <label class="usage-export-field usage-export-project-field">
            <span>Project</span>
            <select class="usage-export-project"></select>
          </label>
        </div>

        <div class="usage-export-status" role="status"></div>

        <div class="confirm-actions">
          <button type="button" class="confirm-btn confirm-btn-ghost usage-export-cancel">Cancel</button>
          <button type="button" class="confirm-btn confirm-btn-primary usage-export-go">Download CSV</button>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string): T =>
      overlay.querySelector(sel) as T;
    const hintEl = q<HTMLElement>(".usage-export-hint");
    const statusEl = q<HTMLElement>(".usage-export-status");
    const datasetSel = q<HTMLSelectElement>(".usage-export-dataset");
    const fromInput = q<HTMLInputElement>(".usage-export-from");
    const toInput = q<HTMLInputElement>(".usage-export-to");
    const intervalSel = q<HTMLSelectElement>(".usage-export-interval");
    const intervalField = q<HTMLElement>(".usage-export-interval-field");
    const projectSel = q<HTMLSelectElement>(".usage-export-project");
    const projectField = q<HTMLElement>(".usage-export-project-field");
    const goBtn = q<HTMLButtonElement>(".usage-export-go");
    const cancelBtn = q<HTMLButtonElement>(".usage-export-cancel");

    // --- seed the form from the chart -------------------------------
    for (const d of DATASETS) {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = DATASET_LABELS[d];
      datasetSel.appendChild(o);
    }
    for (const p of opts.projects) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      projectSel.appendChild(o);
    }
    projectSel.value = view.projectId;
    // `until` is exclusive; step back a second so the inclusive end date
    // shown to the user is the last day actually covered.
    fromInput.value = toDateInputValue(view.since, view.tzOffsetMin);
    toInput.value = toDateInputValue(view.until - 1, view.tzOffsetMin);

    function currentSpanSec(): number {
      const from = localMidnight(fromInput.value, view.tzOffsetMin);
      const to = localMidnight(toInput.value, view.tzOffsetMin);
      if (from === null || to === null || to + 86400 <= from) {
        return view.until - view.since;
      }
      return to + 86400 - from;
    }

    // Interval choices depend on the chosen span — the same rule the
    // chart uses — so the list can't offer a width the daemon's bin cap
    // would reject.
    function refreshIntervals(): void {
      const span = currentSpanSec();
      const options: UsageHistogramBucket[] = widthsForSpan(span);
      if (!options.includes("month")) options.push("month");
      const previous = intervalSel.value;
      intervalSel.innerHTML = "";
      for (const b of options) {
        const o = document.createElement("option");
        o.value = b;
        o.textContent = binOptionLabel(b);
        intervalSel.appendChild(o);
      }
      intervalSel.value = options.includes(previous as UsageHistogramBucket)
        ? previous
        : defaultWidthForSpan(span);
    }
    refreshIntervals();

    // Which controls a dataset actually honours: raw rows aren't binned,
    // and quota is account-level, so showing those fields would invite a
    // setting that silently does nothing.
    function refreshFieldVisibility(): void {
      const dataset = datasetSel.value as UsageExportDataset;
      hintEl.textContent = datasetDescription(dataset);
      intervalField.hidden = isRawDataset(dataset);
      projectField.hidden = !supportsProjectFilter(dataset);
    }
    refreshFieldVisibility();

    datasetSel.addEventListener("change", refreshFieldVisibility);
    fromInput.addEventListener("change", refreshIntervals);
    toInput.addEventListener("change", refreshIntervals);

    function setStatus(text: string, kind: "error" | "info" | "" = ""): void {
      statusEl.textContent = text;
      statusEl.classList.toggle("is-error", kind === "error");
    }

    // --- download ----------------------------------------------------
    async function download(): Promise<void> {
      if (busy) return;
      const params = buildAdvancedParams(
        {
          dataset: datasetSel.value as UsageExportDataset,
          fromDate: fromInput.value,
          toDate: toInput.value,
          bucket: intervalSel.value as UsageHistogramBucket,
          projectId: projectSel.value,
        },
        view.tzOffsetMin,
      );
      if (!params.ok) {
        setStatus(params.error, "error");
        return;
      }

      busy = true;
      goBtn.disabled = true;
      setStatus("Preparing export…", "info");
      try {
        const { csv, filename } = await opts.api.getUsageExportCsv(params.params);
        const res = await window.reckAPI.dialog.saveCsv(filename, csv);
        if (res.canceled) {
          // The user dismissed the save sheet — not a failure, and not a
          // reason to tear down the dialog they may still want.
          setStatus("");
          return;
        }
        if (!res.ok) {
          setStatus(res.error ? `Couldn't save: ${res.error}` : "Couldn't save the file.", "error");
          return;
        }
        close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Export failed: ${msg}`, "error");
      } finally {
        busy = false;
        goBtn.disabled = false;
      }
    }

    // --- lifecycle ----------------------------------------------------
    let done = false;
    function close(): void {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Enter" && !busy) {
        e.stopPropagation();
        void download();
      }
    }

    overlay.addEventListener("pointerdown", (e) => {
      // Don't let a mid-export backdrop click strand an in-flight request.
      if (e.target === overlay && !busy) close();
    });
    cancelBtn.addEventListener("click", () => close());
    goBtn.addEventListener("click", () => void download());
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    goBtn.focus();
  });
}
