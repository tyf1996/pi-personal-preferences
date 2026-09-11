import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import preferenceExtension from "../index.ts";
import { PreferenceCliCleanupError, runPreferenceCli } from "../src/cli-client.ts";
import { selectEvidence } from "../src/evidence-picker.ts";
import { parsePrefCommand, preferenceCommandNames } from "../src/commands.ts";
import { formatPreferenceSummary } from "../src/dashboard.ts";
import {
  conversationQuoteRole,
  parseConversationTurn,
  recentConversationTurns,
  selectConversationTurns,
  turnAssistantText,
  turnFileChanges,
  turnUserText,
  type ConversationTurn,
} from "../src/feedback-context.ts";
import { renderPreferenceFooter } from "../src/footer.ts";
import { MenuSession } from "../src/menu.ts";
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

interface FixtureResources {
  roots: Set<string>;
  shutdowns: Array<() => Promise<void>>;
  cleanupFailures: unknown[];
}

const fixtureResources = new WeakMap<test.TestContext, FixtureResources>();

function resourcesFor(t: test.TestContext): FixtureResources {
  const existing = fixtureResources.get(t);
  if (existing) return existing;
  const resources: FixtureResources = { roots: new Set(), shutdowns: [], cleanupFailures: [] };
  fixtureResources.set(t, resources);
  t.after(async () => {
    const failures: unknown[] = [...resources.cleanupFailures];
    for (const shutdown of [...resources.shutdowns].reverse()) {
      try {
        await shutdown();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "personal preference fixture cleanup failed");
    for (const root of resources.roots) rmSync(root, { recursive: true, force: true });
  });
  return resources;
}

function temporaryRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "pi-pref-fast-"));
  resourcesFor(t).roots.add(root);
  return root;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function writeStatusGateCli(root: string): { script: string; events: string; allow: string; failStatus: string } {
  const events = join(root, "status-events");
  mkdirSync(events);
  const script = join(root, "status-gate.py");
  const allow = join(events, "allow");
  const failStatus = join(events, "fail-status");
  writeFileSync(script, [
    "import json, os, signal, sys, time",
    "events = os.environ['PI_PREF_STATUS_EVENTS']",
    "allow = os.environ['PI_PREF_STATUS_ALLOW']",
    "fail_status = os.environ['PI_PREF_STATUS_FAIL']",
    "command = sys.argv[1]",
    "pid = os.getpid()",
    "def mark(kind):",
    "    with open(os.path.join(events, f'{pid}.{command}.{kind}'), 'w', encoding='utf-8') as handle:",
    "        handle.write(kind)",
    "def stop(signum, _frame):",
    "    mark('closed')",
    "    raise SystemExit(128 + signum)",
    "signal.signal(signal.SIGTERM, stop)",
    "mark('started')",
    "if not os.path.exists(allow) and command == 'status' and os.path.exists(fail_status):",
    "    mark('failed')",
    "    mark('closed')",
    "    print(json.dumps({'ok': False, 'error': {'message': 'controlled status failure'}}))",
    "    raise SystemExit(1)",
    "while not os.path.exists(allow) and not os.path.exists(os.path.join(events, f'release-{pid}')):",
    "    time.sleep(0.01)",
    "if command == 'status':",
    "    value = {'ok': True, 'enabled': True, 'groups': 1, 'rules': 0, 'sync_state': 'clean', 'actionable_count': 0}",
    "elif command == 'context':",
    "    value = {'ok': True, 'effective_groups': ['global']}",
    "else:",
    "    value = {'ok': True, 'feedback': [], 'proposals': [], 'evolution_groups': []}",
    "mark('closed')",
    "print(json.dumps(value))",
  ].join("\n"));
  return { script, events, allow, failStatus };
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

function successfulFileChangeBranch(): Json[] {
  return [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "change files" }] } },
    { type: "message", message: {
      role: "assistant",
      content: [
        { type: "text", text: "editing" },
        { type: "toolCall", id: "edit-ok", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] } },
        { type: "toolCall", id: "write-ok", name: "write", arguments: { path: "notes.md", content: "  line one\nsecret sk_abcdefghijklmnop\n  " } },
        { type: "toolCall", id: "read-ignore", name: "read", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "edit-fail", name: "edit", arguments: { path: "src/fail.ts", oldText: "x", newText: "y" } },
        { type: "toolCall", id: "edit-mismatch", name: "edit", arguments: { path: "src/mismatch.ts", oldText: "x", newText: "y" } },
        { type: "toolCall", id: "write-missing", name: "write", arguments: { path: "missing.md", content: "missing" } },
      ],
      stopReason: "toolUse",
    } },
    { type: "message", message: { role: "toolResult", toolCallId: "write-ok", toolName: "write", isError: false, content: [{ type: "text", text: "written" }], details: {} } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-ok", toolName: "edit", isError: false, content: [{ type: "text", text: "edited" }], details: { patch: "@@ patch body @@" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-ok", toolName: "edit", isError: false, content: [{ type: "text", text: "duplicate" }], details: { patch: "@@ patch body @@" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-fail", toolName: "edit", isError: true, content: [{ type: "text", text: "failed" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "orphan", toolName: "write", isError: false, content: [{ type: "text", text: "orphan" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-mismatch", toolName: "write", isError: false, content: [{ type: "text", text: "mismatch" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "keep the indentation" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
  ];
}

function orderedTurn(quote = "ORDERED-TOOL-QUOTE", path = "ordered.md"): Json {
  return {
    events: [
      { type: "user", text: "ordered user" },
      { type: "assistant", text: "ordered assistant before" },
      { type: "file_change_call", call_id: "change-1", tool: "write", path },
      { type: "file_change_result", call_id: "change-1", content: quote },
      { type: "assistant", text: "ordered assistant after" },
    ],
  };
}

function evaluation(feedback: Json): Json {
  return { sentiment: feedback.sentiment, reason: feedback.reason };
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
    expected_evaluation: evaluation(created.feedback),
    extraction: extraction(shared, { name: groupName, certain: true, summary: `evidence ${index}` }),
    model: { provider: "fake", id: "fake", thinking: "high" },
  });
  ok(root, ["feedback-complete", "--stdin"], {
    feedback_id: created.feedback.id,
    expected_evaluation: evaluation(created.feedback),
    group: groupName,
  });
  return created.feedback;
}

function addProposal(root: string, group: string, proposedRules: string[]): Json {
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group });
  assert.equal(prepared.trigger, true);
  return ok(root, ["save-evolution", "--stdin"], {
    group_id: prepared.group.id,
    base_digest: prepared.base_digest,
    evidence_digest: prepared.evidence_digest,
    evidence_ids: prepared.evidence.map((item: Json) => item.id),
    proposed_rules: proposedRules,
    rationale: `proposal for ${group}`,
  }).proposal;
}

function writeDelayedPreferenceCli(root: string, command: string): { script: string; started: string } {
  const script = join(root, `delay-${command}.py`);
  const started = join(root, `${command}.started`);
  writeFileSync(script, [
    "import os, signal, sys, time",
    `target = ${JSON.stringify(command)}`,
    `started = ${JSON.stringify(started)}`,
    `real = ${JSON.stringify(cliPath)}`,
    "if len(sys.argv) > 1 and sys.argv[1] == target:",
    "    open(started, 'w', encoding='utf-8').write('started')",
    "    def stop(*_args): raise SystemExit(143)",
    "    signal.signal(signal.SIGTERM, stop)",
    "    while True: time.sleep(0.01)",
    "os.execv(sys.executable, [sys.executable, real, *sys.argv[1:]])",
  ].join("\n"));
  return { script, started };
}

function writeFirstContextGateCli(root: string): {
  script: string;
  log: string;
  arm: string;
  release: string;
  started: string;
} {
  const script = join(root, "first-context-gate.py");
  const log = join(root, "first-context-gate.log");
  const arm = join(root, "first-context-gate.arm");
  const release = join(root, "first-context-gate.release");
  const started = join(root, "first-context-gate.started");
  const claimed = join(root, "first-context-gate.claimed");
  writeFileSync(script, [
    "import os, signal, sys, time",
    `real = ${JSON.stringify(cliPath)}`,
    `log = ${JSON.stringify(log)}`,
    `arm = ${JSON.stringify(arm)}`,
    `release = ${JSON.stringify(release)}`,
    `started = ${JSON.stringify(started)}`,
    `claimed = ${JSON.stringify(claimed)}`,
    "command = sys.argv[1] if len(sys.argv) > 1 else ''",
    "with open(log, 'a', encoding='utf-8') as handle: handle.write(command + '\\n')",
    "should_wait = False",
    "if command == 'context' and os.path.exists(arm):",
    "    try:",
    "        descriptor = os.open(claimed, os.O_CREAT | os.O_EXCL | os.O_WRONLY)",
    "        os.close(descriptor)",
    "        should_wait = True",
    "    except FileExistsError:",
    "        pass",
    "if should_wait:",
    "    open(started, 'w', encoding='utf-8').write('started')",
    "    def stop(*_args): raise SystemExit(143)",
    "    signal.signal(signal.SIGTERM, stop)",
    "    while not os.path.exists(release): time.sleep(0.01)",
    "os.execv(sys.executable, [sys.executable, real, *sys.argv[1:]])",
  ].join("\n"));
  return { script, log, arm, release, started };
}

interface HarnessOptions {
  root?: string;
  mode?: "tui" | "rpc";
  branch?: Json[];
  model?: Json | null;
  modelReply?: (prompt: string, call: number, request: Json) => ModelReply | Promise<ModelReply>;
  pickerInputs?: string[][];
  evidenceInputs?: string[][];
  loaderInputs?: string[][];
  detailInputs?: string[][];
  selectReply?: (title: string, choices: string[]) => string | undefined;
  inputReplies?: Array<string | undefined>;
  editorReply?: (title: string, prefill: string | undefined) => string | undefined | Promise<string | undefined>;
  terminalRows?: number;
  terminalColumns?: number;
  preferenceCli?: string;
  menuInputs?: Array<{ title: string; keys: string[] }>;
}

function harness(t: test.TestContext, options: HarnessOptions = {}) {
  const root = options.root ?? temporaryRoot(t);
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  process.env.WIKISKILL_PREFERENCE_CLI = options.preferenceCli ?? cliPath;
  const commands = new Map<string, Json>();
  const handlers = new Map<string, Function>();
  let sentMessages = 0;
  let appendedEntries = 0;
  preferenceExtension({
    registerCommand(name: string, command: Json) { commands.set(name, command); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    sendMessage() { sentMessages += 1; throw new Error("sendMessage must not be used"); },
    sendUserMessage() { sentMessages += 1; throw new Error("sendUserMessage must not be used"); },
    appendEntry() { appendedEntries += 1; throw new Error("appendEntry must not be used"); },
  } as any);

  const events: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const prompts: string[] = [];
  const modelRequests: Json[] = [];
  const selects: Array<{ title: string; choices: string[] }> = [];
  const editors: Array<{ title: string; prefill: string | undefined }> = [];
  const statuses: Array<string | undefined> = [];
  const renderedViews: string[][] = [];
  const customComponents: any[] = [];
  const pickerInputs = [...(options.pickerInputs ?? [])];
  const evidenceInputs = [...(options.evidenceInputs ?? [])];
  const loaderInputs = [...(options.loaderInputs ?? [])];
  const detailInputs = [...(options.detailInputs ?? [])];
  const inputReplies = [...(options.inputReplies ?? [])];
  const menuInputs = [...(options.menuInputs ?? [])];
  const theme = { fg(_name: string, text: string) { return text; }, bold(text: string) { return text; } };
  const terminal = { rows: options.terminalRows ?? 24, columns: options.terminalColumns ?? 80 };
  const tui = { requestRender() {}, terminal };
  let modelCalls = 0;
  let started = false;
  let systemPrompt = "base";
  let menuTarget: string | undefined;
  let menuSeen = false;
  const branch = options.branch ?? completedBranch(1, "selected");

  const mainMenuChoices = [
    "查看当前状态", "记录反馈", "反馈与证据", "重新整理反馈", "处理待办", "手动演化规则", "记住一条规则", "管理组与规则",
    "为当前目录启用组", "为当前目录禁用组", "为当前会话启用组", "为当前会话禁用组", "同步正式规则",
  ];

  function driveMenu(component: any, target: string): void {
    for (let index = 0; index < 50; index += 1) {
      const lines = component.render?.(terminal.columns) ?? [];
      const selected = lines.find((line: string) => line.includes("→ ")) ?? "";
      if (selected.includes(target) || selected.includes(target.slice(0, 24))) {
        component.handleInput?.("\x1b[C");
        return;
      }
      component.handleInput?.("\x1b[B");
    }
    throw new Error(`menu target not found: ${target}`);
  }

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
    async editor(title: string, prefill?: string) {
      editors.push({ title, prefill });
      return options.editorReply ? options.editorReply(title, prefill) : inputReplies.shift();
    },
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
          const isEvidencePicker = initial.some((line: string) => line.includes("选择演化证据"));
          const isLoader = component?.constructor?.name === "BorderedLoader";
          const isMenu = initial.some((line: string) => line.includes("Right/Enter 进入") || line.includes("→ 进入") || line.includes("Space 编辑"));
          if (isMenu) {
            const rendered = initial.join("\n");
            const menuTitle = String(initial[1] ?? "").trim();
            const explicit = menuInputs.findIndex((item) => menuTitle === item.title || menuTitle.startsWith(`${item.title} ·`));
            if (explicit >= 0) {
              const [{ keys }] = menuInputs.splice(explicit, 1);
              for (const key of keys) component.handleInput?.(key);
            } else if (rendered.includes("个人偏好")) {
              selects.push({ title: "个人偏好", choices: mainMenuChoices });
              let target: string | undefined;
              if (menuTarget) {
                if (!menuSeen) {
                  menuSeen = true;
                  target = menuTarget;
                }
              } else {
                target = options.selectReply?.("个人偏好", mainMenuChoices);
              }
              if (target) driveMenu(component, target);
              else component.handleInput?.("\x1b[D");
            } else {
              component.handleInput?.("\x1b[C");
            }
            renderedViews.push(component.render?.(terminal.columns) ?? []);
          } else {
            const inputs = isPicker
              ? pickerInputs.shift() ?? [" ", "\r"]
              : isEvidencePicker
                ? evidenceInputs.shift() ?? [" ", "\r"]
              : isLoader
                ? loaderInputs.shift() ?? []
                : detailInputs.shift() ?? ["\x1b"];
            for (const key of inputs) {
              component.handleInput?.(key);
              renderedViews.push(component.render?.(terminal.columns) ?? []);
            }
          }
        } catch (error) {
          rejectPromise(error);
        }
      });
    },
  };

  const ctx: Json = {
    mode: options.mode ?? "tui",
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
    getSystemPrompt() { return systemPrompt; },
  };

  async function start() {
    if (started) return;
    started = true;
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  }

  const fixture = {
    root,
    ctx,
    events,
    notices,
    prompts,
    modelRequests,
    selects,
    editors,
    statuses,
    renderedViews,
    get sentMessages() { return sentMessages; },
    get appendedEntries() { return appendedEntries; },
    get modelCalls() { return modelCalls; },
    setSystemPrompt(value: string) { systemPrompt = value; },
    sendLastCustom(data: string) {
      const component = customComponents.at(-1);
      if (!component) throw new Error("no custom component is active");
      component.handleInput?.(data);
      renderedViews.push(component.render?.(terminal.columns) ?? []);
    },
    freshContext() {
      return { ...ctx, ui: { ...ui } };
    },
    async pref(args: string) {
      await start();
      await commands.get("pref")!.handler(args, ctx);
    },
    async prefWithContext(args: string, commandContext: Json) {
      await start();
      await commands.get("pref")!.handler(args, commandContext);
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
      try {
        await handlers.get("session_shutdown")?.({ reason }, ctx);
      } catch (error) {
        resourcesFor(t).cleanupFailures.push(error);
        throw error;
      }
    },
    handler(name: string) { return handlers.get(name); },
  };
  resourcesFor(t).shutdowns.push(() => fixture.shutdown());
  return fixture;
}

