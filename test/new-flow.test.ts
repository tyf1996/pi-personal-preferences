import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import preferenceExtension from "../index.ts";
import { runPreferenceCli } from "../src/cli-client.ts";
import { parsePrefCommand, preferenceCommandNames } from "../src/commands.ts";
import { formatPreferenceSummary } from "../src/dashboard.ts";
import { recentConversationTurns, selectConversationTurns, type ConversationTurn } from "../src/feedback-context.ts";
import { renderPreferenceFooter } from "../src/footer.ts";
import { runCapturedPiModelBlocking } from "../src/pi-model.ts";

initTheme("dark", false);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pythonRoot = join(packageRoot, "python");
const cliPath = join(pythonRoot, "wikiskill_preference.py");

type Json = Record<string, any>;
type ModelReply = Json | string | Error;

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

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
      applicability: "supported scope; broader scope uncertain",
      supporting_quotes: [quote],
    },
  };
}

function addCliEvidence(
  root: string,
  index: number,
  quoteRole: "user" | "assistant" | "both" = "assistant",
  groupName = "global",
): Json {
  const shared = `quote-${index}`;
  const user = quoteRole === "assistant" ? `user-${index}` : `${shared} user-${index}`;
  const assistant = quoteRole === "user" ? `assistant-${index}` : `${shared} assistant-${index}`;
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: index % 2 ? "fix" : "good",
    reason: `original reason ${index}`,
    selected_turns: [{ user, assistant }],
    model: { provider: "fake", id: "fake", thinking: "high" },
    group: groupName,
  });
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: created.feedback.id,
    extraction: extraction(shared, { name: groupName, certain: true, summary: `evidence ${index}` }),
    model: { provider: "fake", id: "fake", thinking: "high" },
  });
  ok(root, ["feedback-complete", "--stdin"], { feedback_id: created.feedback.id, group: groupName });
  return created.feedback;
}

interface HarnessOptions {
  root?: string;
  branch?: Json[];
  model?: Json | null;
  modelReply?: (prompt: string, call: number, request: Json) => ModelReply | Promise<ModelReply>;
  pickerInputs?: string[][];
  loaderInputs?: string[][];
  detailInputs?: string[][];
  selectReply?: (title: string, choices: string[]) => string | undefined;
  inputReplies?: Array<string | undefined>;
  terminalRows?: number;
  terminalColumns?: number;
  preferenceCli?: string;
}

