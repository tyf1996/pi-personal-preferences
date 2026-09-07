import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import preferenceExtension from "../index.ts";
import { runPreferenceCli } from "../src/cli-client.ts";
import { parsePrefCommand } from "../src/commands.ts";
import { recentConversationTurns, selectConversationTurns, type ConversationTurn } from "../src/feedback-context.ts";

initTheme("dark", false);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const cliPath = join(repoRoot, "skills/wikiskill/scripts/wikiskill_preference.py");
const pythonRoot = join(repoRoot, "skills/wikiskill/scripts");

type Json = Record<string, any>;
type ModelReply = Json | string | Error;

function temporaryRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "pi-pref-fast-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function cli(root: string, args: string[], input?: Json): Json {
  const result = spawnSync("python3", [cliPath, ...args, "--data-root", root], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pythonRoot },
    timeout: 10_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr || `CLI ${args.join(" ")} returned no output`);
  return JSON.parse(result.stdout) as Json;
}

function ok(root: string, args: string[], input?: Json): Json {
  const result = cli(root, args, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function learning(root: string): Json {
  return JSON.parse(readFileSync(join(root, "local/learning.json"), "utf8")) as Json;
}

function groups(root: string): Json {
  return JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8")) as Json;
}

function completedBranch(count: number, prefix = "turn"): Json[] {
  const entries: Json[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `${prefix}-user-${index}` }] } });
    entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `${prefix}-assistant-${index}` }], stopReason: "stop" } });
  }
  return entries;
}

function extraction(quote: string, options: { name?: string | null; certain?: boolean; summary?: string } = {}): Json {
  return {
    group: {
      name: options.name === undefined ? "global" : options.name,
      certain: options.certain ?? true,
      reason: "group reason",
    },
    evidence: {
      summary: options.summary ?? `summary for ${quote}`,
      actual_behavior: `actual ${quote}`,
      expected_behavior: `expected ${quote}`,
      applicability: "general",
      supporting_quotes: [quote],
    },
  };
}

interface HarnessOptions {
  root?: string;
  branch?: Json[];
  model?: Json | undefined;
  modelReply?: (prompt: string, call: number) => ModelReply;
  pickerInputs?: string[][];
  selectReplies?: Array<string | undefined>;
  inputReplies?: Array<string | undefined>;
  confirmReplies?: boolean[];
}

function harness(t: test.TestContext, options: HarnessOptions = {}) {
  const root = options.root ?? temporaryRoot(t);
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  process.env.WIKISKILL_PREFERENCE_CLI = cliPath;
  const commands = new Map<string, Json>();
  const handlers = new Map<string, Function>();
  preferenceExtension({
    registerCommand(name: string, command: Json) { commands.set(name, command); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
  } as any);

  const events: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const prompts: string[] = [];
  const selects: Array<{ title: string; choices: string[] }> = [];
  const pickerInputs = [...(options.pickerInputs ?? [])];
  const selectReplies = [...(options.selectReplies ?? [])];
  const inputReplies = [...(options.inputReplies ?? [])];
  const confirmReplies = [...(options.confirmReplies ?? [])];
  const theme = { fg(_name: string, text: string) { return text; }, bold(text: string) { return text; } };
  const tui = { requestRender() {} };
  let modelCalls = 0;
  const branch = options.branch ?? completedBranch(1, "selected");

  const ui = {
    notify(message: string, level = "info") { notices.push({ message, level }); },
    setStatus() {},
    setFooter() {},
    async select(title: string, choices: string[]) {
      events.push(`select:${title}`);
      selects.push({ title, choices });
      return selectReplies.shift();
    },
    async input() { return inputReplies.shift(); },
    async editor() { return inputReplies.shift(); },
    async confirm() { return confirmReplies.length ? confirmReplies.shift()! : true; },
    custom(factory: Function) {
      return new Promise((resolvePromise, rejectPromise) => {
        let component: any;
        let closed = false;
        const done = (value: unknown) => {
          if (closed) return;
          closed = true;
          component?.dispose?.();
          resolvePromise(value);
        };
        try {
          component = factory(tui, theme, {}, done);
          if (component?.constructor?.name !== "BorderedLoader") {
            for (const key of pickerInputs.shift() ?? [" ", "\r"]) component.handleInput(key);
          }
        } catch (error) {
          rejectPromise(error);
        }
      });
    },
  };

  const ctx: Json = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/pi-pref-project",
    ui,
    waitForIdle: async () => {},
    model: options.model === undefined
      ? { provider: "fake-provider", id: "fake-model", reasoning: true, contextWindow: 100_000, maxTokens: 4_096 }
      : options.model,
    thinkingLevel: "high",
    modelRegistry: {
      async complete(_model: Json, context: Json) {
        modelCalls += 1;
        events.push("model");
        const prompt = context.messages[0].content[0].text as string;
        prompts.push(prompt);
        const reply = options.modelReply?.(prompt, modelCalls) ?? extraction("selected-assistant-0");
        if (reply instanceof Error) throw reply;
        const text = typeof reply === "string" ? reply : JSON.stringify(reply);
        return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
      },
    },
    sessionManager: {
      getBranch() { return branch; },
      getSessionId() { return "session-fast-test"; },
      getEntries() { return branch; },
      getSessionName() { return undefined; },
    },
    getContextUsage() { return undefined; },
  };

  return {
    root,
    ctx,
    events,
    notices,
    prompts,
    selects,
    get modelCalls() { return modelCalls; },
    async pref(args: string) { await commands.get("pref")!.handler(args, ctx); },
    handler(name: string) { return handlers.get(name); },
  };
}

