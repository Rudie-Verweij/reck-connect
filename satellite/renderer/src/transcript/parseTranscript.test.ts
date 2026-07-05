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

  it("folds a tool_use + its tool_result into ONE assistant turn (not a user turn)", () => {
    const p = new TranscriptParser();
    p.push(assistantToolUse("Bash") + userToolResult("file1\nfile2"));
    // The tool_result arrives as role:user but is NOT the user speaking.
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0].role).toBe("assistant");
    expect(p.turns[0].blocks[0]).toMatchObject({ kind: "tool_use", name: "Bash" });
    expect((p.turns[0].blocks[0] as { input: string }).input).toContain('"cmd"');
    expect(p.turns[0].blocks[1]).toEqual({ kind: "tool_result", text: "file1\nfile2" });
  });

  it("groups a full user→claude turn: text + multiple tool round-trips = one assistant turn", () => {
    const p = new TranscriptParser();
    p.push(
      userLine("do the thing", "q1") +
        assistantText("On it.", "m1") +
        assistantToolUse("Bash", "m1") +
        userToolResult("out1") +
        assistantText("Now the next step.", "m2") +
        assistantToolUse("Read", "m2") +
        userToolResult("out2") +
        userLine("thanks", "q2"),
    );
    // Exactly: YOU, CLAUDE, YOU — no phantom user turns from tool results.
    expect(p.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    const claude = p.turns[1];
    expect(claude.blocks.map((b) => b.kind)).toEqual([
      "text",
      "tool_use",
      "tool_result",
      "text",
      "tool_use",
      "tool_result",
    ]);
    expect(p.turns[0].blocks[0]).toEqual({ kind: "text", text: "do the thing" });
    expect(p.turns[2].blocks[0]).toEqual({ kind: "text", text: "thanks" });
  });

  it("a real user message after tool activity opens a fresh assistant turn", () => {
    const p = new TranscriptParser();
    p.push(userLine("a", "q1") + assistantText("x", "m1") + userToolResult("r"));
    p.push(userLine("b", "q2") + assistantText("y", "m2"));
    expect(p.turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(p.turns[3].blocks).toEqual([{ kind: "text", text: "y" }]);
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

describe("TranscriptParser — harness-wrapper sanitization", () => {
  // Real transcripts inject non-conversational "user" strings: a caveat
  // preamble, background task notifications, system reminders, and slash
  // commands (which arrive as <command-name>…</command-name>, sometimes with
  // <command-message>/<command-args>/<local-command-stdout> siblings). These
  // must not render as phantom "You" prose turns.

  it("drops a pure local-command-caveat line — no phantom turn", () => {
    const p = new TranscriptParser();
    p.push(userLine("<local-command-caveat>Caveat: messages below were generated by local commands.") + assistantText("hi"));
    // Only Claude's turn survives; the caveat produced nothing.
    expect(p.turns.map((t) => t.role)).toEqual(["assistant"]);
  });

  it("drops task-notification and system-reminder noise lines", () => {
    const p = new TranscriptParser();
    p.push(userLine("<task-notification><task-id>x</task-id></task-notification>"));
    p.push(userLine("<system-reminder>Some injected reminder text.</system-reminder>"));
    expect(p.turns).toHaveLength(0);
  });

  it("renders a slash command as a command block, not prose", () => {
    const p = new TranscriptParser();
    p.push(userLine("<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>"));
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0].role).toBe("user");
    expect(p.turns[0].blocks).toEqual([{ kind: "command", name: "/clear" }]);
  });

  it("handles a standalone <command-name> with no siblings", () => {
    const p = new TranscriptParser();
    p.push(userLine("<command-name>/model</command-name>"));
    expect(p.turns[0].blocks).toEqual([{ kind: "command", name: "/model" }]);
  });

  it("drops a standalone local-command-stdout line", () => {
    const p = new TranscriptParser();
    p.push(userLine("<local-command-stdout>lots of /context output here</local-command-stdout>"));
    expect(p.turns).toHaveLength(0);
  });

  it("keeps genuine prose after stripping an appended system-reminder", () => {
    const p = new TranscriptParser();
    p.push(userLine("Please refactor the parser.\n<system-reminder>injected context</system-reminder>"));
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0].blocks).toEqual([{ kind: "text", text: "Please refactor the parser." }]);
  });

  it("a skipped noise line does not break the open assistant turn", () => {
    const p = new TranscriptParser();
    // Claude is mid-turn; a task-notification arrives as role:user between
    // its lines and must NOT split the assistant turn into two.
    p.push(assistantText("step one", "m1"));
    p.push(userLine("<task-notification>bg event</task-notification>"));
    p.push(assistantText("step two", "m1"));
    expect(p.turns.map((t) => t.role)).toEqual(["assistant"]);
    expect(p.turns[0].blocks).toEqual([
      { kind: "text", text: "step one" },
      { kind: "text", text: "step two" },
    ]);
  });

  it("a real command line opens a fresh user boundary (resets the assistant turn)", () => {
    const p = new TranscriptParser();
    p.push(assistantText("before", "m1"));
    p.push(userLine("<command-name>/clear</command-name>"));
    p.push(assistantText("after", "m2"));
    expect(p.turns.map((t) => t.role)).toEqual(["assistant", "user", "assistant"]);
    expect(p.turns[1].blocks).toEqual([{ kind: "command", name: "/clear" }]);
  });
});