test("E01 feedback list Space edits type and full reason while select and RPC remain read-only", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const created = addCliEvidence(root, 1);
  const flow = harness(t, {
    root,
    editorReply: () => "新 理由\n第二行 中文",
    menuInputs: [
      { title: "反馈与证据", keys: [" "] },
      { title: "编辑评价类型（暂存）", keys: ["\x1b[B", "\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
    ],
  });
  await flow.menu("反馈与证据");
  const stored = ok(root, ["feedback-get", "--stdin"], { feedback_id: created.id }).feedback;
  assert.equal(stored.sentiment, "good");
  assert.equal(stored.reason, "新 理由\n第二行 中文");
  assert.equal(flow.modelCalls, 0);
  assert.deepEqual(flow.editors, [{
    title: "编辑评价理由 · 提交即覆盖保存 good 类型与完整理由",
    prefill: "original reason 1",
  }]);
  assert.ok(flow.renderedViews.some((view) => view.some((line) => line.includes("Space 编辑"))));
  assert.ok(flow.renderedViews.some((view) => view.some((line) => line.includes("→") && line.includes("新 理由 第二行 中文"))));
  assert.ok(flow.notices.some((item) => item.message.includes("评价已更新") && item.message.includes("已有证据未自动更新")));

  for (const columns of [24, 30, 40, 80]) {
    let component: any;
    const selection = new MenuSession({
      mode: "tui",
      ui: { custom(factory: Function) {
        return new Promise((resolvePromise) => {
          component = factory({ requestRender() {}, terminal: { rows: 24, columns } }, themeForTest(), {}, resolvePromise);
        });
      } },
    } as any).selectAction("narrow-feedback", "反馈与证据", Array.from({ length: 30 }, (_, index) => ({
      value: `feedback-${index}`,
      label: `r${index} ${"长中文".repeat(20)}`,
    })));
    const initial = component.render(columns);
    assert.ok(initial.some((line: string) => line.includes("Space")));
    assert.ok(initial.length <= 24);
    assert.ok(initial.every((line: string) => visibleWidth(line) <= columns));
    for (let index = 0; index < 29; index += 1) component.handleInput("\x1b[B");
    const finalView = component.render(columns);
    assert.ok(finalView.length <= 24);
    assert.ok(finalView.every((line: string) => visibleWidth(line) <= columns));
    assert.ok(finalView.some((line: string) => line.includes("→") && line.includes("r29")));
    component.handleInput(" ");
    assert.deepEqual(await selection, { value: "feedback-29", action: "space" });
  }

  const viewOnly = harness(t, {
    root,
    menuInputs: [
      { title: "反馈与证据", keys: ["\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
    ],
  });
  await viewOnly.menu("反馈与证据");
  assert.equal(viewOnly.editors.length, 0);

  let rpcSelections = 0;
  const rpc = harness(t, {
    root,
    mode: "rpc",
    selectReply: (title, choices) => {
      if (title === "反馈与证据" && rpcSelections++ === 0) return choices[0];
      return undefined;
    },
  });
  await rpc.menu("反馈与证据");
  assert.equal(rpc.editors.length, 0);
  assert.equal(ok(root, ["feedback-get", "--stdin"], { feedback_id: created.id }).feedback.reason, "新 理由\n第二行 中文");
});

test("E02 cancellation, invalid and unchanged edits are inert while all feedback labels stay single-line", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix",
    reason: "第一行\n第二行\t中文",
    selected_turns: [{ user: "u", assistant: "a" }],
    model: null,
    group: null,
  }).feedback;
  const before = readFileSync(join(root, "local/learning.json"), "utf8");
  const same = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: created.id,
    expected_evaluation: evaluation(created),
    sentiment: "fix",
    reason: "第一行\n第二行\t中文",
  });
  assert.equal(same.changed, false);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  for (const reason of [" \n\t ", "x".repeat(4001)]) {
    const rejected = cli(root, ["feedback-edit-evaluation", "--stdin"], {
      feedback_id: created.id,
      expected_evaluation: evaluation(created),
      sentiment: "good",
      reason,
    });
    assert.equal(rejected.ok, false);
    assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  }

  const cancelled = harness(t, {
    root,
    editorReply: () => undefined,
    menuInputs: [
      { title: "反馈与证据", keys: [" "] },
      { title: "编辑评价类型（暂存）", keys: ["\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
    ],
  });
  await cancelled.menu("反馈与证据");
  assert.equal(cancelled.modelCalls, 0);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);

  for (const choice of ["反馈与证据", "重新整理反馈", "处理待办"]) {
    const labels = harness(t, {
      root,
      terminalColumns: 160,
      menuInputs: [{ title: choice, keys: ["\x1b[D"] }],
    });
    await labels.menu(choice);
    assert.ok(labels.renderedViews.flat().every((line) => !/[\r\n]/u.test(line)));
    assert.ok(labels.renderedViews.flat().some((line) => line.includes("第一行 第二行 中文")));
  }
  assert.equal(ok(root, ["feedback-get", "--stdin"], { feedback_id: created.id }).feedback.reason, "第一行\n第二行\t中文");

  const focusRoot = temporaryRoot(t);
  ok(focusRoot, ["init"]);
  ok(focusRoot, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "first row", selected_turns: [{ user: "u1", assistant: "a1" }], model: null, group: null,
  });
  const focusTarget = ok(focusRoot, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "target old", selected_turns: [{ user: "u2", assistant: "a2" }], model: null, group: null,
  }).feedback;
  ok(focusRoot, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "last row", selected_turns: [{ user: "u3", assistant: "a3" }], model: null, group: null,
  });
  const focused = harness(t, {
    root: focusRoot,
    terminalColumns: 160,
    editorReply: () => "目标新理由\n第二行",
    menuInputs: [
      { title: "反馈与证据", keys: ["\x1b[B", " "] },
      { title: "编辑评价类型（暂存）", keys: ["\x1b[B", "\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
    ],
  });
  await focused.menu("反馈与证据");
  const focusedSaved = ok(focusRoot, ["feedback-get", "--stdin"], { feedback_id: focusTarget.id }).feedback;
  assert.equal(focusedSaved.sentiment, "good");
  assert.equal(focusedSaved.reason, "目标新理由\n第二行");
  const focusedLine = focused.renderedViews.flat().find((line) =>
    line.includes("→") && line.includes(focusTarget.id.slice(-8)) && line.includes("目标新理由 第二行"));
  assert.ok(focusedLine);
  assert.match(focusedLine, /2\. good ·/);
  const narrowLabels = harness(t, {
    root: focusRoot,
    terminalColumns: 30,
    menuInputs: [{ title: "反馈与证据", keys: ["\x1b[D"] }],
  });
  await narrowLabels.menu("反馈与证据");
  assert.ok(narrowLabels.renderedViews.flat().some((line) => /[123]\. good ·/u.test(line)));
  assert.ok(narrowLabels.renderedViews.flat().some((line) => /[123]\. fix ·/u.test(line)));

  const redacted = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: created.id,
    expected_evaluation: evaluation(created),
    sentiment: "good",
    reason: "token sk_abcdefghijklmnop should be hidden",
  });
  assert.equal(redacted.feedback.reason, "token [REDACTED_CREDENTIAL] should be hidden");
});

test("E03 evaluation save preserves evidence and unrelated state, clears obsolete extraction, and stales only related proposals", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "coding", description: "coding" });
  const globalFeedback = [1, 2, 3].map((index) => addCliEvidence(root, index));
  [4, 5, 6].forEach((index) => addCliEvidence(root, index, "assistant", "coding"));
  const related = addProposal(root, "global", ["global proposal"]);
  const unrelated = addProposal(root, "coding", ["coding proposal"]);
  const beforeLearning = learning(root);
  const beforeGroups = readFileSync(join(root, "repo/groups.json"), "utf8");
  const beforeHead = spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout;
  const original = beforeLearning.feedback.find((item: Json) => item.id === globalFeedback[0]!.id);
  const originalEvidence = beforeLearning.evidence.find((item: Json) => item.id === original.evidence_id);
  const edited = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: original.id,
    expected_evaluation: evaluation(original),
    sentiment: "good",
    reason: "updated organized evaluation",
  });
  assert.equal(edited.changed, true);
  assert.equal(edited.invalidated_proposal_count, 1);
  const after = learning(root);
  const saved = after.feedback.find((item: Json) => item.id === original.id);
  assert.deepEqual(after.evidence.find((item: Json) => item.id === originalEvidence.id), originalEvidence);
  for (const key of ["id", "created_at", "selected_turns", "model", "group_name", "status", "evidence_id", "error", "extraction"]) {
    assert.deepEqual(saved[key], original[key]);
  }
  assert.equal(after.proposals.find((item: Json) => item.id === related.id).status, "stale");
  assert.equal(after.proposals.find((item: Json) => item.id === unrelated.id).status, "pending");
  assert.deepEqual(after.reviewed_evidence, beforeLearning.reviewed_evidence);
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), beforeGroups);
  assert.equal(spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout, beforeHead);

  const pending = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "old pending reason", selected_turns: [{ user: "pending", assistant: "pending answer" }],
    model: null, group: null,
  }).feedback;
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: pending.id,
    expected_evaluation: evaluation(pending),
    extraction: extraction("pending answer", { name: null, certain: false }),
    model: { provider: "fake", id: "old", thinking: "low" },
  });
  const pendingBefore = ok(root, ["feedback-get", "--stdin"], { feedback_id: pending.id }).feedback;
  const reset = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: pending.id,
    expected_evaluation: evaluation(pendingBefore),
    sentiment: "good",
    reason: "new pending reason",
  }).feedback;
  assert.equal(reset.status, "saved");
  assert.equal(reset.extraction, null);
  assert.equal(reset.error, null);
  assert.deepEqual(reset.selected_turns, pending.selected_turns);
  assert.equal(learning(root).evidence.some((item: Json) => item.feedback_id === pending.id), false);
});