test("command parser requires reasons and accepts optional groups", () => {
  assert.throws(() => parsePrefCommand("feedback good"), /requires a reason/);
  assert.throws(() => parsePrefCommand("feedback fix"), /requires a reason/);
  assert.deepEqual(parsePrefCommand("feedback --group coding good clear structure"), {
    action: "feedback", group: "coding", sentiment: "good", reason: "clear structure",
  });
  assert.deepEqual(parsePrefCommand("feedback fix needs boundaries"), {
    action: "feedback", sentiment: "fix", reason: "needs boundaries",
  });
  assert.throws(() => parsePrefCommand("feedback --group"), /requires a value/);
});

test("current branch projection keeps only the latest ten complete real turns", () => {
  const branch = completedBranch(11);
  branch.push({ type: "custom", customType: "personal-preferences-feedback-target", data: { marker: "ignored" } });
  branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "special-user" }] } });
  branch.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "THINK_SECRET" }, { type: "text", text: "visible-progress" }], stopReason: "toolUse" } });
  branch.push({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "TOOL_RAW" }] } });
  branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "user-supplement" }] } });
  branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "visible-final" }], stopReason: "stop" } });
  const turns = recentConversationTurns({ sessionManager: { getBranch: () => branch } } as any);
  assert.equal(turns.length, 10);
  assert.equal(turns[0]!.user, "turn-user-2");
  assert.match(turns.at(-1)!.user, /special-user[\s\S]*user-supplement/);
  assert.match(turns.at(-1)!.assistant, /visible-progress[\s\S]*visible-final/);
  assert.ok(!turns.some((turn) => turn.user === "turn-user-0" || turn.user === "turn-user-1"));
  assert.doesNotMatch(JSON.stringify(turns), /THINK_SECRET|TOOL_RAW|marker|abandoned-branch/);
});

