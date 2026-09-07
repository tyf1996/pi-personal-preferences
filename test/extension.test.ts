import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FeedbackBackground, type V2Envelope } from "../src/background.ts";
import { parsePrefCommand } from "../src/commands.ts";
import { resolvePreferenceGroup } from "../src/group.ts";
import { formatPreferenceSummary, showPreferenceDashboard } from "../src/dashboard.ts";
import { FeedbackContext } from "../src/feedback-context.ts";
import { ProposalBackground } from "../src/proposal-background.ts";
import { installPreferenceFooter, renderPreferenceFooter } from "../src/footer.ts";
import { completeWithFrozenPiModel } from "../src/pi-model.ts";
import preferenceExtension from "../index.ts";

const CLI = resolve(import.meta.dirname, "../python/wikiskill_preference.py");
const envelope = (data: Record<string, unknown>, generation = 0): V2Envelope => ({ ok: true, data, error: null, cas: { generation } });
const failure = (code: string, message: string, retryable = false): V2Envelope => ({ ok: false, data: null, error: { code, message, retryable }, cas: null });
const fakeSelection = { provider_source: "fake", provider_id: "fake", model_id: "fixture", api_type: "fake", endpoint_fingerprint: "sha256:fixture", thinking_level: "off", max_tokens: 128, timeout_seconds: 1, config_version: 2 };

function ctxFor(session: SessionManager): any { return { sessionManager: session }; }

function tempRoot(): string { return mkdtempSync(join(tmpdir(), "pi-preferences-latest-")); }

function init(root: string): void { execFileSync("python3", [CLI, "init", "--data-root", root], { encoding: "utf8" }); }