test("E04 optimistic evaluation edits allow unrelated progress and roll back atomically on write failure", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const first = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "shared old", selected_turns: [{ user: "u1", assistant: "a1" }], model: null, group: null,
  }).feedback;
  const expected = evaluation(first);
  ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: first.id, expected_evaluation: expected, sentiment: "good", reason: "first writer",
  });
  const stale = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: first.id, expected_evaluation: expected, sentiment: "fix", reason: "second writer",
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.feedback.reason, "first writer");

  const progressed = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "progressed", selected_turns: [{ user: "u2", assistant: "a2" }], model: null, group: null,
  }).feedback;
  ok(root, ["feedback-fail", "--stdin"], {
    feedback_id: progressed.id, expected_evaluation: evaluation(progressed), error: "background status",
  });
  ok(root, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "unrelated", selected_turns: [{ user: "u3", assistant: "a3" }], model: null, group: null,
  });
  const allowed = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: progressed.id, expected_evaluation: evaluation(progressed), sentiment: "good", reason: "allowed after progress",
  });
  assert.equal(allowed.changed, true);

  const proposalRoot = temporaryRoot(t);
  ok(proposalRoot, ["init"]);
  const candidateFeedback = [1, 2, 3].map((index) => addCliEvidence(proposalRoot, index));
  addProposal(proposalRoot, "global", ["must remain pending"]);
  const target = ok(proposalRoot, ["feedback-get", "--stdin"], { feedback_id: candidateFeedback[0]!.id }).feedback;
  const payload = {
    feedback_id: target.id,
    expected_evaluation: evaluation(target),
    sentiment: target.sentiment === "good" ? "fix" : "good",
    reason: "must fail atomically",
  };
  const beforeFailure = readFileSync(join(proposalRoot, "local/learning.json"), "utf8");
  const script = [
    "from pathlib import Path",
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(pythonRoot)})`,
    "import wikiskill_preference as cli",
    "from wikiskill_preference_core.storage import PreferenceStore",
    `store = PreferenceStore(Path(${JSON.stringify(proposalRoot)}))`,
    `payload = json.loads(${JSON.stringify(JSON.stringify(payload))})`,
    "store.write_learning = lambda _value: (_ for _ in ()).throw(OSError('write failed'))",
    "try:",
    "    cli._feedback_edit_evaluation(store, payload)",
    "except OSError:",
    "    pass",
  ].join("\n");
  const failed = spawnSync("python3", ["-c", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(readFileSync(join(proposalRoot, "local/learning.json"), "utf8"), beforeFailure);
});

test("E05 required evaluation snapshots reject every old success and failure callback without pollution", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const initial = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "initial", selected_turns: [{ user: "old user", assistant: "old answer" }], model: null, group: "global",
  }).feedback;
  for (const [command, extra] of [
    ["feedback-extracted", { extraction: extraction("old answer"), model: { provider: "fake", id: "fake", thinking: "high" } }],
    ["feedback-complete", { group: "global" }],
    ["feedback-fail", { error: "old error" }],
  ] as const) {
    const missing = cli(root, [command, "--stdin"], { feedback_id: initial.id, ...extra });
    assert.equal(missing.ok, false);
    assert.match(missing.error.message, /expected_evaluation/);
    const invalid = cli(root, [command, "--stdin"], {
      feedback_id: initial.id,
      expected_evaluation: { sentiment: "maybe", reason: "initial" },
      ...extra,
    });
    assert.equal(invalid.ok, false);
  }

  const oldEvaluation = evaluation(initial);
  ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: initial.id, expected_evaluation: oldEvaluation, sentiment: "good", reason: "edited",
  });
  const afterEdit = readFileSync(join(root, "local/learning.json"), "utf8");
  for (const [command, extra] of [
    ["feedback-extracted", { extraction: extraction("old answer"), model: { provider: "fake", id: "old", thinking: "high" } }],
    ["feedback-fail", { error: "old failure" }],
  ] as const) {
    const stale = ok(root, [command, "--stdin"], { feedback_id: initial.id, expected_evaluation: oldEvaluation, ...extra });
    assert.equal(stale.stale, true);
    assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), afterEdit);
  }

  const grouping = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "before group", selected_turns: [{ user: "group user", assistant: "group answer" }], model: null, group: "global",
  }).feedback;
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: grouping.id, expected_evaluation: evaluation(grouping), extraction: extraction("group answer"),
    model: { provider: "fake", id: "old", thinking: "high" },
  });
  const groupingStored = ok(root, ["feedback-get", "--stdin"], { feedback_id: grouping.id }).feedback;
  ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: grouping.id, expected_evaluation: evaluation(groupingStored), sentiment: "good", reason: "changed before grouping",
  });
  const afterGroupingEdit = readFileSync(join(root, "local/learning.json"), "utf8");
  const staleComplete = ok(root, ["feedback-complete", "--stdin"], {
    feedback_id: grouping.id, expected_evaluation: evaluation(grouping), group: "global",
  });
  assert.equal(staleComplete.stale, true);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), afterGroupingEdit);

  const replaced = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "old complete", selected_turns: [{ user: "new user", assistant: "new answer" }], model: null, group: "global",
  }).feedback;
  const replacedOld = evaluation(replaced);
  const edited = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: replaced.id, expected_evaluation: replacedOld, sentiment: "good", reason: "new complete",
  }).feedback;
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: replaced.id, expected_evaluation: evaluation(edited), extraction: extraction("new answer"),
    model: { provider: "fake", id: "new", thinking: "high" },
  });
  ok(root, ["feedback-complete", "--stdin"], {
    feedback_id: replaced.id, expected_evaluation: evaluation(edited), group: "global",
  });
  const completedBytes = readFileSync(join(root, "local/learning.json"), "utf8");
  assert.equal(ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: replaced.id, expected_evaluation: replacedOld, extraction: extraction("new answer"),
    model: { provider: "fake", id: "old", thinking: "high" },
  }).stale, true);
  assert.equal(ok(root, ["feedback-fail", "--stdin"], {
    feedback_id: replaced.id, expected_evaluation: replacedOld, error: "late old failure",
  }).stale, true);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), completedBytes);

  const gate = deferred<ModelReply>();
  const flow = harness(t, { root: temporaryRoot(t), modelReply: () => gate.promise });
  await flow.pref("feedback --group global fix handler-initial");
  await waitFor(() => flow.modelCalls === 1, "feedback handler model start");
  const handlerFeedback = learning(flow.root).feedback[0];
  ok(flow.root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: handlerFeedback.id,
    expected_evaluation: evaluation(handlerFeedback),
    sentiment: "good",
    reason: "handler-new",
  });
  const statusCount = flow.statuses.length;
  gate.resolve(extraction("selected-assistant-0"));
  await waitFor(() => flow.statuses.slice(statusCount).some((status) =>
    typeof status === "string" && !status.includes("后台处理中") && !status.includes("状态异常")), "stale handler task completion");
  const handlerStored = learning(flow.root);
  assert.equal(handlerStored.feedback[0].reason, "handler-new");
  assert.equal(handlerStored.feedback[0].status, "saved");
  assert.equal(handlerStored.evidence.length, 0);
  assert.doesNotMatch(flow.notices.map((item) => item.message).join("\n"), /已整理|整理失败/);
});

test("E06 edits feed future reprocessing and invalidate old reprocess and evolution snapshots without model calls", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const feedback = [1, 2, 3].map((index) => addCliEvidence(root, index));
  const target = ok(root, ["feedback-get", "--stdin"], { feedback_id: feedback[2]!.id }).feedback;
  const reprocess = ok(root, ["feedback-reprocess", "--stdin"], { action: "prepare", feedback_id: target.id });
  const automatic = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  const manual = ok(root, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: automatic.group.id, evidence_ids: [target.evidence_id],
  });
  const edited = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: target.id,
    expected_evaluation: evaluation(target),
    sentiment: target.sentiment === "good" ? "fix" : "good",
    reason: "new evaluation used by reprocess",
  });
  assert.equal(edited.changed, true);
  assert.equal(cli(root, ["feedback-reprocess", "--stdin"], {
    action: "apply", feedback_id: target.id, group_id: reprocess.group.id,
    expected_digest: reprocess.expected_digest, expected_group_digest: reprocess.group.base_digest,
    extraction: reprocess.feedback.extraction, model: { provider: "fake", id: "fake", thinking: "high" },
  }).ok, false);
  assert.equal(cli(root, ["save-evolution", "--stdin"], {
    group_id: automatic.group.id, base_digest: automatic.base_digest, evidence_digest: automatic.evidence_digest,
    evidence_ids: automatic.evidence.map((item: Json) => item.id), proposed_rules: ["old automatic"], rationale: "old",
  }).ok, false);
  assert.equal(cli(root, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: manual.group.id, evidence_ids: manual.evidence_ids,
    base_digest: manual.base_digest, evidence_digest: manual.evidence_digest,
    proposed_rules: ["old manual"], rationale: "old",
  }).ok, false);

  const flow = harness(t, {
    root,
    detailInputs: [["\x1b"]],
    modelReply: () => extraction("quote-1", { summary: "fresh" }),
  });
  await flow.menu("重新整理反馈");
  assert.equal(flow.modelCalls, 1);
  const promptInput = JSON.parse(flow.prompts[0]!.split("\n\n").at(-1)!);
  assert.deepEqual(promptInput.evaluation, {
    sentiment: edited.feedback.sentiment,
    reason: "new evaluation used by reprocess",
  });

  const candidate = addProposal(root, "global", ["opened stale candidate"]);
  const candidateTarget = ok(root, ["feedback-get", "--stdin"], { feedback_id: feedback[1]!.id }).feedback;
  const beforeRules = readFileSync(join(root, "repo/groups.json"), "utf8");
  const candidateEdit = ok(root, ["feedback-edit-evaluation", "--stdin"], {
    feedback_id: candidateTarget.id,
    expected_evaluation: evaluation(candidateTarget),
    sentiment: candidateTarget.sentiment === "good" ? "fix" : "good",
    reason: "invalidate open candidate",
  });
  assert.equal(candidateEdit.invalidated_proposal_count, 1);
  const resolved = ok(root, ["resolve-evolution", "--stdin"], { proposal_id: candidate.id, decision: "apply" });
  assert.equal(resolved.proposal.status, "stale");
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), beforeRules);
  assert.equal(flow.modelCalls, 1);
});

test("E07 feedback list, get, type selection, and delayed native editor stop after shutdown without late save or UI", async (t) => {
  for (const command of ["feedback-list", "feedback-get"]) {
    const root = temporaryRoot(t);
    ok(root, ["init"]);
    addCliEvidence(root, 1);
    const delayed = writeDelayedPreferenceCli(root, command);
    const flow = harness(t, {
      root,
      preferenceCli: delayed.script,
      menuInputs: command === "feedback-get" ? [{ title: "反馈与证据", keys: ["\x1b[C"] }] : [],
    });
    const before = readFileSync(join(root, "local/learning.json"), "utf8");
    const running = flow.menu("反馈与证据");
    await waitFor(() => existsSync(delayed.started), `${command} start`);
    const views = flow.renderedViews.length;
    const notices = flow.notices.length;
    await flow.shutdown("reload");
    await running;
    assert.equal(flow.renderedViews.length, views);
    assert.equal(flow.notices.length, notices);
    assert.equal(flow.editors.length, 0);
    assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  }

  const typeRoot = temporaryRoot(t);
  ok(typeRoot, ["init"]);
  addCliEvidence(typeRoot, 1);
  const typeFlow = harness(t, {
    root: typeRoot,
    menuInputs: [
      { title: "反馈与证据", keys: [" "] },
      { title: "编辑评价类型（暂存）", keys: [] },
    ],
  });
  const typeBefore = readFileSync(join(typeRoot, "local/learning.json"), "utf8");
  const choosingType = typeFlow.menu("反馈与证据");
  await waitFor(() => typeFlow.renderedViews.flat().some((line) => line.includes("编辑评价类型")), "evaluation type selection");
  await typeFlow.shutdown("reload");
  await choosingType;
  assert.equal(typeFlow.editors.length, 0);
  assert.equal(readFileSync(join(typeRoot, "local/learning.json"), "utf8"), typeBefore);

  const editorRoot = temporaryRoot(t);
  ok(editorRoot, ["init"]);
  addCliEvidence(editorRoot, 1);
  const editorGate = deferred<string | undefined>();
  const editorFlow = harness(t, {
    root: editorRoot,
    editorReply: () => editorGate.promise,
    menuInputs: [
      { title: "反馈与证据", keys: [" "] },
      { title: "编辑评价类型（暂存）", keys: ["\x1b[C"] },
    ],
  });
  const editorBefore = readFileSync(join(editorRoot, "local/learning.json"), "utf8");
  const editing = editorFlow.menu("反馈与证据");
  await waitFor(() => editorFlow.editors.length === 1, "native editor start");
  const views = editorFlow.renderedViews.length;
  const notices = editorFlow.notices.length;
  await editorFlow.shutdown("reload");
  assert.equal(editorFlow.editors.length, 1);
  editorGate.resolve("must not save after shutdown");
  await editing;
  assert.equal(editorFlow.renderedViews.length, views);
  assert.equal(editorFlow.notices.length, notices);
  assert.equal(readFileSync(join(editorRoot, "local/learning.json"), "utf8"), editorBefore);
});

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
  assert.equal(turnUserText(turns[0]!), "turn-user-2");
  assert.match(turnUserText(turns.at(-1)!), /special-user[\s\S]*user-supplement/);
  assert.match(turnAssistantText(turns.at(-1)!), /visible-progress[\s\S]*visible-final/);
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

test("U01 manual evolution is always visible and explains missing evidence in TUI and RPC", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal rule is not evidence" });
  const before = readFileSync(join(root, "local/learning.json"), "utf8");
  const flow = harness(t, { root });
  await flow.menu("手动演化规则");
  assert.ok(flow.selects.some((item) => item.title === "个人偏好" && item.choices.includes("手动演化规则")));
  assert.ok(flow.notices.some((item) => item.message.includes("没有已整理且归属有效组的证据") && item.message.includes("正式规则不等于证据")));
  assert.equal(flow.modelCalls, 0);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  assert.deepEqual([...preferenceCommandNames], ["remember", "feedback"]);

  const rpc = harness(t, { root, mode: "rpc" });
  await rpc.menu("手动演化规则");
  assert.ok(rpc.notices.some((item) => item.message.includes("需要交互式 TUI")));
  assert.equal(rpc.modelCalls, 0);
  assert.equal(rpc.events.includes("custom"), false);
});

test("U02 manual evidence accepts one or historical selections while automatic thresholds stay unchanged", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "coding", description: "coding" });
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "obsolete", description: "obsolete" });
  ok(root, ["remember", "--stdin"], { group: "global", rule: "formal-only" });
  const first = addCliEvidence(root, 1);
  const second = addCliEvidence(root, 2);
  const coding = addCliEvidence(root, 3, "assistant", "coding");
  const orphan = addCliEvidence(root, 4, "assistant", "obsolete");
  ok(root, ["manage-group", "--stdin"], { action: "delete", group: "obsolete" });
  ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "pending extraction", selected_turns: [{ user: "pending", assistant: "pending assistant" }], model: null, group: null,
  });
  assert.equal(ok(root, ["prepare-evolution", "--stdin"], { group: "global" }).trigger, false);
  addCliEvidence(root, 5);
  assert.equal(ok(root, ["prepare-evolution", "--stdin"], { group: "global" }).trigger, true);
  const groupRows = ok(root, ["groups"]).groups;
  const globalId = groupRows.find((item: Json) => item.name === "global").id;
  const codingId = groupRows.find((item: Json) => item.name === "coding").id;
  const marked = learning(root);
  marked.reviewed_evidence[globalId] = [marked.evidence.find((item: Json) => item.feedback_id === first.id).id];
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(marked)}\n`);
  const firstEvidence = marked.evidence.find((item: Json) => item.feedback_id === first.id);
  const secondEvidence = marked.evidence.find((item: Json) => item.feedback_id === second.id);
  const codingEvidence = marked.evidence.find((item: Json) => item.feedback_id === coding.id);
  const orphanEvidence = marked.evidence.find((item: Json) => item.feedback_id === orphan.id);
  const before = readFileSync(join(root, "local/learning.json"), "utf8");

  const listed = ok(root, ["manual-evolution", "--stdin"], { action: "list" });
  assert.deepEqual(new Set(listed.groups.map((item: Json) => item.id)), new Set([globalId, codingId]));
  assert.ok(listed.evidence.some((item: Json) => item.id === firstEvidence.id));
  assert.ok(listed.evidence.some((item: Json) => item.id === codingEvidence.id));
  assert.equal(listed.evidence.some((item: Json) => item.id === orphanEvidence.id), false);
  assert.equal(listed.evidence.some((item: Json) => item.summary === "formal-only"), false);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);

  assert.equal(ok(root, ["manual-evolution", "--stdin"], { action: "prepare", group_id: globalId, evidence_ids: [firstEvidence.id] }).evidence.length, 1);
  const reordered = ok(root, ["manual-evolution", "--stdin"], { action: "prepare", group_id: globalId, evidence_ids: [secondEvidence.id, firstEvidence.id] });
  assert.deepEqual(reordered.evidence.map((item: Json) => item.id), [firstEvidence.id, secondEvidence.id]);
  assert.deepEqual(reordered.evidence_ids, reordered.evidence.map((item: Json) => item.id));
  for (const evidenceIds of [[], ["unknown-evidence"], [firstEvidence.id, firstEvidence.id], [codingEvidence.id]]) {
    assert.equal(cli(root, ["manual-evolution", "--stdin"], { action: "prepare", group_id: globalId, evidence_ids: evidenceIds }).ok, false);
  }

  const capacityRoot = temporaryRoot(t);
  ok(capacityRoot, ["init"]);
  const capacityFeedback = addCliEvidence(capacityRoot, 1);
  const capacityLearning = learning(capacityRoot);
  const baseEvidence = capacityLearning.evidence.find((item: Json) => item.feedback_id === capacityFeedback.id);
  capacityLearning.evidence = Array.from({ length: 360 }, (_, index) => ({
    ...baseEvidence,
    id: index === 0 ? baseEvidence.id : `evidence-capacity-${index}`,
    summary: "s".repeat(2000),
    actual_behavior: "a".repeat(4000),
    expected_behavior: "e".repeat(4000),
    applicability: "p".repeat(2000),
  }));
  writeFileSync(join(capacityRoot, "local/learning.json"), `${JSON.stringify(capacityLearning)}\n`);
  const capacityGroup = ok(capacityRoot, ["groups"]).groups.find((item: Json) => item.name === "global");
  const capacityResult = cli(capacityRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: capacityGroup.id, evidence_ids: capacityLearning.evidence.map((item: Json) => item.id),
  });
  assert.equal(capacityResult.ok, false);
  assert.match(capacityResult.error.message, /4 MiB/);
});

test("U03 evidence picker uses real multiselect keys, scrolls, and cancellation returns to the remembered menu", async (t) => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `evidence-${index}`,
    createdAt: index === 2 ? "2026-01-03\t12:00" : `2026-01-${String(index + 1).padStart(2, "0")}`,
    summary: index === 0
      ? "LF\n摘要"
      : index === 1 ? "CRLF\r\n摘要" : index === 2 ? "TAB\t摘要" : index === 29
        ? `末项 ${"很长的中文摘要".repeat(30)}`
        : `summary ${index} ${"很长的中文摘要".repeat(20)}`,
  }));
  const originalItems = JSON.parse(JSON.stringify(items));
  const picker = async (keys: string[]) => {
    const renders: string[][] = [];
    const result = selectEvidence({
      mode: "tui",
      ui: { custom(factory: Function) {
        return new Promise((resolvePromise) => {
          const component = factory({ requestRender() {}, terminal: { rows: 24 } }, themeForTest(), {}, resolvePromise);
          renders.push(component.render(40));
          for (const key of keys) {
            component.handleInput(key);
            renders.push(component.render(40));
          }
        });
      } },
    } as any, items, new AbortController().signal);
    return { value: await result, renders };
  };
  const emptyResult = await picker(["\r"]);
  assert.deepEqual(emptyResult.value, []);
  const initialText = emptyResult.renders[0]!.join("\n");
  assert.match(initialText, /LF 摘要/);
  assert.match(initialText, /CRLF 摘要/);
  assert.match(initialText, /2026-01-03 12:00 · TAB 摘要/);
  const selected = await picker([...Array(29).fill("\x1b[B"), " ", "\r"]);
  assert.deepEqual(selected.value, ["evidence-29"]);
  assert.ok(selected.renders.at(-1)!.some((line) => line.includes("末项")));
  for (const view of [...emptyResult.renders, ...selected.renders]) {
    assert.ok(view.length <= 24);
    assert.ok(view.every((line) => !/[\r\n]/u.test(line)));
    assert.ok(view.every((line) => visibleWidth(line) <= 40));
  }
  for (const key of ["\x1b[D", "\x1b", "\x03"]) assert.equal((await picker([key])).value, null);
  assert.deepEqual(items, originalItems);

  const root = temporaryRoot(t);
  ok(root, ["init"]);
  addCliEvidence(root, 1);
  const flow = harness(t, {
    root,
    evidenceInputs: [["\x1b[D"]],
    menuInputs: [
      { title: "个人偏好", keys: [...Array(5).fill("\x1b[B"), "\x1b[C"] },
      { title: "手动演化规则", keys: ["\x1b[C"] },
      { title: "个人偏好", keys: ["\x1b[D"] },
    ],
  });
  await flow.pref("");
  assert.equal(flow.modelCalls, 0);
  assert.ok(flow.renderedViews.some((view) => view.some((line) => line.includes("→ 手动演化规则"))));

  const empty = harness(t, { root, evidenceInputs: [["\r"]] });
  await empty.menu("手动演化规则");
  assert.equal(empty.modelCalls, 0);
  assert.ok(empty.notices.some((item) => item.message.includes("未选择任何证据")));
});

test("T01 collector preserves message and assistant block order without timestamp sorting", () => {
  const branch = [
    { type: "message", timestamp: 50, message: { role: "user", content: "first user" } },
    { type: "message", timestamp: 10, message: { role: "assistant", content: [
      { type: "text", text: "before call" },
      { type: "toolCall", id: "native-edit", name: "edit", arguments: { path: "ordered.ts", oldText: "old", newText: "new" } },
      { type: "text", text: "after call" },
    ], stopReason: "toolUse" } },
    { type: "message", timestamp: 10, message: { role: "user", content: [{ type: "text", text: "user supplement" }] } },
    { type: "message", timestamp: 5, message: { role: "toolResult", toolCallId: "native-edit", toolName: "edit", isError: false, details: { patch: "ORDERED-PATCH" } } },
    { type: "message", timestamp: 1, message: { role: "assistant", content: "final answer", stopReason: "stop" } },
  ];
  const turns = recentConversationTurns({ sessionManager: { getBranch: () => branch } } as any);
  assert.deepEqual(turns, [{ events: [
    { type: "user", text: "first user" },
    { type: "assistant", text: "before call" },
    { type: "file_change_call", call_id: "change-1", tool: "edit", path: "ordered.ts" },
    { type: "assistant", text: "after call" },
    { type: "user", text: "user supplement" },
    { type: "file_change_result", call_id: "change-1", content: "ORDERED-PATCH" },
    { type: "assistant", text: "final answer" },
  ] }]);
});

test("T02 collector filters failed calls and places only final matching results with local IDs", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "turn one" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "working" },
      { type: "toolCall", id: "failed", name: "edit", arguments: { path: "failed.ts", oldText: "a", newText: "b" } },
      { type: "toolCall", id: "kept-a", name: "write", arguments: { path: "a.md", content: "A-CONTENT" } },
      { type: "toolCall", id: "kept-b", name: "edit", arguments: { path: "b.ts", oldText: "a", newText: "b" } },
      { type: "toolCall", id: "read", name: "read", arguments: { path: "ignored" } },
    ], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "kept-b", toolName: "edit", isError: false, details: { patch: "OLD-B" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "orphan", toolName: "edit", isError: false, details: { patch: "ORPHAN" } } },
    { type: "message", message: { role: "user", content: "between results" } },
    { type: "message", message: { role: "toolResult", toolCallId: "kept-a", toolName: "edit", isError: false, details: {} } },
    { type: "message", message: { role: "toolResult", toolCallId: "kept-a", toolName: "write", isError: false, details: {} } },
    { type: "message", message: { role: "toolResult", toolCallId: "failed", toolName: "edit", isError: true, details: { patch: "FAILED" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "kept-b", toolName: "edit", isError: false, details: { patch: "FINAL-B" } } },
    { type: "message", message: { role: "assistant", content: "done", stopReason: "stop" } },
    { type: "message", message: { role: "user", content: "turn two" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "kept-a", name: "write", arguments: { path: "second.md", content: "SECOND" } },
    ], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "kept-a", toolName: "write", isError: false, details: {} } },
    { type: "message", message: { role: "assistant", content: "second done", stopReason: "stop" } },
  ];
  const turns = recentConversationTurns({ sessionManager: { getBranch: () => branch } } as any);
  assert.deepEqual(turns[0], { events: [
    { type: "user", text: "turn one" },
    { type: "assistant", text: "working" },
    { type: "file_change_call", call_id: "change-1", tool: "write", path: "a.md" },
    { type: "file_change_call", call_id: "change-2", tool: "edit", path: "b.ts" },
    { type: "user", text: "between results" },
    { type: "file_change_result", call_id: "change-1", content: "A-CONTENT" },
    { type: "file_change_result", call_id: "change-2", content: "FINAL-B" },
    { type: "assistant", text: "done" },
  ] });
  assert.deepEqual(turns[1], { events: [
    { type: "user", text: "turn two" },
    { type: "file_change_call", call_id: "change-1", tool: "write", path: "second.md" },
    { type: "file_change_result", call_id: "change-1", content: "SECOND" },
    { type: "assistant", text: "second done" },
  ] });
  assert.doesNotMatch(JSON.stringify(turns), /OLD-B|ORPHAN|FAILED|failed\.ts|ignored/);
});