function harness(t: test.TestContext, options: HarnessOptions = {}) {
  const root = options.root ?? temporaryRoot(t);
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  process.env.WIKISKILL_PREFERENCE_CLI = options.preferenceCli ?? cliPath;
  const commands = new Map<string, Json>();
  const handlers = new Map<string, Function>();
  let sentMessages = 0;
  preferenceExtension({
    registerCommand(name: string, command: Json) { commands.set(name, command); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    sendMessage() { sentMessages += 1; throw new Error("sendMessage must not be used"); },
    sendUserMessage() { sentMessages += 1; throw new Error("sendUserMessage must not be used"); },
  } as any);

  const events: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const prompts: string[] = [];
  const modelRequests: Json[] = [];
  const selects: Array<{ title: string; choices: string[] }> = [];
  const statuses: Array<string | undefined> = [];
  const renderedViews: string[][] = [];
  const customComponents: any[] = [];
  const pickerInputs = [...(options.pickerInputs ?? [])];
  const loaderInputs = [...(options.loaderInputs ?? [])];
  const detailInputs = [...(options.detailInputs ?? [])];
  const inputReplies = [...(options.inputReplies ?? [])];
  const theme = { fg(_name: string, text: string) { return text; }, bold(text: string) { return text; } };
  const terminal = { rows: options.terminalRows ?? 24, columns: options.terminalColumns ?? 80 };
  const tui = { requestRender() {}, terminal };
  let modelCalls = 0;
  let started = false;
  let menuTarget: string | undefined;
  let menuSeen = false;
  const branch = options.branch ?? completedBranch(1, "selected");

  const ui = {
    notify(message: string, level = "info") { notices.push({ message, level }); },
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    setFooter() {},
    async select(title: string, choices: string[]) {
      events.push(`select:${title}`);
      selects.push({ title, choices });
      if (title === "个人偏好" && menuTarget) {
        if (!menuSeen) {
          menuSeen = true;
          return menuTarget;
        }
        return "退出";
      }
      return options.selectReply?.(title, choices);
    },
    async input() { return inputReplies.shift(); },
    async editor() { return inputReplies.shift(); },
    async confirm() { throw new Error("confirm is not part of the new flow"); },
    custom(factory: Function) {
      events.push("custom");
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
          customComponents.push(component);
          const initial = component.render?.(terminal.columns) ?? [];
          renderedViews.push(initial);
          const isPicker = initial.some((line: string) => line.includes("选择最近对话"));
          const isLoader = component?.constructor?.name === "BorderedLoader";
          const inputs = isPicker
            ? pickerInputs.shift() ?? [" ", "\r"]
            : isLoader
              ? loaderInputs.shift() ?? []
              : detailInputs.shift() ?? ["\x1b"];
          for (const key of inputs) {
            component.handleInput?.(key);
            renderedViews.push(component.render?.(terminal.columns) ?? []);
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
    waitForIdle: async () => { throw new Error("waitForIdle must not be called"); },
    model: options.model === undefined
      ? { provider: "fake-provider", id: "fake-model", reasoning: true, contextWindow: 100_000, maxTokens: 4_096 }
      : options.model,
    thinkingLevel: "high",
    modelRegistry: {
      async complete(model: Json, context: Json, request: Json) {
        modelCalls += 1;
        events.push("model");
        const prompt = context.messages[0].content[0].text as string;
        prompts.push(prompt);
        modelRequests.push({ model: { ...model }, request: { ...request } });
        const reply = await (options.modelReply?.(prompt, modelCalls, request) ?? extraction("selected-assistant-0"));
        if (reply instanceof Error) throw reply;
        const text = typeof reply === "string" ? reply : JSON.stringify(reply);
        return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
      },
    },
    sessionManager: {
      getBranch() { return branch; },
      getSessionId() { return "session-fast-test"; },
      getEntries() { return branch; },
      getSessionName() { return "test-session"; },
    },
    getContextUsage() { return undefined; },
  };

  async function start() {
    if (started) return;
    started = true;
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  }

  return {
    root,
    ctx,
    events,
    notices,
    prompts,
    modelRequests,
    selects,
    statuses,
    renderedViews,
    get sentMessages() { return sentMessages; },
    get modelCalls() { return modelCalls; },
    sendLastCustom(data: string) {
      const component = customComponents.at(-1);
      if (!component) throw new Error("no custom component is active");
      component.handleInput?.(data);
      renderedViews.push(component.render?.(terminal.columns) ?? []);
    },
    async pref(args: string) {
      await start();
      await commands.get("pref")!.handler(args, ctx);
    },
    async completions(prefix: string) {
      await start();
      return commands.get("pref")!.getArgumentCompletions(prefix);
    },
    async menu(choice: string) {
      menuTarget = choice;
      menuSeen = false;
      try {
        await this.pref("");
      } finally {
        menuTarget = undefined;
        menuSeen = false;
      }
    },
    async shutdown(reason = "quit") {
      await handlers.get("session_shutdown")?.({ reason }, ctx);
    },
    handler(name: string) { return handlers.get(name); },
  };
}

test("command parser and branch picker keep the bounded real-conversation contract", async () => {
  assert.throws(() => parsePrefCommand("feedback good"), /requires a reason/);
  assert.deepEqual(parsePrefCommand("feedback --group coding good clear structure"), {
    action: "feedback", group: "coding", sentiment: "good", reason: "clear structure",
  });
  assert.throws(() => parsePrefCommand("evidence"), /打开 \/pref 主菜单/);
  assert.throws(() => parsePrefCommand("pending"), /打开 \/pref 主菜单/);
  assert.throws(() => parsePrefCommand("reprocess"), /打开 \/pref 主菜单/);
  assert.deepEqual([...preferenceCommandNames], ["remember", "feedback"]);

  const branch = completedBranch(11);
  branch.push({ type: "custom", customType: "ignored", data: { marker: "ignored" } });
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
  assert.doesNotMatch(JSON.stringify(turns), /THINK_SECRET|TOOL_RAW|marker/);

  const values: ConversationTurn[] = [{ user: "u0", assistant: "a0" }, { user: "u1", assistant: "a1" }];
  const pickerCtx = (keys: string[]) => ({
    mode: "tui",
    ui: { custom(factory: Function) {
      return new Promise((resolvePromise) => {
        const component = factory({ requestRender() {}, terminal: { rows: 24 } }, themeForTest(), {}, resolvePromise);
        for (const key of keys) component.handleInput(key);
      });
    } },
  }) as any;
  assert.deepEqual(await selectConversationTurns(pickerCtx([" ", "\x1b[A", " ", "\x1b[B", " ", "\r"]), values), [values[0]]);
  assert.equal(await selectConversationTurns(pickerCtx(["\x1b"]), values), null);
});

function themeForTest() {
  return { fg: (_name: string, text: string) => text, bold: (text: string) => text };
}

test("G02 registered completions reject deleted actions and keep legal group suggestions", async (t) => {
  const flow = harness(t);
  assert.deepEqual(await flow.completions("feedback --group g"), [{ value: "global", label: "global" }]);
  assert.deepEqual(await flow.completions("remember --group g"), [{ value: "global", label: "global" }]);
  for (const prefix of [
    "evidence --group g",
    "pending --group g",
    "reprocess --group g",
    "retry --group g",
    "unknown --group g",
  ]) assert.equal(await flow.completions(prefix), null);
});

test("G01 pre-aborted blocking helper creates no model request or UI", async () => {
  let modelCalls = 0;
  let uiCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await runCapturedPiModelBlocking({
    mode: "tui",
    ui: { custom() { uiCalls += 1; throw new Error("UI must not open"); } },
  } as any, {
    info: { provider: "fake", id: "fake", thinking: "high" },
    async complete() { modelCalls += 1; return "must not run"; },
  }, "prompt", controller.signal);
  assert.equal(result, null);
  assert.equal(modelCalls, 0);
  assert.equal(uiCalls, 0);
});

test("CLI persists the first extraction across processes and keeps old records readable", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix",
    reason: "use the user's reason",
    selected_turns: [{ user: "shared quote and user request", assistant: "shared quote and assistant defense" }],
    model: { provider: "first", id: "draft", thinking: "low" },
    group: null,
  });
  const feedbackId = created.feedback.id;
  const saved = ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: feedbackId,
    extraction: extraction("shared quote", { name: "global", certain: true, summary: "first summary" }),
    model: { provider: "actual", id: "used-model", thinking: "high" },
  });
  assert.equal(saved.needs_group, false);
  const persisted = ok(root, ["feedback-get", "--stdin"], { feedback_id: feedbackId });
  assert.equal(persisted.feedback.extraction.evidence.summary, "first summary");
  assert.equal(persisted.feedback.model.id, "used-model");
  assert.deepEqual(persisted.quote_sources, [{ text: "shared quote", role: "both" }]);

  const duplicate = ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: feedbackId,
    extraction: extraction("shared quote", { name: null, certain: false, summary: "must not replace" }),
    model: { provider: "later", id: "other-model", thinking: "off" },
  });
  assert.equal(duplicate.feedback.extraction.evidence.summary, "first summary");
  assert.equal(duplicate.feedback.model.id, "used-model");
  const completed = ok(root, ["feedback-complete", "--stdin"], { feedback_id: feedbackId, group: "global" });
  assert.equal(completed.evidence.summary, "first summary");
  ok(root, ["feedback-fail", "--stdin"], { feedback_id: feedbackId, error: "late failure" });
  assert.equal(ok(root, ["feedback-get", "--stdin"], { feedback_id: feedbackId }).feedback.status, "organized");

  const oldLearning = learning(root);
  delete oldLearning.feedback[0].extraction;
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(oldLearning)}\n`);
  assert.equal(ok(root, ["feedback-list"]).feedback[0].extraction, null);

  const invalid = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "reason",
    selected_turns: [{ user: "only user", assistant: "only assistant" }],
    model: { provider: "fake", id: "fake", thinking: "off" }, group: null,
  });
  const rejected = cli(root, ["feedback-extracted", "--stdin"], {
    feedback_id: invalid.feedback.id,
    extraction: extraction("user\nonly assistant"),
    model: { provider: "fake", id: "fake", thinking: "off" },
  });
  assert.equal(rejected.ok, false);
  assert.equal(learning(root).feedback.find((item: Json) => item.id === invalid.feedback.id).extraction, null);
});

test("candidate snapshots survive new evidence and review only their own evidence", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  for (let index = 1; index <= 3; index += 1) addCliEvidence(root, index);
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  assert.equal(prepared.trigger, true);
  assert.match(JSON.stringify(prepared.evidence), /original reason 1/);
  assert.match(JSON.stringify(prepared.evidence), /"role":"assistant"/);
  const saved = ok(root, ["save-evolution", "--stdin"], {
    group_id: prepared.group.id,
    base_digest: prepared.base_digest,
    evidence_digest: prepared.evidence_digest,
    evidence_ids: prepared.evidence.map((item: Json) => item.id),
    proposed_rules: ["candidate rule"], rationale: "first three",
  });
  addCliEvidence(root, 4);
  assert.equal(ok(root, ["prepare-evolution", "--stdin"], { group: "global" }).pending_proposal.id, saved.proposal.id);
  assert.equal(ok(root, ["pending-list"]).evolution_groups.length, 0);
  ok(root, ["resolve-evolution", "--stdin"], { proposal_id: saved.proposal.id, decision: "reject" });
  assert.equal(ok(root, ["prepare-evolution", "--stdin"], { group: "global" }).new_evidence_count, 1);
  addCliEvidence(root, 5);
  addCliEvidence(root, 6);
  const pending = ok(root, ["pending-list"]);
  assert.deepEqual(pending.evolution_groups.map((item: Json) => [item.name, item.new_evidence_count]), [["global", 3]]);
  assert.equal(ok(root, ["prepare-evolution", "--stdin"], { group: "global" }).evidence.length, 6);
});

test("R05/R07/R08 reprocess apply is atomic, conflict-safe, and invalidates only related candidates", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal-rule" });
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "other", description: "other group" });
  const globalFeedback = [1, 2, 3].map((index) => addCliEvidence(root, index));
  for (let index = 101; index <= 103; index += 1) addCliEvidence(root, index, "assistant", "other");
  const globalPrepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  const globalProposal = ok(root, ["save-evolution", "--stdin"], {
    group_id: globalPrepared.group.id,
    base_digest: globalPrepared.base_digest,
    evidence_digest: globalPrepared.evidence_digest,
    evidence_ids: globalPrepared.evidence.map((item: Json) => item.id),
    proposed_rules: ["global candidate"], rationale: "global candidate",
  }).proposal;
  const otherPrepared = ok(root, ["prepare-evolution", "--stdin"], { group: "other" });
  const otherProposal = ok(root, ["save-evolution", "--stdin"], {
    group_id: otherPrepared.group.id,
    base_digest: otherPrepared.base_digest,
    evidence_digest: otherPrepared.evidence_digest,
    evidence_ids: otherPrepared.evidence.map((item: Json) => item.id),
    proposed_rules: ["other candidate"], rationale: "other candidate",
  }).proposal;
  const before = learning(root);
  const oldFeedback = before.feedback.find((item: Json) => item.id === globalFeedback[0].id);
  const oldEvidence = before.evidence.find((item: Json) => item.feedback_id === globalFeedback[0].id);
  const prepared = ok(root, ["feedback-reprocess", "--stdin"], { action: "prepare", feedback_id: globalFeedback[0].id });
  assert.equal(prepared.group.name, "global");
  ok(root, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "unrelated feedback",
    selected_turns: [{ user: "unrelated user", assistant: "unrelated assistant" }],
    model: null, group: null,
  });
  const replacement = extraction("quote-1", { name: "other", certain: true, summary: "reprocessed summary" });
  replacement.evidence.actual_behavior = "reprocessed actual quote-1";
  const applied = ok(root, ["feedback-reprocess", "--stdin"], {
    action: "apply", feedback_id: globalFeedback[0].id,
    group_id: prepared.group.id, expected_digest: prepared.expected_digest,
    expected_group_digest: prepared.group.base_digest,
    extraction: replacement,
    model: { provider: "new-provider", id: "new-model", thinking: "high" },
  });
  const after = learning(root);
  const updatedFeedback = after.feedback.find((item: Json) => item.id === globalFeedback[0].id);
  const updatedEvidence = after.evidence.find((item: Json) => item.feedback_id === globalFeedback[0].id);
  assert.equal(after.feedback.length, before.feedback.length + 1);
  assert.equal(after.evidence.length, before.evidence.length);
  assert.equal(updatedFeedback.id, oldFeedback.id);
  assert.equal(updatedEvidence.id, oldEvidence.id);
  assert.equal(updatedEvidence.created_at, oldEvidence.created_at);
  assert.equal(updatedEvidence.summary, "reprocessed summary");
  assert.equal(updatedFeedback.model.id, "new-model");
  assert.equal(updatedFeedback.reason, oldFeedback.reason);
  assert.deepEqual(updatedFeedback.selected_turns, oldFeedback.selected_turns);
  assert.deepEqual(groups(root).groups.find((item: Json) => item.name === "global").rules.map((item: Json) => item.text), ["formal-rule"]);
  assert.equal(applied.invalidated_proposal_count, 1);
  assert.equal(after.proposals.find((item: Json) => item.id === globalProposal.id).status, "stale");
  assert.equal(after.proposals.find((item: Json) => item.id === otherProposal.id).status, "pending");

  const oldGeneration = cli(root, ["save-evolution", "--stdin"], {
    group_id: globalPrepared.group.id,
    base_digest: globalPrepared.base_digest,
    evidence_digest: globalPrepared.evidence_digest,
    evidence_ids: globalPrepared.evidence.map((item: Json) => item.id),
    proposed_rules: ["stale generated rule"], rationale: "stale generation",
  });
  assert.equal(oldGeneration.ok, false);
  assert.match(oldGeneration.error.message, /evidence changed/);

  const conflictPrepared = ok(root, ["feedback-reprocess", "--stdin"], { action: "prepare", feedback_id: globalFeedback[0].id });
  const firstConflictApply = {
    action: "apply", feedback_id: globalFeedback[0].id,
    group_id: conflictPrepared.group.id, expected_digest: conflictPrepared.expected_digest,
    expected_group_digest: conflictPrepared.group.base_digest,
    extraction: extraction("quote-1", { name: "global", certain: true, summary: "newer concurrent result" }),
    model: { provider: "new-provider", id: "newer-model", thinking: "high" },
  };
  ok(root, ["feedback-reprocess", "--stdin"], firstConflictApply);
  const rejectedConflict = cli(root, ["feedback-reprocess", "--stdin"], {
    ...firstConflictApply,
    extraction: extraction("quote-1", { name: "global", certain: true, summary: "must not overwrite" }),
  });
  assert.equal(rejectedConflict.ok, false);
  assert.match(rejectedConflict.error.message, /changed before reprocess apply/);
  assert.equal(ok(root, ["feedback-get", "--stdin"], { feedback_id: globalFeedback[0].id }).evidence.summary, "newer concurrent result");

  const freshEvolution = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  ok(root, ["save-evolution", "--stdin"], {
    group_id: freshEvolution.group.id,
    base_digest: freshEvolution.base_digest,
    evidence_digest: freshEvolution.evidence_digest,
    evidence_ids: freshEvolution.evidence.map((item: Json) => item.id),
    proposed_rules: ["pending during failed write"], rationale: "must stay pending",
  });
  const failingPrepare = ok(root, ["feedback-reprocess", "--stdin"], { action: "prepare", feedback_id: globalFeedback[0].id });
  const failingPayload = {
    action: "apply", feedback_id: globalFeedback[0].id,
    group_id: failingPrepare.group.id, expected_digest: failingPrepare.expected_digest,
    expected_group_digest: failingPrepare.group.base_digest,
    extraction: extraction("quote-1", { name: "global", certain: true, summary: "failed write result" }),
    model: { provider: "write", id: "failure", thinking: "high" },
  };
  const beforeFailedWrite = readFileSync(join(root, "local/learning.json"), "utf8");
  const script = [
    "from pathlib import Path",
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(pythonRoot)})`,
    "import wikiskill_preference as cli",
    "from wikiskill_preference_core.storage import PreferenceStore",
    `store = PreferenceStore(Path(${JSON.stringify(root)}))`,
    `payload = json.loads(${JSON.stringify(JSON.stringify(failingPayload))})`,
    "store.write_learning = lambda _value: (_ for _ in ()).throw(OSError('write failed'))",
    "try:",
    "    cli._feedback_reprocess(store, payload)",
    "except OSError:",
    "    pass",
  ].join("\n");
  const failedWrite = spawnSync("python3", ["-c", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(failedWrite.status, 0, failedWrite.stderr);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeFailedWrite);
  const unchanged = ok(root, ["feedback-reprocess", "--stdin"], {
    action: "apply", feedback_id: globalFeedback[0].id,
    group_id: failingPrepare.group.id, expected_digest: failingPrepare.expected_digest,
    expected_group_digest: failingPrepare.group.base_digest,
    extraction: failingPrepare.feedback.extraction,
    model: { provider: "same", id: "content", thinking: "high" },
  });
  assert.equal(unchanged.invalidated_proposal_count, 0);
  assert.equal(learning(root).proposals.at(-1).status, "pending");
});