function setConfig(root: string, update: (config: any) => void): void {
  const path = join(root, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  update(config);
  writeFileSync(path, JSON.stringify(config), "utf8");
}

let v2RequestCounter = 0;
function runV2(root: string, command: string, action: string, expectedGeneration: number | null, payload: Record<string, unknown>): any {
  return JSON.parse(execFileSync("python3", [CLI, command, "--stdin", "--data-root", root], {
    input: JSON.stringify({ schema_version: 2, request_id: `test-${++v2RequestCounter}`, action, expected_generation: expectedGeneration, payload }),
    encoding: "utf8",
  }));
}

function authorizeFeedback(root: string, feedback: string, snapshot: Record<string, unknown>, selection: Record<string, unknown>, revision: number): any {
  const preview = runV2(root, "feedback", "preview", null, { feedback, snapshot, model_selection: selection });
  return runV2(root, "feedback", "authorize", preview.cas.generation, {
    revision, allowed: true, scope: "single", input_signature: preview.data.input_signature, model_selection: selection,
  });
}

function seedPiFeedbackJob(root: string, selection: Record<string, unknown>): { jobId: string; groupId: string } {
  init(root);
  setConfig(root, (config) => {
    config.learning.extraction.enabled = true;
    config.learning.extraction.thinking_level = selection.thinking_level;
    config.learning.extraction.timeout_seconds = selection.timeout_seconds;
    config.learning.extraction.max_tokens = selection.max_tokens;
  });
  const groupId = JSON.parse(execFileSync("python3", [CLI, "groups", "--data-root", root], { encoding: "utf8" })).groups[0].id;
  const snapshot = { session_id: "session", task_key: "task", user_entry_id: "user", assistant_entry_id: "assistant", user_text: "请简洁回答", assistant_text: "这是当前结果", origin_verified: true, storage_mode: "ask" };
  const authorized = authorizeFeedback(root, "fix: 请简洁", snapshot, selection, 1);
  const created = runV2(root, "feedback", "create", authorized.cas.generation, { feedback: "fix: 请简洁", group_id: groupId, snapshot, model_selection: selection, consent_revision: 1 });
  return { jobId: created.data.job.job_id, groupId };
}

function extractionOutput(groupId: string, assistantText = "这是当前结果"): string {
  return JSON.stringify({
    group_id: groupId,
    target: { type: "assistant_text", description: "回答表达" },
    quote: { source_alias: "assistant_result", text: assistantText },
    observations: ["回答可以更简洁"],
    actual_behavior: "给出了当前结果",
    expected_behavior: "用更简洁的方式回答",
    task_summary: "回答简洁性请求",
    evidence_summary: "用户明确要求更简洁",
    applicability: "一般回答",
    nature: "preference",
    specificity: "specific",
    confidence: 0.9,
    needs_review: false,
  });
}

async function waitForJob(root: string, jobId: string, state: string, timeoutMs = 2_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    const job = jobs.find((item: any) => item.job_id === jobId);
    if (job?.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${jobId} did not reach ${state}`);
}

function feedbackExtensionHarness(session?: SessionManager): { command: { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: (prefix: string) => Promise<unknown> }; events: Map<string, (...args: any[]) => any> } {
  let command: any;
  const events = new Map<string, (...args: any[]) => any>();
  const pi: any = {
    on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
    registerCommand(name: string, value: any) { if (name === "pref") command = value; },
    appendEntry(customType: string, data: unknown) { session?.appendCustomEntry(customType, data); },
  };
  preferenceExtension(pi);
  if (!command) throw new Error("pref command was not registered");
  return { command, events };
}

interface ExtensionHarnessOptions {
  selects?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  editors?: Array<string | undefined>;
  confirms?: boolean[];
  hasUI?: boolean;
  modelResponse?: string | ((prompt: string) => string);
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  session?: SessionManager;
  selectHandler?: (title: string, values: string[]) => string | undefined;
}

function createExtensionHarness(cwd: string, options: ExtensionHarnessOptions = {}) {
  const session = options.session ?? SessionManager.inMemory(cwd);
  const harness = feedbackExtensionHarness(session);
  const notices: Array<{ message: string; level: string }> = [];
  const calls: Array<{ method: string; title: string; options?: string[] }> = [];
  const statuses = new Map<string, string>();
  const selects = [...(options.selects ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const editors = [...(options.editors ?? [])];
  const confirms = [...(options.confirms ?? [])];
  let reloads = 0;
  let sends = 0;
  let reasoning: unknown;
  let authCalls = 0;
  const model = options.modelResponse === undefined ? undefined : {
    provider: "test-provider", id: "test-model", api: "openai-completions", baseUrl: "https://declared.test/v1",
    reasoning: true, contextWindow: 128_000, maxTokens: 8192,
  };
  const ctx: any = {
    cwd,
    mode: "tui",
    hasUI: options.hasUI ?? true,
    sessionManager: session,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRegistry: {
      find: (provider: string, id: string) => provider === model?.provider && id === model?.id ? model : undefined,
      getApiKeyAndHeaders: async () => {
        authCalls += 1;
        return { ok: true, apiKey: "fixture-key", headers: { "x-fixture": "yes" }, env: { FIXTURE: "1" }, baseUrl: "https://resolved.test/v1" };
      },
      getProvider: () => model ? {
        streamSimple: (_selected: unknown, context: any, request: Record<string, unknown>) => {
          sends += 1;
          reasoning = request.reasoning;
          const prompt = String(context?.messages?.at(-1)?.content?.at?.(-1)?.text ?? "");
          const response = typeof options.modelResponse === "function" ? options.modelResponse(prompt) : options.modelResponse;
          return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: response ?? "{}" }] }) };
        },
      } : undefined,
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0.1 }),
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      setFooter() {},
      select: async (title: string, values: string[]) => { calls.push({ method: "select", title, options: [...values] }); return options.selectHandler?.(title, values) ?? selects.shift(); },
      input: async (title: string) => { calls.push({ method: "input", title }); return inputs.shift(); },
      editor: async (title: string) => { calls.push({ method: "editor", title }); return editors.shift(); },
      confirm: async (title: string) => { calls.push({ method: "confirm", title }); return confirms.shift() ?? false; },
    },
    waitForIdle: async () => undefined,
    hasPendingMessages: () => false,
    reload: async () => { reloads += 1; },
  };
  return { ...harness, ctx, session, notices, calls, statuses, get reloads() { return reloads; }, get sends() { return sends; }, get reasoning() { return reasoning; }, get authCalls() { return authCalls; } };
}

function feedbackCommandHarness(_session: SessionManager): { handler: (args: string, ctx: any) => Promise<void> } {
  return feedbackExtensionHarness().command;
}

function sessionWithFeedbackTarget(): SessionManager {
  const session = SessionManager.inMemory("/workspace");
  session.appendMessage({ role: "user", content: "请给出简洁结论", timestamp: Date.now() } as any);
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "这是当前结果" }], stopReason: "stop", timestamp: Date.now() } as any);
  new FeedbackContext().markSettled(ctxFor(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
  return session;
}

test("feedback context uses real active branch references and restores after reload/fork", () => {
  const session = SessionManager.inMemory("/workspace");
  const firstUserId = session.appendMessage({ role: "user", content: "请解释同步状态", timestamp: Date.now() } as any);
  session.appendMessage({ role: "tool", content: "secret raw tool output", timestamp: Date.now() } as any);
  session.appendMessage({ role: "user", content: "补充说明也要区分完成与完整", timestamp: Date.now() } as any);
  session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "同步流程已结束，并说明了完整性。" }], stopReason: "stop", timestamp: Date.now() } as any);
  const context = new FeedbackContext();
  const target = context.markSettled(ctxFor(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
  assert.ok(target);
  assert.equal(target?.userEntryId, firstUserId);
  assert.equal(session.getBranch().some((entry: any) => entry.type === "custom" && JSON.stringify(entry.data).includes("同步流程")), false);
  const restored = new FeedbackContext();
  const targets = restored.restore(ctxFor(session));
  assert.equal(targets[0]?.taskKey, target?.taskKey);
  const snapshot = restored.snapshot(ctxFor(session), target!.taskKey, "ask");
  assert.equal(snapshot?.assistant_text, "同步流程已结束，并说明了完整性。");
  assert.match(snapshot?.user_text ?? "", /请解释同步状态.*补充说明/su);
  assert.doesNotMatch(snapshot?.assistant_text ?? "", /private|tool output/u);
  session.branch(session.getEntry(target!.userEntryId)!.id);
  assert.equal(restored.available(ctxFor(session)).length, 0);
  assert.equal(restored.snapshot(ctxFor(session), target!.taskKey, "ask"), undefined);
});

test("real feedback UI and command report unsaved before prompting when no complete source exists", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const uiAttempt = createExtensionHarness(root, { session: SessionManager.inMemory(root), modelResponse: "{}" });
    await uiAttempt.command.handler("feedback", uiAttempt.ctx);
    assert.equal(uiAttempt.calls.length, 0);
    assert.equal(uiAttempt.authCalls, 0);
    assert.equal(uiAttempt.sends, 0);
    assert.match(uiAttempt.notices.at(-1)?.message ?? "", /本次反馈未保存.*最终助手回复.*重新执行 \/pref feedback/su);

    const commandAttempt = createExtensionHarness(root, { session: SessionManager.inMemory(root), modelResponse: "{}" });
    await commandAttempt.command.handler("feedback --group global good", commandAttempt.ctx);
    assert.equal(commandAttempt.authCalls, 0);
    assert.equal(commandAttempt.sends, 0);
    assert.match(commandAttempt.notices.at(-1)?.message ?? "", /本次反馈未保存/u);
    assert.equal(existsSync(join(root, "local/feedback-jobs.json")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real feedback command persists a markerless legacy target before reporting its job ID", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    setConfig(root, (config) => { config.privacy.context_mode = "local_only"; });
    const session = SessionManager.inMemory(root);
    session.appendMessage({ role: "user", content: "旧会话真实请求", timestamp: Date.now() } as any);
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "旧会话真实最终回复" }], stopReason: "stop", timestamp: Date.now() } as any);
    const harness = createExtensionHarness(root, { session });

    await harness.command.handler("feedback --group global good", harness.ctx);

    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(jobs.length, 1);
    assert.match(harness.notices.at(-1)?.message ?? "", new RegExp(`已保存.*${jobs[0].job_id}`, "u"));
    assert.equal(jobs[0].snapshot_ref !== null, true);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling feedback content selection creates no job and never reports success", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const session = SessionManager.inMemory(root);
    session.appendMessage({ role: "user", content: "可评价请求", timestamp: Date.now() } as any);
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "可评价最终回复" }], stopReason: "stop", timestamp: Date.now() } as any);
    const harness = createExtensionHarness(root, { session, selects: [undefined] });

    await harness.command.handler("feedback", harness.ctx);

    assert.equal(existsSync(join(root, "local/feedback-jobs.json")), false);
    assert.doesNotMatch(harness.notices.map((notice) => notice.message).join("\n"), /已保存|已入队/u);
    assert.match(harness.notices.at(-1)?.message ?? "", /本次反馈未保存.*取消/u);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("latest command grammar has no compatibility domain or evolve paths", () => {
  assert.deepEqual(parsePrefCommand("remember --group coding 优先复用已有设计"), { action: "remember", group: "coding", rule: "优先复用已有设计" });
  assert.deepEqual(parsePrefCommand("feedback --group coding fix 结果过长"), { action: "feedback", group: "coding", sentiment: "fix", reason: "结果过长" });
  assert.throws(() => parsePrefCommand("remember --domain coding rule"));
  assert.throws(() => parsePrefCommand("evolve"));
});

test("latest CLI init, groups, remember and status are isolated to a temporary root", () => {
  const root = tempRoot();
  try {
    init(root);
    const groups = JSON.parse(execFileSync("python3", [CLI, "groups", "--data-root", root], { encoding: "utf8" }));
    const groupId = groups.groups[0].id;
    const remembered = JSON.parse(execFileSync("python3", [CLI, "remember", "--stdin", "--data-root", root], { input: JSON.stringify({ group: "global", rule: "回答先给结论" }), encoding: "utf8" }));
    assert.equal(remembered.group, "global");
    const latest = JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8"));
    assert.equal(latest.groups[0].id, groupId);
    assert.equal(latest.groups[0].rules[0].text, "回答先给结论");
    const status = JSON.parse(execFileSync("python3", [CLI, "status", "--data-root", root], { encoding: "utf8" }));
    assert.equal(typeof status.pending_feedback_count, "number");
    assert.equal("auto_evolve" in JSON.parse(readFileSync(join(root, "config.json"), "utf8")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("footer keeps the dim first-line right summary and preserves location when narrow", () => {
  const summary = formatPreferenceSummary({
    enabled: true, groups: 3, rules: 8, pending_proposal_count: 1, sync_state: "no-remote",
  }, ["global", "coding"]);
  const wide = renderPreferenceFooter({
    cwd: "/workspace/project", branch: "feature", preferenceStatus: summary,
    contextPercent: 12.5, contextWindow: 128_000, model: "gpt-test", thinkingLevel: "high",
  }, 140);
  assert.match(wide[0] ?? "", /^\/workspace\/project \(feature\)/u);
  assert.ok(wide[0]?.endsWith(summary));
  assert.ok(wide[1]?.endsWith("gpt-test • high"));
  const narrow = renderPreferenceFooter({ cwd: "/work", branch: "main", preferenceStatus: summary, contextWindow: 128_000 }, 14);
  assert.match(narrow[0] ?? "", /^\/work/u);
  assert.doesNotMatch(narrow[0] ?? "", /启用/u);

  const colors: string[] = [];
  let factory: any;
  installPreferenceFooter({
    mode: "tui", cwd: "/work", model: undefined,
    sessionManager: { getEntries: () => [], getSessionName: () => undefined },
    getContextUsage: () => null,
    ui: { setFooter: (value: unknown) => { factory = value; } },
  } as any);
  const footer = factory({ requestRender() {} }, { fg: (color: string, value: string) => { colors.push(color); return value; } }, {
    getGitBranch: () => "main", getExtensionStatuses: () => new Map([["personal-preferences", summary]]), onBranchChange: () => () => {},
  });
  footer.render(80);
  assert.deepEqual(colors, ["dim", "dim"]);
});

test("explicit grouping makes zero model requests and Pi grouping receives inherited thinking", async () => {
  const groups = [{ name: "global", description: "通用" }, { name: "coding", description: "代码" }];
  let classificationCalls = 0;
  assert.equal(await resolvePreferenceGroup({
    explicitGroup: "coding", preferenceText: "保持改动聚焦", groups,
    ctx: { hasUI: true, ui: { select: async () => undefined } } as any,
    invokeCli: async () => { classificationCalls += 1; return { group: "global" }; },
  }), "coding");
  assert.equal(classificationCalls, 0);

  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "create", name: "coding", description: "代码任务" }), encoding: "utf8",
    });
    const harness = createExtensionHarness(root, { modelResponse: '{"group":"coding"}', thinkingLevel: "high" });
    await harness.command.handler("remember 复用仓库已有设计", harness.ctx);
    assert.equal(harness.sends, 1);
    assert.equal(harness.reasoning, "high");
    const document = JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(document.groups.find((item: any) => item.name === "coding").rules.map((item: any) => item.text), ["复用仓库已有设计"]);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime injects only effective formal rules without evidence, candidates, sources, or discovery", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    for (const payload of [
      { action: "create", name: "coding", description: "适用于代码实现" },
      { action: "add_rule", group: "coding", rule: "复用已有设计" },
      { action: "create", name: "private", description: "未启用 evidence candidate source" },
    ]) execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], { input: JSON.stringify(payload), encoding: "utf8" });
    execFileSync("python3", [CLI, "set-activation", "--stdin", "--data-root", root], {
      input: JSON.stringify({ target: "directory", key: resolve(root), group: "coding", enabled: true }), encoding: "utf8",
    });
    const harness = createExtensionHarness(root);
    const result = await harness.events.get("before_agent_start")?.({ systemPrompt: "Base", systemPromptOptions: {} }, harness.ctx);
    const prompt = String(result?.systemPrompt);
    assert.match(prompt, /Personal Preference Group: global/u);
    assert.match(prompt, /Personal Preference Group: coding/u);
    assert.match(prompt, /复用已有设计/u);
    assert.doesNotMatch(prompt, /未启用 evidence candidate source/u);
    assert.doesNotMatch(prompt, /EvidenceRevision|Proposal|source_kind/u);
    assert.deepEqual(harness.events.get("resources_discover")?.({}, harness.ctx), {});
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("remember applies on the next turn without reload and completions follow current groups", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "create", name: "coding", description: "代码任务" }), encoding: "utf8",
    });
    const harness = createExtensionHarness(root);
    await harness.command.handler("remember --group coding 保持改动聚焦", harness.ctx);
    assert.equal(harness.reloads, 0);
    let completion = await harness.command.getArgumentCompletions?.("remember --group co") as any;
    assert.deepEqual(completion, [{ value: "coding", label: "coding" }]);
    execFileSync("python3", [CLI, "set-activation", "--stdin", "--data-root", root], {
      input: JSON.stringify({ target: "directory", key: resolve(root), group: "coding", enabled: true }), encoding: "utf8",
    });
    const injected = await harness.events.get("before_agent_start")?.({ systemPrompt: "Base", systemPromptOptions: {} }, harness.ctx);
    assert.match(String(injected?.systemPrompt), /保持改动聚焦/u);
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "create", name: "communication", description: "表达" }), encoding: "utf8",
    });
    completion = await harness.command.getArgumentCompletions?.("feedback --group comm") as any;
    assert.deepEqual(completion, [{ value: "communication", label: "communication" }]);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real dashboard manages groups, rules, activations, sync, rollback, and one-level cancellation", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const run = async (options: ExtensionHarnessOptions) => {
      const harness = createExtensionHarness(root, options);
      await harness.command.handler("", harness.ctx);
      return harness;
    };
    await run({ selects: ["创建偏好组", undefined], inputs: ["coding", "代码任务"] });
    await run({ selects: ["创建偏好组", undefined], inputs: ["communication", "表达任务"] });
    await run({ selects: ["编辑组介绍", "coding", undefined], editors: ["代码、测试和审查"] });
    await run({ selects: ["管理组内规则", "coding", "增加规则", undefined], inputs: ["复用已有设计"] });
    await run({ selects: ["管理组内规则", "coding", "修改规则", "复用已有设计", undefined], editors: ["复用仓库已有设计"] });
    await run({ selects: ["管理组内规则", "coding", "移动到其他组", "复用仓库已有设计", "communication", undefined] });
    await run({ selects: ["管理组内规则", "communication", "删除规则", "复用仓库已有设计", undefined] });
    await run({ selects: ["为当前目录启用组", "coding", undefined] });
    await run({ selects: ["为当前目录禁用组", "coding", undefined] });
    await run({ selects: ["为当前会话启用组", "communication", "为当前会话禁用组", "communication", undefined] });
    const synced = await run({ selects: ["同步偏好仓库", undefined] });
    assert.match(synced.notices.at(-1)?.message ?? "", /同步完成/u);
    await run({ selects: ["管理组内规则", "communication", "增加规则", undefined], inputs: ["用于 rollback 的规则"] });
    await run({ selects: ["撤销最近一次变化", undefined], confirms: [true] });
    const document = JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8"));
    assert.equal(document.groups.find((item: any) => item.name === "coding").description, "代码、测试和审查");
    assert.equal(document.groups.find((item: any) => item.name === "communication").rules.length, 0);
    const activations = JSON.parse(readFileSync(join(root, "local/activations.json"), "utf8"));
    assert.deepEqual(activations.directories, {});
    assert.deepEqual(activations.sessions, {});

    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "add_rule", group: "coding", rule: "导航取消测试" }), encoding: "utf8",
    });
    const cancelled = await run({
      selects: [
        "管理组内规则", "coding", "移动到其他组", "导航取消测试", undefined,
        undefined, undefined, undefined, "查看偏好组", undefined, undefined,
      ],
    });
    assert.deepEqual(cancelled.calls.filter((item) => item.method === "select").map((item) => item.title), [
      "个人偏好", "选择要管理的组", "管理组内规则", "选择规则", "移动到其他组",
      "选择规则", "管理组内规则", "选择要管理的组", "个人偏好", "查看偏好组", "个人偏好",
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("first dashboard initializes only a missing config while invalid config fails closed without writes", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    const first = createExtensionHarness(root, { selects: [undefined] });
    await first.command.handler("", first.ctx);
    assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).schema_version, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8")).groups.map((item: any) => item.name), ["global"]);
    assert.match(first.notices.map((item) => item.message).join("\n"), /已初始化/u);

    const invalidRoot = tempRoot();
    try {
      writeFileSync(join(invalidRoot, "config.json"), JSON.stringify({ schema_version: 2, invalid: true }), "utf8");
      process.env.PI_PREFERENCE_DATA_ROOT = invalidRoot;
      const before = readFileSync(join(invalidRoot, "config.json"), "utf8");
      const invalid = createExtensionHarness(invalidRoot);
      await invalid.command.handler("", invalid.ctx);
      assert.equal(readFileSync(join(invalidRoot, "config.json"), "utf8"), before);
      assert.equal(existsSync(join(invalidRoot, "repo/groups.json")), false);
      assert.match(invalid.notices.at(-1)?.message ?? "", /配置|config|unknown|missing/iu);
    } finally {
      rmSync(invalidRoot, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled false stops prompt injection, edit capture, background claims, and remember", async () => {
  const root = tempRoot();
  const workspace = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    setConfig(root, (config) => {
      config.enabled = false;
      config.learning.extraction.enabled = true;
      config.learning.proposals.enabled = true;
    });
    const harness = createExtensionHarness(workspace);
    await harness.events.get("session_start")?.({}, harness.ctx);
    assert.equal(await harness.events.get("before_agent_start")?.({ systemPrompt: "Base" }, harness.ctx), undefined);
    await harness.events.get("input")?.({ source: "interactive", text: "任务" }, harness.ctx);
    harness.events.get("tool_call")?.({ toolName: "write", toolCallId: "disabled-write", input: { path: "answer.md" } }, harness.ctx);
    writeFileSync(join(workspace, "answer.md"), "agent\n", "utf8");
    harness.events.get("tool_execution_end")?.({ toolCallId: "disabled-write", isError: false }, harness.ctx);
    await harness.events.get("agent_settled")?.({}, harness.ctx);
    writeFileSync(join(workspace, "answer.md"), "user\n", "utf8");
    await harness.events.get("input")?.({ source: "interactive", text: "下一轮" }, harness.ctx);
    assert.equal(existsSync(join(root, "local/feedback-jobs.json")), false);
    await harness.command.handler("remember --group global 不应写入", harness.ctx);
    assert.match(harness.notices.at(-1)?.message ?? "", /停用/u);
    assert.equal(JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8")).groups[0].rules.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed tools and sensitive paths never become user-edit records", async () => {
  const root = tempRoot();
  const workspace = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const harness = createExtensionHarness(workspace);
    await harness.events.get("session_start")?.({}, harness.ctx);
    await harness.events.get("input")?.({ source: "interactive", text: "修改文件" }, harness.ctx);
    harness.events.get("tool_call")?.({ toolName: "write", toolCallId: "failed", input: { path: "failed.md" } }, harness.ctx);
    writeFileSync(join(workspace, "failed.md"), "agent\n", "utf8");
    harness.events.get("tool_execution_end")?.({ toolCallId: "failed", isError: true }, harness.ctx);
    harness.events.get("tool_call")?.({ toolName: "write", toolCallId: "secret", input: { path: ".env" } }, harness.ctx);
    writeFileSync(join(workspace, ".env"), "TOKEN=agent\n", "utf8");
    harness.events.get("tool_execution_end")?.({ toolCallId: "secret", isError: false }, harness.ctx);
    harness.events.get("tool_call")?.({ toolName: "edit", toolCallId: "safe", input: { path: "safe.md" } }, harness.ctx);
    writeFileSync(join(workspace, "safe.md"), "agent\n", "utf8");
    harness.events.get("tool_execution_end")?.({ toolCallId: "safe", isError: false }, harness.ctx);
    await harness.events.get("agent_settled")?.({}, harness.ctx);
    writeFileSync(join(workspace, "failed.md"), "user\n", "utf8");
    writeFileSync(join(workspace, ".env"), "TOKEN=user\n", "utf8");
    writeFileSync(join(workspace, "safe.md"), "user\n", "utf8");
    await harness.events.get("input")?.({ source: "interactive", text: "继续" }, harness.ctx);
    const rows = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].source_context.paths, ["safe.md"]);
    assert.doesNotMatch(JSON.stringify(rows), /TOKEN|failed\.md|\.env/u);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("successful write followed by a user edit creates one weak local record without a snapshot or model wait", async () => {
  const root = tempRoot();
  const workspace = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    init(root);
    const harness = feedbackExtensionHarness();
    const session = SessionManager.inMemory(workspace);
    const ctx: any = {
      cwd: workspace,
      sessionManager: session,
      hasUI: false,
      ui: { notify() {}, setStatus() {} },
    };
    await harness.events.get("input")?.({ source: "interactive", text: "生成文档" }, ctx);
    harness.events.get("tool_call")?.({ toolName: "write", toolCallId: "write-1", input: { path: "answer.md" } }, ctx);
    writeFileSync(join(workspace, "answer.md"), "Agent version\n", "utf8");
    harness.events.get("tool_execution_end")?.({ toolCallId: "write-1", isError: false }, ctx);
    await harness.events.get("agent_settled")?.({}, ctx);
    writeFileSync(join(workspace, "answer.md"), "User version\n", "utf8");
    await harness.events.get("input")?.({ source: "interactive", text: "继续" }, ctx);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].source_kind, "user_edit");
    assert.equal(jobs[0].state, "needs_review");
    assert.equal(jobs[0].snapshot_ref, null);
    assert.equal(jobs[0].model_selection, null);
    assert.deepEqual(jobs[0].source_context.paths, ["answer.md"]);
    assert.match(jobs[0].source_context.diffs["answer.md"], /User version/u);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the real feedback command saves local-only good feedback without resolving auth or inventing a reason", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    setConfig(root, (config) => { config.privacy.context_mode = "local_only"; });
    const session = sessionWithFeedbackTarget();
    let authCalls = 0;
    const notifications: string[] = [];
    const ctx: any = {
      cwd: "/workspace", hasUI: true, sessionManager: session,
      model: { provider: "provider", id: "model", baseUrl: "https://model", reasoning: true },
      modelRegistry: { getApiKeyAndHeaders: async () => { authCalls += 1; throw new Error("OAuth unavailable"); } },
      thinkingLevel: "off", waitForIdle: async () => {},
      ui: { notify: (message: string) => notifications.push(message), setStatus() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false },
    };
    await feedbackCommandHarness(session).handler("feedback --group global good", ctx);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(authCalls, 0);
    assert.equal(jobs[0].feedback, "good");
    assert.equal(jobs[0].model_selection, null);
    assert.equal(jobs[0].state, "blocked_consent");
    assert.match(notifications.join("\n"), /未发送/u);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabling user-edit capture does not disable explicit feedback", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    init(root);
    setConfig(root, (config) => { config.capture_user_edits = false; config.privacy.context_mode = "local_only"; });
    const session = sessionWithFeedbackTarget();
    const ctx: any = {
      cwd: "/workspace",
      sessionManager: session,
      hasUI: false,
      waitForIdle: async () => {},
      modelRegistry: {},
      ui: { notify() {}, setStatus() {} },
    };
    await feedbackCommandHarness(session).handler("feedback --group global good", ctx);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].source_kind, "feedback");
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real dashboard reaches local-only feedback without status or menu OAuth lookup", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const session = sessionWithFeedbackTarget();
    const command = feedbackCommandHarness(session);
    let authCalls = 0;
    let dashboardSelections = 0;
    const notifications: string[] = [];
    const ctx: any = {
      cwd: "/workspace", hasUI: true, sessionManager: session,
      model: { provider: "provider", id: "model", baseUrl: "https://model", reasoning: true },
      modelRegistry: { getApiKeyAndHeaders: async () => { authCalls += 1; throw new Error("OAuth must not run"); } },
      thinkingLevel: "off", waitForIdle: async () => {},
      ui: {
        notify: (message: string) => notifications.push(message), setStatus() {}, input: async () => undefined, confirm: async () => false,
        select: async (title: string, options: string[]) => {
          if (title === "个人偏好") return dashboardSelections++ === 0 ? "仅本机保存反馈" : undefined;
          if (title === "评价当前结果") return "满意";
          if (title === "选择反馈所属组") return options[0];
          return undefined;
        },
      },
    };
    await command.handler("", ctx);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(authCalls, 0);
    assert.match(notifications.join("\n"), /未检查/u);
    assert.equal(jobs[0].state, "blocked_consent");
    assert.equal(jobs[0].model_selection, null);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real headless ask path durably saves local-only feedback with zero auth and zero send", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const session = sessionWithFeedbackTarget();
    let authCalls = 0;
    const ctx: any = {
      cwd: "/workspace", hasUI: false, sessionManager: session,
      model: { provider: "provider", id: "model", baseUrl: "https://model", reasoning: true },
      modelRegistry: { getApiKeyAndHeaders: async () => { authCalls += 1; return { ok: true }; } },
      thinkingLevel: "off", waitForIdle: async () => {},
      ui: { notify() {}, setStatus() {} },
    };
    await feedbackCommandHarness(session).handler("feedback --group global good", ctx);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    const snapshot = JSON.parse(readFileSync(join(root, "local/feedback-snapshots", `${jobs[0].job_id}.json`), "utf8"));
    assert.equal(authCalls, 0);
    assert.equal(jobs[0].state, "blocked_consent");
    assert.equal(jobs[0].model_selection, null);
    assert.equal(snapshot.storage_mode, "local_only");
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real ask path keeps feedback blocked and unbound when Pi auth resolution fails", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    setConfig(root, (config) => { config.learning.extraction.enabled = true; });
    const session = sessionWithFeedbackTarget();
    let authCalls = 0;
    const notifications: string[] = [];
    const ctx: any = {
      cwd: "/workspace", hasUI: true, sessionManager: session,
      model: { provider: "provider", id: "model", baseUrl: "https://declared", reasoning: true },
      modelRegistry: { getApiKeyAndHeaders: async () => { authCalls += 1; throw new Error("OAuth unavailable"); } },
      thinkingLevel: "off", waitForIdle: async () => {},
      ui: { notify: (message: string) => notifications.push(message), setStatus() {}, select: async () => undefined, input: async () => undefined, confirm: async () => true },
    };
    await feedbackCommandHarness(session).handler("feedback --group global good", ctx);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(authCalls, 1);
    assert.equal(jobs[0].state, "blocked_model");
    assert.equal(jobs[0].model_selection, null);
    assert.doesNotMatch(JSON.stringify(jobs[0]), /unavailable|fixture/u);
    assert.match(notifications.join("\n"), /未绑定模型/u);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("background does not claim local-only or extraction-disabled jobs", async () => {
  const background = new FeedbackBackground();
  const calls: string[] = [];
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    calls.push(`${command}:${String((request.payload as any)?.action ?? request.action)}`);
    if (command === "feedback" && request.action === "list") return envelope({ jobs: [] }, 0);
    if (command === "feedback" && request.action === "create") return envelope({ job: { job_id: "job-local" } }, 1);
    throw new Error("unexpected model call");
  };
  const ctx: any = { model: undefined, modelRegistry: {} };
  const id = await background.enqueueAndRun(ctx, invoke, { feedback: "仅保存", snapshot: { storage_mode: "local_only" }, model_selection: { provider_source: "fake" } }, "off", true);
  assert.equal(id, "job-local");
  assert.equal(calls.some((call) => call.includes("claim")), false);
});

test("background claims without queue OAuth but performs zero Pi sends when frozen auth is unavailable", async () => {
  const calls: string[] = [];
  let generation = 0;
  let sends = 0;
  const selection = { provider_source: "pi", provider_id: "p", model_id: "m", api_type: "pi", endpoint_fingerprint: "sha256:unused", thinking_level: "off", max_tokens: 32, timeout_seconds: 1, config_version: 2 };
  const job = { job_id: "job-no-auth", generation: 0, state: "queued", next_attempt_at: null as string | null, error_code: null as string | null, consent_revision: 1, input_digest: "sha256:input", model_selection: selection };
  let created = false;
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    calls.push(`${command}:${String(request.action)}`);
    if (command === "feedback" && request.action === "list") return envelope({ jobs: created ? [job] : [] }, generation);
    if (command === "feedback" && request.action === "create") { created = true; generation += 1; return envelope({ job }, generation); }
    if (command === "learning-job" && request.action === "claim") {
      job.state = "running"; job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: "lease", generation: job.generation }, prompt: "{}" } }, generation);
    }
    if (command === "learning-job" && request.action === "fail") {
      job.state = "retry_wait"; job.next_attempt_at = new Date(Date.now() + 30_000).toISOString(); job.error_code = "model_failed"; job.generation += 1; generation += 1;
      return envelope({ job }, generation);
    }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const model = { provider: "p", id: "m", baseUrl: "https://declared", reasoning: true };
  const background = new FeedbackBackground();
  await background.enqueueAndRun({ model, modelRegistry: { find: () => model, getProvider: () => ({ streamSimple: () => { sends += 1; throw new Error("must not send"); } }), getApiKeyAndHeaders: async () => ({ ok: false, error: "revoked" }) }, ui: { notify() {} } } as any, invoke, { feedback: "fix", snapshot: { storage_mode: "ask" }, model_selection: selection }, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.filter((call) => call === "learning-job:claim").length, 1);
  assert.equal(sends, 0);
  assert.equal(job.state, "retry_wait");
  await background.cancelAll();
});

test("session recovery sweeps and resumes a queued job through one worker", async () => {
  const calls: string[] = [];
  let listCount = 0;
  const job = { job_id: "job-resume", state: "queued", consent_revision: 1, input_digest: "sha256:input", model_selection: { provider_source: "fake", provider_id: "fake", model_id: "fixture", api_type: "fake", endpoint_fingerprint: "sha256:fixture", thinking_level: "off", max_tokens: 128, timeout_seconds: 10, config_version: 2 } };
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    calls.push(`${command}:${String(request.action)}`);
    if (command === "feedback" && request.action === "list") { listCount += 1; return envelope({ jobs: listCount === 1 ? [job] : [job] }, listCount); }
    if (command === "learning-job" && request.action === "sweep") return envelope({ recovered: 0, jobs: [job] }, listCount + 1);
    if (command === "learning-job" && request.action === "claim") return envelope({ job: { ...job, state: "running", lease: { token: "token", expires_at: new Date(Date.now() + 10000).toISOString(), generation: 1 }, prompt: "{}" } }, listCount + 2);
    if (command === "model-call") return envelope({ output: "{}" }, listCount + 3);
    if (command === "learning-job" && request.action === "complete") return envelope({ job: { ...job, state: "needs_review" } }, listCount + 4);
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground();
  await background.resume({ model: undefined, modelRegistry: {} } as any, invoke, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(calls.includes("learning-job:sweep"));
  assert.ok(calls.includes("learning-job:claim"));
});

test("session recovery sends frozen model A from the registry after the current model switches to B", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  const endpoint = "https://model-a.example/v1";
  const selection = { provider_source: "pi", provider_id: "provider-a", model_id: "model-a", api_type: "pi", endpoint_fingerprint: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`, thinking_level: "off", max_tokens: 128, timeout_seconds: 5, config_version: 2 };
  try {
    const seeded = seedPiFeedbackJob(root, selection);
    const harness = feedbackExtensionHarness();
    const modelA = { provider: "provider-a", id: "model-a", baseUrl: "https://declared-a", reasoning: true };
    const modelB = { provider: "provider-b", id: "model-b", baseUrl: "https://model-b.example/v1", reasoning: true };
    const authModels: string[] = [];
    let sends = 0;
    const ctx: any = {
      mode: "rpc", cwd: "/workspace", hasUI: true, sessionManager: SessionManager.inMemory("/workspace"), model: modelB, thinkingLevel: "off",
      modelRegistry: {
        find: (provider: string, model: string) => provider === modelA.provider && model === modelA.id ? modelA : undefined,
        getProvider: (provider: string) => provider === modelA.provider ? { streamSimple: () => { sends += 1; return { result: async () => ({ content: [{ type: "text", text: extractionOutput(seeded.groupId) }], stopReason: "stop" }) }; } } : undefined,
        getApiKeyAndHeaders: async (model: any) => { authModels.push(`${model.provider}/${model.id}`); return { ok: true, apiKey: "key", headers: {}, env: {}, baseUrl: endpoint }; },
      },
      ui: { notify() {}, setStatus() {} },
    };
    const startHandler = harness.events.get("session_start");
    const shutdownHandler = harness.events.get("session_shutdown");
    assert.ok(startHandler && shutdownHandler);
    await startHandler({}, ctx);
    await waitForJob(root, seeded.jobId, "needs_review", 3_000);
    assert.deepEqual(authModels, ["provider-a/model-a"]);
    assert.equal(sends, 1);
    await shutdownHandler();
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("never-resolving frozen auth is bounded by session shutdown and leaves a durable cancel", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  const endpoint = "https://model-a.example/v1";
  const selection = { provider_source: "pi", provider_id: "provider-a", model_id: "model-a", api_type: "pi", endpoint_fingerprint: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`, thinking_level: "off", max_tokens: 128, timeout_seconds: 30, config_version: 2 };
  try {
    const seeded = seedPiFeedbackJob(root, selection);
    const harness = feedbackExtensionHarness();
    const modelA = { provider: "provider-a", id: "model-a", baseUrl: endpoint, reasoning: true };
    let authStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { authStarted = resolveStarted; });
    let authCalls = 0;
    const ctx: any = {
      mode: "rpc", cwd: "/workspace", hasUI: true, sessionManager: SessionManager.inMemory("/workspace"), model: modelA, thinkingLevel: "off",
      modelRegistry: {
        find: () => modelA,
        getProvider: () => ({ streamSimple: () => { throw new Error("provider send must not start"); } }),
        getApiKeyAndHeaders: async () => { authCalls += 1; authStarted(); return new Promise(() => {}); },
      },
      ui: { notify() {}, setStatus() {} },
    };
    const startHandler = harness.events.get("session_start");
    const shutdownHandler = harness.events.get("session_shutdown");
    assert.ok(startHandler && shutdownHandler);
    await startHandler({}, ctx);
    await started;
    const shutdown = shutdownHandler();
    await Promise.race([
      shutdown,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("session shutdown waited on unresolved auth")), 500)),
    ]);
    const cancelled = await waitForJob(root, seeded.jobId, "cancelled", 1_000);
    assert.equal(cancelled.error_code, "cancelled");
    assert.equal(authCalls, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pump drains two jobs and does not spin when a job does not advance", async () => {
  const calls: string[] = [];
  const jobs = [{ job_id: "one", state: "queued", consent_revision: 1, input_digest: "sha256:one", model_selection: { provider_source: "fake", provider_id: "fake", model_id: "fixture", api_type: "fake", endpoint_fingerprint: "sha256:fixture", thinking_level: "off", max_tokens: 1, timeout_seconds: 1, config_version: 2 } }, { job_id: "two", state: "queued", consent_revision: 1, input_digest: "sha256:two", model_selection: { provider_source: "fake", provider_id: "fake", model_id: "fixture", api_type: "fake", endpoint_fingerprint: "sha256:fixture", thinking_level: "off", max_tokens: 1, timeout_seconds: 1, config_version: 2 } }];
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    calls.push(`${command}:${String(request.action)}`);
    if (command === "feedback" && request.action === "list") return envelope({ jobs }, calls.length);
    if (command === "learning-job" && request.action === "sweep") return envelope({}, calls.length);
    if (command === "learning-job" && request.action === "claim") { const id = String((request.payload as any).job_id); jobs.find((job) => job.job_id === id)!.state = "running"; return envelope({ job: { ...jobs.find((job) => job.job_id === id), lease: { token: id, generation: 1 }, prompt: "{}" } }, calls.length); }
    if (command === "model-call") return envelope({ output: "{}" }, calls.length);
    if (command === "learning-job" && request.action === "complete") { const id = String((request.payload as any).job_id); jobs.find((job) => job.job_id === id)!.state = "needs_review"; return envelope({ job: jobs.find((job) => job.job_id === id)! }, calls.length); }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground();
  await background.resume({ model: undefined, modelRegistry: {} } as any, invoke, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.filter((call) => call === "learning-job:claim").length, 2);
});

test("pump durably fails a permanent claim error, drains the next job, and never retries on wake", async () => {
  const claims: string[] = [];
  const warnings: string[] = [];
  const jobs = [
    { job_id: "bad", generation: 0, state: "queued", next_attempt_at: null, error_code: null as string | null, consent_revision: 1, input_digest: "sha256:bad", model_selection: fakeSelection },
    { job_id: "good", generation: 0, state: "queued", next_attempt_at: null, error_code: null, consent_revision: 1, input_digest: "sha256:good", model_selection: fakeSelection },
  ];
  let generation = 1;
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    if (command === "feedback" && request.action === "list") return envelope({ jobs }, generation);
    if (command === "learning-job" && request.action === "sweep") return envelope({}, generation);
    if (command === "learning-job" && request.action === "claim") {
      const id = String((request.payload as any).job_id); claims.push(id);
      if (id === "bad") return failure("invalid_contract", "permanent claim error");
      const job = jobs[1]; job.state = "running"; job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: id, generation: job.generation }, prompt: "{}" } }, generation);
    }
    if (command === "learning-job" && request.action === "reject") {
      const payload = request.payload as any;
      assert.equal(payload.job_id, "bad");
      assert.equal(payload.generation, 0);
      jobs[0].state = "failed"; jobs[0].error_code = "dispatch_invalid_contract"; jobs[0].generation += 1; generation += 1;
      return envelope({ job: jobs[0], blocked: false }, generation);
    }
    if (command === "model-call") return envelope({ output: "{}" }, generation);
    if (command === "learning-job" && request.action === "complete") {
      jobs[1].state = "needs_review"; jobs[1].generation += 1; generation += 1;
      return envelope({ job: jobs[1] }, generation);
    }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const ctx = { modelRegistry: {}, ui: { notify: (message: string) => warnings.push(message) } } as any;
  const background = new FeedbackBackground({ retryDelayMs: 20 });
  await background.resume(ctx, invoke, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(claims, ["bad", "good"]);
  assert.equal(jobs[0].state, "failed");
  assert.equal(jobs[0].error_code, "dispatch_invalid_contract");
  background.wake(ctx, invoke, "off");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const restarted = new FeedbackBackground({ retryDelayMs: 20 });
  await restarted.resume(ctx, invoke, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(claims, ["bad", "good"]);
  assert.match(warnings.join("\n"), /permanent claim error/u);
});

test("pump drains a ready job before a retry deadline and later drains the due retry", async () => {
  const claims: string[] = [];
  const jobs = [
    { job_id: "later", generation: 0, state: "retry_wait", next_attempt_at: new Date(Date.now() + 60).toISOString(), error_code: "temporary", consent_revision: 1, input_digest: "sha256:later", model_selection: fakeSelection },
    { job_id: "ready", generation: 0, state: "queued", next_attempt_at: null, error_code: null, consent_revision: 1, input_digest: "sha256:ready", model_selection: fakeSelection },
  ];
  let generation = 1;
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    if (command === "feedback" && request.action === "list") return envelope({ jobs }, generation);
    if (command === "learning-job" && request.action === "sweep") return envelope({}, generation);
    if (command === "learning-job" && request.action === "claim") {
      const id = String((request.payload as any).job_id); claims.push(id);
      const job = jobs.find((item) => item.job_id === id)!; job.state = "running"; job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: id, generation: job.generation }, prompt: "{}" } }, generation);
    }
    if (command === "model-call") return envelope({ output: "{}" }, generation);
    if (command === "learning-job" && request.action === "complete") {
      const id = String((request.payload as any).job_id); const job = jobs.find((item) => item.job_id === id)!;
      job.state = "needs_review"; job.next_attempt_at = null; job.generation += 1; generation += 1;
      return envelope({ job }, generation);
    }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground({ retryDelayMs: 10 });
  await background.resume({ modelRegistry: {}, ui: { notify() {} } } as any, invoke, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(claims, ["ready", "later"]);
});

test("heartbeat retries a stale collection CAS and completion uses the renewed lease", async () => {
  const job = { job_id: "heartbeat", generation: 0, state: "queued", next_attempt_at: null, error_code: null, consent_revision: 1, input_digest: "sha256:heartbeat", model_selection: fakeSelection };
  let generation = 1;
  let renewCalls = 0;
  let conflicted = false;
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    if (command === "feedback" && request.action === "list") return envelope({ jobs: [job] }, generation);
    if (command === "learning-job" && request.action === "sweep") return envelope({}, generation);
    if (command === "learning-job" && request.action === "claim") {
      job.state = "running"; job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: "lease", generation: job.generation }, prompt: "{}" } }, generation);
    }
    if (command === "learning-job" && request.action === "renew") {
      renewCalls += 1;
      if (!conflicted) { conflicted = true; generation += 1; return failure("generation_conflict", "stale", true); }
      assert.equal(request.expected_generation, generation);
      job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: "lease", generation: job.generation } } }, generation);
    }
    if (command === "model-call") {
      await new Promise((resolve) => setTimeout(resolve, 65));
      return envelope({ output: "{}" }, generation);
    }
    if (command === "learning-job" && request.action === "complete") {
      assert.equal(request.expected_generation, generation);
      job.state = "needs_review"; job.generation += 1; generation += 1;
      return envelope({ job }, generation);
    }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground({ heartbeatMs: 10, leaseSeconds: 5, retryDelayMs: 10 });
  await background.resume({ modelRegistry: {}, ui: { notify() {} } } as any, invoke, "off", true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(renewCalls >= 2);
  assert.equal(job.state, "needs_review");
});

test("UI cancellation owns the durable transition and does not race learning-job cancel", async () => {
  const job = { job_id: "cancel-race", generation: 0, state: "queued", next_attempt_at: null, error_code: null as string | null, consent_revision: 1, input_digest: "sha256:cancel", model_selection: fakeSelection };
  let generation = 1;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const learningCancels: string[] = [];
  const invoke = async (command: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<V2Envelope> => {
    if (command === "feedback" && request.action === "list") return envelope({ jobs: [job] }, generation);
    if (command === "learning-job" && request.action === "claim") {
      job.state = "running"; job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: "lease", generation: job.generation }, prompt: "{}" } }, generation);
    }
    if (command === "model-call") {
      modelStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("model aborted"));
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (command === "feedback" && request.action === "cancel") {
      job.state = "cancelled"; job.generation += 1; job.error_code = "cancelled"; generation += 1;
      return envelope({ job }, generation);
    }
    if (command === "learning-job" && request.action === "cancel") { learningCancels.push("cancel"); return failure("invalid_contract", "lease gone"); }
    if (command === "learning-job" && request.action === "fail") { learningCancels.push("fail"); return failure("invalid_contract", "lease gone"); }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground();
  const run = background.run({ modelRegistry: {}, ui: { notify() {} } } as any, invoke, job.job_id, "off");
  await started;
  const cancelled = await background.cancelJob(invoke, job.job_id);
  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(run, /model aborted/u);
  assert.deepEqual(learningCancels, []);
});

test("cancelAll aborts a never-resolving claim, durably cancels it, and never claims the next job", async () => {
  const jobs = [
    { job_id: "claiming", generation: 0, state: "queued", next_attempt_at: null, error_code: null as string | null, consent_revision: 1, input_digest: "sha256:claiming", model_selection: fakeSelection },
    { job_id: "next", generation: 0, state: "queued", next_attempt_at: null, error_code: null, consent_revision: 1, input_digest: "sha256:next", model_selection: fakeSelection },
  ];
  let generation = 1;
  let claimStarted!: () => void;
  const started = new Promise<void>((resolve) => { claimStarted = resolve; });
  const claims: string[] = [];
  let claimSawSignal = false;
  let sends = 0;
  const invoke = async (command: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<V2Envelope> => {
    if (command === "feedback" && request.action === "list") return envelope({ jobs }, generation);
    if (command === "learning-job" && request.action === "sweep") return envelope({}, generation);
    if (command === "learning-job" && request.action === "claim") {
      const id = String((request.payload as any).job_id); claims.push(id); claimStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => { claimSawSignal = true; reject(new Error("claim aborted")); };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (command === "feedback" && request.action === "cancel") {
      jobs[0].state = "cancelled"; jobs[0].generation += 1; jobs[0].error_code = "cancelled"; generation += 1;
      return envelope({ job: jobs[0] }, generation);
    }
    if (command === "model-call") { sends += 1; return envelope({ output: "{}" }, generation); }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground();
  await background.resume({ modelRegistry: {}, ui: { notify() {} } } as any, invoke, "off", true);
  await started;
  await Promise.race([
    background.cancelAll(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancelAll did not abort claim")), 300)),
  ]);
  assert.equal(claimSawSignal, true);
  assert.deepEqual(claims, ["claiming"]);
  assert.equal(sends, 0);
  assert.equal(jobs[0].state, "cancelled");
  assert.equal(jobs[1].state, "queued");
});

test("Pi auth delayed past consent revocation is rechecked before zero-send dispatch", async () => {
  const { createHash } = await import("node:crypto");
  const endpoint = `sha256:${createHash("sha256").update("https://resolved.example/v1").digest("hex")}`;
  const selection = { provider_source: "pi", provider_id: "provider", model_id: "model", api_type: "pi", endpoint_fingerprint: endpoint, thinking_level: "off", max_tokens: 32, timeout_seconds: 10, config_version: 2 };
  const job = { job_id: "auth-delay", generation: 0, state: "queued", next_attempt_at: null, error_code: null as string | null, consent_revision: 1, input_digest: "sha256:auth", model_selection: selection };
  let generation = 1;
  let releaseAuth!: () => void;
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => { authStarted = resolve; });
  const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
  let consentAllowed = true;
  let sends = 0;
  const model = { provider: "provider", id: "model", baseUrl: "https://declared", reasoning: true };
  const ctx: any = {
    model,
    modelRegistry: {
      find: () => model,
      getProvider: () => ({ streamSimple: () => { sends += 1; return { result: async () => ({ content: [{ type: "text", text: "{}" }], stopReason: "stop" }) }; } }),
      getApiKeyAndHeaders: async () => { authStarted(); await authGate; return { ok: true, apiKey: "key", headers: {}, env: {}, baseUrl: "https://resolved.example/v1" }; },
    },
    ui: { notify() {} },
  };
  const invoke = async (command: string, request: Record<string, unknown>): Promise<V2Envelope> => {
    if (command === "feedback" && request.action === "list") return envelope({ jobs: [job] }, generation);
    if (command === "learning-job" && request.action === "claim") {
      job.state = "running"; job.generation += 1; generation += 1;
      return envelope({ job: { ...job, lease: { token: "lease", generation: job.generation }, prompt: "{}" } }, generation);
    }
    if (command === "learning-job" && request.action === "authorize-send") {
      if (!consentAllowed) {
        job.state = "blocked_consent"; job.error_code = "consent_revoked"; job.generation += 1; generation += 1;
        return envelope({ job, blocked: true }, generation);
      }
      return envelope({ job, authorized: true }, generation);
    }
    if (command === "learning-job" && request.action === "fail") return failure("invalid_contract", "lease gone");
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new FeedbackBackground();
  const run = background.run(ctx, invoke, job.job_id, "off");
  await started;
  consentAllowed = false;
  releaseAuth();
  await assert.rejects(run, /dispatch blocked/u);
  assert.equal(sends, 0);
  assert.equal(job.state, "blocked_consent");
});

test("a pre-aborted Pi helper performs no auth lookup or provider send", async () => {
  let authCalls = 0;
  let sends = 0;
  const controller = new AbortController(); controller.abort();
  const model = { provider: "p", id: "m", baseUrl: "https://model", reasoning: true };
  const ctx: any = { model, modelRegistry: { find: () => model, getProvider: () => ({ streamSimple: () => { sends += 1; throw new Error("must not send"); } }), getApiKeyAndHeaders: async () => { authCalls += 1; return { ok: true }; } } };
  await assert.rejects(() => completeWithFrozenPiModel(ctx, { provider_source: "pi", provider_id: "p", model_id: "m", api_type: "pi", endpoint_fingerprint: "sha256:unused", thinking_level: "off", max_tokens: 1, timeout_seconds: 1, config_version: 2 }, "off", "{}", controller.signal), /取消/u);
  assert.equal(authCalls, 0);
  assert.equal(sends, 0);
});

test("Pi timeout covers delayed auth and still performs zero provider sends", async () => {
  let sends = 0;
  const model = { provider: "p", id: "m", baseUrl: "https://model", reasoning: true };
  const ctx: any = {
    model,
    modelRegistry: {
      find: () => model,
      getProvider: () => ({ streamSimple: () => { sends += 1; throw new Error("must not send"); } }),
      getApiKeyAndHeaders: async () => new Promise(() => {}),
    },
  };
  const started = Date.now();
  await assert.rejects(() => completeWithFrozenPiModel(ctx, { provider_source: "pi", provider_id: "p", model_id: "m", api_type: "pi", endpoint_fingerprint: "sha256:unused", thinking_level: "off", max_tokens: 1, timeout_seconds: 0.02, config_version: 2 }, "off", "{}", new AbortController().signal), /超时/u);
  assert.ok(Date.now() - started < 300);
  assert.equal(sends, 0);
});

test("dashboard exposes real feedback task management entry", async () => {
  let managed = false;
  const selections = ["管理反馈任务", undefined];
  const ctx: any = { cwd: "/workspace", hasUI: true, ui: { setStatus() {}, notify() {}, select: async () => selections.shift() } };
  const invoke = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args[0] === "status") return { enabled: true, groups: 1, rules: 0, pending_feedback_count: 1, model_ready: true, sync_state: "no-remote" };
    if (args[0] === "context") return { effective_groups: [], directory_groups: [], session_groups: [] };
    if (args[0] === "groups") return { groups: [] };
    throw new Error(`unexpected dashboard command ${args[0]}`);
  };
  await showPreferenceDashboard(ctx, invoke as any, { remember: async () => {}, feedback: async () => {}, manageFeedback: async () => { managed = true; }, sessionId: "session" });
  assert.equal(managed, true);
});

test("real end-to-end preference learning spans two SessionManagers, two devices, sync, withdrawal, stale review, and expected-target rollback", async () => {
  const base = tempRoot();
  const rootA = join(base, "device-a");
  const rootB = join(base, "device-b");
  const workspace = join(base, "workspace");
  const remote = join(base, "preferences.git");
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousKey = process.env.PREFERENCE_TEST_KEY;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = rootA;
    process.env.PREFERENCE_TEST_KEY = "loopback-test-key";
    init(rootA);
    const groups = JSON.parse(execFileSync("python3", [CLI, "groups", "--data-root", rootA], { encoding: "utf8" })).groups;
    const groupId = groups[0].id as string;

    // The only model transport in this test is a loopback OpenAI-compatible
    // server. It returns extractor/proposer JSON from the actual prompt input;
    // no evidence or proposal is pre-seeded in either root.
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        const prompt = String(parsed.messages?.at(-1)?.content ?? "");
        const inputMarker = "INPUT_JSON\n";
        const inputStart = prompt.lastIndexOf(inputMarker);
        assert.ok(inputStart >= 0, `loopback model prompt missing ${inputMarker}`);
        const input = JSON.parse(prompt.slice(inputStart + inputMarker.length));
        let content: string;
        if (prompt.startsWith("Propose changes to rules")) {
          const refs = (input.effective_evidence ?? []).map((item: any) => ({ evidence_id: item.evidence_id, revision_id: item.revision_id }));
          const changes = refs.length < 2 ? [{
            action: "add", rule_id: null, expected_text: null, proposed_text: "单个任务不足以形成规则。", evidence_refs: refs, opposing_evidence_refs: [],
            rationale: "先保留单次反馈，等待独立任务。", applicability: "一般回答", uncertainty: "当前只有一个独立任务", old_rule_problem: null,
          }] : [
            { action: "add", rule_id: null, expected_text: null, proposed_text: "说明结果时先给结论，再给必要依据。", evidence_refs: refs, opposing_evidence_refs: [], rationale: "两个独立任务支持该稳定表达偏好。", applicability: "一般回答", uncertainty: null, old_rule_problem: null },
            { action: "add", rule_id: null, expected_text: null, proposed_text: "说明状态时区分完成状态与数据完整性。", evidence_refs: refs, opposing_evidence_refs: [], rationale: "两个独立任务支持该边界清晰的状态说明偏好。", applicability: "状态说明", uncertainty: null, old_rule_problem: null },
          ];
          content = JSON.stringify({ changes });
        } else {
          const assistantText = String(input.sources.assistant_result);
          content = extractionOutput(String(input.explicit_group_id ?? groupId), assistantText);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
      });
    });
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;

    const settings = createExtensionHarness(rootA, { selects: ["学习设置与隐私", "设置默认模型", "自定义 OpenAI-compatible 模型", undefined], inputs: ["loopback-model", "PREFERENCE_TEST_KEY", endpoint] });
    await settings.command.handler("", settings.ctx);
    const enableExtraction = createExtensionHarness(rootA, { selects: ["学习设置与隐私", "开启反馈整理", undefined] });
    await enableExtraction.command.handler("", enableExtraction.ctx);
    const enableProposals = createExtensionHarness(rootA, { selects: ["学习设置与隐私", "开启候选提案", undefined] });
    await enableProposals.command.handler("", enableProposals.ctx);
    const triggerSettings = createExtensionHarness(rootA, { selects: ["学习设置与隐私", "设置候选触发策略", "有效新证据时准备候选", undefined] });
    await triggerSettings.command.handler("", triggerSettings.ctx);
    const optIn = createExtensionHarness(rootA, { selects: ["学习设置与隐私", "授权有效新证据自动生成候选", "global", undefined], confirms: [true] });
    await optIn.command.handler("", optIn.ctx);
    const configured = JSON.parse(readFileSync(join(rootA, "config.json"), "utf8"));
    assert.equal(configured.learning.proposal_trigger, "new_evidence");
    assert.equal(configured.learning.proposals.enabled, true);
    assert.equal(JSON.parse(readFileSync(join(rootA, "local/proposal-consent.json"), "utf8")).scope, "new_evidence");

    const makeSession = (index: number): SessionManager => {
      const session = SessionManager.inMemory(workspace);
      session.appendMessage({ role: "user", content: `任务 ${index}：请先给出结论，再说明依据`, timestamp: Date.now() } as any);
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: `任务 ${index} 的结论与依据` }], stopReason: "stop", timestamp: Date.now() } as any);
      new FeedbackContext().markSettled(ctxFor(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
      return session;
    };
    const feedback = async (index: number): Promise<any> => {
      const session = makeSession(index);
      const harness = createExtensionHarness(workspace, { session, confirms: [true] });
      const ctx = harness.ctx;
      await harness.command.handler("feedback --group global fix 请先给结论再说明必要依据", ctx);
      const jobs = JSON.parse(readFileSync(join(rootA, "local/feedback-jobs.json"), "utf8"));
      const job = jobs.at(-1);
      assert.equal(job.source_kind, "feedback");
      assert.equal(job.state, "queued");
      assert.ok(job.snapshot_ref);
      const completed = await waitForJob(rootA, job.job_id, "needs_review", 10_000);
      assert.equal(completed.result_ref !== null, true);
      const evidenceList = JSON.parse(execFileSync("python3", [CLI, "evidence", "--stdin", "--data-root", rootA], { input: JSON.stringify({ schema_version: 2, request_id: `e2e-evidence-${index}`, action: "list", expected_generation: null, payload: {} }), encoding: "utf8" }));
      return evidenceList.data.evidence;
    };
    const firstState = await feedback(1);
    assert.equal(firstState.length >= 1, true);
    const firstProposalDeadline = Date.now() + 10_000;
    let proposals: any[] = [];
    while (Date.now() < firstProposalDeadline) {
      try { proposals = JSON.parse(readFileSync(join(rootA, "local/proposals.json"), "utf8")); } catch { /* background is still writing */ }
      if (proposals.length >= 1) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    assert.equal(proposals.length, 1, `automatic proposal was not created; feedback=${readFileSync(join(rootA, "local/feedback-jobs.json"), "utf8")}; evidence=${execFileSync("find", [join(rootA, "local/evidence"), "-type", "f", "-name", "*.json"], { encoding: "utf8" })}`);
    assert.equal(proposals[0].changes[0].state, "blocked");
    assert.match(JSON.stringify(proposals[0].changes[0].gate_result), /independent|evidence|support/iu);

    await feedback(2);
    const secondProposalDeadline = Date.now() + 10_000;
    while (Date.now() < secondProposalDeadline) {
      try { proposals = JSON.parse(readFileSync(join(rootA, "local/proposals.json"), "utf8")); } catch { /* background is still writing */ }
      if (proposals.some((item) => item.changes.some((change: any) => change.state === "pending_review"))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    const pendingProposal = proposals.find((item) => item.changes.some((change: any) => change.state === "pending_review"));
    assert.ok(pendingProposal);
    assert.equal(pendingProposal.changes.filter((change: any) => change.state === "pending_review").length, 2);
    const pendingChange = pendingProposal.changes.find((change: any) => change.state === "pending_review");

    const review = createExtensionHarness(workspace, { selects: ["生成与审核候选规则", "审核候选", `${pendingProposal.proposal_id} · pending_review · ${groupId}`, "逐项审核", `${pendingChange.change_id} · add · pending_review`, "接受", undefined], confirms: [true] });
    await review.command.handler("", review.ctx);
    const groupsAfterReview = JSON.parse(readFileSync(join(rootA, "repo/groups.json"), "utf8"));
    const acceptedRule = groupsAfterReview.groups[0].rules.find((rule: any) => rule.text === pendingChange.proposed_text);
    assert.ok(acceptedRule);
    const operationFiles = execFileSync("git", ["-C", join(rootA, "repo"), "ls-files", "changes"], { encoding: "utf8" }).trim().split("\\n").filter(Boolean);
    assert.equal(operationFiles.length, 1);
    assert.equal(execFileSync("git", ["-C", join(rootA, "repo"), "show", "--format=%P", "--no-patch", "HEAD"], { encoding: "utf8" }).trim().split("\\n").length >= 1, true);

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["-C", join(rootA, "repo"), "remote", "add", "origin", remote], { stdio: "ignore" });
    const firstSync = JSON.parse(execFileSync("python3", [CLI, "sync", "--data-root", rootA], { encoding: "utf8" }));
    assert.equal(firstSync.pushed, true);
    execFileSync("git", ["clone", "--quiet", remote, join(rootB, "repo")]);
    init(rootB);
    const syncB = JSON.parse(execFileSync("python3", [CLI, "sync", "--data-root", rootB], { encoding: "utf8" }));
    assert.equal(typeof syncB.sync_state, "string");
    const rootBeforeDeviceB = process.env.PI_PREFERENCE_DATA_ROOT;
    process.env.PI_PREFERENCE_DATA_ROOT = rootB;
    const deviceB = createExtensionHarness(workspace, { session: makeSession(99) });
    const injected = await deviceB.events.get("before_agent_start")?.({ systemPrompt: "Base", systemPromptOptions: {} }, deviceB.ctx);
    assert.match(String(injected?.systemPrompt), /说明结果时先给结论|说明状态时区分/iu);
    assert.doesNotMatch(String(injected?.systemPrompt), /raw_feedback|EvidenceRevision|候选|proposal|任务 1/u);
    if (rootBeforeDeviceB === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = rootBeforeDeviceB;

    const evidenceRows = JSON.parse(execFileSync("python3", [CLI, "evidence", "--stdin", "--data-root", rootA], { input: JSON.stringify({ schema_version: 2, request_id: "e2e-evidence-list", action: "list", expected_generation: null, payload: {} }), encoding: "utf8" }));
    const publishedEvidence = evidenceRows.data.evidence.find((row: any) => row.status === "active");
    assert.ok(publishedEvidence);
    const publishUi = createExtensionHarness(workspace, { selects: ["管理学习证据", `${publishedEvidence.evidence_id} · active`, "发布", undefined], confirms: [true, true] });
    await publishUi.command.handler("", publishUi.ctx);
    const publishedDetail = runV2(rootA, "evidence", "get", null, { evidence_id: publishedEvidence.evidence_id });
    assert.equal(publishedDetail.data.published, true);
    const withdrawUi = createExtensionHarness(workspace, { selects: ["管理学习证据", `${publishedEvidence.evidence_id} · active`, "撤回", undefined], confirms: [true] });
    await withdrawUi.command.handler("", withdrawUi.ctx);
    const withdrawnDetail = runV2(rootA, "evidence", "get", null, { evidence_id: publishedEvidence.evidence_id });
    assert.equal(withdrawnDetail.data.status, "withdrawn");
    const publishWithdrawalUi = createExtensionHarness(workspace, { selects: ["管理学习证据", `${publishedEvidence.evidence_id} · withdrawn`, "发布", undefined], confirms: [true, true] });
    await publishWithdrawalUi.command.handler("", publishWithdrawalUi.ctx);
    const withdrawalPublished = runV2(rootA, "evidence", "get", null, { evidence_id: publishedEvidence.evidence_id });
    assert.equal(withdrawalPublished.data.published, true);
    const staleProposal = JSON.parse(readFileSync(join(rootA, "local/proposals.json"), "utf8")).find((item: any) => item.proposal_id === pendingProposal.proposal_id);
    assert.ok(staleProposal.changes.some((change: any) => change.state === "stale"));
    const syncAfterWithdrawal = JSON.parse(execFileSync("python3", [CLI, "sync", "--data-root", rootA], { encoding: "utf8" }));
    assert.equal(typeof syncAfterWithdrawal.sync_state, "string");
    const syncBAfterWithdrawal = JSON.parse(execFileSync("python3", [CLI, "sync", "--data-root", rootB], { encoding: "utf8" }));
    assert.equal(typeof syncBAfterWithdrawal.sync_state, "string");
    const bEvidenceAfterWithdrawal = runV2(rootB, "evidence", "get", null, { evidence_id: publishedEvidence.evidence_id });
    assert.equal(bEvidenceAfterWithdrawal.data.status, "withdrawn");
    const bAfterWithdrawal = createExtensionHarness(workspace, { session: makeSession(100) });
    const bRuntimeAfterWithdrawal = await bAfterWithdrawal.events.get("before_agent_start")?.({ systemPrompt: "Base", systemPromptOptions: {} }, bAfterWithdrawal.ctx);
    assert.match(String(bRuntimeAfterWithdrawal?.systemPrompt), new RegExp(acceptedRule.text, "u"));
    assert.match(JSON.stringify(bEvidenceAfterWithdrawal.data), /withdrawn/u);

    const rollbackPreview = JSON.parse(execFileSync("python3", [CLI, "rollback", "--preview", "--data-root", rootA], { encoding: "utf8" }));
    assert.equal(rollbackPreview.target_operation_id.length > 0, true);
    const rolledBack = JSON.parse(execFileSync("python3", [CLI, "rollback", "--stdin", "--data-root", rootA], { input: JSON.stringify({ expected_operation_id: rollbackPreview.target_operation_id, expected_head: rollbackPreview.expected_head }), encoding: "utf8" }));
    assert.equal(rolledBack.reverts_operation_id, rollbackPreview.target_operation_id);
    const syncAfterRollback = JSON.parse(execFileSync("python3", [CLI, "sync", "--data-root", rootA], { encoding: "utf8" }));
    assert.equal(typeof syncAfterRollback.sync_state, "string");
    const syncBAfterRollback = JSON.parse(execFileSync("python3", [CLI, "sync", "--data-root", rootB], { encoding: "utf8" }));
    assert.equal(typeof syncBAfterRollback.sync_state, "string");
    const bEvidenceAfterRollback = runV2(rootB, "evidence", "get", null, { evidence_id: publishedEvidence.evidence_id });
    assert.equal(bEvidenceAfterRollback.data.status, "withdrawn");
    const bAfterRollback = createExtensionHarness(workspace, { session: makeSession(101) });
    const bRuntimeAfterRollback = await bAfterRollback.events.get("before_agent_start")?.({ systemPrompt: "Base", systemPromptOptions: {} }, bAfterRollback.ctx);
    assert.doesNotMatch(String(bRuntimeAfterRollback?.systemPrompt), new RegExp(acceptedRule.text, "u"));
    const retainedEvidence = JSON.parse(execFileSync("python3", [CLI, "evidence", "--stdin", "--data-root", rootA], { input: JSON.stringify({ schema_version: 2, request_id: "e2e-final-evidence", action: "list", expected_generation: null, payload: {} }), encoding: "utf8" }));
    assert.equal(retainedEvidence.data.evidence.length >= 2, true);
    assert.equal(JSON.parse(readFileSync(join(rootA, "local/decisions.json"), "utf8")).length >= 1, true);
    assert.equal(JSON.parse(readFileSync(join(rootA, "repo/groups.json"), "utf8")).groups[0].rules.some((rule: any) => rule.text === acceptedRule.text), false);
  } finally {
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.PREFERENCE_TEST_KEY; else process.env.PREFERENCE_TEST_KEY = previousKey;
    rmSync(base, { recursive: true, force: true });
  }
});

test("real settings UI covers toggles, stage parameters, privacy, authorization, and cleanup", async () => {
  const root = tempRoot();
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    setConfig(root, (config) => {
      config.provider = { name: "fake", model: "fixture", api_key_env: "PREFERENCE_TEST_KEY", thinking_level: "off", timeout_seconds: 30, max_tokens: 256 };
      config.learning.extraction.enabled = true;
      config.learning.proposals.enabled = true;
    });
    const runSettings = async (action: string, inputs: Array<string | undefined> = [], confirms: boolean[] = [], nestedSelects: Array<string | undefined> = []) => {
      const harness = createExtensionHarness(root, { selects: ["学习设置与隐私", action, ...nestedSelects, undefined], inputs, confirms });
      await harness.command.handler("", harness.ctx);
      return harness;
    };
    await runSettings("停用个人偏好");
    await runSettings("启用个人偏好");
    await runSettings("关闭文件修改采集");
    await runSettings("设置默认模型", ["fixture-model", "PREFERENCE_TEST_KEY", "https://fixture.test/v1"], [], ["自定义 OpenAI-compatible 模型"]);
    await runSettings("设置反馈整理模型", [], [], ["继承默认模型"]);
    await runSettings("设置候选提案模型", [], [], ["继承默认模型"]);
    await runSettings("设置候选触发策略", [], [], ["有效新证据时准备候选"]);
    await runSettings("设置上下文发送策略", [], [], ["只在本机保存"]);
    await runSettings("设置快照保留天数", ["14"]);
    await runSettings("设置重试与每日预算", ["2", "7"]);
    const extractionParameters = createExtensionHarness(root, { selects: ["学习设置与隐私", "设置反馈整理参数", "low", undefined], inputs: ["20", "128"] });
    await extractionParameters.command.handler("", extractionParameters.ctx);
    const proposalParameters = createExtensionHarness(root, { selects: ["学习设置与隐私", "设置候选提案参数", "high", undefined], inputs: ["30", "256"] });
    await proposalParameters.command.handler("", proposalParameters.ctx);
    await runSettings("关闭反馈整理");
    await runSettings("关闭候选提案");
    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    assert.equal(config.capture_user_edits, false);
    assert.equal(config.privacy.snapshot_retention_days, 14);
    assert.equal(config.learning.max_attempts, 2);
    assert.equal(config.learning.max_requests_per_day, 7);
    assert.equal(config.learning.extraction.enabled, false);
    assert.equal(config.learning.proposals.enabled, false);
    assert.equal(config.learning.extraction.timeout_seconds, 20);
    assert.equal(config.learning.proposals.max_tokens, 256);
    // Every destructive privacy branch asks before writing; cancellation is zero-write.
    const before = readFileSync(join(root, "config.json"));
    const invalidSettings = await runSettings("设置快照保留天数", ["not-a-number"]);
    assert.deepEqual(readFileSync(join(root, "config.json")), before);
    assert.match(invalidSettings.notices.at(-1)?.message ?? "", /invalid|无效|范围|snapshot/iu);
    await runSettings("立即清理反馈快照", [], [false]);
    await runSettings("撤回反馈发送授权", [], [false]);
    await runSettings("撤回候选发送授权", [], [false]);
    assert.deepEqual(readFileSync(join(root, "config.json")), before);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real settings shutdown aborts active stage work, releases the shared worker, and preserves independent stage jobs", async () => {
  const root = tempRoot();
  const workspace = tempRoot();
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousKey = process.env.PREFERENCE_TEST_KEY;
  let server: ReturnType<typeof createServer> | undefined;
  let activeHarness: ReturnType<typeof createExtensionHarness> | undefined;
  let requestStarted = false;
  let requestClosed = false;
  let responseCompleted = false;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    process.env.PREFERENCE_TEST_KEY = "competition-key";
    init(root);
    server = createServer((request, response) => {
      requestStarted = true;
      request.on("close", () => { if (!response.writableEnded) { requestClosed = true; response.destroy(); } });
      setTimeout(() => {
        if (response.writableEnded || response.destroyed) return;
        responseCompleted = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: extractionOutput(JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8")).groups[0].id) } }], usage: {} }));
      }, 10_000).unref();
    });
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const configure = createExtensionHarness(workspace, { selects: ["学习设置与隐私", "设置默认模型", "自定义 OpenAI-compatible 模型", undefined], inputs: ["competition-model", "PREFERENCE_TEST_KEY", endpoint] });
    await configure.command.handler("", configure.ctx);
    const enableExtraction = createExtensionHarness(workspace, { selects: ["学习设置与隐私", "开启反馈整理", undefined] });
    await enableExtraction.command.handler("", enableExtraction.ctx);
    const enableProposals = createExtensionHarness(workspace, { selects: ["学习设置与隐私", "开启候选提案", undefined] });
    await enableProposals.command.handler("", enableProposals.ctx);
    const session = SessionManager.inMemory(workspace);
    session.appendMessage({ role: "user", content: "请整理这次结果", timestamp: Date.now() } as any);
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "这是结果" }], stopReason: "stop", timestamp: Date.now() } as any);
    new FeedbackContext().markSettled(ctxFor(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
    activeHarness = createExtensionHarness(workspace, { session, confirms: [true] });
    await activeHarness.command.handler("feedback --group global fix 请整理结果并保留必要依据", activeHarness.ctx);
    const startedDeadline = Date.now() + 5_000;
    let feedbackJob: any;
    while (Date.now() < startedDeadline) {
      feedbackJob = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"))[0];
      if (requestStarted && feedbackJob.state === "running") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(requestStarted, true);
    assert.equal(feedbackJob.state, "running");
    const selection = {
      provider_source: "custom", provider_id: "openai_compatible", model_id: "competition-model", api_type: "openai_compatible",
      endpoint_fingerprint: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`, thinking_level: "off", max_tokens: 2048, timeout_seconds: 60,
      config_version: runV2(root, "settings", "get", null, {}).cas.generation,
    };
    const groupId = JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8")).groups[0].id;
    const proposalPreview = runV2(root, "proposal", "preview", null, { group_id: groupId, model_selection: selection });
    const proposalAuth = runV2(root, "proposal", "authorize", proposalPreview.cas.generation, { revision: 901, allowed: true, stage: "proposals", scope: "single", group_ids: [groupId], input_signature: proposalPreview.data.input_signature, model_selection: selection });
    const proposal = runV2(root, "proposal", "generate", proposalAuth.cas.generation, { group_id: groupId, model_selection: selection, authorization_revision: 901, explicit_retry: false });
    assert.equal(proposal.data.job.state, "queued");
    // The real feedback transport owns the single root worker; the other
    // stage remains queued and recoverable, with no parallel effective worker.
    const proposalJobs = runV2(root, "proposal-job", "list", null, {});
    const competingProposal = proposalJobs.data.jobs.find((item: any) => item.job_id === proposal.data.job.job_id);
    const worker = JSON.parse(readFileSync(join(root, "local/worker.json"), "utf8"));
    assert.equal(worker.job_id, feedbackJob.job_id);
    assert.equal(competingProposal.state, "queued");

    // A live foreground turn keeps the queued proposal from being claimed
    // while the feedback transport is revoked; this exercises the real
    // foreground-busy gate rather than manually touching a runner.
    await activeHarness.events.get("input")?.({ source: "interactive", text: "foreground task" }, activeHarness.ctx);
    const revokeTopChoices = ["学习设置与隐私", undefined];
    const revokeSettingsChoices = ["撤回反馈发送授权", undefined];
    let revokeSelectCalls = 0;
    activeHarness.ctx.ui.select = async (title: string) => {
      revokeSelectCalls += 1;
      if (revokeSelectCalls > 4) throw new Error("settings revoke UI loop exceeded guard");
      if (title === "个人偏好") return revokeTopChoices.shift();
      if (title === "学习设置与隐私") return revokeSettingsChoices.shift();
      return undefined;
    };
    activeHarness.ctx.ui.confirm = async () => true;
    await activeHarness.command.handler("", activeHarness.ctx);
    const proposalAfterRevoke = runV2(root, "proposal-job", "list", null, {}).data.jobs.find((item: any) => item.job_id === proposal.data.job.job_id);
    const feedbackAfterRevoke = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8")).find((item: any) => item.job_id === feedbackJob.job_id);
    assert.equal(proposalAfterRevoke.state, "queued");
    assert.equal(feedbackAfterRevoke.state, "blocked_consent");
    assert.equal(existsSync(join(root, "local/worker.json")), false);
    const revokeCloseDeadline = Date.now() + 2_000;
    while (!requestClosed && Date.now() < revokeCloseDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(requestClosed, true);
    assert.equal(responseCompleted, false);

    const stopTopChoices = ["学习设置与隐私", undefined];
    const stopSettingsChoices = ["停用个人偏好", undefined];
    let stopSelectCalls = 0;
    activeHarness.ctx.ui.select = async (title: string) => {
      stopSelectCalls += 1;
      if (stopSelectCalls > 4) throw new Error("settings shutdown UI loop exceeded guard");
      if (title === "个人偏好") return stopTopChoices.shift();
      if (title === "学习设置与隐私") return stopSettingsChoices.shift();
      return undefined;
    };
    await activeHarness.command.handler("", activeHarness.ctx);
    const stoppedFeedback = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8")).find((item: any) => item.job_id === feedbackJob.job_id);
    assert.equal(stoppedFeedback.state, "blocked_consent");
    const stoppedProposal = runV2(root, "proposal-job", "list", null, {}).data.jobs.find((item: any) => item.job_id === proposal.data.job.job_id);
    assert.equal(stoppedProposal.state, "blocked_config");
    assert.equal(existsSync(join(root, "local/worker.json")), false);
    const closeDeadline = Date.now() + 2_000;
    while (!requestClosed && Date.now() < closeDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(requestClosed, true);
    assert.equal(responseCompleted, false);
  } finally {
    await activeHarness?.events.get("session_shutdown")?.({}, activeHarness.ctx);
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.PREFERENCE_TEST_KEY; else process.env.PREFERENCE_TEST_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("real evidence revise and restore trigger the configured new-evidence path", async () => {
  const root = tempRoot();
  const workspace = tempRoot();
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousKey = process.env.PREFERENCE_TEST_KEY;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    process.env.PREFERENCE_TEST_KEY = "revise-restore-key";
    init(root);
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const requestBody = JSON.parse(body);
        const prompt = String(requestBody.messages?.at(-1)?.content ?? "");
        const marker = "INPUT_JSON\n";
        const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
        const content = prompt.startsWith("Propose changes to rules")
          ? JSON.stringify({ changes: [{ action: "noop", rule_id: null, expected_text: null, proposed_text: null, evidence_refs: (input.effective_evidence ?? []).map((item: any) => ({ evidence_id: item.evidence_id, revision_id: item.revision_id })), opposing_evidence_refs: [], rationale: "等待用户继续核对。", applicability: "一般回答", uncertainty: null, old_rule_problem: null }] })
          : extractionOutput(String(input.explicit_group_id), String(input.sources.assistant_result));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
      });
    });
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const configure = createExtensionHarness(workspace, { selects: ["学习设置与隐私", "设置默认模型", "自定义 OpenAI-compatible 模型", undefined], inputs: ["revise-model", "PREFERENCE_TEST_KEY", endpoint] });
    await configure.command.handler("", configure.ctx);
    for (const action of ["开启反馈整理", "开启候选提案"]) {
      const toggle = createExtensionHarness(workspace, { selects: ["学习设置与隐私", action, undefined] });
      await toggle.command.handler("", toggle.ctx);
    }
    const trigger = createExtensionHarness(workspace, { selects: ["学习设置与隐私", "设置候选触发策略", "有效新证据时准备候选", undefined] });
    await trigger.command.handler("", trigger.ctx);
    const optIn = createExtensionHarness(workspace, { selects: ["学习设置与隐私", "授权有效新证据自动生成候选", "global", undefined], confirms: [true] });
    await optIn.command.handler("", optIn.ctx);
    const session = SessionManager.inMemory(workspace);
    session.appendMessage({ role: "user", content: "请给出简洁结论", timestamp: Date.now() } as any);
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "原始回答结果" }], stopReason: "stop", timestamp: Date.now() } as any);
    new FeedbackContext().markSettled(ctxFor(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
    const feedback = createExtensionHarness(workspace, { session, confirms: [true] });
    await feedback.command.handler("feedback --group global fix 请保留简洁结论", feedback.ctx);
    const job = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"))[0];
    await waitForJob(root, job.job_id, "needs_review", 10_000);
    const evidenceList = runV2(root, "evidence", "list", null, {});
    const row = evidenceList.data.evidence[0];
    const revise = createExtensionHarness(workspace, { selects: ["管理学习证据", `${row.evidence_id} · active`, "修订用户期望", undefined], editors: ["以后仍保留简洁结论"] });
    await revise.command.handler("", revise.ctx);
    let proposals: any[] = [];
    const proposalDeadline = Date.now() + 10_000;
    while (Date.now() < proposalDeadline) {
      try { proposals = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8")); } catch { /* trigger is still enqueueing */ }
      if (proposals.length >= 1) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    assert.equal(proposals.length, 1);
    const revisedEvidence = runV2(root, "evidence", "get", null, { evidence_id: row.evidence_id });
    const revisedHead = revisedEvidence.data.heads[0];
    const withdrawUi = createExtensionHarness(workspace, { selects: ["管理学习证据", `${row.evidence_id} · active`, "撤回", undefined], confirms: [true] });
    await withdrawUi.command.handler("", withdrawUi.ctx);
    const withdrawnEvidence = runV2(root, "evidence", "get", null, { evidence_id: row.evidence_id });
    assert.equal(withdrawnEvidence.data.status, "withdrawn");
    const proposalsBeforeRestore = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8"));
    const restore = createExtensionHarness(workspace, { selects: ["管理学习证据", `${row.evidence_id} · withdrawn`, "恢复", `${revisedHead} · `, undefined], confirms: [true] });
    await restore.command.handler("", restore.ctx);
    const restored = runV2(root, "evidence", "get", null, { evidence_id: row.evidence_id });
    assert.equal(restored.data.status, "active");
    const restoredDeadline = Date.now() + 10_000;
    let restoredProposals: any[] = [];
    while (Date.now() < restoredDeadline) {
      try { restoredProposals = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8")); } catch { /* trigger is still enqueueing */ }
      if (restoredProposals.length > proposalsBeforeRestore.length) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    assert.equal(restoredProposals.length > proposalsBeforeRestore.length, true);
  } finally {
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.PREFERENCE_TEST_KEY; else process.env.PREFERENCE_TEST_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("dashboard exposes proposal and provenance actions", async () => {
  const calls: string[] = [];
  const selections = ["生成与审核候选规则", "查看规则来源与历史", undefined];
  const ctx: any = { cwd: "/workspace", hasUI: true, ui: { setStatus() {}, notify() {}, select: async () => selections.shift() } };
  const invoke = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args[0] === "status") return { enabled: true, groups: 1, rules: 1, pending_proposal_count: 1, sync_state: "no-remote" };
    if (args[0] === "context") return { effective_groups: [], directory_groups: [], session_groups: [] };
    throw new Error(`unexpected dashboard command ${args[0]}`);
  };
  await showPreferenceDashboard(ctx, invoke as any, {
    remember: async () => {}, feedback: async () => {},
    manageProposals: async () => { calls.push("proposals"); },
    manageHistory: async () => { calls.push("history"); }, sessionId: "session",
  });
  assert.deepEqual(calls, ["proposals", "history"]);
});

test("real proposal UI authorizes exact evidence, generates, reviews, applies, and cancels a queued job", async () => {
  const root = tempRoot();
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousResponse = process.env.PREFERENCE_MODEL_RESPONSE;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    init(root);
    setConfig(root, (config) => {
      config.provider = { name: "fake", model: "fixture", api_key_env: "PREFERENCE_MODEL_API_KEY", thinking_level: "off", max_tokens: 2048, timeout_seconds: 300 };
      config.learning.extraction.enabled = true;
      config.learning.proposals.enabled = true;
    });
    const selection = { provider_source: "fake", provider_id: "fake", model_id: "fixture", api_type: "fake", endpoint_fingerprint: `sha256:${createHash("sha256").update("").digest("hex")}`, thinking_level: "off", max_tokens: 2048, timeout_seconds: 300, config_version: 2 };
    const groupId = JSON.parse(execFileSync("python3", [CLI, "groups", "--data-root", root], { encoding: "utf8" })).groups[0].id;
    const revisions: any[] = [];
    let generation = runV2(root, "feedback", "list", null, {}).cas.generation;
    for (let index = 0; index < 2; index += 1) {
      const snapshot = { session_id: `session-${index}`, task_key: `task-${index}`, user_entry_id: `user-${index}`, assistant_entry_id: `assistant-${index}`, user_text: "请简洁", assistant_text: "这是当前结果", origin_verified: true, storage_mode: "ask" };
      const authorized = authorizeFeedback(root, "fix: 请更简洁", snapshot, selection, index + 1);
      generation = authorized.cas.generation;
      const created = runV2(root, "feedback", "create", generation, { feedback: "fix: 请更简洁", group_id: groupId, snapshot, model_selection: selection, consent_revision: index + 1 });
      const claimed = runV2(root, "learning-job", "claim", created.cas.generation, { job_id: created.data.job.job_id, owner_id: "worker", consent_revision: index + 1, model_selection: selection, lease_seconds: 30 });
      const completed = runV2(root, "learning-job", "complete", claimed.cas.generation, { job_id: created.data.job.job_id, token: claimed.data.job.lease.token, input_digest: claimed.data.job.input_digest, model_selection: selection, consent_revision: index + 1, output: extractionOutput(groupId) });
      revisions.push(completed.data.evidence_revision);
      generation = completed.cas.generation;
    }
    const refs = revisions.map((item) => ({ evidence_id: item.evidence_id, revision_id: item.revision_id }));
    process.env.PREFERENCE_MODEL_RESPONSE = JSON.stringify({ changes: [
      { action: "add", rule_id: null, expected_text: null, proposed_text: "候选第一项。", evidence_refs: refs, opposing_evidence_refs: [], rationale: "两个独立任务支持第一项", applicability: "一般回答", uncertainty: null, old_rule_problem: null },
      { action: "add", rule_id: null, expected_text: null, proposed_text: "候选第二项。", evidence_refs: refs, opposing_evidence_refs: [], rationale: "两个独立任务支持第二项", applicability: "一般回答", uncertainty: null, old_rule_problem: null },
    ] });
    const harness = feedbackExtensionHarness();
    const session = sessionWithFeedbackTarget();
    const confirmations: Array<{ title: string; body: string }> = [];
    let top = 0;
    let proposalMenu = 0;
    const ctx: any = {
      cwd: "/workspace", sessionManager: session, hasUI: true, model: undefined, modelRegistry: {}, thinkingLevel: "off", waitForIdle: async () => {},
      ui: {
        setStatus() {}, notify() {}, input: async () => undefined, editor: async () => undefined,
        select: async (title: string) => {
          if (title === "个人偏好") return top++ === 0 ? "生成与审核候选规则" : undefined;
          if (title === "候选规则") return proposalMenu++ === 0 ? "生成新候选" : "返回上一级";
          if (title === "选择候选目标组") return "global";
          return undefined;
        },
        confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; },
      },
    };
    await harness.command.handler("", ctx);
    assert.match(confirmations[0].body, /input_signature=/u);
    assert.match(confirmations[0].body, /不复用 feedback 快照授权/u);
    const deadline = Date.now() + 3_000;
    let proposal: any;
    while (Date.now() < deadline) {
      try { proposal = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8"))[0]; } catch { /* still running */ }
      if (proposal) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(proposal?.state, "pending_review");
    assert.equal(proposal?.changes.length, 2);

    const reviewChange = async (changeIndex: number, itemAction: string): Promise<void> => {
      top = 0;
      let reviewMenu = 0;
      ctx.ui.input = async () => "真实 UI 拒绝原因";
      ctx.ui.select = async (title: string, options: string[]) => {
        if (title === "个人偏好") return top++ === 0 ? "生成与审核候选规则" : undefined;
        if (title === "候选规则") return reviewMenu++ === 0 ? "审核候选" : "返回上一级";
        if (title === "选择候选") return options[0];
        if (title === "审核候选") return "逐项审核";
        if (title === "选择候选项") return options[changeIndex];
        if (title === "处理候选项") return itemAction;
        return undefined;
      };
      await harness.command.handler("", ctx);
    };

    await reviewChange(0, "暂不处理");
    let reviewed = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8"))[0];
    assert.deepEqual(reviewed.changes.map((item: any) => item.state), ["deferred", "pending_review"]);
    await reviewChange(0, "继续审核");
    reviewed = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8"))[0];
    assert.deepEqual(reviewed.changes.map((item: any) => item.state), ["pending_review", "pending_review"]);
    await reviewChange(0, "拒绝");
    reviewed = JSON.parse(readFileSync(join(root, "local/proposals.json"), "utf8"))[0];
    assert.deepEqual(reviewed.changes.map((item: any) => item.state), ["rejected", "pending_review"]);
    await reviewChange(1, "接受");
    const groups = JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8"));
    assert.equal(groups.groups[0].rules[0].text, "候选第二项。");
    const operationFiles = execFileSync("git", ["-C", join(root, "repo"), "ls-files", "changes"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.equal(operationFiles.length > 0, true);

    const preview = runV2(root, "proposal", "preview", null, { group_id: groupId, model_selection: selection });
    const blocked = runV2(root, "proposal", "generate", preview.cas.generation, { group_id: groupId, model_selection: selection, authorization_revision: 0, explicit_retry: true });
    assert.equal(blocked.data.job.state, "blocked_consent");
    top = 0;
    let cancelMenu = 0;
    ctx.ui.select = async (title: string, options: string[]) => {
      if (title === "个人偏好") return top++ === 0 ? "生成与审核候选规则" : undefined;
      if (title === "候选规则") return cancelMenu++ === 0 ? "取消候选任务" : "返回上一级";
      if (title === "选择候选任务") return options.find((item) => item.startsWith(blocked.data.job.job_id));
      return undefined;
    };
    await harness.command.handler("", ctx);
    const jobs = runV2(root, "proposal-job", "list", null, {}).data.jobs;
    assert.equal(jobs.find((item: any) => item.job_id === blocked.data.job.job_id).state, "cancelled");
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousResponse === undefined) delete process.env.PREFERENCE_MODEL_RESPONSE; else process.env.PREFERENCE_MODEL_RESPONSE = previousResponse;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real delete review UI shows exact old rule and raw evidence before user opposition confirmation", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    init(root);
    setConfig(root, (config) => {
      config.provider = { name: "fake", model: "fixture", api_key_env: "PREFERENCE_MODEL_API_KEY", thinking_level: "off", max_tokens: 2048, timeout_seconds: 300 };
      config.learning.extraction.enabled = true;
      config.learning.proposals.enabled = true;
    });
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], { input: JSON.stringify({ action: "add_rule", group: "global", rule: "始终用英文回答。" }), encoding: "utf8" });
    const groups = JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8"));
    const groupId = groups.groups[0].id;
    const rule = groups.groups[0].rules[0];
    const selection = { provider_source: "fake", provider_id: "fake", model_id: "fixture", api_type: "fake", endpoint_fingerprint: `sha256:${createHash("sha256").update("").digest("hex")}`, thinking_level: "off", max_tokens: 2048, timeout_seconds: 300, config_version: 2 };
    let generation = runV2(root, "feedback", "list", null, {}).cas.generation;
    const revisions: any[] = [];
    for (let index = 0; index < 3; index += 1) {
      const snapshot = { session_id: `delete-session-${index}`, task_key: `delete-task-${index}`, user_entry_id: `delete-user-${index}`, assistant_entry_id: `delete-assistant-${index}`, user_text: "请回答", assistant_text: "这是当前结果", origin_verified: true, storage_mode: "ask" };
      const authorized = authorizeFeedback(root, "fix: 回答应更简洁", snapshot, selection, index + 1);
      generation = authorized.cas.generation;
      const created = runV2(root, "feedback", "create", generation, { feedback: "fix: 回答应更简洁", group_id: groupId, snapshot, model_selection: selection, consent_revision: index + 1 });
      const claimed = runV2(root, "learning-job", "claim", created.cas.generation, { job_id: created.data.job.job_id, owner_id: "delete-worker", consent_revision: index + 1, model_selection: selection, lease_seconds: 30 });
      const completed = runV2(root, "learning-job", "complete", claimed.cas.generation, { job_id: created.data.job.job_id, token: claimed.data.job.lease.token, input_digest: claimed.data.job.input_digest, model_selection: selection, consent_revision: index + 1, output: extractionOutput(groupId) });
      revisions.push(completed.data.evidence_revision); generation = completed.cas.generation;
    }
    const refs = revisions.map((item) => ({ evidence_id: item.evidence_id, revision_id: item.revision_id }));
    const preview = runV2(root, "proposal", "preview", null, { group_id: groupId, model_selection: selection });
    const authorized = runV2(root, "proposal", "authorize", preview.cas.generation, { revision: 90, allowed: true, stage: "proposals", scope: "single", group_ids: [groupId], input_signature: preview.data.input_signature, model_selection: selection });
    const generated = runV2(root, "proposal", "generate", authorized.cas.generation, { group_id: groupId, model_selection: selection, authorization_revision: 90, explicit_retry: false });
    const claimed = runV2(root, "proposal-job", "claim", generated.cas.generation, { job_id: generated.data.job.job_id, owner_id: "delete-proposer", authorization_revision: 90, model_selection: selection, lease_seconds: 30 });
    runV2(root, "proposal-job", "complete", claimed.cas.generation, { job_id: generated.data.job.job_id, token: claimed.data.job.lease.token, input_digest: claimed.data.job.input_digest, input_signature: claimed.data.job.input_signature, model_selection: selection, authorization_revision: 90, output: JSON.stringify({ changes: [{ action: "delete", rule_id: rule.id, expected_text: rule.text, proposed_text: null, evidence_refs: refs, opposing_evidence_refs: refs, rationale: "模型声称反对旧规则", applicability: "一般回答", uncertainty: null, old_rule_problem: "模型声称旧规则有问题" }] }) });

    const harness = feedbackExtensionHarness();
    const confirmations: Array<{ title: string; body: string }> = [];
    let top = 0; let proposalMenu = 0;
    const ctx: any = {
      cwd: "/workspace", sessionManager: sessionWithFeedbackTarget(), hasUI: true, model: undefined, modelRegistry: {}, thinkingLevel: "off", waitForIdle: async () => {},
      ui: {
        setStatus() {}, notify() {}, input: async () => undefined, editor: async () => undefined,
        select: async (title: string, options: string[]) => {
          if (title === "个人偏好") return top++ === 0 ? "生成与审核候选规则" : undefined;
          if (title === "候选规则") return proposalMenu++ === 0 ? "审核候选" : "返回上一级";
          if (title === "选择候选") return options[0];
          if (title === "审核候选") return "逐项审核";
          if (title === "选择候选项") return options[0];
          if (title === "处理候选项") return "核对删除反对证据";
          if (title === "选择要核对的明确反对来源") return options[0];
          return undefined;
        },
        confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; },
      },
    };
    await harness.command.handler("", ctx);
    const body = confirmations.find((item) => item.title === "确认这条证据明确反对具体旧规则？")?.body ?? "";
    assert.match(body, /始终用英文回答/u);
    assert.match(body, /fix: 回答应更简洁/u);
    assert.match(body, /仍需之后正式接受候选/u);
    const stored = JSON.parse(readFileSync(join(root, "local/delete-opposition-confirmations.json"), "utf8"));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].rule_ref.rule_id, rule.id);
    assert.equal(stored[0].rule_ref.revision, rule.revision);
    assert.equal(stored[0].rule_ref.text, rule.text);
    assert.match(stored[0].rule_ref.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.parse(readFileSync(join(root, "repo/groups.json"), "utf8")).groups[0].rules.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal background does not claim while foreground is busy and wakes after settled", async () => {
  const selection = { ...fakeSelection };
  const job: any = { job_id: "proposal-job-one", generation: 0, state: "queued", next_attempt_at: null, authorization_revision: 1, input_digest: "sha256:input", input_signature: "sha256:signature", model_selection: selection };
  let generation = 0;
  let claims = 0;
  const invoke = async (command: string, request: Record<string, any>): Promise<V2Envelope> => {
    if (command === "proposal-job" && request.action === "list") return envelope({ jobs: [job] }, generation);
    if (command === "proposal-job" && request.action === "claim") {
      claims += 1; generation += 1; job.state = "running"; job.generation = 1;
      return envelope({ job: { ...job, lease: { token: "proposal-token" } }, prompt: "{}" }, generation);
    }
    if (command === "model-call") return envelope({ output: "{\"changes\":[{\"action\":\"noop\"}] }" });
    if (command === "proposal-job" && request.action === "complete") { generation += 1; job.state = "completed"; job.generation = 2; return envelope({ job }, generation); }
    if (command === "proposal-job" && request.action === "fail") { generation += 1; job.state = "failed"; return envelope({ job }, generation); }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new ProposalBackground({ retryDelayMs: 10 });
  const ctx: any = { ui: { notify() {} } };
  background.setForegroundBusy(true);
  background.wake(ctx, invoke, "off");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(claims, 0);
  background.setForegroundBusy(false);
  background.wake(ctx, invoke, "off");
  const deadline = Date.now() + 500;
  while (job.state !== "completed" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(claims, 1);
  assert.equal(job.state, "completed");
  await background.cancelAll();
});

test("proposal resume schedules a future retry deadline instead of waiting for another wake", async () => {
  const job: any = {
    job_id: "proposal-future", generation: 0, state: "retry_wait",
    next_attempt_at: new Date(Date.now() + 50).toISOString(), authorization_revision: 1,
    input_digest: "sha256:input", input_signature: "sha256:signature", model_selection: fakeSelection,
  };
  let generation = 0;
  let claims = 0;
  const usage = { known: false, input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: null, cost_status: "unknown", provider_id: "fake", model_id: "fixture", max_tokens: 128 };
  const invoke = async (command: string, request: Record<string, any>): Promise<V2Envelope> => {
    if (command === "proposal-job" && request.action === "list") return envelope({ jobs: [job] }, generation);
    if (command === "proposal-job" && request.action === "sweep") return envelope({ jobs: [job] }, generation);
    if (command === "proposal-job" && request.action === "claim") {
      claims += 1; generation += 1; job.state = "running"; job.generation += 1;
      return envelope({ job: { ...job, lease: { token: "future-token" } }, prompt: "{}" }, generation);
    }
    if (command === "model-call") return envelope({ output: "{}", usage }, generation);
    if (command === "proposal-job" && request.action === "complete") {
      generation += 1; job.state = "completed"; job.generation += 1; return envelope({ job }, generation);
    }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const background = new ProposalBackground({ retryDelayMs: 5 });
  await background.resume({ ui: { notify() {} } } as any, invoke, "off", true);
  assert.equal(claims, 0);
  const deadline = Date.now() + 500;
  while (job.state !== "completed" && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(claims, 1);
  await background.cancelAll();
});

test("proposal shutdown aborts never-resolving Pi auth and performs zero late sends", async () => {
  const endpoint = "https://proposal-auth.example/v1";
  const selection = { provider_source: "pi", provider_id: "provider", model_id: "proposal", api_type: "pi", endpoint_fingerprint: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`, thinking_level: "high", max_tokens: 256, timeout_seconds: 30, config_version: 1 };
  const job: any = { job_id: "proposal-never-auth", generation: 0, state: "queued", next_attempt_at: null, authorization_revision: 1, input_digest: "sha256:input", input_signature: "sha256:signature", model_selection: selection };
  let generation = 0;
  let sends = 0;
  let authStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { authStarted = resolveStarted; });
  const invoke = async (command: string, request: Record<string, any>): Promise<V2Envelope> => {
    if (command === "proposal-job" && request.action === "list") return envelope({ jobs: [job] }, generation);
    if (command === "proposal-job" && request.action === "sweep") return envelope({ jobs: [job] }, generation);
    if (command === "proposal-job" && request.action === "claim") {
      generation += 1; job.state = "running"; job.generation += 1;
      return envelope({ job: { ...job, lease: { token: "proposal-auth-token" } }, prompt: "{}" }, generation);
    }
    if (command === "proposal-job" && request.action === "cancel") {
      generation += 1; job.state = "cancelled"; job.generation += 1; return envelope({ job }, generation);
    }
    if (command === "proposal" && request.action === "cancel") {
      generation += 1; job.state = "cancelled"; job.generation += 1; return envelope({ job }, generation);
    }
    throw new Error(`unexpected ${command}/${String(request.action)}`);
  };
  const model = { provider: "provider", id: "proposal", baseUrl: endpoint, reasoning: true };
  const ctx: any = {
    ui: { notify() {} }, modelRegistry: {
      find: () => model,
      getProvider: () => ({ streamSimple: () => { sends += 1; throw new Error("late send"); } }),
      getApiKeyAndHeaders: async () => { authStarted(); return new Promise(() => {}); },
    },
  };
  const background = new ProposalBackground();
  background.wake(ctx, invoke, "high");
  await started;
  await Promise.race([
    background.cancelAll(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("proposal shutdown waited on auth")), 500)),
  ]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.equal(job.state, "cancelled");
  assert.equal(sends, 0);
});

test("the real evidence UI reads details and creates an accurately confirmed withdrawal", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    init(root);
    setConfig(root, (config) => {
      config.provider = { name: "fake", model: "fixture", api_key_env: "PREFERENCE_MODEL_API_KEY", thinking_level: "off", max_tokens: 128, timeout_seconds: 10 };
      config.learning.extraction.enabled = true;
    });
    const selection = { ...fakeSelection, endpoint_fingerprint: `sha256:${createHash("sha256").update("").digest("hex")}`, timeout_seconds: 10 };
    const groupId = JSON.parse(execFileSync("python3", [CLI, "groups", "--data-root", root], { encoding: "utf8" })).groups[0].id;
    let listed = runV2(root, "feedback", "list", null, {});
    const snapshot = { session_id: "session", task_key: "task", user_entry_id: "user", assistant_entry_id: "assistant", user_text: "请简洁", assistant_text: "这是当前结果", origin_verified: true, storage_mode: "ask" };
    const authorized = authorizeFeedback(root, "fix: 请简洁", snapshot, selection, 1);
    const created = runV2(root, "feedback", "create", authorized.cas.generation, { feedback: "fix: 请简洁", group_id: groupId, snapshot, model_selection: selection, consent_revision: 1 });
    listed = runV2(root, "feedback", "list", null, {});
    const claimed = runV2(root, "learning-job", "claim", listed.cas.generation, { job_id: created.data.job.job_id, owner_id: "worker", consent_revision: 1, model_selection: selection, lease_seconds: 30 });
    runV2(root, "learning-job", "complete", claimed.cas.generation, { job_id: created.data.job.job_id, token: claimed.data.job.lease.token, input_digest: claimed.data.job.input_digest, model_selection: selection, consent_revision: 1, output: extractionOutput(groupId) });
    const evidenceBefore = runV2(root, "evidence", "list", null, {});
    const evidenceRow = evidenceBefore.data.evidence[0];
    const publishPreview = runV2(root, "evidence", "publish", evidenceBefore.cas.generation, { mode: "preview", evidence_id: evidenceRow.evidence_id, expected_heads: evidenceRow.heads });
    runV2(root, "evidence", "publish", publishPreview.cas.generation, { mode: "apply", evidence_id: evidenceRow.evidence_id, expected_heads: evidenceRow.heads, preview_digest: publishPreview.data.preview_digest, revision_ids: publishPreview.data.revision_ids });

    const harness = feedbackExtensionHarness();
    const confirmations: Array<{ title: string; body: string }> = [];
    const notifications: string[] = [];
    let top = 0;
    let evidenceChoices = 0;
    const session = sessionWithFeedbackTarget();
    const ctx: any = {
      cwd: "/workspace",
      sessionManager: session,
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        setStatus() {},
        notify(message: string) { notifications.push(message); },
        input: async () => undefined,
        editor: async () => undefined,
        select: async (title: string, options: string[]) => {
          if (title === "个人偏好") return top++ === 0 ? "管理学习证据" : undefined;
          if (title === "选择学习证据") return evidenceChoices++ === 0 ? options[0] : undefined;
          if (title === "管理学习证据") return "撤回";
          return undefined;
        },
        confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; },
      },
    };
    await harness.command.handler("", ctx);
    const evidence = runV2(root, "evidence", "list", null, {});
    assert.equal(evidence.data.evidence[0].status, "withdrawn");
    assert.equal(evidence.data.evidence[0].withdrawal_pending_publish, true);
    assert.match(confirmations[0].body, /Git 历史、其他设备已有副本和已发送给模型提供方的数据不会自动清除/u);
    assert.match(notifications.join("\n"), /撤回待发布.*普通同步不会传播/u);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real publish preview displays every revision body and cancellation exports nothing", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  try {
    process.env.PI_PREFERENCE_DATA_ROOT = root;
    init(root);
    setConfig(root, (config) => {
      config.provider = { name: "fake", model: "fixture", api_key_env: "PREFERENCE_MODEL_API_KEY", thinking_level: "off", max_tokens: 128, timeout_seconds: 10 };
      config.learning.extraction.enabled = true;
    });
    const selection = { ...fakeSelection, endpoint_fingerprint: `sha256:${createHash("sha256").update("").digest("hex")}`, timeout_seconds: 10 };
    const groupId = JSON.parse(execFileSync("python3", [CLI, "groups", "--data-root", root], { encoding: "utf8" })).groups[0].id;
    let feedback = runV2(root, "feedback", "list", null, {});
    const snapshot = { session_id: "session", task_key: "task", user_entry_id: "user", assistant_entry_id: "assistant", user_text: "请简洁", assistant_text: "这是当前结果", origin_verified: true, storage_mode: "ask" };
    const authorized = authorizeFeedback(root, "fix: 请简洁", snapshot, selection, 1);
    const created = runV2(root, "feedback", "create", authorized.cas.generation, { feedback: "fix: 请简洁", group_id: groupId, snapshot, model_selection: selection, consent_revision: 1 });
    feedback = runV2(root, "feedback", "list", null, {});
    const claimed = runV2(root, "learning-job", "claim", feedback.cas.generation, { job_id: created.data.job.job_id, owner_id: "worker", consent_revision: 1, model_selection: selection, lease_seconds: 30 });
    runV2(root, "learning-job", "complete", claimed.cas.generation, { job_id: created.data.job.job_id, token: claimed.data.job.lease.token, input_digest: claimed.data.job.input_digest, model_selection: selection, consent_revision: 1, output: extractionOutput(groupId) });

    const harness = feedbackExtensionHarness();
    const previewBodies: string[] = [];
    let top = 0;
    let evidenceChoices = 0;
    const session = sessionWithFeedbackTarget();
    const ctx: any = {
      cwd: "/workspace", sessionManager: session, hasUI: true, waitForIdle: async () => {},
      ui: {
        setStatus() {}, notify() {}, input: async () => undefined, editor: async () => undefined,
        select: async (title: string, options: string[]) => {
          if (title === "个人偏好") return top++ === 0 ? "管理学习证据" : undefined;
          if (title === "选择学习证据") return evidenceChoices++ === 0 ? options[0] : undefined;
          if (title === "管理学习证据") return "发布";
          return undefined;
        },
        confirm: async (title: string, body: string) => {
          if (title.startsWith("查看待发布修订")) { previewBodies.push(body); return false; }
          throw new Error(`unexpected confirmation ${title}`);
        },
      },
    };
    await harness.command.handler("", ctx);
    assert.equal(previewBodies.length, 1);
    assert.match(previewBodies[0], /"raw_feedback": "fix: 请简洁"/u);
    assert.match(previewBodies[0], /"text": "这是当前结果"/u);
    const evidence = runV2(root, "evidence", "list", null, {});
    assert.equal(evidence.data.evidence[0].repo_revision_count, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard exposes the real learning-evidence management entry", async () => {
  let managed = false;
  const selections = ["管理学习证据", undefined];
  const ctx: any = { cwd: "/workspace", hasUI: true, ui: { setStatus() {}, notify() {}, select: async () => selections.shift() } };
  const invoke = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args[0] === "status") return { enabled: true, groups: 1, rules: 0, pending_feedback_count: 0, pending_evidence_count: 1, model_ready: null, sync_state: "no-remote" };
    if (args[0] === "context") return { effective_groups: [], directory_groups: [], session_groups: [] };
    throw new Error(`unexpected dashboard command ${args[0]}`);
  };
  await showPreferenceDashboard(ctx, invoke as any, { remember: async () => {}, feedback: async () => {}, manageEvidence: async () => { managed = true; }, sessionId: "session" });
  assert.equal(managed, true);
});

test("the real custom feedback wrapper forwards UI cancellation to the active HTTP subprocess", async () => {
  const root = tempRoot();
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousKey = process.env.PREFERENCE_TEST_KEY;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  process.env.PREFERENCE_TEST_KEY = "fixture-key";
  let requestStarted!: () => void;
  let requestClosed!: () => void;
  const started = new Promise<void>((resolveStarted) => { requestStarted = resolveStarted; });
  const closed = new Promise<void>((resolveClosed) => { requestClosed = resolveClosed; });
  const server = createServer((_request, response) => {
    requestStarted();
    const timer = setTimeout(() => {
      if (response.destroyed) return;
      const body = JSON.stringify({ choices: [{ message: { content: "{}" } }] });
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      response.end(body);
    }, 2_000);
    response.on("close", () => { clearTimeout(timer); requestClosed(); });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    init(root);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server did not expose a port");
    setConfig(root, (config) => {
      config.provider = { name: "openai_compatible", model: "fixture", api_key_env: "PREFERENCE_TEST_KEY", base_url: `http://127.0.0.1:${address.port}/v1`, thinking_level: "off", timeout_seconds: 5, max_tokens: 2048 };
      config.learning.extraction.enabled = true;
      config.privacy.context_mode = "ask";
    });
    const session = sessionWithFeedbackTarget();
    const command = feedbackCommandHarness(session);
    const confirmations: Array<{ title: string; body: string }> = [];
    const ctx: any = {
      cwd: "/workspace", hasUI: true, sessionManager: session, model: undefined, modelRegistry: {}, thinkingLevel: "off", waitForIdle: async () => {},
      ui: { notify() {}, setStatus() {}, select: async () => undefined, input: async () => undefined, confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; } },
    };
    await command.handler("feedback --group global fix 请更简洁", ctx);
    await started;
    let dashboardSelections = 0;
    ctx.ui.select = async (title: string, options: string[]) => {
      if (title === "个人偏好") return dashboardSelections++ === 0 ? "管理反馈任务" : undefined;
      if (title === "选择反馈任务") return options[0];
      if (title === "管理反馈任务") return "取消";
      return undefined;
    };
    await command.handler("", ctx);
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("custom HTTP subprocess was not aborted")), 700)),
    ]);
    const jobs = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    assert.equal(jobs[0].state, "cancelled");
    assert.equal(readFileSync(join(root, "local/feedback-snapshots", `${jobs[0].job_id}.json`), "utf8").length > 0, true);
    assert.match(confirmations.at(-1)?.body ?? "", /原始反馈和现有快照继续保留/u);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.PREFERENCE_TEST_KEY; else process.env.PREFERENCE_TEST_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real feedback menu shows source details and accurately deletes the job and snapshot", async () => {
  const root = tempRoot();
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    setConfig(root, (config) => { config.privacy.context_mode = "local_only"; });
    const session = sessionWithFeedbackTarget();
    const command = feedbackCommandHarness(session);
    const notifications: string[] = [];
    const confirmations: Array<{ title: string; body: string }> = [];
    const ctx: any = {
      cwd: "/workspace", hasUI: true, sessionManager: session,
      model: undefined,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }) },
      thinkingLevel: "off", waitForIdle: async () => {},
      ui: { notify: (message: string) => notifications.push(message), setStatus() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false },
    };
    await command.handler("feedback --group global good", ctx);
    const before = JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8"));
    const jobId = before[0].job_id;
    const snapshotPath = join(root, "local/feedback-snapshots", `${jobId}.json`);
    assert.equal(readFileSync(snapshotPath, "utf8").length > 0, true);
    let dashboardSelections = 0;
    ctx.ui.select = async (title: string, options: string[]) => {
      if (title === "个人偏好") return dashboardSelections++ === 0 ? "管理反馈任务" : undefined;
      if (title === "选择反馈任务") return options[0];
      if (title === "管理反馈任务") return "删除";
      return undefined;
    };
    ctx.ui.confirm = async (title: string, body: string) => { confirmations.push({ title, body }); return true; };
    await command.handler("", ctx);
    assert.match(notifications.join("\n"), /请求：请给出简洁结论/u);
    assert.match(notifications.join("\n"), /结果：这是当前结果/u);
    assert.equal(confirmations[0].title, "删除反馈任务？");
    assert.match(confirmations[0].body, /原始反馈和本机快照将被永久删除/u);
    assert.doesNotMatch(confirmations[0].body, /将保留/u);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "local/feedback-jobs.json"), "utf8")), []);
    assert.throws(() => readFileSync(snapshotPath, "utf8"));
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT; else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi frozen timeout aborts the provider request", async () => {
  const model = { provider: "provider", id: "slow", baseUrl: "https://slow", reasoning: true };
  const ctx: any = { model, modelRegistry: { find: () => model, getProvider: () => ({ streamSimple: (_m: any, _c: any, options: any) => ({ result: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) }) }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {}, baseUrl: "https://slow" }) } };
  const { createHash } = await import("node:crypto");
  await assert.rejects(() => completeWithFrozenPiModel(ctx, { provider_source: "pi", provider_id: "provider", model_id: "slow", api_type: "pi", endpoint_fingerprint: `sha256:${createHash("sha256").update("https://slow").digest("hex")}`, thinking_level: "off", max_tokens: 32, timeout_seconds: 0.02, config_version: 2 }, "off", "{}", new AbortController().signal), /超时|aborted/u);
});