test("C01/C03/H01 collects only final matching successful edit/write results in stable call order", () => {
  const branch = [
    ...successfulFileChangeBranch(),
    { type: "message", message: { role: "user", content: [{ type: "text", text: "fallback edits" }] } },
    { type: "message", message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit-json", name: "edit", arguments: { path: "src/json.ts", edits: JSON.stringify([{ oldText: "before\n", newText: "after\n" }]), oldText: "legacy-before", newText: "legacy-after" } },
        { type: "toolCall", id: "edit-object", name: "edit", arguments: { path: "src/object.ts", edits: { oldText: "object-before", newText: "object-after" } } },
        { type: "toolCall", id: "write-empty", name: "write", arguments: { path: "empty.txt", content: "" } },
      ],
      stopReason: "toolUse",
    } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-ok", toolName: "edit", isError: false, details: { patch: "CROSS-TURN" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-json", toolName: "edit", isError: false, details: {} } },
    { type: "message", message: { role: "toolResult", toolCallId: "edit-object", toolName: "edit", isError: false, details: {} } },
    { type: "message", message: { role: "toolResult", toolCallId: "write-empty", toolName: "write", isError: false, details: {} } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "fallback done" }], stopReason: "stop" } },
  ];
  const turns = recentConversationTurns({ sessionManager: { getBranch: () => branch } } as any);
  assert.equal(turns.length, 2);
  const firstChanges = turnFileChanges(turns[0]!);
  const secondChanges = turnFileChanges(turns[1]!);
  assert.deepEqual(firstChanges.map((item) => [item.tool, item.path]), [
    ["edit", "src/a.ts"],
    ["write", "notes.md"],
  ]);
  assert.equal(firstChanges[0]!.content, "@@ patch body @@");
  assert.equal(firstChanges[1]!.content, "  line one\nsecret [REDACTED_CREDENTIAL]\n  ");
  assert.doesNotMatch(JSON.stringify(turns), /DUPLICATE|fail\.ts|mismatch\.ts|missing\.md|CROSS-TURN|read-ignore/);
  assert.match(secondChanges[0]!.content, /第 1 处修改前[\s\S]*before\n[\s\S]*第 1 处修改后[\s\S]*after\n/);
  assert.match(secondChanges[0]!.content, /第 2 处修改前[\s\S]*legacy-before[\s\S]*第 2 处修改后[\s\S]*legacy-after/);
  assert.match(secondChanges[1]!.content, /修改前[\s\S]*object-before[\s\S]*修改后[\s\S]*object-after/);
  assert.deepEqual(secondChanges[2], { tool: "write", path: "empty.txt", content: "" });

  const finalResults = recentConversationTurns({ sessionManager: { getBranch: () => [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "final results" }] } },
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "recover", name: "edit", arguments: { path: "recover.ts", oldText: "a", newText: "b" } },
      { type: "toolCall", id: "mismatch", name: "edit", arguments: { path: "mismatch.ts", oldText: "a", newText: "b" } },
      { type: "toolCall", id: "final-failure", name: "edit", arguments: { path: "final-failure.ts", oldText: "a", newText: "b" } },
      { type: "toolCall", id: "last-success", name: "edit", arguments: { path: "last-success.ts", oldText: "a", newText: "b" } },
    ], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "recover", toolName: "edit", isError: true, details: { patch: "FAILED-FIRST" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "recover", toolName: "edit", isError: false, details: { patch: "RECOVERED-LAST" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "mismatch", toolName: "write", isError: false, details: { patch: "WRONG-NAME" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "mismatch", toolName: "edit", isError: false, details: { patch: "MATCHED-LAST" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "final-failure", toolName: "edit", isError: false, details: { patch: "EARLY-SUCCESS" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "final-failure", toolName: "edit", isError: true, details: { patch: "FINAL-FAILURE" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "last-success", toolName: "edit", isError: false, details: { patch: "FIRST-SUCCESS" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "last-success", toolName: "edit", isError: false, details: { patch: "LAST-SUCCESS" } } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
  ] } } as any);
  assert.deepEqual(turnFileChanges(finalResults[0]!), [
    { tool: "edit", path: "recover.ts", content: "RECOVERED-LAST" },
    { tool: "edit", path: "mismatch.ts", content: "MATCHED-LAST" },
    { tool: "edit", path: "last-success.ts", content: "LAST-SUCCESS" },
  ]);
  assert.doesNotMatch(JSON.stringify(finalResults), /FAILED-FIRST|WRONG-NAME|EARLY-SUCCESS|FINAL-FAILURE|FIRST-SUCCESS|final-failure\.ts/);
});

test("C02/C05/C06 selected noncontinuous turns persist and send only their successful changes", async (t) => {
  const middle = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "middle unselected" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "middle-write", name: "write", arguments: { path: "middle.txt", content: "MIDDLE-UNSELECTED" } }], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "middle-write", toolName: "write", isError: false, details: {} } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "middle done" }], stopReason: "stop" } },
  ];
  const last = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "last selected" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "last-edit", name: "edit", arguments: { path: "last.ts", oldText: "old-last", newText: "new-last" } }], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "last-edit", toolName: "edit", isError: false, details: { diff: "LAST-SELECTED-DIFF" } } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "last done" }], stopReason: "stop" } },
  ];
  const gate = deferred<ModelReply>();
  const flow = harness(t, {
    branch: [...successfulFileChangeBranch(), ...middle, ...last],
    pickerInputs: [[" ", "\x1b[A", "\x1b[A", " ", "\r"]],
    detailInputs: [["\x1b[D"]],
    menuInputs: [
      { title: "反馈与证据", keys: ["\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
    ],
    modelReply: () => gate.promise,
  });
  await flow.pref("feedback --group global fix include successful changes");
  assert.equal(flow.modelCalls, 1);
  const saved = learning(flow.root).feedback[0];
  assert.equal(saved.selected_turns.length, 2);
  assert.deepEqual(saved.selected_turns.flatMap((turn: Json) => turnFileChanges(parseConversationTurn(turn)).map((item) => item.path)), ["src/a.ts", "notes.md", "last.ts"]);
  assert.match(flow.prompts[0]!, /@@ patch body @@|LAST-SELECTED-DIFF/);
  assert.match(flow.prompts[0]!, /events 必须按数组顺序|相同 call_id/);
  assert.doesNotMatch(flow.prompts[0]!, /MIDDLE-UNSELECTED|middle\.txt/);
  assert.ok(flow.renderedViews.flat().some((line) => line.includes("成功改动")));
  gate.resolve(extraction("@@ patch body @@", { name: "global", certain: true, summary: "tool-backed evidence" }));
  await waitFor(() => learning(flow.root).feedback[0]?.status === "organized", "tool-backed evidence organization");
  assert.equal(learning(flow.root).evidence.length, 1);
  await flow.menu("反馈与证据");
  assert.match(flow.renderedViews.flat().join("\n"), /\[文件改动\] @@ patch body @@/);
});

function themeForTest() {
  return { fg: (_name: string, text: string) => text, bold: (text: string) => text };
}

test("T05 feedback handler saves and models the exact ordered snapshot without rereading branch or disk", async (t) => {
  const branch = [
    { type: "message", message: { role: "user", content: "handler user" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "handler before" },
      { type: "toolCall", id: "handler-edit", name: "edit", arguments: { path: "handler.ts", oldText: "old", newText: "new" } },
    ], stopReason: "toolUse" } },
    { type: "message", message: { role: "user", content: "handler supplement" } },
    { type: "message", message: { role: "toolResult", toolCallId: "handler-edit", toolName: "edit", isError: false, details: { patch: "HANDLER-PATCH" } } },
    { type: "message", message: { role: "assistant", content: "handler done", stopReason: "stop" } },
  ];
  const gate = deferred<ModelReply>();
  const flow = harness(t, { branch, modelReply: () => gate.promise });
  await flow.pref("feedback --group global good ordered handler");
  await waitFor(() => flow.modelCalls === 1, "ordered handler model");
  const savedTurns = learning(flow.root).feedback[0].selected_turns;
  assert.equal(Object.keys(savedTurns[0]).join(","), "events");
  const modelInput = JSON.parse(flow.prompts[0]!.split("\n\n").at(-1)!);
  assert.deepEqual(modelInput.selected_turns, savedTurns);
  branch.push({ type: "message", message: { role: "user", content: "CURRENT-BRANCH-SENTINEL" } });
  writeFileSync(join(flow.root, "handler.ts"), "CURRENT-DISK-SENTINEL\n");
  assert.doesNotMatch(flow.prompts[0]!, /CURRENT-BRANCH-SENTINEL|CURRENT-DISK-SENTINEL/);
  gate.resolve(extraction("HANDLER-PATCH", { summary: "ordered handler evidence" }));
  await waitFor(() => learning(flow.root).feedback[0].status === "organized", "ordered handler organization");
  assert.deepEqual(learning(flow.root).feedback[0].selected_turns, savedTurns);
});

test("U04/U05 manual handler sends the exact selected projection and keeps data unchanged before apply", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "keep unrelated rule" });
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "coding", description: "coding" });
  const first = addCliEvidence(root, 1);
  const second = addCliEvidence(root, 2);
  addCliEvidence(root, 3);
  addCliEvidence(root, 4, "assistant", "coding");
  const document = learning(root);
  const firstEvidence = document.evidence.find((item: Json) => item.feedback_id === first.id);
  const secondEvidence = document.evidence.find((item: Json) => item.feedback_id === second.id);
  document.evidence[0].summary = "SELECTED-EVIDENCE-ONE";
  document.evidence[1].summary = "SELECTED-EVIDENCE-TWO";
  document.evidence[2].summary = "UNSELECTED-SAME-GROUP";
  document.evidence[3].summary = "OTHER-GROUP-EVIDENCE";
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(document)}\n`);
  const globalId = ok(root, ["groups"]).groups.find((item: Json) => item.name === "global").id;
  const expected = ok(root, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: globalId, evidence_ids: [firstEvidence.id, secondEvidence.id],
  });
  const gate = deferred<ModelReply>();
  const flow = harness(t, {
    root,
    evidenceInputs: [[" ", "\x1b[B", " ", "\r"]],
    detailInputs: [["r"]],
    modelReply: () => gate.promise,
  });
  const beforeLearning = readFileSync(join(root, "local/learning.json"), "utf8");
  const beforeGroups = readFileSync(join(root, "repo/groups.json"), "utf8");
  let settled = false;
  const running = flow.menu("手动演化规则").then(() => { settled = true; });
  await waitFor(() => flow.modelCalls === 1, "manual evolution model");
  assert.equal(settled, false);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeLearning);
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), beforeGroups);
  const input = JSON.parse(flow.prompts[0]!.split("\n\n").at(-1)!);
  assert.deepEqual(input, { group: expected.group, selected_evidence: expected.evidence });
  assert.match(flow.prompts[0]!, /本次主动选择的证据|未选证据缺席不表示其不存在|完整建议规则/);
  assert.doesNotMatch(flow.prompts[0]!, /UNSELECTED-SAME-GROUP|OTHER-GROUP-EVIDENCE|selected_turns|"events"|RAW-/);
  assert.equal(flow.modelRequests[0].request.reasoning, "high");
  assert.match(flow.renderedViews.flat().join("\n"), /规则演化中，Esc 取消/);
  gate.resolve({ proposed_rules: ["keep unrelated rule", "manual suggestion"], rationale: "selected rationale" });
  await running;
  assert.equal(flow.modelCalls, 1);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeLearning);
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), beforeGroups);
  const preview = flow.renderedViews.flat().join("\n");
  assert.match(preview, /目标组：global|本次证据：2 条|SELECTED-EVIDENCE-ONE|selected rationale|keep unrelated rule|manual suggestion|\+ manual suggestion/);
});

test("U05 explicit A applies a full manual rule list while cancel and invalid output remain zero-write", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "existing manual base" });
  addCliEvidence(root, 1);
  const beforeLearning = readFileSync(join(root, "local/learning.json"), "utf8");
  const beforeGroups = readFileSync(join(root, "repo/groups.json"), "utf8");

  const invalid = harness(t, { root, modelReply: () => "not-json" });
  await invalid.menu("手动演化规则");
  assert.equal(invalid.modelCalls, 1);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeLearning);
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), beforeGroups);

  const right = harness(t, {
    root,
    detailInputs: [["\x1b[C", "\x1b[D"]],
    modelReply: () => ({ proposed_rules: ["existing manual base", "right must not apply"], rationale: "right ignored" }),
  });
  await right.menu("手动演化规则");
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), beforeGroups);

  const headBefore = spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const applied = harness(t, {
    root,
    detailInputs: [[...Array(30).fill("\x1b[6~"), "a"]],
    modelReply: () => ({
      proposed_rules: ["existing manual base", `manual long rule ${"x".repeat(300)} RULE-TAIL`],
      rationale: `${"reason ".repeat(150)}RATIONALE-TAIL`,
    }),
  });
  await applied.menu("手动演化规则");
  const headAfter = spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(headAfter, headBefore);
  assert.deepEqual(groups(root).groups[0].rules.map((item: Json) => item.text), ["existing manual base", `manual long rule ${"x".repeat(300)} RULE-TAIL`]);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeLearning);
  assert.ok(applied.notices.some((item) => item.message.includes("已应用并提交 Git")));
  assert.match(applied.renderedViews.flat().join("\n"), /RULE-TAIL|RATIONALE-TAIL/);

  const capacityRoot = temporaryRoot(t);
  ok(capacityRoot, ["init"]);
  addCliEvidence(capacityRoot, 1);
  const wrapper = join(capacityRoot, "manual-capacity.py");
  writeFileSync(wrapper, [
    "import json, os, subprocess, sys",
    `real_cli = ${JSON.stringify(cliPath)}`,
    "payload = sys.stdin.buffer.read()",
    "result = subprocess.run([sys.executable, real_cli, *sys.argv[1:]], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "if sys.argv[1] == 'manual-evolution' and b'\"action\":\"prepare\"' in payload and result.returncode == 0:",
    "    value = json.loads(result.stdout)",
    "    value['evidence'][0]['padding'] = 'x' * (4 * 1024 * 1024)",
    "    os.write(1, json.dumps(value).encode())",
    "else:",
    "    os.write(1, result.stdout)",
    "os.write(2, result.stderr)",
    "raise SystemExit(result.returncode)",
  ].join("\n"));
  const capacityBefore = readFileSync(join(capacityRoot, "local/learning.json"), "utf8");
  const capacity = harness(t, { root: capacityRoot, preferenceCli: wrapper });
  await capacity.menu("手动演化规则");
  assert.equal(capacity.modelCalls, 0);
  assert.ok(capacity.notices.some((item) => item.message.includes("超过") && item.message.includes("没有内容被裁剪或发送")));
  assert.equal(readFileSync(join(capacityRoot, "local/learning.json"), "utf8"), capacityBefore);
});

test("U06 manual apply preserves IDs, disabled rules, other data, and no-change revisions", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["manage-group", "--stdin"], { action: "create", name: "coding", description: "coding" });
  ok(root, ["remember", "--stdin"], { group: "global", rule: "retained active" });
  ok(root, ["remember", "--stdin"], { group: "global", rule: "retained disabled" });
  ok(root, ["remember", "--stdin"], { group: "coding", rule: "other group rule" });
  const groupsPath = join(root, "repo/groups.json");
  const fixtureGroups = groups(root);
  const globalFixture = fixtureGroups.groups.find((item: Json) => item.name === "global");
  const retainedId = globalFixture.rules.find((item: Json) => item.text === "retained active").id;
  const disabledBefore = { ...globalFixture.rules.find((item: Json) => item.text === "retained disabled"), enabled: false };
  globalFixture.rules = globalFixture.rules.map((item: Json) => item.text === "retained disabled" ? disabledBefore : item);
  writeFileSync(groupsPath, `${JSON.stringify(fixtureGroups)}\n`);
  spawnSync("git", ["-C", join(root, "repo"), "add", "groups.json"]);
  const fixtureCommit = spawnSync("git", ["-C", join(root, "repo"), "commit", "-m", "fixture: disable rule"], { encoding: "utf8" });
  assert.equal(fixtureCommit.status, 0, fixtureCommit.stderr);
  const feedback = addCliEvidence(root, 1);
  const learningDoc = learning(root);
  const evidence = learningDoc.evidence.find((item: Json) => item.feedback_id === feedback.id);
  learningDoc.reviewed_evidence[globalFixture.id] = [evidence.id];
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(learningDoc)}\n`);
  const beforeLearning = readFileSync(join(root, "local/learning.json"), "utf8");
  const codingBefore = groups(root).groups.find((item: Json) => item.name === "coding");

  const prepared = ok(root, ["manual-evolution", "--stdin"], { action: "prepare", group_id: globalFixture.id, evidence_ids: [evidence.id] });
  const applied = ok(root, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: globalFixture.id, evidence_ids: prepared.evidence_ids,
    base_digest: prepared.base_digest, evidence_digest: prepared.evidence_digest,
    proposed_rules: ["retained active", "manual added"], rationale: "manual selected evidence",
  });
  assert.equal(applied.changed, true);
  assert.ok(applied.commit);
  const after = groups(root);
  const globalAfter = after.groups.find((item: Json) => item.name === "global");
  assert.equal(globalAfter.rules.find((item: Json) => item.text === "retained active").id, retainedId);
  assert.deepEqual(globalAfter.rules.find((item: Json) => item.text === "retained disabled"), disabledBefore);
  assert.deepEqual(after.groups.find((item: Json) => item.name === "coding"), codingBefore);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeLearning);

  const revision = globalAfter.revision;
  const head = spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const repeated = ok(root, ["manual-evolution", "--stdin"], { action: "prepare", group_id: globalFixture.id, evidence_ids: [evidence.id] });
  const unchanged = ok(root, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: globalFixture.id, evidence_ids: repeated.evidence_ids,
    base_digest: repeated.base_digest, evidence_digest: repeated.evidence_digest,
    proposed_rules: ["retained active", "manual added"], rationale: "same result",
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.commit, null);
  assert.equal(groups(root).groups.find((item: Json) => item.name === "global").revision, revision);
  assert.equal(spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), head);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), beforeLearning);
});