test("R08 an already-open candidate cannot report success after reprocess invalidates it", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  for (let index = 1; index <= 3; index += 1) addCliEvidence(root, index);
  const evolution = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  const proposal = ok(root, ["save-evolution", "--stdin"], {
    group_id: evolution.group.id,
    base_digest: evolution.base_digest,
    evidence_digest: evolution.evidence_digest,
    evidence_ids: evolution.evidence.map((item: Json) => item.id),
    proposed_rules: ["must not apply"], rationale: "opened before reprocess",
  }).proposal;
  const flow = harness(t, {
    root,
    detailInputs: [[]],
    selectReply: (title, choices) => title === "处理待办" ? choices.find((item) => item.includes("规则候选")) : undefined,
  });
  const reviewing = flow.menu("处理待办");
  await waitFor(() => flow.renderedViews.flat().some((line) => line.includes("规则组：global")), "open candidate preview");
  const prepared = ok(root, ["feedback-reprocess", "--stdin"], { action: "prepare", feedback_id: learning(root).feedback[0].id });
  ok(root, ["feedback-reprocess", "--stdin"], {
    action: "apply", feedback_id: prepared.feedback.id,
    group_id: prepared.group.id, expected_digest: prepared.expected_digest,
    expected_group_digest: prepared.group.base_digest,
    extraction: extraction("quote-1", { name: "global", certain: true, summary: "candidate invalidating update" }),
    model: { provider: "other-session", id: "other-model", thinking: "high" },
  });
  assert.equal(learning(root).proposals.find((item: Json) => item.id === proposal.id).status, "stale");
  flow.sendLastCustom("a");
  await reviewing;
  assert.ok(flow.notices.some((item) => item.message.includes("候选已失效") && item.message.includes("未应用")));
  assert.equal(flow.notices.some((item) => item.message.includes("规则已确认应用")), false);
  assert.equal(groups(root).groups[0].rules.length, 0);
});