const assistantExitPlan = (plan: string, path = ".claude/plans/x.md", id = "mp") =>
  `{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{"id":"${id}","role":"assistant","content":[{"type":"tool_use","id":"toolu_p","name":"ExitPlanMode","input":{"plan":${JSON.stringify(plan)},"planFilePath":${JSON.stringify(path)}}}]},"uuid":"ap"}\n`;

const assistantAskQuestion = (id = "mq") =>
  `{"parentUuid":"a1","isSidechain":false,"type":"assistant","message":{"id":"${id}","role":"assistant","content":[{"type":"tool_use","id":"toolu_q","name":"AskUserQuestion","input":{"questions":[{"question":"Which approach?","header":"Approach","multiSelect":false,"options":[{"label":"A","description":"first"},{"label":"B","description":"second"}]}]}}]},"uuid":"aq"}\n`;

const userPlanApproved = () =>
  `{"parentUuid":"ap","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_p","content":"User has approved your plan. You can now start coding."}]},"uuid":"upa"}\n`;

describe("TranscriptParser — plans, questions, approvals", () => {
  it("renders an ExitPlanMode tool call as a plan block (path + text), not a raw tool_use", () => {
    const p = new TranscriptParser();
    p.push(userLine("q") + assistantExitPlan("# My Plan\n\nDo the thing", ".claude/plans/x.md"));
    const claude = p.turns[1];
    expect(claude.blocks).toContainEqual({
      kind: "plan",
      text: "# My Plan\n\nDo the thing",
      path: ".claude/plans/x.md",
    });
    expect(claude.blocks.some((b) => b.kind === "tool_use")).toBe(false);
  });

  it("renders an AskUserQuestion tool call as a structured question block", () => {
    const p = new TranscriptParser();
    p.push(userLine("q") + assistantAskQuestion());
    const claude = p.turns[1];
    const qb = claude.blocks.find((b) => b.kind === "question");
    expect(qb).toBeTruthy();
    expect(qb).toMatchObject({
      kind: "question",
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
        },
      ],
    });
    expect(claude.blocks.some((b) => b.kind === "tool_use")).toBe(false);
  });

  it("folds the plan-approval tool_result into a compact plan_approved block (no phantom user turn)", () => {
    const p = new TranscriptParser();
    p.push(userLine("q") + assistantExitPlan("# P") + userPlanApproved());
    expect(p.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    const claude = p.turns[1];
    expect(claude.blocks.some((b) => b.kind === "plan_approved")).toBe(true);
    expect(claude.blocks.some((b) => b.kind === "tool_result")).toBe(false);
  });
});