test("U07 manual snapshots reject selected changes and preserve automatic candidate recovery branches", (t) => {
  const candidateRoot = temporaryRoot(t);
  ok(candidateRoot, ["init"]);
  const candidateFeedback = [1, 2, 3].map((index) => addCliEvidence(candidateRoot, index));
  const candidateLearning = learning(candidateRoot);
  const candidateEvidence = candidateFeedback.map((feedback) => candidateLearning.evidence.find((item: Json) => item.feedback_id === feedback.id));
  const auto = ok(candidateRoot, ["prepare-evolution", "--stdin"], { group: "global" });
  const proposal = ok(candidateRoot, ["save-evolution", "--stdin"], {
    group_id: auto.group.id, base_digest: auto.base_digest, evidence_digest: auto.evidence_digest,
    evidence_ids: auto.evidence.map((item: Json) => item.id), proposed_rules: ["manual target"], rationale: "same automatic suggestion",
  }).proposal;
  const manual = ok(candidateRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: auto.group.id, evidence_ids: [candidateEvidence[0].id],
  });
  const learningBeforeManual = readFileSync(join(candidateRoot, "local/learning.json"), "utf8");
  ok(candidateRoot, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: auto.group.id, evidence_ids: manual.evidence_ids,
    base_digest: manual.base_digest, evidence_digest: manual.evidence_digest,
    proposed_rules: ["manual target"], rationale: "manual apply",
  });
  assert.equal(readFileSync(join(candidateRoot, "local/learning.json"), "utf8"), learningBeforeManual);
  assert.equal(ok(candidateRoot, ["pending-list"]).proposals.some((item: Json) => item.id === proposal.id), false);
  const recovered = ok(candidateRoot, ["resolve-evolution", "--stdin"], { proposal_id: proposal.id, decision: "apply" });
  assert.equal(recovered.proposal.status, "applied");
  assert.deepEqual(learning(candidateRoot).reviewed_evidence[auto.group.id], proposal.evidence_ids);
  assert.deepEqual(groups(candidateRoot).groups[0].rules.map((item: Json) => item.text), ["manual target"]);

  const differentRoot = temporaryRoot(t);
  ok(differentRoot, ["init"]);
  for (let index = 1; index <= 3; index += 1) addCliEvidence(differentRoot, index);
  const differentAuto = ok(differentRoot, ["prepare-evolution", "--stdin"], { group: "global" });
  const differentProposal = ok(differentRoot, ["save-evolution", "--stdin"], {
    group_id: differentAuto.group.id, base_digest: differentAuto.base_digest, evidence_digest: differentAuto.evidence_digest,
    evidence_ids: differentAuto.evidence.map((item: Json) => item.id), proposed_rules: ["different automatic"], rationale: "different",
  }).proposal;
  const differentManual = ok(differentRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: differentAuto.group.id, evidence_ids: [differentAuto.evidence[0].id],
  });
  ok(differentRoot, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: differentAuto.group.id, evidence_ids: differentManual.evidence_ids,
    base_digest: differentManual.base_digest, evidence_digest: differentManual.evidence_digest,
    proposed_rules: ["manual wins"], rationale: "manual",
  });
  assert.equal(cli(differentRoot, ["resolve-evolution", "--stdin"], { proposal_id: differentProposal.id, decision: "apply" }).ok, false);
  assert.equal(learning(differentRoot).proposals.find((item: Json) => item.id === differentProposal.id).status, "stale");
  assert.deepEqual(groups(differentRoot).groups[0].rules.map((item: Json) => item.text), ["manual wins"]);
  assert.equal(cli(differentRoot, ["save-evolution", "--stdin"], {
    group_id: differentAuto.group.id, base_digest: differentAuto.base_digest, evidence_digest: differentAuto.evidence_digest,
    evidence_ids: differentAuto.evidence.map((item: Json) => item.id), proposed_rules: ["late automatic"], rationale: "late",
  }).ok, false);

  const conflictRoot = temporaryRoot(t);
  ok(conflictRoot, ["init"]);
  ok(conflictRoot, ["manage-group", "--stdin"], { action: "create", name: "other", description: "other" });
  const selectedFeedback = addCliEvidence(conflictRoot, 1);
  const unselectedFeedback = addCliEvidence(conflictRoot, 2);
  const conflictLearning = learning(conflictRoot);
  const selectedEvidence = conflictLearning.evidence.find((item: Json) => item.feedback_id === selectedFeedback.id);
  const unselectedEvidence = conflictLearning.evidence.find((item: Json) => item.feedback_id === unselectedFeedback.id);
  const conflictGroup = ok(conflictRoot, ["groups"]).groups.find((item: Json) => item.name === "global");
  const selectedPrepared = ok(conflictRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: conflictGroup.id, evidence_ids: [selectedEvidence.id],
  });
  selectedEvidence.summary = "externally changed selected evidence";
  selectedEvidence.group_id = ok(conflictRoot, ["groups"]).groups.find((item: Json) => item.name === "other").id;
  conflictLearning.feedback.find((item: Json) => item.id === selectedFeedback.id).reason = "externally changed reason";
  writeFileSync(join(conflictRoot, "local/learning.json"), `${JSON.stringify(conflictLearning)}\n`);
  assert.equal(cli(conflictRoot, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: conflictGroup.id, evidence_ids: selectedPrepared.evidence_ids,
    base_digest: selectedPrepared.base_digest, evidence_digest: selectedPrepared.evidence_digest,
    proposed_rules: ["must not apply"], rationale: "conflict",
  }).ok, false);
  assert.equal(groups(conflictRoot).groups.find((item: Json) => item.name === "global").rules.length, 0);

  selectedEvidence.summary = "evidence 1";
  selectedEvidence.group_id = conflictGroup.id;
  conflictLearning.feedback.find((item: Json) => item.id === selectedFeedback.id).reason = "original reason 1";
  writeFileSync(join(conflictRoot, "local/learning.json"), `${JSON.stringify(conflictLearning)}\n`);
  const unselectedPrepared = ok(conflictRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: conflictGroup.id, evidence_ids: [selectedEvidence.id],
  });
  unselectedEvidence.summary = "changed but unselected";
  writeFileSync(join(conflictRoot, "local/learning.json"), `${JSON.stringify(conflictLearning)}\n`);
  assert.equal(ok(conflictRoot, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: conflictGroup.id, evidence_ids: unselectedPrepared.evidence_ids,
    base_digest: unselectedPrepared.base_digest, evidence_digest: unselectedPrepared.evidence_digest,
    proposed_rules: ["unselected change allowed"], rationale: "allowed",
  }).changed, true);

  const groupPrepared = ok(conflictRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: conflictGroup.id, evidence_ids: [selectedEvidence.id],
  });
  ok(conflictRoot, ["remember", "--stdin"], { group: "global", rule: "concurrent group change" });
  assert.equal(cli(conflictRoot, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: conflictGroup.id, evidence_ids: groupPrepared.evidence_ids,
    base_digest: groupPrepared.base_digest, evidence_digest: groupPrepared.evidence_digest,
    proposed_rules: ["must not overwrite group"], rationale: "group conflict",
  }).ok, false);
});

test("U08 manual prepare, picker, model, and preview obey shutdown while Git failures preserve rules", async (t) => {
  const prepareRoot = temporaryRoot(t);
  ok(prepareRoot, ["init"]);
  addCliEvidence(prepareRoot, 1);
  const wrapper = join(prepareRoot, "manual-prepare-delay.py");
  const prepareStarted = join(prepareRoot, "manual-prepare-started");
  writeFileSync(wrapper, [
    "import os, signal, subprocess, sys, time",
    `real_cli = ${JSON.stringify(cliPath)}`,
    "if sys.argv[1] != 'manual-evolution':",
    "    os.execv(sys.executable, [sys.executable, real_cli, *sys.argv[1:]])",
    "payload = sys.stdin.buffer.read()",
    "if b'\"action\":\"prepare\"' not in payload:",
    "    result = subprocess.run([sys.executable, real_cli, *sys.argv[1:]], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
    "    os.write(1, result.stdout)",
    "    os.write(2, result.stderr)",
    "    raise SystemExit(result.returncode)",
    "signal.signal(signal.SIGTERM, lambda _signum, _frame: None)",
    `open(${JSON.stringify(prepareStarted)}, 'w').close()`,
    "while True:",
    "    time.sleep(1)",
  ].join("\n"));
  const prepareFlow = harness(t, { root: prepareRoot, preferenceCli: wrapper });
  const prepareBefore = readFileSync(join(prepareRoot, "local/learning.json"), "utf8");
  const prepareRunning = prepareFlow.menu("手动演化规则");
  await waitFor(() => existsSync(prepareStarted), "manual prepare start");
  const prepareUi = prepareFlow.events.filter((item) => item === "custom").length;
  const prepareNotices = prepareFlow.notices.length;
  assert.equal(prepareFlow.modelCalls, 0);
  await prepareFlow.shutdown("reload");
  await prepareRunning;
  assert.equal(prepareFlow.modelCalls, 0);
  assert.equal(prepareFlow.events.filter((item) => item === "custom").length, prepareUi);
  assert.equal(prepareFlow.notices.length, prepareNotices);
  assert.equal(readFileSync(join(prepareRoot, "local/learning.json"), "utf8"), prepareBefore);

  const pickerRoot = temporaryRoot(t);
  ok(pickerRoot, ["init"]);
  addCliEvidence(pickerRoot, 1);
  const pickerFlow = harness(t, { root: pickerRoot, evidenceInputs: [[]] });
  const pickerBeforeGroups = readFileSync(join(pickerRoot, "repo/groups.json"), "utf8");
  const pickerRunning = pickerFlow.menu("手动演化规则");
  await waitFor(() => pickerFlow.renderedViews.flat().some((line) => line.includes("选择演化证据")), "manual picker before shutdown");
  const pickerUi = pickerFlow.events.filter((item) => item === "custom").length;
  await pickerFlow.shutdown("reload");
  await pickerRunning;
  assert.equal(pickerFlow.modelCalls, 0);
  assert.equal(pickerFlow.events.filter((item) => item === "custom").length, pickerUi);
  assert.equal(readFileSync(join(pickerRoot, "repo/groups.json"), "utf8"), pickerBeforeGroups);

  const modelRoot = temporaryRoot(t);
  ok(modelRoot, ["init"]);
  addCliEvidence(modelRoot, 1);
  const modelGate = deferred<ModelReply>();
  const modelFlow = harness(t, { root: modelRoot, modelReply: () => modelGate.promise });
  const modelBefore = readFileSync(join(modelRoot, "repo/groups.json"), "utf8");
  const modelRunning = modelFlow.menu("手动演化规则");
  await waitFor(() => modelFlow.modelCalls === 1, "manual model before shutdown");
  const modelUi = modelFlow.events.filter((item) => item === "custom").length;
  await modelFlow.shutdown("reload");
  await modelRunning;
  modelGate.resolve({ proposed_rules: ["late manual"], rationale: "late" });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(modelFlow.events.filter((item) => item === "custom").length, modelUi);
  assert.equal(readFileSync(join(modelRoot, "repo/groups.json"), "utf8"), modelBefore);

  const previewRoot = temporaryRoot(t);
  ok(previewRoot, ["init"]);
  addCliEvidence(previewRoot, 1);
  const previewFlow = harness(t, {
    root: previewRoot,
    detailInputs: [[]],
    modelReply: () => ({ proposed_rules: ["preview manual"], rationale: "preview rationale" }),
  });
  const previewBefore = readFileSync(join(previewRoot, "repo/groups.json"), "utf8");
  const previewRunning = previewFlow.menu("手动演化规则");
  await waitFor(() => previewFlow.renderedViews.flat().some((line) => line.includes("preview rationale")), "manual preview before shutdown");
  const previewUi = previewFlow.events.filter((item) => item === "custom").length;
  await previewFlow.shutdown("reload");
  await previewRunning;
  assert.equal(previewFlow.events.filter((item) => item === "custom").length, previewUi);
  assert.equal(readFileSync(join(previewRoot, "repo/groups.json"), "utf8"), previewBefore);

  const failureRoot = temporaryRoot(t);
  ok(failureRoot, ["init"]);
  const failureFeedback = addCliEvidence(failureRoot, 1);
  const failureLearning = learning(failureRoot);
  const failureEvidence = failureLearning.evidence.find((item: Json) => item.feedback_id === failureFeedback.id);
  const failureGroup = ok(failureRoot, ["groups"]).groups.find((item: Json) => item.name === "global");
  const failurePrepared = ok(failureRoot, ["manual-evolution", "--stdin"], {
    action: "prepare", group_id: failureGroup.id, evidence_ids: [failureEvidence.id],
  });
  const beforeFailureGroups = readFileSync(join(failureRoot, "repo/groups.json"), "utf8");
  const beforeFailureLearning = readFileSync(join(failureRoot, "local/learning.json"), "utf8");
  const dirty = join(failureRoot, "repo/dirty.txt");
  writeFileSync(dirty, "dirty\n");
  spawnSync("git", ["-C", join(failureRoot, "repo"), "add", "dirty.txt"]);
  assert.equal(cli(failureRoot, ["manual-evolution", "--stdin"], {
    action: "apply", group_id: failureGroup.id, evidence_ids: failurePrepared.evidence_ids,
    base_digest: failurePrepared.base_digest, evidence_digest: failurePrepared.evidence_digest,
    proposed_rules: ["must not apply"], rationale: "dirty",
  }).ok, false);
  assert.equal(readFileSync(join(failureRoot, "repo/groups.json"), "utf8"), beforeFailureGroups);
  assert.equal(readFileSync(join(failureRoot, "local/learning.json"), "utf8"), beforeFailureLearning);
  spawnSync("git", ["-C", join(failureRoot, "repo"), "reset", "--quiet"]);
  unlinkSync(dirty);

  const provider = harness(t, { root: failureRoot, modelReply: () => new Error("provider failed") });
  await provider.menu("手动演化规则");
  assert.equal(provider.modelCalls, 1);
  assert.equal(readFileSync(join(failureRoot, "repo/groups.json"), "utf8"), beforeFailureGroups);
  assert.equal(readFileSync(join(failureRoot, "local/learning.json"), "utf8"), beforeFailureLearning);
});

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
    expected_evaluation: evaluation(created.feedback),
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
    expected_evaluation: evaluation(created.feedback),
    extraction: extraction("shared quote", { name: null, certain: false, summary: "must not replace" }),
    model: { provider: "later", id: "other-model", thinking: "off" },
  });
  assert.equal(duplicate.feedback.extraction.evidence.summary, "first summary");
  assert.equal(duplicate.feedback.model.id, "used-model");
  const completed = ok(root, ["feedback-complete", "--stdin"], {
    feedback_id: feedbackId, expected_evaluation: evaluation(created.feedback), group: "global",
  });
  assert.equal(completed.evidence.summary, "first summary");
  ok(root, ["feedback-fail", "--stdin"], {
    feedback_id: feedbackId, expected_evaluation: evaluation(created.feedback), error: "late failure",
  });
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
    expected_evaluation: evaluation(invalid.feedback),
    extraction: extraction("user\nonly assistant"),
    model: { provider: "fake", id: "fake", thinking: "off" },
  });
  assert.equal(rejected.ok, false);
  assert.equal(learning(root).feedback.find((item: Json) => item.id === invalid.feedback.id).extraction, null);
});

