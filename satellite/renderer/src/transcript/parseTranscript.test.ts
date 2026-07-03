import { describe, it, expect } from "vitest";
import { TranscriptParser } from "./parseTranscript";

// Fixtures are compacted versions of REAL lines observed in a station
// transcript (Claude Code 2.1.x JSONL). The parser must stay tolerant:
// anything without a user/assistant message is skipped, unknown types
// included — the schema is not a public API.

const metaLines =
  `{"type":"custom-title","customTitle":"proj/adaf7dd3","sessionId":"s1"}\n` +
  `{"type":"agent-name","agentName":"proj/adaf7dd3","sessionId":"s1"}\n` +
  `{"type":"mode","mode":"normal","sessionId":"s1"}\n` +
  `{"type":"permission-mode","permissionMode":"default","sessionId":"s1"}\n` +
  `{"type":"file-history-snapshot","messageId":"m0","snapshot":{}}\n` +
  `{"type":"last-prompt","lastPrompt":"hi","leafUuid":"u9"}\n` +
  `{"parentUuid":"u1","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":24576}\n` +
  `{"parentUuid":"u1","isSidechain":false,"attachment":{"type":"skill_listing","content":"x"},"type":"attachment"}\n`;

const userLine = (text: string, uuid = "u1") =>
  `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":${JSON.stringify(text)}},"uuid":"${uuid}","timestamp":"2026-05-28T09:28:59.372Z"}\n`;

const assistantText = (text: string, id = "msg_1") =>
  `{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"model":"m","id":"${id}","type":"message","role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]},"uuid":"a1"}\n`;

const assistantThinking = (text: string, id = "msg_1") =>
  `{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"id":"${id}","role":"assistant","content":[{"type":"thinking","thinking":${JSON.stringify(text)}}]},"uuid":"a0"}\n`;

const assistantToolUse = (name: string, id = "msg_2") =>
  `{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{"id":"${id}","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"${name}","input":{"cmd":"ls"}}]},"uuid":"a2"}\n`;

const userToolResult = (text: string) =>
  `{"parentUuid":"a2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":${JSON.stringify(text)}}]},"uuid":"u2"}\n`;

describe("TranscriptParser", () => {
  it("skips meta/system/attachment lines and parses user + assistant turns", () => {
    const p = new TranscriptParser();
    p.push(metaLines + userLine("hello there") + assistantText("**hi**"));
    expect(p.turns).toHaveLength(2);
    expect(p.turns[0]).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "hello there" }],
    });
    expect(p.turns[1]).toMatchObject({
      role: "assistant",
      blocks: [{ kind: "text", text: "**hi**" }],
    });
  });

  it("merges assistant lines sharing message.id into one turn", () => {
    // Real transcripts write one JSONL line per completed content block,
    // all carrying the same message.id (observed: thinking then text).
    const p = new TranscriptParser();
    p.push(userLine("q") + assistantThinking("pondering", "msg_9") + assistantText("answer", "msg_9"));
    expect(p.turns).toHaveLength(2);
    expect(p.turns[1].blocks).toEqual([
      { kind: "thinking", text: "pondering" },
      { kind: "text", text: "answer" },
    ]);
  });

  it("dedupes an identical re-written block on the same message id", () => {
    const p = new TranscriptParser();
    p.push(assistantText("same", "msg_5") + assistantText("same", "msg_5"));
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0].blocks).toEqual([{ kind: "text", text: "same" }]);
  });

  it("skips sidechain lines", () => {
    const side = userLine("subagent prompt").replace('"isSidechain":false', '"isSidechain":true');
    const p = new TranscriptParser();
    p.push(side + userLine("real"));
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0].blocks[0]).toEqual({ kind: "text", text: "real" });
  });

  it("carries a partial trailing line across pushes", () => {
    const line = userLine("split across chunks");
    const p = new TranscriptParser();
    p.push(line.slice(0, 40));
    expect(p.turns).toHaveLength(0);
    p.push(line.slice(40));
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0].blocks[0]).toEqual({ kind: "text", text: "split across chunks" });
  });

  it("survives garbage lines", () => {
    const p = new TranscriptParser();
    p.push("not json at all\n" + '{"half":\n' + userLine("ok"));
    expect(p.turns).toHaveLength(1);
  });

  it("extracts tool_use and tool_result blocks", () => {
    const p = new TranscriptParser();
    p.push(assistantToolUse("Bash") + userToolResult("file1\nfile2"));
    expect(p.turns).toHaveLength(2);
    expect(p.turns[0].blocks[0]).toMatchObject({ kind: "tool_use", name: "Bash" });
    expect((p.turns[0].blocks[0] as { input: string }).input).toContain('"cmd"');
    expect(p.turns[1].blocks[0]).toEqual({ kind: "tool_result", text: "file1\nfile2" });
  });

  it("handles tool_result content given as an array of text parts", () => {
    const line =
      `{"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"part1"},{"type":"text","text":"part2"}]}]},"uuid":"u3"}\n`;
    const p = new TranscriptParser();
    p.push(line);
    expect(p.turns[0].blocks[0]).toEqual({ kind: "tool_result", text: "part1\npart2" });
  });

  it("reports firstChanged for appends and in-place merges", () => {
    const p = new TranscriptParser();
    const u1 = p.push(userLine("a"));
    expect(u1).toEqual({ firstChanged: 0 });
    const u2 = p.push(assistantThinking("t", "msg_7"));
    expect(u2).toEqual({ firstChanged: 1 });
    // Appending a block to the existing assistant turn changes index 1.
    const u3 = p.push(assistantText("done", "msg_7"));
    expect(u3).toEqual({ firstChanged: 1 });
    // Pure meta produces no update.
    expect(p.push(metaLines)).toBeNull();
  });
});
