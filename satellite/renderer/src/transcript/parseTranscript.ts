// Incremental parser for Claude Code session transcripts (JSONL).
//
// The daemon serves the transcript file in offset-addressed slices; this
// parser accepts those raw slices, carries any partial trailing line
// between pushes, and folds the lines into an ordered list of chat
// turns for the TranscriptView.
//
// The JSONL schema is NOT a public API, so the parser is tolerant by
// construction: only lines carrying a `message` with role user/assistant
// become turns; every other shape (custom-title, mode, system,
// attachment, file-history-snapshot, unknown future types, unparseable
// garbage) is skipped. Sidechain lines (subagent traffic) are skipped
// too.
//
// Turn grouping mirrors the conversation, not the wire: a REAL user
// message opens a "user" turn; everything after it until the next real
// user message — the assistant's text and tool_use lines, PLUS the
// tool_result lines (which Claude Code writes as role:"user"!) — folds
// into a single "assistant" turn. Without this, every tool result would
// render as a phantom "you" turn between Claude's actions.

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; input: string }
  | { kind: "tool_result"; text: string };

export interface TranscriptTurn {
  role: "user" | "assistant";
  blocks: TranscriptBlock[];
  timestamp?: string;
}

export interface ParseUpdate {
  /** Index of the first turn that changed — re-render from here. */
  firstChanged: number;
}

export class TranscriptParser {
  readonly turns: TranscriptTurn[] = [];
  private remainder = "";
  /** The assistant turn currently accumulating (text + tool calls +
   *  tool results) until the next real user message. When set it is
   *  always the last element of `turns`. */
  private openAssistant: TranscriptTurn | null = null;

  /** Feed the next raw slice; returns which turns changed, if any. */
  push(chunk: string): ParseUpdate | null {
    const data = this.remainder + chunk;
    const lines = data.split("\n");
    // The final element is either "" (chunk ended on a newline) or a
    // partial line the next slice will complete.
    this.remainder = lines.pop() ?? "";
    let firstChanged: number | null = null;
    for (const line of lines) {
      const idx = this.consumeLine(line);
      if (idx !== null && (firstChanged === null || idx < firstChanged)) {
        firstChanged = idx;
      }
    }
    return firstChanged === null ? null : { firstChanged };
  }

  /** Returns the index of the turn this line created/changed, or null. */
  private consumeLine(line: string): number | null {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null; // torn write or non-JSON noise — skip
    }
    if (typeof obj !== "object" || obj === null) return null;
    const rec = obj as Record<string, unknown>;
    if (rec.isSidechain === true) return null;
    const msg = rec.message;
    if (typeof msg !== "object" || msg === null) return null;
    const m = msg as Record<string, unknown>;
    const role = m.role;
    if (role !== "user" && role !== "assistant") return null;

    const blocks = blocksFromContent(m.content);
    if (blocks.length === 0) return null;
    const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

    // A role:"user" line whose content is only tool_result(s) is NOT the
    // user speaking — it's tool output being fed back to Claude. Fold it
    // into the open assistant turn instead of starting a user turn.
    const isToolResult =
      role === "user" && blocks.every((b) => b.kind === "tool_result");

    if (role === "user" && !isToolResult) {
      this.turns.push({ role: "user", blocks, ...(timestamp ? { timestamp } : {}) });
      this.openAssistant = null; // the next assistant activity starts fresh
      return this.turns.length - 1;
    }

    // Assistant text/tool_use, or a tool_result carrier → accumulate into
    // the current assistant turn (opening one if needed).
    if (this.openAssistant === null) {
      this.openAssistant = { role: "assistant", blocks: [], ...(timestamp ? { timestamp } : {}) };
      this.turns.push(this.openAssistant);
    }
    const turn = this.openAssistant; // always the last turn while open
    const before = turn.blocks.length;
    for (const b of blocks) {
      // Light dedup: skip a block identical to the one just appended
      // (guards against a re-written partial line) without needing ids.
      const last = turn.blocks[turn.blocks.length - 1];
      if (last && JSON.stringify(last) === JSON.stringify(b)) continue;
      turn.blocks.push(b);
    }
    if (turn.blocks.length === before) return null; // nothing new added
    return this.turns.length - 1;
  }
}

function blocksFromContent(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text !== "") {
          out.push({ kind: "text", text: b.text });
        }
        break;
      case "thinking":
        if (typeof b.thinking === "string" && b.thinking !== "") {
          out.push({ kind: "thinking", text: b.thinking });
        }
        break;
      case "tool_use":
        out.push({
          kind: "tool_use",
          name: typeof b.name === "string" ? b.name : "tool",
          input: stringifyInput(b.input),
        });
        break;
      case "tool_result":
        out.push({ kind: "tool_result", text: toolResultText(b.content) });
        break;
      default:
        break; // unknown block type — skip, stay tolerant
    }
  }
  return out;
}

function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null) {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") return p.text;
      }
      return "";
    })
    .filter((s) => s !== "")
    .join("\n");
}