test("T03 backend validates ordered event pairing and rejects mixed or cross-turn structures atomically", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const valid = orderedTurn();
  const invalidTurns: Json[][] = [
    [{ ...valid, user: "mixed" }],
    [{ events: [{ type: "user", text: "u" }, { type: "assistant", text: "a" }, { type: "unknown", text: "x" }] }],
    [{ events: [{ type: "user", text: "u" }, { type: "file_change_call", call_id: "change-1", tool: "bash", path: "x" }, { type: "file_change_result", call_id: "change-1", content: "x" }, { type: "assistant", text: "a" }] }],
    [{ events: [{ type: "user", text: "u" }, { type: "file_change_call", call_id: "bad id", tool: "edit", path: "x" }, { type: "file_change_result", call_id: "bad id", content: "x" }, { type: "assistant", text: "a" }] }],
    [{ events: [{ type: "user", text: "u" }, { type: "file_change_call", call_id: "change-1", tool: "edit", path: "x" }, { type: "file_change_call", call_id: "change-1", tool: "edit", path: "y" }, { type: "file_change_result", call_id: "change-1", content: "x" }, { type: "assistant", text: "a" }] }],
    [{ events: [{ type: "user", text: "u" }, { type: "file_change_result", call_id: "change-1", content: "x" }, { type: "file_change_call", call_id: "change-1", tool: "edit", path: "x" }, { type: "assistant", text: "a" }] }],
    [{ events: [{ type: "user", text: "u" }, { type: "file_change_call", call_id: "change-1", tool: "edit", path: "x" }, { type: "assistant", text: "a" }] }],
    [{ events: [{ type: "user", text: "u" }, { type: "file_change_call", call_id: "change-1", tool: "edit", path: "x" }, { type: "file_change_result", call_id: "change-1", content: "x" }, { type: "file_change_result", call_id: "change-1", content: "y" }, { type: "assistant", text: "a" }] }],
    [valid, { events: [{ type: "user", text: "u2" }, { type: "file_change_result", call_id: "change-1", content: "cross" }, { type: "assistant", text: "a2" }] }],
  ];
  for (const selectedTurns of invalidTurns) {
    const rejected = cli(root, ["feedback-create", "--stdin"], {
      sentiment: "fix", reason: "invalid ordered turn", selected_turns: selectedTurns, model: null, group: null,
    });
    assert.equal(rejected.ok, false);
  }
  assert.equal(learning(root).feedback.length, 0);
});

test("T04 ordered snapshots preserve content, enforce 4 MiB, and coexist with untouched legacy turns", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const ordered = {
    events: [
      { type: "user", text: "new user" },
      { type: "assistant", text: "new assistant" },
      { type: "file_change_call", call_id: "change-1", tool: "edit", path: "patch.ts" },
      { type: "file_change_result", call_id: "change-1", content: "  PATCH\nsk_abcdefghijklmnop\n  " },
      { type: "file_change_call", call_id: "change-2", tool: "write", path: "empty.txt" },
      { type: "file_change_result", call_id: "change-2", content: "" },
      { type: "assistant", text: "new done" },
    ],
  };
  const legacy = { user: "legacy user", assistant: "legacy assistant" };
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "mixed snapshots", selected_turns: [ordered, legacy], model: null, group: null,
  });
  assert.equal(Object.hasOwn(created.feedback.selected_turns[0], "user"), false);
  assert.deepEqual(created.feedback.selected_turns[0].events[3], {
    type: "file_change_result", call_id: "change-1", content: "  PATCH\n[REDACTED_CREDENTIAL]\n  ",
  });
  assert.deepEqual(created.feedback.selected_turns[0].events[5], { type: "file_change_result", call_id: "change-2", content: "" });
  assert.deepEqual(created.feedback.selected_turns[1], legacy);
  const stored = ok(root, ["feedback-get", "--stdin"], { feedback_id: created.feedback.id }).feedback.selected_turns;
  assert.deepEqual(stored, created.feedback.selected_turns);
  assert.equal(Object.hasOwn(stored[1], "events"), false);
  assert.equal(Object.hasOwn(stored[1], "file_changes"), false);

  const huge = orderedTurn("x".repeat(4 * 1024 * 1024));
  const rejected = cli(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "large events", selected_turns: [huge], model: null, group: null,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /4 MiB|exceeds/);
  assert.equal(learning(root).feedback.length, 1);
});

test("C04 validates file changes, preserves old missing fields, and enforces the shared size limit", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const old = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "good", reason: "old record",
    selected_turns: [{ user: "old user", assistant: "old assistant" }],
    model: null, group: null,
  });
  const valid = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "valid change",
    selected_turns: [{
      user: "u", assistant: "a",
      file_changes: [{ tool: "write", path: "empty.txt", content: "" }],
    }],
    model: null, group: null,
  });
  assert.deepEqual(valid.feedback.selected_turns[0].file_changes, [{ tool: "write", path: "empty.txt", content: "" }]);
  const storedOld = learning(root).feedback.find((item: Json) => item.id === old.feedback.id);
  assert.equal(Object.hasOwn(storedOld.selected_turns[0], "file_changes"), false);
  for (const change of [
    { tool: "bash", path: "x", content: "bad" },
    { tool: "edit", path: "", content: "bad" },
    { tool: "edit", path: "x", content: "" },
    { tool: "write", path: "x", content: 42 },
  ]) {
    const rejected = cli(root, ["feedback-create", "--stdin"], {
      sentiment: "fix", reason: "invalid",
      selected_turns: [{ user: "u", assistant: "a", file_changes: [change] }],
      model: null, group: null,
    });
    assert.equal(rejected.ok, false);
  }
  const huge = "x".repeat(4 * 1024 * 1024);
  const backendLarge = cli(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "too large",
    selected_turns: [{ user: "u", assistant: "a", file_changes: [{ tool: "write", path: "huge.txt", content: huge }] }],
    model: null, group: null,
  });
  assert.equal(backendLarge.ok, false);
  assert.match(backendLarge.error.message, /4 MiB|exceeds/);

  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "large write" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "large", name: "write", arguments: { path: "huge.txt", content: huge } }], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "large", toolName: "write", isError: false, details: {} } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
  ];
  const frontend = harness(t, { branch });
  await frontend.pref("feedback --group global fix too large");
  assert.equal(frontend.modelCalls, 0);
  assert.equal(learning(frontend.root).feedback.length, 0);
  assert.ok(frontend.notices.some((item) => item.message.includes("超过") && item.message.includes("没有内容被截断")));
});

test("C06 rejects quotes from failed changes and cross-field concatenation", async (t) => {
  const failedBranch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "failed change" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "failed-edit", name: "edit", arguments: { path: "x.ts", oldText: "FAILED-ONLY", newText: "new" } }], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "failed-edit", toolName: "edit", isError: true } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "could not edit" }], stopReason: "stop" } },
  ];
  const failed = harness(t, { branch: failedBranch, modelReply: () => extraction("FAILED-ONLY") });
  await failed.pref("feedback --group global fix failed tool quote");
  await waitFor(() => learning(failed.root).feedback[0]?.status === "failed", "failed tool quote rejection");
  assert.equal(learning(failed.root).evidence.length, 0);

  const crossBranch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "USER-PART" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "cross-write", name: "write", arguments: { path: "x.txt", content: "TOOL-PART" } }], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "cross-write", toolName: "write", isError: false, details: {} } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
  ];
  const cross = harness(t, { branch: crossBranch, modelReply: () => extraction("USER-PARTTOOL-PART") });
  await cross.pref("feedback --group global fix cross field quote");
  await waitFor(() => learning(cross.root).feedback[0]?.status === "failed", "cross-field quote rejection");
  assert.equal(learning(cross.root).evidence.length, 0);
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

test("T07 event quotes use single-event sources and evolution omits raw timelines", (t) => {
  const roles: ConversationTurn[] = [{ events: [
    { type: "user", text: "USER-ONLY SHARED" },
    { type: "assistant", text: "ASSISTANT-ONLY SHARED" },
    { type: "file_change_call", call_id: "change-1", tool: "write", path: "PATH-ONLY" },
    { type: "file_change_result", call_id: "change-1", content: "TOOL-ONLY" },
    { type: "assistant", text: "done" },
  ] }];
  assert.equal(conversationQuoteRole(roles, "USER-ONLY"), "user");
  assert.equal(conversationQuoteRole(roles, "ASSISTANT-ONLY"), "assistant");
  assert.equal(conversationQuoteRole(roles, "SHARED"), "both");
  assert.equal(conversationQuoteRole(roles, "TOOL-ONLY"), "tool");
  assert.equal(conversationQuoteRole(roles, "PATH-ONLY"), "unknown");
  assert.equal(conversationQuoteRole(roles, "change-1"), "unknown");
  assert.equal(conversationQuoteRole(roles, "USER-ONLYASSISTANT-ONLY"), "unknown");

  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const invalid = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "invalid event quote", selected_turns: [orderedTurn("VALID-RESULT", "quoted-path.md")], model: null, group: null,
  });
  for (const quote of ["quoted-path.md", "change-1", "ordered userordered assistant before", "OLD-DISCARDED-RESULT"]) {
    const rejected = cli(root, ["feedback-extracted", "--stdin"], {
      feedback_id: invalid.feedback.id,
      expected_evaluation: evaluation(invalid.feedback),
      extraction: extraction(quote, { name: null, certain: false }),
      model: { provider: "fake", id: "fake", thinking: "high" },
    });
    assert.equal(rejected.ok, false);
  }
  assert.equal(learning(root).feedback.find((item: Json) => item.id === invalid.feedback.id).extraction, null);

  for (let index = 1; index <= 3; index += 1) {
    const quote = `EVENT-TOOL-QUOTE-${index}`;
    const created = ok(root, ["feedback-create", "--stdin"], {
      sentiment: "good", reason: `event reason ${index}`,
      selected_turns: [orderedTurn(`${quote}\nRAW-EVENT-TIMELINE-${index}`, `event-${index}.md`)],
      model: null, group: "global",
    });
    ok(root, ["feedback-extracted", "--stdin"], {
      feedback_id: created.feedback.id,
      expected_evaluation: evaluation(created.feedback),
      extraction: extraction(quote, { summary: `event evidence ${index}` }),
      model: { provider: "fake", id: "fake", thinking: "high" },
    });
    const completed = ok(root, ["feedback-complete", "--stdin"], {
      feedback_id: created.feedback.id, expected_evaluation: evaluation(created.feedback), group: "global",
    });
    assert.equal(completed.duplicate, false);
    const detail = ok(root, ["feedback-get", "--stdin"], { feedback_id: created.feedback.id });
    assert.deepEqual(detail.quote_sources, [{ text: quote, role: "tool" }]);
  }
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  assert.equal(prepared.evidence.length, 3);
  const projected = JSON.stringify(prepared.evidence);
  assert.match(projected, /"role":"tool"/);
  assert.doesNotMatch(projected, /RAW-EVENT-TIMELINE|"events"|file_change_call|file_change_result/);
  assert.equal(learning(root).evidence.length, 3);
});

test("C07 file changes do not alter evidence counts or leak wholesale into evolution input", (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  for (let index = 1; index <= 3; index += 1) {
    const created = ok(root, ["feedback-create", "--stdin"], {
      sentiment: "fix", reason: `reason-${index}`,
      selected_turns: [{
        user: `user-${index}`, assistant: `assistant-${index}`,
        file_changes: [
          { tool: "write", path: `file-${index}.txt`, content: `RAW-FILE-BODY-${index} NECESSARY-TOOL-QUOTE-${index}` },
          { tool: "edit", path: `other-${index}.txt`, content: `UNQUOTED-RAW-CHANGE-${index}` },
        ],
      }],
      model: { provider: "fake", id: "fake", thinking: "high" }, group: "global",
    });
    ok(root, ["feedback-extracted", "--stdin"], {
      feedback_id: created.feedback.id,
      expected_evaluation: evaluation(created.feedback),
      extraction: extraction(`NECESSARY-TOOL-QUOTE-${index}`, { name: "global", certain: true, summary: `summary-${index}` }),
      model: { provider: "fake", id: "fake", thinking: "high" },
    });
    ok(root, ["feedback-complete", "--stdin"], {
      feedback_id: created.feedback.id, expected_evaluation: evaluation(created.feedback), group: "global",
    });
  }
  const stored = learning(root);
  assert.equal(stored.feedback.length, 3);
  assert.equal(stored.evidence.length, 3);
  const prepared = ok(root, ["prepare-evolution", "--stdin"], { group: "global" });
  assert.equal(prepared.trigger, true);
  const projected = JSON.stringify(prepared.evidence);
  for (let index = 1; index <= 3; index += 1) {
    assert.match(projected, new RegExp(`NECESSARY-TOOL-QUOTE-${index}`));
  }
  assert.match(projected, /"role":"tool"/);
  assert.doesNotMatch(projected, /RAW-FILE-BODY|UNQUOTED-RAW-CHANGE|file-1\.txt/);
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
  assert.match(flow.prompts[0]!, /actual_behavior 的行为证据/);
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
  assert.equal(turnAssistantText(parseConversationTurn(learning(originalRoot).feedback[0].selected_turns[0])), longAssistant);
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
  const flow = harness(t, {
    modelReply: () => extraction("selected-assistant-0", { name: null, certain: false, summary: "saved uncertain evidence" }),
    selectReply: (title) => {
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
  assert.ok(flow.renderedViews.flat().some((line) => line.includes("处理待办")));
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
    expected_evaluation: evaluation(created.feedback),
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

test("P01 every main-model context ends with one ephemeral preference reminder", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "keep the formal rule" });
  const rulesBefore = readFileSync(join(root, "repo/groups.json"), "utf8");
  const flow = harness(t, { root });
  await flow.handler("session_start")!({ reason: "startup" }, flow.ctx);
  const injected = await flow.handler("before_agent_start")!({ systemPrompt: "base-system" }, flow.ctx);
  assert.match(injected.systemPrompt, /keep the formal rule/);
  assert.match(injected.systemPrompt, /These preferences have lower priority than safety, correctness, the user's current request, and AGENTS\.md\./);
  assert.match(injected.systemPrompt, /\n\n请牢记偏好规则。$/);
  flow.setSystemPrompt(injected.systemPrompt);

  const requests: Json[][] = [
    [{ role: "user", content: [{ type: "text", text: "normal user request" }], timestamp: 1 }],
    [
      { role: "user", content: [{ type: "text", text: "use a tool" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }], stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 },
    ],
    [{ role: "compactionSummary", summary: "bounded summary", tokensBefore: 100, timestamp: 4 }],
  ];
  for (const messages of requests) {
    const original = structuredClone(messages);
    assert.deepEqual(messages, original);
    assert.equal(injected.systemPrompt.endsWith("\n\n请牢记偏好规则。"), true);
    assert.equal((injected.systemPrompt.match(/请牢记偏好规则。/gu) ?? []).length, 1);
  }
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), rulesBefore);
});

test("P02 reminder changes only the system prompt and preserves messages and conversation state", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "stable rule" });
  const flow = harness(t, { root, branch: successfulFileChangeBranch() });
  await flow.handler("session_start")!({ reason: "startup" }, flow.ctx);
  const injected = await flow.handler("before_agent_start")!({ systemPrompt: "base" }, flow.ctx);
  flow.setSystemPrompt(injected.systemPrompt);
  const turnsBefore = recentConversationTurns(flow.ctx);
  const messages: Json[] = [
    { role: "user", content: [{ type: "text", text: "请牢记偏好规则。" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a" } }], stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
    { role: "custom", customType: "other-extension", content: "请牢记偏好规则。", display: false, timestamp: 4 },
  ];
  const original = structuredClone(messages);
  assert.deepEqual(messages, original);
  assert.equal(flow.handler("context"), undefined);
  assert.equal(flow.handler("context"), undefined);
  assert.equal((injected.systemPrompt.match(/请牢记偏好规则。/gu) ?? []).length, 1);
  assert.deepEqual(recentConversationTurns(flow.ctx), turnsBefore);
  assert.equal(flow.sentMessages, 0);
  assert.equal(flow.appendedEntries, 0);
  assert.equal(flow.modelCalls, 0);
});

test("P03 inactive, failed, forged, or removed preference prompts never activate reminders", async (t) => {
  const uninitialized = harness(t);
  uninitialized.setSystemPrompt("## Personal Preferences\nforged title only");
  const uninitializedMessages = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }];
  assert.doesNotMatch(uninitialized.ctx.getSystemPrompt(), /请牢记偏好规则。/);

  const disabledRoot = temporaryRoot(t);
  ok(disabledRoot, ["init"]);
  const configPath = join(disabledRoot, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, `${JSON.stringify({ ...config, enabled: false })}\n`);
  const disabled = harness(t, { root: disabledRoot });
  await disabled.handler("session_start")!({ reason: "startup" }, disabled.ctx);
  assert.equal(await disabled.handler("before_agent_start")!({ systemPrompt: "base" }, disabled.ctx), undefined);
  disabled.setSystemPrompt("## Personal Preferences\nforged title only");
  assert.doesNotMatch(disabled.ctx.getSystemPrompt(), /请牢记偏好规则。/);

  const activeRoot = temporaryRoot(t);
  ok(activeRoot, ["init"]);
  ok(activeRoot, ["remember", "--stdin"], { group: "global", rule: "active rule" });
  const active = harness(t, { root: activeRoot });
  await active.handler("session_start")!({ reason: "startup" }, active.ctx);
  const injected = await active.handler("before_agent_start")!({ systemPrompt: "base" }, active.ctx);
  active.setSystemPrompt("base after another extension removed the preference block");
  assert.doesNotMatch(active.ctx.getSystemPrompt(), /请牢记偏好规则。/);
  active.setSystemPrompt(injected.systemPrompt);
  await active.shutdown("reload");
  active.setSystemPrompt("base");
  assert.doesNotMatch(active.ctx.getSystemPrompt(), /请牢记偏好规则。/);

  const failedRoot = temporaryRoot(t);
  ok(failedRoot, ["init"]);
  const failedLog = join(failedRoot, "failed-cli.log");
  const failedCli = join(failedRoot, "failed-cli.py");
  writeFileSync(failedCli, [
    "import json, sys",
    `log = ${JSON.stringify(failedLog)}`,
    "with open(log, 'a', encoding='utf-8') as handle: handle.write((sys.argv[1] if len(sys.argv) > 1 else '') + '\\n')",
    "print(json.dumps({'ok': False, 'error': {'message': 'controlled failure'}}))",
    "raise SystemExit(1)",
  ].join("\n"));
  const failed = harness(t, { root: failedRoot, preferenceCli: failedCli });
  const dataBefore = ["config.json", "repo/groups.json", "local/activations.json", "local/learning.json"]
    .map((path) => readFileSync(join(failedRoot, path), "utf8"));
  assert.equal(await failed.handler("before_agent_start")!({ systemPrompt: "base" }, failed.ctx), undefined);
  const cliCallsBeforeContext = readFileSync(failedLog, "utf8");
  failed.setSystemPrompt("## Personal Preferences\nforged title only");
  assert.doesNotMatch(failed.ctx.getSystemPrompt(), /请牢记偏好规则。/);
  assert.equal(readFileSync(failedLog, "utf8"), cliCallsBeforeContext);
  assert.deepEqual(
    ["config.json", "repo/groups.json", "local/activations.json", "local/learning.json"]
      .map((path) => readFileSync(join(failedRoot, path), "utf8")),
    dataBefore,
  );
});