test("picker uses temporary Space selection, arrows, Enter, and Esc", async () => {
  const turns: ConversationTurn[] = [
    { user: "u0", assistant: "a0" },
    { user: "u1", assistant: "a1" },
    { user: "u2", assistant: "a2" },
  ];
  const makeCtx = (keys: string[]) => ({
    mode: "tui",
    ui: {
      custom(factory: Function) {
        return new Promise((resolvePromise) => {
          const component = factory({ requestRender() {} }, { fg: (_n: string, text: string) => text, bold: (text: string) => text }, {}, resolvePromise);
          for (const key of keys) component.handleInput(key);
        });
      },
    },
  }) as any;
  const selected = await selectConversationTurns(makeCtx([" ", "\x1b[A", " ", "\x1b[B", " ", "\r"]), turns);
  assert.deepEqual(selected, [turns[1]]);
  assert.equal(await selectConversationTurns(makeCtx(["\x1b"]), turns), null);
  assert.deepEqual(await selectConversationTurns(makeCtx(["\r"]), turns), []);

  const tenTurns = Array.from({ length: 10 }, (_, index) => ({ user: `u${index}`, assistant: `a${index}` }));
  let visibleLines: string[] = [];
  const first = await selectConversationTurns({
    mode: "tui",
    ui: {
      custom(factory: Function) {
        return new Promise((resolvePromise) => {
          const component = factory(
            { requestRender() {}, terminal: { rows: 24 } },
            { fg: (_n: string, text: string) => text, bold: (text: string) => text },
            {},
            resolvePromise,
          );
          for (let index = 0; index < 9; index += 1) component.handleInput("\x1b[A");
          visibleLines = component.render(80);
          component.handleInput(" ");
          component.handleInput("\r");
        });
      },
    },
  } as any, tenTurns);
  assert.ok(visibleLines.length <= 24);
  assert.ok(visibleLines.some((line) => line.includes("> [ ] 1. 用户：u0")));
  assert.deepEqual(first, [tenTurns[0]]);
});

test("empty or cancelled picker selection saves nothing and calls no model", async (t) => {
  const empty = harness(t, { pickerInputs: [["\r"]] });
  await empty.pref("feedback --group global good reason");
  assert.equal(empty.modelCalls, 0);
  assert.equal(learning(empty.root).feedback.length, 0);
  assert.ok(empty.notices.some((item) => item.message.includes("没有勾选")));

  const cancelled = harness(t, { pickerInputs: [["\x1b"]] });
  await cancelled.pref("feedback --group global fix reason");
  assert.equal(cancelled.modelCalls, 0);
  assert.equal(learning(cancelled.root).feedback.length, 0);
});

test("registered pref handler asks for a group only after uncertain joint extraction", async (t) => {
  const longAssistant = `${"长".repeat(26_000)}TAIL-UNIQUE`;
  const branch = [
    ...completedBranch(1, "unselected"),
    { type: "message", message: { role: "user", content: [{ type: "text", text: "selected-user-0" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: longAssistant }], stopReason: "stop" } },
  ];
  const certain = harness(t, {
    branch,
    modelReply: () => extraction("TAIL-UNIQUE", { name: "global", certain: true }),
  });
  await certain.pref("feedback good reason-certain");
  assert.equal(certain.modelCalls, 1);
  assert.equal(certain.selects.length, 0);
  assert.doesNotMatch(certain.prompts[0]!, /unselected-user|unselected-assistant/);
  assert.match(certain.prompts[0]!, /selected-user-0/);
  assert.match(certain.prompts[0]!, /TAIL-UNIQUE/);
  assert.deepEqual(learning(certain.root).feedback[0].selected_turns, [{ user: "selected-user-0", assistant: longAssistant }]);
  assert.equal(learning(certain.root).evidence[0].supporting_quotes[0], "TAIL-UNIQUE");

  const uncertain = harness(t, {
    branch: completedBranch(1, "selected"),
    selectReplies: ["global"],
    modelReply: () => extraction("selected-assistant-0", { name: null, certain: false }),
  });
  await uncertain.pref("feedback fix reason-uncertain");
  assert.deepEqual(uncertain.events.filter((item) => item === "model" || item.startsWith("select:")), ["model", "select:模型无法确定现有组"]);
  assert.equal(learning(uncertain.root).feedback[0].group_name, "global");

  const explicit = harness(t, {
    branch: completedBranch(1, "selected"),
    modelReply: () => extraction("selected-assistant-0", { name: null, certain: false }),
  });
  await explicit.pref("feedback --group global good explicit-reason");
  assert.equal(explicit.selects.length, 0);
  assert.equal(learning(explicit.root).feedback[0].group_name, "global");
});