test("frozen Pi model resolves through registry and verifies resolved auth endpoint", async () => {
  const calls: any[] = [];
  const model = { provider: "provider", id: "model", baseUrl: "https://declared.example/v1", reasoning: true };
  const ctx: any = {
    model,
    thinkingLevel: "high",
    modelRegistry: {
      find: () => model,
      getProvider: () => ({ streamSimple: (_model: any, _context: any, options: any) => { calls.push(options); return { result: async () => ({ content: [{ type: "text", text: "{}" }], stopReason: "stop" }) }; } }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {}, baseUrl: "https://resolved.example/v1" }),
    },
  };
  const endpoint = "sha256:8e06a5e5f4d3f1d5f1e4f7ba9872f9b6a4ab20c2f8d873d35b3a6be3fbd0d2c7";
  // Compute the exact fingerprint through the public hash behavior without using a real provider.
  const { createHash } = await import("node:crypto");
  const result = await completeWithFrozenPiModel(ctx, { provider_source: "pi", provider_id: "provider", model_id: "model", api_type: "pi", endpoint_fingerprint: `sha256:${createHash("sha256").update("https://resolved.example/v1").digest("hex")}`, thinking_level: "high", max_tokens: 128, timeout_seconds: 10, config_version: 2 }, "high", "{}", new AbortController().signal);
  assert.equal(result, "{}");
  assert.equal(calls[0].reasoning, "high");
  await assert.rejects(() => completeWithFrozenPiModel(ctx, { provider_source: "pi", provider_id: "provider", model_id: "model", api_type: "pi", endpoint_fingerprint: endpoint, thinking_level: "high", max_tokens: 128, timeout_seconds: 10, config_version: 2 }, "high", "{}", new AbortController().signal), /endpoint/u);
});