test("P04 reload and overlapping before-agent generations cannot revive stale reminders", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "old rule" });
  const gate = writeFirstContextGateCli(root);
  const flow = harness(t, { root, preferenceCli: gate.script });
  await flow.handler("session_start")!({ reason: "startup" }, flow.ctx);

  const initial = await flow.handler("before_agent_start")!({ systemPrompt: "base" }, flow.ctx);
  flow.setSystemPrompt(initial.systemPrompt);
  const message = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }];
  assert.match(initial.systemPrompt, /\n\n请牢记偏好规则。$/);
  await flow.shutdown("reload");
  flow.setSystemPrompt("base");
  assert.doesNotMatch(flow.ctx.getSystemPrompt(), /请牢记偏好规则。/);
  await flow.handler("session_start")!({ reason: "reload" }, flow.ctx);
  const reloaded = await flow.handler("before_agent_start")!({ systemPrompt: "base" }, flow.ctx);
  flow.setSystemPrompt(reloaded.systemPrompt);
  assert.match(reloaded.systemPrompt, /\n\n请牢记偏好规则。$/);

  writeFileSync(gate.arm, "arm\n");
  const stalePromise = flow.handler("before_agent_start")!({ systemPrompt: "base" }, flow.ctx);
  await waitFor(() => existsSync(gate.started), "first delayed context lookup");
  ok(root, ["remember", "--stdin"], { group: "global", rule: "new rule" });
  const fresh = await flow.handler("before_agent_start")!({ systemPrompt: "base" }, flow.freshContext());
  assert.match(fresh.systemPrompt, /old rule/);
  assert.match(fresh.systemPrompt, /new rule/);
  flow.setSystemPrompt(fresh.systemPrompt);
  assert.match(fresh.systemPrompt, /\n\n请牢记偏好规则。$/);

  writeFileSync(gate.release, "release\n");
  const stale = await stalePromise;
  assert.match(stale.systemPrompt, /old rule/);
  assert.doesNotMatch(stale.systemPrompt, /new rule/);
  flow.setSystemPrompt(stale.systemPrompt);
  assert.match(stale.systemPrompt, /\n\n请牢记偏好规则。$/);
  flow.setSystemPrompt(fresh.systemPrompt);
  assert.match(fresh.systemPrompt, /\n\n请牢记偏好规则。$/);
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

test("Q05 fresh same-generation contexts refresh status and report command parsing errors", async (t) => {
  const flow = harness(t);
  await flow.pref("");
  const commandContext = flow.freshContext();
  assert.notEqual(commandContext, flow.ctx);
  const noticesBefore = flow.notices.length;
  await flow.prefWithContext("feedback good", commandContext);
  assert.equal(flow.notices.length, noticesBefore + 1);
  assert.match(flow.notices.at(-1)!.message, /requires a reason/);
  assert.equal(flow.notices.at(-1)!.level, "error");

  const commandStatusCount = flow.statuses.length;
  await flow.prefWithContext("", flow.freshContext());
  assert.ok(flow.statuses.length > commandStatusCount);
  const settledStatusCount = flow.statuses.length;
  await flow.handler("agent_settled")!({}, flow.freshContext());
  assert.ok(flow.statuses.length > settledStatusCount);
});

test("Q01/Q03 status refreshes drain every query before shutdown and root removal", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const gate = writeStatusGateCli(root);
  const previous = {
    events: process.env.PI_PREF_STATUS_EVENTS,
    allow: process.env.PI_PREF_STATUS_ALLOW,
    fail: process.env.PI_PREF_STATUS_FAIL,
  };
  process.env.PI_PREF_STATUS_EVENTS = gate.events;
  process.env.PI_PREF_STATUS_ALLOW = gate.allow;
  process.env.PI_PREF_STATUS_FAIL = gate.failStatus;
  writeFileSync(gate.allow, "allow\n");
  const flow = harness(t, { root, preferenceCli: gate.script });
  const startedFiles = () => readdirSync(gate.events).filter((name) => name.endsWith(".started"));
  const closedFiles = () => readdirSync(gate.events).filter((name) => name.endsWith(".closed"));
  const pidsFrom = (files: string[]) => files.map((name) => Number(name.split(".", 1)[0]));
  try {
    await flow.handler("session_start")!({ reason: "startup" }, flow.ctx);
    const initialStarts = startedFiles().length;
    assert.equal(initialStarts, 3);
    unlinkSync(gate.allow);

    writeFileSync(gate.failStatus, "fail\n");
    const statusCount = flow.statuses.length;
    let failedBatchSettled = false;
    const failedBatch = flow.handler("agent_settled")!({}, flow.freshContext()).finally(() => { failedBatchSettled = true; });
    await waitFor(() => startedFiles().length === initialStarts + 3, "controlled failed status batch start");
    await waitFor(() => readdirSync(gate.events).some((name) => name.endsWith(".status.failed")), "controlled status failure");
    assert.equal(failedBatchSettled, false);
    assert.equal(flow.statuses.length, statusCount);
    const failedBatchStarts = startedFiles().slice(initialStarts);
    for (const pid of pidsFrom(failedBatchStarts)) writeFileSync(join(gate.events, `release-${pid}`), "release\n");
    await failedBatch;
    assert.equal(flow.statuses.at(-1), "偏好：状态异常");
    assert.equal(closedFiles().length, initialStarts + 3);
    assert.ok(pidsFrom(failedBatchStarts).every((pid) => !processExists(pid)));
    unlinkSync(gate.failStatus);

    const overlapStart = startedFiles().length;
    const statusesBeforeShutdown = flow.statuses.length;
    const firstRefresh = flow.handler("agent_settled")!({}, flow.freshContext());
    const secondRefresh = flow.handler("agent_settled")!({}, flow.freshContext());
    await waitFor(() => startedFiles().length === overlapStart + 6, "overlapping status refreshes");
    const overlapFiles = startedFiles().slice(overlapStart);
    await flow.shutdown("reload");
    await Promise.all([firstRefresh, secondRefresh]);
    assert.equal(flow.statuses.length, statusesBeforeShutdown);
    assert.equal(closedFiles().length, overlapStart + 6);
    assert.ok(pidsFrom(overlapFiles).every((pid) => !processExists(pid)));
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  } finally {
    if (previous.events === undefined) delete process.env.PI_PREF_STATUS_EVENTS;
    else process.env.PI_PREF_STATUS_EVENTS = previous.events;
    if (previous.allow === undefined) delete process.env.PI_PREF_STATUS_ALLOW;
    else process.env.PI_PREF_STATUS_ALLOW = previous.allow;
    if (previous.fail === undefined) delete process.env.PI_PREF_STATUS_FAIL;
    else process.env.PI_PREF_STATUS_FAIL = previous.fail;
  }
});

