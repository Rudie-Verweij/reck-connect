import { tokenizeClaudeArgs } from "@client-core/launch-args/tokenize";

export type LaunchScope = "machine" | "project";

export interface LaunchDialogResult {
  scope: LaunchScope;
  args: string; // raw string as typed (not tokenized)
}

export interface LaunchDialogInput {
  machineDefault: string;
  projectOverride: string;
  projectName: string | null; // null when no project is focused → "project" scope disabled
}

const EXAMPLES = [
  {
    flag: "--dangerously-skip-permissions",
    note: "skip every permission prompt (you asked for the gun)",
  },
  {
    flag: "--permission-mode plan",
    note: "other values: acceptEdits, auto, dontAsk, bypassPermissions",
  },
  { flag: "--betas interleaved-thinking", note: "opt into a beta header" },
  { flag: "--model claude-opus-4-7", note: "pin a model for this pane" },
  { flag: "--effort high", note: "set effort level" },
];

/**
 * Prompt the user for Claude Code launch args. Resolves to the chosen scope
 * plus the raw args string, or null if cancelled.
 */
export function promptForClaudeLaunchArgs(
  input: LaunchDialogInput,
): Promise<LaunchDialogResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "new-pane-dialog";

    const projectDisabled = !input.projectName;
    const initialScope: LaunchScope =
      !projectDisabled && input.projectOverride !== "" ? "project" : "machine";
    let scope: LaunchScope = initialScope;

    const examplesHtml = EXAMPLES.map(
      (e) =>
        `<div><code class="inline-code">${escape(e.flag)}</code> &mdash; ${escape(e.note)}</div>`,
    ).join("");

    overlay.innerHTML = `
      <div class="options" role="dialog" aria-label="Claude Code launch args" style="max-width:620px;">
        <div class="dialog-title">Claude Code launch command</div>
        <div class="dialog-body" style="margin-top:12px;">
          <p style="font-size:13px; margin:0 0 8px 0;">
            These args are appended verbatim to <code class="inline-code">claude</code> when a new Claude
            pane spawns. <b>Existing panes keep their current argv.</b> You're explicitly asking for the
            gun — the daemon only refuses flags that would break its own integrity
            (<code class="inline-code">--cwd</code>, out-of-sandbox <code class="inline-code">--add-dir</code>,
            out-of-TMPDIR <code class="inline-code">--debug-file</code>).
          </p>

          <div style="margin-top:10px;">
            <label style="font-size:12px; margin-right:14px;">
              <input type="radio" name="cl-scope" value="machine"${
                scope === "machine" ? " checked" : ""
              } /> This machine (default)
            </label>
            <label style="font-size:12px;${projectDisabled ? " color:var(--sl-gray);" : ""}">
              <input type="radio" name="cl-scope" value="project"${
                scope === "project" ? " checked" : ""
              }${projectDisabled ? " disabled" : ""} /> This project only${
                projectDisabled
                  ? " (no project focused)"
                  : input.projectName
                    ? ` (${escape(input.projectName)})`
                    : ""
              }
            </label>
          </div>

          <label for="cl-args" class="dialog-hint-label" style="margin-top:10px;">Extra args</label>
          <textarea id="cl-args" rows="3" autocomplete="off" spellcheck="false"
            style="width:100%; margin-top:4px; font-family:var(--mono, ui-monospace, SFMono-Regular, monospace); font-size:12px;"
            placeholder="e.g. --dangerously-skip-permissions --model claude-opus-4-7"></textarea>

          <label class="dialog-hint-label" style="margin-top:12px;">Preview</label>
          <pre id="cl-preview" class="code-block" style="white-space:pre-wrap; word-break:break-all;"></pre>

          <div id="cl-error" style="color:var(--sl-red); font-size:12px; min-height:1em; margin-top:4px;"></div>

          <details style="margin-top:12px; font-size:12px;">
            <summary style="cursor:pointer;">Reference — safe examples (not exhaustive; run <code class="inline-code">claude --help</code> for the full list)</summary>
            <div style="margin-top:8px; line-height:1.6;">${examplesHtml}</div>
          </details>
        </div>
        <div class="dialog-buttons" style="margin-top:16px;">
          <button id="cl-cancel" type="button">Cancel</button>
          <button id="cl-save" class="primary" type="button">Save</button>
        </div>
      </div>
    `;

    const input$ = overlay.querySelector("#cl-args") as HTMLTextAreaElement;
    const preview$ = overlay.querySelector("#cl-preview") as HTMLElement;
    const error$ = overlay.querySelector("#cl-error") as HTMLElement;
    const saveBtn = overlay.querySelector("#cl-save") as HTMLButtonElement;
    const radios = overlay.querySelectorAll(
      'input[name="cl-scope"]',
    ) as NodeListOf<HTMLInputElement>;

    input$.value = initialScope === "project" ? input.projectOverride : input.machineDefault;

    const refreshPreview = () => {
      const raw = input$.value.trim();
      let tokens: string[] = [];
      try {
        tokens = raw === "" ? [] : tokenizeClaudeArgs(raw);
        error$.textContent = "";
        saveBtn.disabled = false;
      } catch (e) {
        error$.textContent = (e as Error).message;
        saveBtn.disabled = true;
      }
      const extra = tokens.length ? " " + tokens.map(shQuote).join(" ") : "";
      // Preamble (--append-system-prompt …) is injected server-side from the
      // project's preamble config and doesn't appear here.
      preview$.textContent = `claude${extra}`;
    };

    const scopeChanged = () => {
      // Save whatever the user had typed for the previous scope into a
      // transient buffer keyed by scope, so switching back restores it.
      transient[scope] = input$.value;
      const next = (
        Array.from(radios).find((r) => r.checked) as HTMLInputElement | undefined
      )?.value as LaunchScope | undefined;
      if (!next) return;
      scope = next;
      input$.value =
        transient[scope] ??
        (scope === "project" ? input.projectOverride : input.machineDefault);
      refreshPreview();
    };
    const transient: Record<LaunchScope, string | undefined> = {
      machine: undefined,
      project: undefined,
    };

    input$.addEventListener("input", refreshPreview);
    radios.forEach((r) => r.addEventListener("change", scopeChanged));
    refreshPreview();

    document.body.appendChild(overlay);

    const finish = (value: LaunchDialogResult | null) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const commit = () => {
      if (saveBtn.disabled) return;
      finish({ scope, args: input$.value.trim() });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    (overlay.querySelector("#cl-cancel") as HTMLElement).addEventListener("click", () =>
      finish(null),
    );
    saveBtn.addEventListener("click", commit);

    input$.focus();
    input$.select();
  });
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
    }
    return c;
  });
}

// shQuote is for preview-display only — not used for actual argv. Quotes
// tokens that contain whitespace or shell metachars so the preview
// round-trips as a valid shell command.
function shQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}