test("B01/B09 feedback returns before a delayed model and uses the submission snapshot", async (t) => {
  const gate = deferred<ModelReply>();
  const originalRoot = temporaryRoot(t);
  const otherRoot = temporaryRoot(t);
  const longAssistant = `${"长内容".repeat(10_000)}TAIL-UNIQUE`;
  const branch = [
    ...completedBranch(1, "unselected"),
    { type: "message", message: { role: "user", content: [{ type: "text", text: "selected-user" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: longAssistant }], stopReason: "stop" } },
  ];
  const flow = harness(t, { root: originalRoot, branch, modelReply: () => gate.promise });
  await flow.pref("feedback --group global good complete historical reason");
  assert.equal(flow.modelCalls, 1);
  assert.match(flow.prompts[0]!, /complete historical reason/);
  assert.match(flow.prompts[0]!, /assistant 正文只用于描述被评价的实际行为/);
  assert.match(flow.prompts[0]!, /不能当成用户认可的偏好规则/);
  assert.match(flow.prompts[0]!, /TAIL-UNIQUE/);
  assert.doesNotMatch(flow.prompts[0]!, /unselected-user|unselected-assistant/);
  assert.equal(learning(originalRoot).feedback.length, 1);
  assert.equal(learning(originalRoot).evidence.length, 0);
  assert.equal(flow.events.filter((event) => event === "custom").length, 1);
  assert.ok(flow.statuses.some((status) => status?.includes("后台处理中")));
  process.env.PI_PREFERENCE_DATA_ROOT = otherRoot;
  flow.ctx.model = { provider: "changed", id: "changed-model", reasoning: false };
  flow.ctx.thinkingLevel = "off";
  gate.resolve(extraction("TAIL-UNIQUE", { summary: "background summary" }));
  await waitFor(() => learning(originalRoot).feedback[0].status === "organized", "background organization");
  assert.equal(learning(originalRoot).feedback[0].model.id, "fake-model");
  assert.equal(learning(originalRoot).feedback[0].model.thinking, "high");
  assert.equal(learning(originalRoot).feedback[0].selected_turns[0].assistant, longAssistant);
  assert.equal(existsSync(join(otherRoot, "local/learning.json")), false);
  assert.equal(flow.modelRequests[0].model.id, "fake-model");
  assert.equal(flow.modelRequests[0].request.reasoning, "high");
  assert.equal(flow.events.filter((event) => event === "custom").length, 1);
  await waitFor(() => flow.notices.some((item) => item.message.includes("background summary") && item.message.includes("打开 /pref → 反馈与证据")), "background summary notice");
  assert.equal(flow.sentMessages, 0);
});

test("B02 dashboard feedback exits and empty or cancelled selection saves nothing", async (t) => {
  const panel = harness(t, {
    selectReply: (title, choices) => title === "个人偏好" ? "记录反馈" : title === "评价助手结果" ? "good" : choices[0],
    inputReplies: ["panel reason"],
  });
  await panel.pref("");
  assert.equal(panel.selects.filter((item) => item.title === "个人偏好").length, 1);
  const mainMenu = panel.selects.find((item) => item.title === "个人偏好")!.choices;
  assert.ok(mainMenu.includes("反馈与证据") && mainMenu.includes("重新整理反馈") && mainMenu.includes("处理待办"));
  await waitFor(() => learning(panel.root).feedback[0]?.status === "organized", "panel feedback");

  const empty = harness(t, { pickerInputs: [["\r"]] });
  await empty.pref("feedback --group global good reason");
  assert.equal(empty.modelCalls, 0);
  assert.equal(learning(empty.root).feedback.length, 0);
  const cancelled = harness(t, { pickerInputs: [["\x1b"]] });
  await cancelled.pref("feedback --group global fix reason");
  assert.equal(cancelled.modelCalls, 0);
  assert.equal(learning(cancelled.root).feedback.length, 0);
});

test("B03 uncertain extraction waits without dialogs and manual grouping reuses it", async (t) => {
  let pendingSelections = 0;
  const flow = harness(t, {
    modelReply: () => extraction("selected-assistant-0", { name: null, certain: false, summary: "saved uncertain evidence" }),
    selectReply: (title, choices) => {
      if (title === "处理待办") { pendingSelections += 1; return choices[0]; }
      if (title === "确定反馈所属组") return "global";
      return undefined;
    },
  });
  await flow.pref("feedback fix uncertain reason");
  await waitFor(() => learning(flow.root).feedback[0]?.status === "pending_group", "pending group");
  assert.equal(flow.modelCalls, 1);
  assert.equal(flow.selects.filter((item) => item.title === "确定反馈所属组").length, 0);
  assert.equal(learning(flow.root).feedback[0].extraction.evidence.summary, "saved uncertain evidence");
  await waitFor(() => flow.statuses.some((status) => status?.includes("待处理1")), "pending status");
  await flow.menu("处理待办");
  await waitFor(() => learning(flow.root).feedback[0]?.status === "organized", "manual grouping");
  assert.equal(flow.modelCalls, 1);
  assert.equal(pendingSelections, 1);
});