test("Q01 cleanup failures recorded before shutdown remain explicit and preserve fixture evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-pref-status-cleanup-error-"));
  ok(root, ["init"]);
  const script = join(root, "status-close.py");
  writeFileSync(script, [
    "import json, sys",
    "command = sys.argv[1]",
    "if command == 'status':",
    "    value = {'ok': True, 'enabled': True, 'groups': 1, 'rules': 0, 'sync_state': 'clean', 'actionable_count': 0}",
    "elif command == 'context':",
    "    value = {'ok': True, 'effective_groups': ['global']}",
    "else:",
    "    value = {'ok': True, 'feedback': [], 'proposals': [], 'evolution_groups': []}",
    "print(json.dumps(value), flush=True)",
  ].join("\n"));
  const flow = harness(t, { root, preferenceCli: script });
  const originalKill = process.kill;
  (process as any).kill = (target: number, signal?: NodeJS.Signals | number) => {
    if (target < 0 && signal === 0) return true;
    return originalKill(target, signal as NodeJS.Signals | number | undefined);
  };
  let startFailure: unknown;
  try {
    startFailure = await flow.handler("session_start")!({ reason: "startup" }, flow.ctx).then(() => undefined, (error: unknown) => error);
  } finally {
    (process as any).kill = originalKill;
  }
  assert.ok(startFailure instanceof PreferenceCliCleanupError);
  const shutdownFailure = await flow.shutdown("reload").then(() => undefined, (error: unknown) => error);
  assert.ok(shutdownFailure instanceof PreferenceCliCleanupError);
  assert.equal(existsSync(root), true);
  await flow.shutdown("reload");
  resourcesFor(t).cleanupFailures.length = 0;
  rmSync(root, { recursive: true, force: true });
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
    expected_evaluation: evaluation(secondCreated.feedback),
    extraction: {
      group: { name: "global", certain: true, reason: "group" },
      evidence: {
        summary: longEvidence, actual_behavior: "detail actual", expected_behavior: "detail expected",
        applicability: "detail scope", supporting_quotes: ["shared", "assistant-only"],
      },
    },
    model: { provider: "fake", id: "fake", thinking: "high" },
  });
  ok(root, ["feedback-complete", "--stdin"], {
    feedback_id: secondCreated.feedback.id, expected_evaluation: evaluation(secondCreated.feedback), group: "global",
  });
  const document = learning(root);
  document.feedback[0].created_at = "2026-01-01T00:00:00+00:00";
  document.feedback[0].reason = "REASON-SENTINEL";
  document.feedback[1].created_at = "2026-01-01T00:00:00+00:00";
  const secondEvidence = document.evidence.find((item: Json) => item.feedback_id === secondCreated.feedback.id);
  secondEvidence.supporting_quotes.push("legacy unknown");
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(document)}\n`);

  const flow = harness(t, {
    root, terminalRows: 24, terminalColumns: 60,
    detailInputs: [[...Array(30).fill("\x1b[6~"), "\x1b[D"]],
    menuInputs: [
      { title: "反馈与证据", keys: ["\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
    ],
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

test("T06 reprocess reuses exact ordered events while legacy prompts keep order unknown", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const eventTurn = orderedTurn("REPROCESS-EVENT-QUOTE", "event-saved.md");
  const created = ok(root, ["feedback-create", "--stdin"], {
    sentiment: "fix", reason: "ordered reprocess", selected_turns: [eventTurn],
    model: { provider: "fake", id: "old", thinking: "high" }, group: "global",
  });
  ok(root, ["feedback-extracted", "--stdin"], {
    feedback_id: created.feedback.id,
    expected_evaluation: evaluation(created.feedback),
    extraction: extraction("REPROCESS-EVENT-QUOTE", { summary: "old ordered evidence" }),
    model: { provider: "fake", id: "old", thinking: "high" },
  });
  ok(root, ["feedback-complete", "--stdin"], {
    feedback_id: created.feedback.id, expected_evaluation: evaluation(created.feedback), group: "global",
  });
  writeFileSync(join(root, "event-saved.md"), "CURRENT-EVENT-DISK\n");
  const gate = deferred<ModelReply>();
  const flow = harness(t, {
    root,
    branch: completedBranch(1, "CURRENT-EVENT-BRANCH"),
    detailInputs: [["r"]],
    modelReply: () => gate.promise,
  });
  const before = readFileSync(join(root, "local/learning.json"), "utf8");
  const running = flow.menu("重新整理反馈");
  await waitFor(() => flow.modelCalls === 1, "ordered reprocess model");
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  const modelInput = JSON.parse(flow.prompts[0]!.split("\n\n").at(-1)!);
  assert.deepEqual(modelInput.selected_turns, [eventTurn]);
  assert.match(flow.prompts[0]!, /events 必须按数组顺序|相同 call_id/);
  assert.doesNotMatch(flow.prompts[0]!, /CURRENT-EVENT-BRANCH|CURRENT-EVENT-DISK/);
  gate.resolve(extraction("REPROCESS-EVENT-QUOTE", { summary: "new ordered preview" }));
  await running;
  assert.equal(flow.modelCalls, 1);
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  assert.match(flow.renderedViews.flat().join("\n"), /\[文件改动\] REPROCESS-EVENT-QUOTE/);
});

test("R03/R04/H02 reprocess uses the exact saved change snapshot and previews tool quotes", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const created = addCliEvidence(root, 1);
  const withChanges = learning(root);
  const storedFeedback = withChanges.feedback.find((item: Json) => item.id === created.id);
  storedFeedback.selected_turns[0].file_changes = [
    { tool: "write", path: "saved.md", content: "REPROCESS-SAVED-CHANGE\nSAVED-TOOL-QUOTE" },
  ];
  const savedTurns = JSON.parse(JSON.stringify(storedFeedback.selected_turns));
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(withChanges)}\n`);
  writeFileSync(join(root, "saved.md"), "CURRENT-DISK-SENTINEL\n");
  const gate = deferred<ModelReply>();
  const flow = harness(t, {
    root,
    branch: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "CURRENT-BRANCH-USER" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "current-write", name: "write", arguments: { path: "saved.md", content: "CURRENT-BRANCH-CHANGE" } }], stopReason: "toolUse" } },
      { type: "message", message: { role: "toolResult", toolCallId: "current-write", toolName: "write", isError: false, details: {} } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "CURRENT-BRANCH-ASSISTANT" }], stopReason: "stop" } },
    ],
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
  assert.match(flow.prompts[0]!, /旧格式仅提供按角色汇总|交错先后未知/);
  const reprocessInput = JSON.parse(flow.prompts[0]!.split("\n\n").at(-1)!);
  assert.deepEqual(reprocessInput.selected_turns, savedTurns);
  assert.doesNotMatch(flow.prompts[0]!, /CURRENT-BRANCH-USER|CURRENT-BRANCH-CHANGE|CURRENT-BRANCH-ASSISTANT|CURRENT-DISK-SENTINEL/);
  gate.resolve(extraction("SAVED-TOOL-QUOTE", { name: "global", certain: true, summary: "fresh preview result" }));
  await running;
  assert.equal(readFileSync(join(root, "local/learning.json"), "utf8"), before);
  assert.equal(flow.modelCalls, 1);
  const preview = flow.renderedViews.flat().join("\n");
  assert.match(preview, /fresh preview result/);
  assert.match(preview, /\[文件改动\] SAVED-TOOL-QUOTE/);
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
  const uiCount = flow.events.filter((item) => item === "custom").length;
  assert.equal(uiCount, 2);
  const notices = flow.notices.length;
  const shutdownStarted = Date.now();
  await flow.shutdown("reload");
  assert.ok(Date.now() - shutdownStarted < 1_000);
  writeFileSync(releaseFile, "release\n");
  await running;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(flow.modelCalls, 0);
  assert.equal(flow.events.filter((item) => item === "custom").length, uiCount);
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
  const shutdownUiCount = shutdownFlow.events.filter((item) => item === "custom").length;
  const started = Date.now();
  await shutdownFlow.shutdown("reload");
  assert.ok(Date.now() - started < 1_000);
  await running;
  shutdownGate.resolve(extraction("quote-1", { summary: "late reprocess result" }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.equal(readFileSync(join(shutdownRoot, "local/learning.json"), "utf8"), beforeShutdown);
  assert.equal(shutdownFlow.notices.length, noticeCount);
  assert.equal(shutdownFlow.events.filter((item) => item === "custom").length, shutdownUiCount);

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
    expected_evaluation: evaluation(created.feedback),
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

test("Q02/Q04 CLI abort, timeout, and orphaned descendants settle only after process closure", async (t) => {
  const root = temporaryRoot(t);
  const hanging = join(root, "hanging-cli.py");
  writeFileSync(hanging, [
    "import os, time",
    "with open(os.environ['PI_PREF_PID_FILE'], 'w', encoding='utf-8') as handle:",
    "    handle.write(str(os.getpid()))",
    "while True:",
    "    time.sleep(1)",
  ].join("\n"));

  const abortPidFile = join(root, "abort.pid");
  const abortController = new AbortController();
  const aborted = runPreferenceCli(hanging, root, [], undefined, 10_000, { PI_PREF_PID_FILE: abortPidFile }, abortController.signal);
  await waitFor(() => existsSync(abortPidFile), "abort CLI pid");
  const abortPid = Number(readFileSync(abortPidFile, "utf8"));
  abortController.abort();
  await assert.rejects(aborted, /CLI aborted/);
  assert.equal(processExists(abortPid), false);

  const timeoutPidFile = join(root, "timeout.pid");
  const timedOut = runPreferenceCli(hanging, root, [], undefined, 500, { PI_PREF_PID_FILE: timeoutPidFile });
  await waitFor(() => existsSync(timeoutPidFile), "timeout CLI pid");
  const timeoutPid = Number(readFileSync(timeoutPidFile, "utf8"));
  await assert.rejects(timedOut, /CLI timed out/);
  assert.equal(processExists(timeoutPid), false);

  const descendantPidFile = join(root, "descendant.pid");
  const forking = join(root, "forking-cli.py");
  writeFileSync(forking, [
    "import json, os, signal, time",
    "pid_file = os.environ['PI_PREF_DESCENDANT_PID_FILE']",
    "child = os.fork()",
    "if child == 0:",
    "    devnull = os.open(os.devnull, os.O_RDWR)",
    "    for descriptor in (0, 1, 2):",
    "        os.dup2(devnull, descriptor)",
    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "    with open(pid_file, 'w', encoding='utf-8') as handle:",
    "        handle.write(str(os.getpid()))",
    "    while True:",
    "        signal.pause()",
    "while not os.path.exists(pid_file):",
    "    time.sleep(0.01)",
    "print(json.dumps({'ok': True, 'parent': os.getpid()}), flush=True)",
  ].join("\n"));
  const forked = await runPreferenceCli(forking, root, [], undefined, 10_000, { PI_PREF_DESCENDANT_PID_FILE: descendantPidFile });
  const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
  assert.equal(forked.ok, true);
  assert.equal(processExists(descendantPid), false);
});

test("Q06 parent exit always bounds close without signaling a setsid stdio holder", async (t) => {
  const root = temporaryRoot(t);
  const script = join(root, "setsid-holder-cli.py");
  writeFileSync(script, [
    "import json, os, signal, time",
    "release = os.environ['PI_PREF_HOLDER_RELEASE']",
    "pid_file = os.environ['PI_PREF_HOLDER_PID']",
    "parent_exit = os.environ['PI_PREF_PARENT_EXIT']",
    "child = os.fork()",
    "if child == 0:",
    "    os.setsid()",
    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "    with open(pid_file, 'w', encoding='utf-8') as handle:",
    "        handle.write(str(os.getpid()))",
    "    while not os.path.exists(release):",
    "        time.sleep(0.01)",
    "    raise SystemExit(0)",
    "while not os.path.exists(pid_file):",
    "    time.sleep(0.01)",
    "with open(parent_exit, 'w', encoding='utf-8') as handle:",
    "    handle.write(str(os.getpid()))",
    "print(json.dumps({'ok': True}), flush=True)",
  ].join("\n"));

  const withinRelease = join(root, "within.release");
  const withinPidFile = join(root, "within.pid");
  const withinParentExit = join(root, "within.parent-exit");
  const within = runPreferenceCli(script, root, [], undefined, 10_000, {
    PI_PREF_HOLDER_RELEASE: withinRelease,
    PI_PREF_HOLDER_PID: withinPidFile,
    PI_PREF_PARENT_EXIT: withinParentExit,
  });
  await waitFor(() => existsSync(withinPidFile) && existsSync(withinParentExit), "within-deadline setsid holder");
  const withinPid = Number(readFileSync(withinPidFile, "utf8"));
  assert.equal(processExists(withinPid), true);
  writeFileSync(withinRelease, "release\n");
  assert.equal((await within).ok, true);
  await waitFor(() => !processExists(withinPid), "released within-deadline setsid holder");

  const overdueRelease = join(root, "overdue.release");
  const overduePidFile = join(root, "overdue.pid");
  const overdueParentExit = join(root, "overdue.parent-exit");
  const overdue = runPreferenceCli(script, root, [], undefined, 200, {
    PI_PREF_HOLDER_RELEASE: overdueRelease,
    PI_PREF_HOLDER_PID: overduePidFile,
    PI_PREF_PARENT_EXIT: overdueParentExit,
  });
  await waitFor(() => existsSync(overduePidFile) && existsSync(overdueParentExit), "overdue setsid holder");
  const overduePid = Number(readFileSync(overduePidFile, "utf8"));
  const closeStarted = Date.now();
  let watchdog: NodeJS.Timeout | undefined;
  let failure: unknown;
  try {
    failure = await Promise.race([
      overdue.then(() => new Error("setsid holder unexpectedly completed"), (error) => error),
      new Promise<Error>((resolvePromise) => {
        watchdog = setTimeout(() => resolvePromise(new Error("setsid holder close deadline was not enforced")), 1_500);
      }),
    ]);
    assert.ok(failure instanceof PreferenceCliCleanupError, String(failure));
    assert.ok(Date.now() - closeStarted < 1_300);
    assert.equal(processExists(overduePid), true);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    writeFileSync(overdueRelease, "release\n");
    await waitFor(() => !processExists(overduePid), "released overdue setsid holder");
  }
});

test("Q02 cleanup timeout is explicit and preserves its root until controlled recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-pref-cleanup-error-"));
  const script = join(root, "cleanup-timeout.py");
  const pidFile = join(root, "child.pid");
  writeFileSync(script, [
    "import os, time",
    "with open(os.environ['PI_PREF_PID_FILE'], 'w', encoding='utf-8') as handle:",
    "    handle.write(str(os.getpid()))",
    "while True:",
    "    time.sleep(1)",
  ].join("\n"));
  const controller = new AbortController();
  const running = runPreferenceCli(script, root, [], undefined, 10_000, { PI_PREF_PID_FILE: pidFile }, controller.signal);
  await waitFor(() => existsSync(pidFile), "cleanup timeout CLI pid");
  const pid = Number(readFileSync(pidFile, "utf8"));
  const originalKill = process.kill;
  let ownedGroup: number | null = null;
  (process as any).kill = (target: number, signal?: NodeJS.Signals | number) => {
    if (target < 0) {
      if (ownedGroup === null && signal !== 0) ownedGroup = -target;
      if (ownedGroup === -target && signal === 0) return true;
    }
    return originalKill(target, signal as NodeJS.Signals | number | undefined);
  };
  let failure: unknown;
  try {
    controller.abort();
    failure = await running.then(() => undefined, (error) => error);
  } finally {
    (process as any).kill = originalKill;
  }
  assert.ok(failure instanceof PreferenceCliCleanupError);
  assert.match(failure.message, /did not close within 1 second/);
  assert.match(failure.primaryError?.message ?? "", /CLI aborted/);
  assert.equal(existsSync(root), true);
  assert.equal(processExists(pid), false);
  rmSync(root, { recursive: true, force: true });
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

test("T08 picker derives summaries and successful counts from events without rewriting the turn", async () => {
  const turn: ConversationTurn = { events: [
    { type: "user", text: "first user block" },
    { type: "assistant", text: "first assistant block" },
    { type: "file_change_call", call_id: "change-1", tool: "edit", path: "one.ts" },
    { type: "user", text: "second user block" },
    { type: "file_change_result", call_id: "change-1", content: "PATCH-ONE" },
    { type: "file_change_call", call_id: "change-2", tool: "write", path: "two.md" },
    { type: "file_change_result", call_id: "change-2", content: "" },
    { type: "assistant", text: "second assistant block" },
  ] };
  let rendered: string[] = [];
  const selected = await selectConversationTurns({
    mode: "tui",
    ui: { custom(factory: Function) {
      return new Promise((resolvePromise) => {
        const component = factory({ requestRender() {}, terminal: { rows: 24 } }, themeForTest(), {}, resolvePromise);
        rendered = component.render(100);
        component.handleInput(" ");
        component.handleInput("\r");
      });
    } },
  } as any, [turn]);
  assert.deepEqual(selected, [turn]);
  assert.match(rendered.join("\n"), /first user block second user block · 成功改动 2/);
  assert.match(rendered.join("\n"), /first assistant block second assistant block/);
  assert.deepEqual(selected![0], turn);
});

test("N01 real menu keys preserve main and group-rule positions without pseudo rows", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  ok(root, ["remember", "--stdin"], { group: "global", rule: "menu-rule" });
  const flow = harness(t, {
    root,
    terminalRows: 8,
    terminalColumns: 40,
    menuInputs: [
      { title: "个人偏好", keys: [...Array(7).fill("\x1b[B"), "\x1b[C"] },
      { title: "管理偏好组", keys: [...Array(4).fill("\x1b[B"), "\x1b[C"] },
      { title: "管理组内规则", keys: ["\x1b[B", "\x1b[C"] },
      { title: "管理组内规则", keys: ["\x1b[D"] },
      { title: "管理偏好组", keys: ["\x1b[D"] },
      { title: "个人偏好", keys: ["\x1b[D"] },
    ],
    selectReply: (title, choices) => title === "选择偏好组" || title === "选择规则" ? choices[0] : undefined,
  });
  await flow.pref("");
  const views = flow.renderedViews;
  assert.ok(views.some((view) => view.some((line) => line.includes("→ 管理组与规则"))));
  assert.ok(views.some((view) => view.some((line) => line.includes("→ 管理规则"))));
  assert.ok(views.some((view) => view.some((line) => line.includes("→ 修改"))));
  assert.equal(views.flat().some((line) => /→\s*(返回|退出)/u.test(line)), false);
  assert.ok(views.flat().every((line) => visibleWidth(line) <= 40));
});

test("N02 evidence navigation remembers stable IDs and safely falls back after deletion", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const older = addCliEvidence(root, 1);
  const newer = addCliEvidence(root, 2);
  const labeled = learning(root);
  labeled.feedback.find((item: Json) => item.id === older.id).reason = "OLD-REMOVED";
  labeled.feedback.find((item: Json) => item.id === newer.id).reason = "NEW-REMAINING";
  labeled.feedback.forEach((item: Json) => { item.created_at = "t"; });
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(labeled)}\n`);
  const flow = harness(t, {
    root,
    detailInputs: [[]],
    menuInputs: [
      { title: "个人偏好", keys: ["\x1b[B", "\x1b[B", "\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[B", "\x1b[C"] },
      { title: "反馈与证据", keys: ["\x1b[D"] },
      { title: "个人偏好", keys: ["\x1b[D"] },
    ],
  });
  const running = flow.pref("");
  await waitFor(() => flow.renderedViews.flat().some((line) => line.includes("evidence 1")), "older evidence detail");
  const document = learning(root);
  document.feedback = document.feedback.filter((item: Json) => item.id !== older.id);
  document.evidence = document.evidence.filter((item: Json) => item.feedback_id !== older.id);
  writeFileSync(join(root, "local/learning.json"), `${JSON.stringify(document)}\n`);
  flow.sendLastCustom("\x1b[D");
  await running;
  const listViews = flow.renderedViews.filter((view) => view.some((line) => line.trim() === "反馈与证据") && view.some((line) => line.includes("→ ")));
  assert.ok(listViews.at(-1)!.some((line) => line.includes("NEW-REMAINING")));
  assert.equal(learning(root).feedback.length, 1);
  assert.equal(learning(root).evidence.length, 1);
});

test("N02 resource cancellation returns to its menu without writing", async (t) => {
  const root = temporaryRoot(t);
  ok(root, ["init"]);
  const before = readFileSync(join(root, "repo/groups.json"), "utf8");
  const flow = harness(t, {
    root,
    menuInputs: [
      { title: "个人偏好", keys: [...Array(7).fill("\x1b[B"), "\x1b[C"] },
      { title: "管理偏好组", keys: ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[C"] },
      { title: "管理偏好组", keys: ["\x1b[D"] },
      { title: "个人偏好", keys: ["\x1b[D"] },
    ],
    selectReply: () => undefined,
  });
  await flow.pref("");
  assert.equal(readFileSync(join(root, "repo/groups.json"), "utf8"), before);
});

test("N03 feedback selection Left returns to the remembered main item without saving", async (t) => {
  const flow = harness(t, {
    pickerInputs: [["\x1b[D"]],
    inputReplies: ["cancel before save"],
    menuInputs: [
      { title: "个人偏好", keys: ["\x1b[B", "\x1b[C"] },
      { title: "个人偏好", keys: ["\x1b[D"] },
    ],
    selectReply: (title) => title === "评价助手结果" ? "good" : undefined,
  });
  await flow.pref("");
  assert.equal(flow.modelCalls, 0);
  assert.equal(learning(flow.root).feedback.length, 0);
  assert.ok(flow.renderedViews.some((view) => view.some((line) => line.includes("→ 记录反馈"))));
});

test("N03 Left cancels details and Right never applies confirmation actions", async (t) => {
  const proposalRoot = temporaryRoot(t);
  ok(proposalRoot, ["init"]);
  for (let index = 1; index <= 3; index += 1) addCliEvidence(proposalRoot, index);
  const prepared = ok(proposalRoot, ["prepare-evolution", "--stdin"], { group: "global" });
  ok(proposalRoot, ["save-evolution", "--stdin"], {
    group_id: prepared.group.id, base_digest: prepared.base_digest, evidence_digest: prepared.evidence_digest,
    evidence_ids: prepared.evidence.map((item: Json) => item.id), proposed_rules: ["not-applied"], rationale: "right ignored",
  });
  const proposalFlow = harness(t, {
    root: proposalRoot,
    detailInputs: [["\x1b[C", "\x1b[D"]],
    menuInputs: [
      { title: "个人偏好", keys: [...Array(4).fill("\x1b[B"), "\x1b[C"] },
      { title: "处理待办", keys: ["\x1b[C"] },
      { title: "个人偏好", keys: ["\x1b[D"] },
    ],
  });
  await proposalFlow.pref("");
  assert.equal(learning(proposalRoot).proposals.at(-1).status, "pending");
  assert.equal(groups(proposalRoot).groups[0].rules.length, 0);

  const reprocessRoot = temporaryRoot(t);
  ok(reprocessRoot, ["init"]);
  addCliEvidence(reprocessRoot, 1);
  const before = readFileSync(join(reprocessRoot, "local/learning.json"), "utf8");
  const reprocessFlow = harness(t, {
    root: reprocessRoot,
    detailInputs: [["\x1b[C", "\x1b[D"]],
    menuInputs: [
      { title: "个人偏好", keys: ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[C"] },
      { title: "重新整理反馈", keys: ["\x1b[C"] },
    ],
    modelReply: () => extraction("quote-1", { summary: "right must not apply" }),
  });
  await reprocessFlow.pref("");
  assert.equal(readFileSync(join(reprocessRoot, "local/learning.json"), "utf8"), before);
  assert.equal(reprocessFlow.modelCalls, 1);
});

test("H03 MenuSession Enter selects while Esc and Ctrl+C preserve position without actions", async () => {
  let component: any;
  const session = new MenuSession({
    mode: "tui",
    ui: {
      custom(factory: Function) {
        return new Promise((resolvePromise) => {
          component = factory({ requestRender() {}, terminal: { rows: 10, columns: 60 } }, themeForTest(), {}, resolvePromise);
        });
      },
    },
  } as any);
  const items = [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
    { value: "third", label: "Third" },
  ];
  const actions: string[] = [];

  const enteredPromise = session.select("keys", "Key Menu", items);
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  const entered = await enteredPromise;
  if (entered) actions.push(entered);
  assert.equal(entered, "second");

  const escapedPromise = session.select("keys", "Key Menu", items);
  assert.ok(component.render(60).some((line: string) => line.includes("→ Second")));
  component.handleInput("\x1b");
  const escaped = await escapedPromise;
  if (escaped) actions.push(escaped);
  assert.equal(escaped, undefined);

  const ctrlCPromise = session.select("keys", "Key Menu", items);
  assert.ok(component.render(60).some((line: string) => line.includes("→ Second")));
  component.handleInput("\x03");
  const ctrlC = await ctrlCPromise;
  if (ctrlC) actions.push(ctrlC);
  assert.equal(ctrlC, undefined);
  assert.deepEqual(actions, ["second"]);
});

test("N04 short menus keep the selected row visible and RPC uses native select", async () => {
  let component: any;
  const tuiResult = new MenuSession({
    mode: "tui",
    ui: {
      custom(factory: Function) {
        return new Promise((resolvePromise) => {
          component = factory({ requestRender() {}, terminal: { rows: 7, columns: 28 } }, themeForTest(), {}, resolvePromise);
        });
      },
    },
  } as any).select("short", "Short Menu", Array.from({ length: 20 }, (_, index) => ({ value: `item-${index}`, label: `Long item ${index} with text` })));
  for (let index = 0; index < 15; index += 1) component.handleInput("\x1b[B");
  const lines = component.render(28);
  assert.ok(lines.some((line: string) => line.includes("→ ")));
  assert.ok(lines.length <= 7);
  assert.ok(lines.every((line: string) => visibleWidth(line) <= 28));
  component.handleInput("\x1b[C");
  assert.equal(await tuiResult, "item-15");

  let nativeCalls = 0;
  const rpc = await new MenuSession({
    mode: "rpc",
    ui: { async select(_title: string, choices: string[]) { nativeCalls += 1; return choices[1]; } },
  } as any).select("rpc", "RPC Menu", [{ value: "one", label: "One" }, { value: "two", label: "Two" }]);
  assert.equal(rpc, "two");
  assert.equal(nativeCalls, 1);
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
