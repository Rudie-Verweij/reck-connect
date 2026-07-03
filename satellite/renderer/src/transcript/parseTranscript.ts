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
// too. One important real-world shape: Claude Code writes one JSONL
// line per completed assistant content block, all sharing the same
// `message.id` — those lines merge into a single assistant turn.

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
  /** message.id of the turn at the tail of `turns`, when assistant. */
  private lastAssistantId: string | null = null;

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
    const msgId = typeof m.id === "string" ? m.id : null;

    // Merge: another block of the assistant message already at the tail.
    if (role === "assistant" && msgId !== null && msgId === this.lastAssistantId) {
      const turn = this.turns[this.turns.length - 1];
      const seen = new Set(turn.blocks.map((b) => JSON.stringify(b)));
      const fresh = blocks.filter((b) => !seen.has(JSON.stringify(b)));
      if (fresh.length === 0) return null;
      turn.blocks.push(...fresh);
      return this.turns.length - 1;
    }

    this.turns.push({ role, blocks, ...(timestamp ? { timestamp } : {}) });
    this.lastAssistantId = role === "assistant" ? msgId : null;
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