test("third and sixth evidence trigger evolution with full evidence and current rules", async (t) => {
  let extractionCount = 0;
  const flow = harness(t, {
    branch: completedBranch(1, "selected"),
    confirmReplies: [true, false],
    modelReply: (prompt) => {
      if (prompt.includes("反馈整理器")) {
        extractionCount += 1;
        return extraction("selected-assistant-0", { summary: `evidence-${extractionCount}` });
      }
      return prompt.includes("rule-one")
        ? { proposed_rules: ["rule-one", "rule-two"], rationale: "all six" }
        : { proposed_rules: ["rule-one"], rationale: "first three" };
    },
  });
  await flow.pref("feedback --group global good r1");
  await flow.pref("feedback --group global good r2");
  assert.equal(flow.modelCalls, 2);
  await flow.pref("feedback --group global good r3");
  assert.equal(flow.modelCalls, 4);
  assert.deepEqual(groups(flow.root).groups[0].rules.map((item: Json) => item.text), ["rule-one"]);
  await flow.pref("feedback --group global good r4");
  await flow.pref("feedback --group global good r5");
  assert.equal(flow.modelCalls, 6);
  await flow.pref("feedback --group global good r6");
  assert.equal(flow.modelCalls, 8);
  const evolutionPrompts = flow.prompts.filter((prompt) => prompt.includes("规则演化器"));
  assert.equal(evolutionPrompts.length, 2);
  for (let index = 1; index <= 6; index += 1) assert.match(evolutionPrompts[1]!, new RegExp(`evidence-${index}`));
  assert.match(evolutionPrompts[1]!, /rule-one/);
  assert.deepEqual(groups(flow.root).groups[0].rules.map((item: Json) => item.text), ["rule-one"]);
});

test("rejected batch does not rerun and only formal rules enter the next prompt", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal-rule" });
  let evidenceNumber = 0;
  const flow = harness(t, {
    root,
    branch: completedBranch(1, "selected"),
    confirmReplies: [false],
    modelReply: (prompt) => prompt.includes("反馈整理器")
      ? extraction("selected-assistant-0", { summary: `private-evidence-${++evidenceNumber}` })
      : { proposed_rules: ["candidate-rule"], rationale: "candidate-rationale" },
  });
  for (let index = 0; index < 3; index += 1) await flow.pref(`feedback --group global fix reject-${index}`);
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["formal-rule"]);
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  assert.equal(prepared.trigger, false);
  assert.equal(prepared.new_evidence_count, 0);
  const beforeAgent = flow.handler("before_agent_start")!;
  const injected = await beforeAgent({ systemPrompt: "base" }, flow.ctx);
  assert.match(injected.systemPrompt, /formal-rule/);
  assert.doesNotMatch(injected.systemPrompt, /candidate-rule|candidate-rationale|private-evidence|reject-0/);
});

test("missing model, invalid JSON, and unselected quotes preserve feedback without rules", async (t) => {
  const noModel = harness(t, { model: null, branch: completedBranch(1, "selected") });
  await noModel.pref("feedback --group global good saved-first");
  assert.equal(noModel.modelCalls, 0);
  assert.equal(learning(noModel.root).feedback[0].status, "failed");
  assert.equal(learning(noModel.root).evidence.length, 0);

  const invalid = harness(t, { branch: completedBranch(1, "selected"), modelReply: () => "not-json" });
  await invalid.pref("feedback --group global fix invalid-json");
  assert.equal(learning(invalid.root).feedback[0].status, "failed");
  assert.equal(learning(invalid.root).evidence.length, 0);
  assert.equal(groups(invalid.root).groups[0].rules.length, 0);

  const wrongQuote = harness(t, {
    branch: [...completedBranch(1, "unselected"), ...completedBranch(1, "selected")],
    modelReply: () => extraction("unselected-assistant-0"),
  });
  await wrongQuote.pref("feedback --group global fix wrong-quote");
  assert.equal(learning(wrongQuote.root).feedback[0].status, "failed");
  assert.equal(learning(wrongQuote.root).evidence.length, 0);
});