test("F01 expired explicit groups require a manual choice and keep the saved extraction", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "coding", description: "coding preferences" });
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "explicit group later removed",
    selected_turns: [{ user: "selected user", assistant: "selected assistant" }],
    model: { provider: "old", id: "old", thinking: "high" }, group: "coding",
  });
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: created.feedback.id,
    extraction: extraction("selected assistant", { name: "global", certain: true, summary: "saved before group removal" }),
    model: { provider: "old", id: "old", thinking: "high" },
  });
  ok(root, ["manage-group", "--stdin"], { action: "delete", group: "coding" });

  let selectedGroup: string | undefined;
  const flow = harness(t, {
    root,
    selectReply: (title, choices) => {
      if (title === "处理待办") return choices[0];
      if (title === "确定反馈所属组") return selectedGroup;
      return undefined;
    },
  });
  await flow.menu("处理待办");
  assert.equal(flow.selects.filter((item) => item.title === "确定反馈所属组").length, 1);
  assert.equal(learning(root).evidence.length, 0);
  assert.equal(learning(root).feedback[0].extraction.evidence.summary, "saved before group removal");

  selectedGroup = "global";
  await flow.menu("处理待办");
  assert.equal(learning(root).evidence.length, 1);
  assert.equal(learning(root).feedback[0].status, "organized");
  assert.equal(flow.modelCalls, 0);
});

test("B04/B05 proposals stay noninteractive until pending review and six-evidence input is complete", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal-rule" });
  let extractionCount = 0;
  let pendingPick = "proposal";
  const flow = harness(t, {
    root,
    detailInputs: [["\x1b"], ["r"], ["a"]],
    selectReply: (title, choices) => {
      if (title !== "处理待办") return undefined;
      return pendingPick === "proposal"
        ? choices.find((item) => item.includes("规则候选"))
        : choices.find((item) => item.includes("规则建议"));
    },
    modelReply: (prompt) => {
      if (prompt.includes("反馈整理器")) {
        extractionCount += 1;
        return extraction("selected-assistant-0", { summary: `evidence-${extractionCount}` });
      }
      return extractionCount <= 3
        ? { proposed_rules: ["formal-rule", "rule-one"], rationale: "first three" }
        : { proposed_rules: ["formal-rule", "rule-two"], rationale: "all six" };
    },
  });
  for (let index = 1; index <= 3; index += 1) {
    await flow.pref(`feedback --group global fix original-reason-${index}`);
    await waitFor(() => learning(root).feedback.filter((item: Json) => item.status === "organized").length === index, `organized ${index}`);
  }
  await waitFor(() => learning(root).proposals.some((item: Json) => item.status === "pending"), "first proposal");
  assert.equal(flow.selects.some((item) => item.title.includes("应用")), false);
  await flow.menu("处理待办");
  assert.equal(learning(root).proposals.at(-1).status, "pending");
  await flow.menu("处理待办");
  assert.equal(learning(root).proposals.at(-1).status, "rejected");
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["formal-rule"]);

  for (let index = 4; index <= 6; index += 1) {
    await flow.pref(`feedback --group global good original-reason-${index}`);
    await waitFor(() => learning(root).feedback.filter((item: Json) => item.status === "organized").length === index, `organized ${index}`);
  }
  await waitFor(() => learning(root).proposals.filter((item: Json) => item.status === "pending").length === 1, "second proposal");
  const evolutionPrompts = flow.prompts.filter((prompt) => prompt.includes("规则演化器"));
  assert.equal(evolutionPrompts.length, 2);
  for (let index = 1; index <= 6; index += 1) {
    assert.match(evolutionPrompts[1]!, new RegExp(`evidence-${index}`));
    assert.match(evolutionPrompts[1]!, new RegExp(`original-reason-${index}`));
  }
  assert.match(evolutionPrompts[1]!, /"role":"assistant"/);
  assert.match(evolutionPrompts[1]!, /formal-rule/);
  await flow.menu("处理待办");
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["formal-rule", "rule-two"]);
  const injected = await flow.handler("before_agent_start")!({ systemPrompt: "base" }, flow.ctx);
  assert.match(injected.systemPrompt, /formal-rule|rule-two/);
  assert.doesNotMatch(injected.systemPrompt, /evidence-|original-reason-|first three|all six/);
});

test("B06 evidence changes during generation preserve data and leave regeneration pending", async (t) => {
  const evolutionGate = deferred<ModelReply>();
  let extractionCount = 0;
  let evolutionCount = 0;
  const flow = harness(t, {
    selectReply: (title, choices) => title === "处理待办" ? choices.find((item) => item.includes("规则建议")) : undefined,
    modelReply: (prompt) => {
      if (prompt.includes("反馈整理器")) {
        extractionCount += 1;
        return extraction("selected-assistant-0", { summary: `change-${extractionCount}` });
      }
      evolutionCount += 1;
      return evolutionCount === 1 ? evolutionGate.promise : { proposed_rules: ["regenerated"], rationale: "fresh full input" };
    },
  });
  for (let index = 1; index <= 3; index += 1) {
    await flow.pref(`feedback --group global good r${index}`);
    await waitFor(() => learning(flow.root).feedback.filter((item: Json) => item.status === "organized").length === index, `first ${index}`);
  }
  await waitFor(() => flow.modelCalls === 4, "delayed evolution call");
  await flow.pref("feedback --group global good r4");
  await waitFor(() => learning(flow.root).feedback.filter((item: Json) => item.status === "organized").length === 4, "fourth evidence");
  evolutionGate.resolve({ proposed_rules: ["stale"], rationale: "old input" });
  await waitFor(() => flow.notices.some((item) => item.message.includes("全部证据已保留")), "input change notice");
  assert.equal(learning(flow.root).proposals.length, 0);
  assert.equal(ok(flow.root, ["pending-list"]).evolution_groups[0].new_evidence_count, 4);
  await flow.menu("处理待办");
  assert.ok(flow.notices.some((item) => item.message.includes("已交给后台生成")));
  await waitFor(() => learning(flow.root).proposals.some((item: Json) => item.status === "pending"), "regenerated proposal");
  assert.equal(evolutionCount, 2);
});