test("staged, Git commit, and file write failures keep the old groups document", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const groupsPath = join(root, "repo/groups.json");
  const original = readFileSync(groupsPath, "utf8");

  const note = join(root, "repo/staged.txt");
  writeFileSync(note, "staged\n");
  spawnSync("git", ["-C", join(root, "repo"), "add", "staged.txt"]);
  const staged = cli(root, ["remember", "--stdin"], { group: "global", rule: "must-not-write" });
  assert.equal(staged.ok, false);
  assert.match(staged.error.message, /staged/);
  assert.equal(readFileSync(groupsPath, "utf8"), original);
  spawnSync("git", ["-C", join(root, "repo"), "reset", "--quiet"]);
  unlinkSync(note);

  const hook = join(root, "repo/.git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const gitFailure = cli(root, ["remember", "--stdin"], { group: "global", rule: "commit-must-fail" });
  assert.equal(gitFailure.ok, false);
  assert.equal(readFileSync(groupsPath, "utf8"), original);
  unlinkSync(hook);

  const script = [
    "from pathlib import Path",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(pythonRoot)})`,
    "import wikiskill_preference as cli",
    "from wikiskill_preference_core.storage import PreferenceStore",
    `root = Path(${JSON.stringify(root)})`,
    "store = PreferenceStore(root)",
    "before = store.groups_path.read_bytes()",
    "store.write_groups = lambda _value: (_ for _ in ()).throw(OSError('write failed'))",
    "try:",
    "    cli._remember(store, {'group': 'global', 'rule': 'file-must-fail'})",
    "except OSError:",
    "    pass",
    "assert store.groups_path.read_bytes() == before",
  ].join("\n");
  const fileFailure = spawnSync("python3", ["-c", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(fileFailure.status, 0, fileFailure.stderr);
  assert.equal(readFileSync(groupsPath, "utf8"), original);
});

test("CLI decoding preserves UTF-8 characters split across stdout chunks", async (t) => {
  const root = temporaryRoot(t);
  const script = join(root, "split-output.py");
  writeFileSync(script, [
    "import os, time",
    "parts = [b'{\"ok\":true,\"text\":\"', bytes.fromhex('e4bd'), bytes.fromhex('a0'), b'\"}']",
    "for part in parts:",
    "    os.write(1, part)",
    "    time.sleep(0.02)",
  ].join("\n"));
  const result = await runPreferenceCli(script, root, []);
  assert.equal(result.text, "你");
});

test("concurrent group changes block model output and stdin is prepared before dispatch locks", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  for (let index = 1; index <= 3; index += 1) {
    const created = ok(root, ["feedback-create", "--stdin"], {
      sentiment: "fix",
      reason: `r${index}`,
      selected_turns: [{ user: `u${index}`, assistant: `a${index}` }],
      model: { provider: "fake", id: "fake", thinking: "off" },
      group: "global",
    });
    ok(root, ["feedback-complete", "--stdin"], {
      feedback_id: created.feedback.id,
      group: "global",
      evidence: {
        summary: `s${index}`,
        actual_behavior: `actual${index}`,
        expected_behavior: `expected${index}`,
        applicability: "general",
        supporting_quotes: [`a${index}`],
      },
    });
  }
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  ok(root, ["remember", "--stdin"], { group: "global", rule: "concurrent-rule" });
  const stale = cli(root, ["save-evolution", "--stdin"], {
    group_id: prepared.group.id,
    base_digest: prepared.base_digest,
    evidence_ids: prepared.evidence.map((item: Json) => item.id),
    proposed_rules: ["model-rule"],
    rationale: "stale model result",
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error.message, /changed while the model was running/);
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["concurrent-rule"]);

  const source = readFileSync(cliPath, "utf8");
  const preparedAt = source.indexOf("stdin_value = _stdin_object(args) if args.stdin else None");
  const dispatchAt = source.indexOf("output = dispatch(args, stdin_value)");
  assert.ok(preparedAt >= 0 && dispatchAt > preparedAt);
  const dispatchBody = source.slice(source.indexOf("def dispatch("), source.indexOf("def parser("));
  assert.doesNotMatch(dispatchBody, /_stdin_object\(/);
});