test("R02 default evidence detail hides raw feedback metadata and reaches the model-result tail", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const first = addCliEvidence(root, 1, "user");
  assert.equal(ok(root, ["feedback-get", "--stdin"], { feedback_id: first.id }).quote_sources[0].role, "user");
  const longEvidence = `${"model result ".repeat(100)}EVIDENCE-TAIL`;
  const secondCreated = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "REASON-SENTINEL",
    selected_turns: [{ user: "shared second user", assistant: "assistant-only shared RAW-CONVERSATION-SENTINEL" }],
    model: { provider: "MODEL-SENTINEL", id: "fake", thinking: "high" }, group: "global",
  });
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: secondCreated.feedback.id,
    extraction: {
      group: { name: "global", certain: true, reason: "group" },
      evidence: {
        summary: longEvidence, actual_behavior: "detail actual", expected_behavior: "detail expected",
        applicability: "detail scope", supporting_quotes: ["shared", "assistant-only"],
      },
    },
    model: { provider: "fake", id: "fake", thinking: "high" },
  });
  ok(root, ["feedback-complete", "--stdin"], { feedback_id: secondCreated.feedback.id, group: "global" });
  const document = learning(root);
  document.feedback[0].created_at = "2026-01-01T00:00:00+00:00";
  document.feedback[0].reason = "REASON-SENTINEL";
  document.feedback[1].created_at = "2026-01-01T00:00:00+00:00";
  const secondEvidence = document.evidence.find((item: Json) => item.feedback_id === secondCreated.feedback.id);
  secondEvidence.supporting_quotes.push("legacy unknown");
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(document)}\n`);

  const flow = harness(t, {
    root, terminalRows: 24, terminalColumns: 60,
    detailInputs: [[...Array(30).fill("\x1b[6~"), "\x1b"]],
    selectReply: (title, choices) => title === "反馈与证据"
      ? choices.find((item) => item.includes(secondCreated.feedback.id.slice(-8)))
      : undefined,
  });
  await flow.menu("反馈与证据");
  const rendered = flow.renderedViews.flat().join("\n");
  assert.match(rendered, /EVIDENCE-TAIL/);
  assert.doesNotMatch(rendered, /RAW-CONVERSATION-SENTINEL|REASON-SENTINEL|MODEL-SENTINEL/);
  assert.match(rendered, /\[both\] shared/);
  assert.match(rendered, /\[assistant\] assistant-only/);
  assert.match(rendered, /\[unknown\] legacy unknown/);
  assert.doesNotMatch(rendered, new RegExp(first.id.slice(-8)));
});

test("R03/R04 reprocess blocks for a fresh model result and preserves data until explicit apply", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const created = addCliEvidence(root, 1);
  const gate = deferred<ModelReply>();
  const flow = harness(t, {
    root,
    detailInputs: [["r"]],
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => gate.promise,
  });
  const before = readFileSync(join(root, "local/learning.json"), "utf8");
  let settled = false;
  const running = flow.menu("重新整理反馈").then(() => { settled = true; });
  await waitFor(() => flow.modelCalls === 1, "blocking reprocess model");
  assert.equal(settled, false);
  assert.match(flow.renderedViews.flat().join("\n"), /重新整理中，Esc 取消/);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  assert.match(flow.prompts[0]!, /original reason 1|user-1|assistant-1/);
  gate.resolve(extraction("quote-1", { name: "global", certain: true, summary: "fresh preview result" }));
  await running;
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  assert.equal(flow.modelCalls, 1);
  assert.ok(flow.renderedViews.flat().join("\n").includes("fresh preview result"));
  assert.equal(ok(root, ["feedback-get", "--stdin"], { feedback_id: created.id }).feedback.status, "organized");

  const invalid = harness(t, {
    root,
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => "not-json",
  });
  const beforeInvalid = readFileSync(join(root, "local/learning.json"), "utf8");
  await invalid.menu("重新整理反馈");
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeInvalid);
  assert.equal(learning(root).feedback.find((item: Json) => item.id === created.id).status, "organized");
  assert.ok(invalid.notices.some((item) => item.message.includes("不可应用")));
});

test("R05 confirmed reprocess overwrites evidence in place without changing feedback or rules", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal-kept" });
  const created = addCliEvidence(root, 1);
  const before = learning(root);
  const oldFeedback = before.feedback.find((item: Json) => item.id === created.id);
  const oldEvidence = before.evidence.find((item: Json) => item.feedback_id === created.id);
  const replacement = extraction("quote-1", { name: "other-model-suggestion", certain: true, summary: "confirmed replacement" });
  replacement.evidence.actual_behavior = "confirmed actual quote-1";
  const flow = harness(t, {
    root,
    detailInputs: [["a"]],
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => replacement,
  });
  await flow.menu("重新整理反馈");
  const after = learning(root);
  const feedback = after.feedback.find((item: Json) => item.id === created.id);
  const evidence = after.evidence.find((item: Json) => item.feedback_id === created.id);
  assert.equal(flow.modelCalls, 1);
  assert.equal(after.feedback.length, before.feedback.length);
  assert.equal(after.evidence.length, before.evidence.length);
  assert.equal(feedback.id, oldFeedback.id);
  assert.equal(evidence.id, oldEvidence.id);
  assert.equal(evidence.created_at, oldEvidence.created_at);
  assert.equal(evidence.summary, "confirmed replacement");
  assert.equal(feedback.model.id, "fake-model");
  assert.equal(feedback.reason, oldFeedback.reason);
  assert.deepEqual(feedback.selected_turns, oldFeedback.selected_turns);
  assert.equal(feedback.group_name, "global");
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["formal-kept"]);
  assert.ok(flow.notices.some((item) => item.message.includes("证据已覆盖，正式规则未改变")));
});

test("R06 reprocess chooses groups only after the model when no valid original group exists", async (t) => {
  const certainRoot = temporaryRoot(t);
  ok(certainRoot, ["init"]);
  const certain = ok(certainRoot, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "ungrouped certain",
    selected_turns: [{ user: "certain user", assistant: "certain assistant" }],
    model: null, group: null,
  });
  const certainFlow = harness(t, {
    root: certainRoot,
    detailInputs: [["a"]],
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => extraction("certain assistant", { name: "global", certain: true }),
  });
  await certainFlow.menu("重新整理反馈");
  assert.equal(certainFlow.selects.some((item) => item.title === "确定重新整理后的分组"), false);
  assert.equal(learning(certainRoot).feedback.length, 1);
  assert.equal(learning(certainRoot).evidence.length, 1);
  assert.equal(learning(certainRoot).feedback[0].id, certain.feedback.id);

  const uncertainRoot = temporaryRoot(t);
  ok(uncertainRoot, ["init"]);
  ok(uncertainRoot, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "ungrouped uncertain",
    selected_turns: [{ user: "uncertain user", assistant: "uncertain assistant" }],
    model: null, group: null,
  });
  const uncertainFlow = harness(t, {
    root: uncertainRoot,
    detailInputs: [["a"]],
    selectReply: (title, choices) => title === "重新整理反馈"
      ? choices[0]
      : title === "确定重新整理后的分组" ? "global" : undefined,
    modelReply: () => extraction("uncertain assistant", { name: null, certain: false }),
  });
  await uncertainFlow.menu("重新整理反馈");
  const modelEvent = uncertainFlow.events.indexOf("model");
  const groupEvent = uncertainFlow.events.indexOf("select:确定重新整理后的分组");
  assert.ok(modelEvent >= 0 && groupEvent > modelEvent);
  assert.equal(uncertainFlow.modelCalls, 1);
  assert.equal(learning(uncertainRoot).evidence.length, 1);

  const expiredRoot = temporaryRoot(t);
  ok(expiredRoot, ["init"]);
  ok(expiredRoot, ["manage-group", "--stdin"], { action: "create", name: "coding", description: "coding" });
  const expired = ok(expiredRoot, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "expired original group",
    selected_turns: [{ user: "expired user", assistant: "expired assistant" }],
    model: null, group: "coding",
  });
  ok(expiredRoot, ["manage-group", "--stdin"], { action: "delete", group: "coding" });
  const expiredFlow = harness(t, {
    root: expiredRoot,
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => extraction("expired assistant", { name: "global", certain: true }),
  });
  await expiredFlow.menu("重新整理反馈");
  assert.equal(expiredFlow.selects.filter((item) => item.title === "确定重新整理后的分组").length, 1);
  assert.equal(expiredFlow.modelCalls, 1);
  assert.equal(learning(expiredRoot).feedback[0].id, expired.feedback.id);
  assert.equal(learning(expiredRoot).evidence.length, 0);
});

test("G01 shutdown during delayed prepare prevents later model and UI startup", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  addCliEvidence(root, 1);
  const wrapper = join(root, "delayed-prepare.py");
  const startedFile = join(root, "prepare-started");
  const releaseFile = join(root, "prepare-release");
  writeFileSync(wrapper, [
    "import os, signal, subprocess, sys, time",
    `real_cli = ${JSON.stringify(cliPath)}`,
    "if sys.argv[1] != 'feedback-reprocess':",
    "    os.execv(sys.executable, [sys.executable, real_cli, *sys.argv[1:]])",
    "payload = sys.stdin.buffer.read()",
    "if b'\"action\":\"prepare\"' not in payload:",
    "    result = subprocess.run([sys.executable, real_cli, *sys.argv[1:]], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "    os.write(1, result.stdout)",
    "    os.write(2, result.stderr)",
    "    raise SystemExit(result.returncode)",
    "signal.signal(signal.SIGTERM, lambda _signum, _frame: None)",
    `open(${JSON.stringify(startedFile)}, 'w').close()`,
    `while not os.path.exists(${JSON.stringify(releaseFile)}):`,
    "    time.sleep(0.01)",
    "result = subprocess.run([sys.executable, real_cli, *sys.argv[1:]], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "os.write(1, result.stdout)",
    "os.write(2, result.stderr)",
    "raise SystemExit(result.returncode)",
  ].join("\n"));
  const flow = harness(t, {
    root,
    preferenceCli: wrapper,
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
  });
  const before = readFileSync(join(root, "local/learning.json"), "utf8");
  const running = flow.menu("重新整理反馈");
  await waitFor(() => existsSync(startedFile), "delayed prepare start");
  assert.equal(flow.modelCalls, 0);
  assert.equal(flow.events.filter((item) => item === "custom").length, 0);
  const notices = flow.notices.length;
  const shutdownStarted = Date.now();
  await flow.shutdown("reload");
  assert.ok(Date.now() - shutdownStarted < 1_000);
  writeFileSync(releaseFile, "release\n");
  await running;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(flow.modelCalls, 0);
  assert.equal(flow.events.filter((item) => item === "custom").length, 0);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  assert.equal(flow.notices.length, notices);
});

test("R10 reprocess cancel and shutdown discard ignored-abort late responses", async (t) => {
  const shutdownRoot = temporaryRoot(t);
  ok(shutdownRoot, ["init"]);
  addCliEvidence(shutdownRoot, 1);
  const shutdownGate = deferred<ModelReply>();
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  const shutdownFlow = harness(t, {
    root: shutdownRoot,
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => shutdownGate.promise,
  });
  const beforeShutdown = readFileSync(join(shutdownRoot, "local/learning.json"), "utf8");
  const running = shutdownFlow.menu("重新整理反馈");
  await waitFor(() => shutdownFlow.modelCalls === 1, "reprocess model before shutdown");
  const noticeCount = shutdownFlow.notices.length;
  const started = Date.now();
  await shutdownFlow.shutdown("reload");
  assert.ok(Date.now() - started < 1_000);
  await running;
  shutdownGate.resolve(extraction("quote-1", { summary: "late reprocess result" }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(readFileSync(join(shutdownRoot, "local/learning.json"), "utf8"), beforeShutdown);
  assert.equal(shutdownFlow.notices.length, noticeCount);
  assert.equal(shutdownFlow.events.filter((item) => item === "custom").length, 1);

  const escapeRoot = temporaryRoot(t);
  ok(escapeRoot, ["init"]);
  addCliEvidence(escapeRoot, 1);
  const escapeGate = deferred<ModelReply>();
  const escapeFlow = harness(t, {
    root: escapeRoot,
    loaderInputs: [["\x1b"]],
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => escapeGate.promise,
  });
  const beforeEscape = readFileSync(join(escapeRoot, "local/learning.json"), "utf8");
  await escapeFlow.menu("重新整理反馈");
  assert.equal(escapeFlow.modelCalls, 1);
  escapeGate.resolve(extraction("quote-1", { summary: "late after escape" }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(readFileSync(join(escapeRoot, "local/learning.json"), "utf8"), beforeEscape);

  const previewRoot = temporaryRoot(t);
  ok(previewRoot, ["init"]);
  addCliEvidence(previewRoot, 1);
  const previewFlow = harness(t, {
    root: previewRoot,
    detailInputs: [[]],
    selectReply: (title, choices) => title === "重新整理反馈" ? choices[0] : undefined,
    modelReply: () => extraction("quote-1", { summary: "preview before shutdown" }),
  });
  const beforePreview = readFileSync(join(previewRoot, "local/learning.json"), "utf8");
  const previewRunning = previewFlow.menu("重新整理反馈");
  await waitFor(() => previewFlow.renderedViews.flat().some((line) => line.includes("preview before shutdown")), "reprocess preview before shutdown");
  const previewNotices = previewFlow.notices.length;
  await previewFlow.shutdown("reload");
  await previewRunning;
  assert.equal(readFileSync(join(previewRoot, "local/learning.json"), "utf8"), beforePreview);
  assert.equal(previewFlow.notices.length, previewNotices);
  assert.deepEqual(unhandled, []);
});

test("B10 shutdown blocks a late first-stage extraction result", async (t) => {
  const gate = deferred<ModelReply>();
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  const flow = harness(t, { modelReply: () => gate.promise });
  await flow.pref("feedback --group global fix delayed-extraction");
  assert.equal(flow.modelCalls, 1);
  assert.equal(learning(flow.root).feedback[0].status, "saved");
  assert.equal(learning(flow.root).feedback[0].extraction, null);
  const beforeShutdownNotices = flow.notices.length;
  const started = Date.now();
  await flow.shutdown("reload");
  assert.ok(Date.now() - started < 1_000);
  gate.resolve(extraction("selected-assistant-0", { summary: "late extraction" }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const stored = learning(flow.root);
  assert.equal(stored.feedback[0].status, "saved");
  assert.equal(stored.feedback[0].extraction, null);
  assert.equal(stored.evidence.length, 0);
  assert.equal(stored.proposals.length, 0);
  assert.equal(flow.notices.length, beforeShutdownNotices);
  assert.deepEqual(unhandled, []);
});

test("B10/F03 shutdown blocks a late second-stage evolution result", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal-before-shutdown" });
  const gate = deferred<ModelReply>();
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  const flow = harness(t, {
    root,
    modelReply: (prompt) => prompt.includes("反馈整理器")
      ? extraction("selected-assistant-0")
      : gate.promise,
  });
  for (let index = 1; index <= 3; index += 1) {
    await flow.pref(`feedback --group global fix delayed-evolution-${index}`);
    await waitFor(() => learning(root).feedback.filter((item: Json) => item.status === "organized").length === index, `organized before shutdown ${index}`);
  }
  await waitFor(() => flow.modelCalls === 4, "second-stage evolution request");
  assert.equal(learning(root).evidence.length, 3);
  assert.equal(learning(root).proposals.length, 0);
  await flow.menu("处理待办");
  assert.equal(flow.modelCalls, 4);
  const beforeShutdownNotices = flow.notices.length;
  const started = Date.now();
  await flow.shutdown("reload");
  assert.ok(Date.now() - started < 1_000);
  gate.resolve({ proposed_rules: ["late-candidate"], rationale: "too late" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const stored = learning(root);
  assert.equal(stored.evidence.length, 3);
  assert.equal(stored.proposals.length, 0);
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["formal-before-shutdown"]);
  assert.equal(flow.notices.length, beforeShutdownNotices);
  assert.deepEqual(unhandled, []);
});

test("B11 model and validation failures preserve feedback, saved extraction retries without extraction", async (t) => {
  const noModel = harness(t, { model: null });
  await noModel.pref("feedback --group global good saved-first");
  assert.equal(noModel.modelCalls, 0);
  assert.equal(learning(noModel.root).feedback[0].status, "failed");

  const invalid = harness(t, { modelReply: () => "not-json" });
  await invalid.pref("feedback --group global fix invalid-json");
  await waitFor(() => learning(invalid.root).feedback[0]?.status === "failed", "invalid JSON failure");
  assert.equal(learning(invalid.root).evidence.length, 0);

  const wrongQuote = harness(t, { modelReply: () => extraction("not selected") });
  await wrongQuote.pref("feedback --group global fix wrong-quote");
  await waitFor(() => learning(wrongQuote.root).feedback[0]?.status === "failed", "quote failure");
  assert.equal(learning(wrongQuote.root).evidence.length, 0);

  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "stored reason",
    selected_turns: [{ user: "stored user", assistant: "stored assistant" }],
    model: { provider: "old", id: "old", thinking: "low" }, group: null,
  });
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: created.feedback.id,
    extraction: extraction("stored assistant", { name: null, certain: false }),
    model: { provider: "old", id: "old", thinking: "low" },
  });
  const retry = harness(t, {
    root,
    selectReply: (title, choices) => title === "处理待办" ? choices[0] : title === "确定反馈所属组" ? "global" : undefined,
  });
  await retry.menu("处理待办");
  assert.equal(learning(root).feedback[0].status, "organized");
  assert.equal(retry.modelCalls, 0);
});

test("F02 unavailable models keep rule generation pending without a false start notice", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  for (let index = 1; index <= 3; index += 1) addCliEvidence(root, index);
  const flow = harness(t, {
    root,
    model: null,
    selectReply: (title, choices) => title === "处理待办" ? choices.find((item) => item.includes("规则建议")) : undefined,
  });
  await flow.menu("处理待办");
  assert.equal(flow.modelCalls, 0);
  assert.equal(learning(root).proposals.length, 0);
  assert.equal(ok(root, ["pending-list"]).evolution_groups.length, 1);
  assert.ok(flow.notices.some((item) => item.message.includes("当前没有可用模型")));
  assert.equal(flow.notices.some((item) => item.message.includes("已交给后台生成")), false);
});

test("Git/file failures and concurrent rule changes preserve the old groups document", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const groupsPath = join(root, "repo/groups.json");
  const original = readFileSync(groupsPath, "utf8");
  const note = join(root, "repo/staged.txt");
  writeFileSync(note, "staged\n");
  spawnSync("git", ["-C", join(root, "repo"), "add", "staged.txt"]);
  assert.equal(cli(root, ["remember", "--stdin"], { group: "global", rule: "must-not-write" }).ok, false);
  assert.equal(readFileSync(groupsPath, "utf8"), original);
  spawnSync("git", ["-C", join(root, "repo"), "reset", "--quiet"]);
  unlinkSync(note);

  const hook = join(root, "repo/.git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  assert.equal(cli(root, ["remember", "--stdin"], { group: "global", rule: "commit-must-fail" }).ok, false);
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

  for (let index = 1; index <= 3; index += 1) addCliEvidence(root, index);
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  ok(root, ["remember", "--stdin"], { group: "global", rule: "concurrent-rule" });
  const stale = cli(root, ["save-evolution", "--stdin"], {
    group_id: prepared.group.id, base_digest: prepared.base_digest, evidence_digest: prepared.evidence_digest,
    evidence_ids: prepared.evidence.map((item: Json) => item.id),
    proposed_rules: ["model-rule"], rationale: "stale model result",
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

test("B12 preference status stays compact while the footer preserves Pi and extension information", () => {
  const status = { enabled: true, groups: 9, rules: 42, sync_state: "clean" };
  assert.equal(formatPreferenceSummary(status, ["global", "code"]), "偏好：global、code");
  assert.equal(formatPreferenceSummary(status, ["global"], { background: true }), "偏好：global · 后台处理中");
  assert.equal(formatPreferenceSummary(status, ["global"], { actionable: 2 }), "偏好：global · 待处理2");
  assert.equal(formatPreferenceSummary(status, ["global"], { background: true, actionable: 2 }), "偏好：global · 后台处理中 · 待处理2");
  assert.equal(formatPreferenceSummary({ enabled: false }, [], { actionable: 1 }), "偏好：停用 · 待处理1");
  for (const rendered of [
    formatPreferenceSummary(status, ["global"]),
    formatPreferenceSummary(status, ["global"], { background: true, actionable: 2 }),
  ]) assert.doesNotMatch(rendered, /9|42|同步|本地|待处理0|模型|预算/);

  const footer = renderPreferenceFooter({
    cwd: "/tmp/project", branch: "feature", sessionName: "session", preferenceStatus: "偏好：global",
    otherStatuses: ["lint:ok"], inputTokens: 1200, outputTokens: 300, cost: 0.125,
    contextPercent: 12.5, contextWindow: 100_000, model: "fake-model", thinkingLevel: "high",
  }, 100).join("\n");
  assert.match(footer, /project.*feature.*session.*偏好：global/);
  assert.match(footer, /↑1.2k.*↓300.*\$0.125.*12.5%\/100k.*fake-model.*high/);
  assert.match(footer, /lint:ok/);
  const unknown = renderPreferenceFooter({ cwd: "/tmp/project", preferenceStatus: "偏好：global", contextWindow: 100_000 }, 80).join("\n");
  assert.doesNotMatch(unknown, /\?\/|no-model/);
});
