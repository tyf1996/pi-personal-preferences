import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import preferenceExtension from "../index.ts";
import { parsePrefCommand } from "../src/commands.ts";
import { formatPreferenceSummary } from "../src/dashboard.ts";
import { renderPreferenceFooter } from "../src/footer.ts";
import { resolvePreferenceGroup } from "../src/group.ts";

const CLI = resolve(import.meta.dirname, "../python/wikiskill_preference.py");

type Handler = (event: any, ctx: any) => unknown;

type Command = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
};

interface HarnessOptions {
  selects?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  editors?: Array<string | undefined>;
  confirms?: boolean[];
  hasUI?: boolean;
  piModelResponses?: string[];
  configuredAuth?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

function createHarness(cwd: string, options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const notices: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const uiCalls: Array<{ method: string; title: string; options?: string[] }> = [];
  const themeColors: string[] = [];
  const extensionStatuses = new Map<string, string>();
  let footerFactory: any;
  const selects = [...(options.selects ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const editors = [...(options.editors ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const piModelResponses = [...(options.piModelResponses ?? [])];
  const modelCalls: Array<{
    prompt: string;
    reasoning?: string;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }> = [];
  const model = options.piModelResponses ? {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } : undefined;
  let reloads = 0;
  const theme = {
    fg: (color: string, value: string) => {
      themeColors.push(color);
      return value;
    },
  };
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  preferenceExtension(pi);
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "session-test",
      getEntries: () => [],
      getSessionName: () => undefined,
    },
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRegistry: {
      hasConfiguredAuth: () => Boolean(model) && (options.configuredAuth ?? true),
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: { "x-test-auth": "header" },
        env: { TEST_PROVIDER_ENV: "value" },
        baseUrl: "https://resolved.example.test/v1",
      }),
      getProvider: () => model ? {
        streamSimple: (selectedModel: any, context: any, requestOptions: any) => {
          const prompt = context.messages[0]?.content[0]?.text ?? "";
          modelCalls.push({
            prompt,
            reasoning: requestOptions.reasoning,
            baseUrl: selectedModel.baseUrl,
            apiKey: requestOptions.apiKey,
            headers: requestOptions.headers,
            env: requestOptions.env,
          });
          return {
            result: async () => {
              const response = piModelResponses.shift();
              if (response === undefined) throw new Error("test Pi model response is missing");
              return {
                role: "assistant",
                content: [{ type: "text", text: response }],
                api: "openai-completions",
                provider: "test-provider",
                model: "test-model",
                usage: {
                  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              };
            },
          };
        },
      } : undefined,
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0.1 }),
    ui: {
      theme,
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => {
        statuses.push(value);
        if (value === undefined) extensionStatuses.delete(key);
        else extensionStatuses.set(key, value);
      },
      setFooter: (factory: unknown) => { footerFactory = factory; },
      select: async (title: string, values: string[]) => {
        uiCalls.push({ method: "select", title, options: [...values] });
        return selects.shift();
      },
      input: async (title: string, _placeholder?: string) => {
        uiCalls.push({ method: "input", title });
        return inputs.shift();
      },
      editor: async (title: string, _prefill?: string) => {
        uiCalls.push({ method: "editor", title });
        return editors.shift();
      },
      confirm: async (title: string, _message: string) => {
        uiCalls.push({ method: "confirm", title });
        return confirms.shift() ?? false;
      },
    },
    waitForIdle: async () => undefined,
    hasPendingMessages: () => false,
    reload: async () => {
      reloads += 1;
    },
  } as unknown as ExtensionCommandContext;
  return {
    commands, ctx, handlers, notices, statuses, uiCalls, modelCalls, themeColors,
    renderFooter(width = 100) {
      if (!footerFactory) return [] as string[];
      const footer = footerFactory(
        { requestRender() {} },
        theme,
        {
          getGitBranch: () => "main",
          getExtensionStatuses: () => extensionStatuses,
          onBranchChange: () => () => undefined,
        },
      );
      return footer.render(width) as string[];
    },
    get reloads() { return reloads; },
  };
}

function init(root: string): void {
  execFileSync("python3", [CLI, "init", "--data-root", root], { encoding: "utf8" });
}

async function configureFake(root: string): Promise<void> {
  const path = join(root, "config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  config.provider = {
    name: "fake",
    model: "fixture",
    api_key_env: "PREFERENCE_MODEL_API_KEY",
    thinking_level: "medium",
  };
  await writeFile(path, JSON.stringify(config), "utf8");
}

test("formats a readable right-aligned footer status", () => {
  const summary = formatPreferenceSummary({
    enabled: true,
    groups: 12,
    rules: 34,
    pending_evidence_count: 2,
    evolve_due: true,
    model_ready: true,
    sync_state: "no-remote",
  }, ["communication-preferences", "coding", "documentation"]);
  assert.equal(summary, "偏好：communicati… +2 · 12组/34规则 · 2条待处理! · 本地");
  const lines = renderPreferenceFooter({
    cwd: "/workspace/project",
    branch: "feature",
    preferenceStatus: summary,
    contextPercent: 12.5,
    contextWindow: 128_000,
    model: "gpt-5.6-sol",
    thinkingLevel: "xhigh",
  }, 120);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^\/workspace\/project \(feature\)/u);
  assert.ok(lines[0]?.endsWith(summary));
  assert.match(lines[1] ?? "", /^12\.5%\/128k/u);
  assert.ok(lines[1]?.endsWith("gpt-5.6-sol • xhigh"));
});

test("parses only the documented group command shapes", () => {
  assert.deepEqual(parsePrefCommand("remember --group coding Prefer focused changes"), {
    action: "remember", group: "coding", rule: "Prefer focused changes",
  });
  assert.deepEqual(parsePrefCommand("feedback good explain why the result is useful"), {
    action: "feedback", sentiment: "good", reason: "explain why the result is useful",
  });
  assert.deepEqual(parsePrefCommand("feedback --group communication fix too verbose"), {
    action: "feedback", group: "communication", sentiment: "fix", reason: "too verbose",
  });
  assert.deepEqual(parsePrefCommand(""), { action: "dashboard" });
  assert.deepEqual(parsePrefCommand("remember --group unknown rule"), {
    action: "remember", group: "unknown", rule: "rule",
  });
  assert.throws(() => parsePrefCommand("remember --group coding --group global rule"));
  assert.throws(() => parsePrefCommand("remember --domain coding rule"), /unknown remember flag/u);
  assert.throws(() => parsePrefCommand("remember --global rule"), /unknown remember flag/u);
  assert.throws(() => parsePrefCommand("feedback fix"));
});

test("explicit groups bypass classification and model failures ask for an existing group", async () => {
  let calls = 0;
  const groups = [
    { name: "global", description: "通用偏好。" },
    { name: "communication", description: "回复方式。" },
  ];
  const explicit = await resolvePreferenceGroup({
    explicitGroup: "communication",
    preferenceText: "回答太长",
    groups,
    ctx: { hasUI: true, ui: { select: async () => undefined } } as any,
    invokeCli: async () => {
      calls += 1;
      return { group: "global" };
    },
  });
  assert.equal(explicit, "communication");
  assert.equal(calls, 0);
  const selected = await resolvePreferenceGroup({
    preferenceText: "回答太长",
    groups,
    ctx: {
      hasUI: true,
      ui: { select: async (_title: string, options: string[]) => options[1] },
    } as any,
    invokeCli: async () => {
      calls += 1;
      return { group: "missing" };
    },
  });
  assert.equal(selected, "communication");
  assert.equal(calls, 1);
  await assert.rejects(() => resolvePreferenceGroup({
    preferenceText: "回答太长",
    groups,
    ctx: { hasUI: false, ui: {} } as any,
    invokeCli: async () => { throw new Error("provider unavailable"); },
  }), /--group/u);
});

test("loads only effective group prompts without resource discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-extension-"));
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    for (const payload of [
      { action: "create", name: "coding", description: "适用于代码实现。" },
      { action: "add_rule", group: "coding", rule: "优先复用现有设计。" },
      { action: "create", name: "documentation", description: "不应自动加载。" },
    ]) {
      execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
    }
    execFileSync("python3", [CLI, "set-activation", "--stdin", "--data-root", root], {
      input: JSON.stringify({ target: "directory", key: resolve(root), group: "coding", enabled: true }),
      encoding: "utf8",
    });
    const harness = createHarness(root);
    const start = harness.handlers.get("before_agent_start");
    const result = await start?.({ systemPrompt: "Base prompt", systemPromptOptions: {} }, harness.ctx);
    const systemPrompt = String((result as any)?.systemPrompt);
    assert.match(systemPrompt, /Personal Preference Group: global/u);
    assert.match(systemPrompt, /Personal Preference Group: coding/u);
    assert.match(systemPrompt, /适用于代码实现。/u);
    assert.match(systemPrompt, /优先复用现有设计。/u);
    assert.doesNotMatch(systemPrompt, /不应自动加载。/u);
    const resources = harness.handlers.get("resources_discover")?.({}, harness.ctx) as any;
    assert.deepEqual(resources, {});
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("remember writes the explicit group without reload and group completion is dynamic", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-extension-"));
  const previous = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "create", name: "coding", description: "代码任务。" }),
      encoding: "utf8",
    });
    const harness = createHarness(root);
    await harness.commands.get("pref")?.handler("remember --group coding Prefer focused changes", harness.ctx);
    assert.equal(harness.reloads, 0);
    const groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups.find((group: any) => group.name === "coding").rules, ["Prefer focused changes"]);
    const completion = await harness.commands.get("pref")?.getArgumentCompletions?.("remember --group co") as any;
    assert.deepEqual(completion, [{ value: "coding", label: "coding" }]);
    assert.match(harness.notices.at(-1)?.message ?? "", /已记住到 coding/u);
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "delete_rule", group: "coding", rule: "Prefer focused changes" }),
      encoding: "utf8",
    });
    const restoredHarness = createHarness(root);
    await restoredHarness.commands.get("pref")?.handler("remember --group coding Prefer focused changes", restoredHarness.ctx);
    assert.match(restoredHarness.notices.at(-1)?.message ?? "", /已恢复到 coding/u);
    const restoredGroups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(restoredGroups.groups.find((group: any) => group.name === "coding").rules, ["Prefer focused changes"]);
  } finally {
    if (previous === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("default Pi model classifies preferences and inherits or overrides thinking level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-pi-model-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
      input: JSON.stringify({ action: "create", name: "communication", description: "回复表达。" }),
      encoding: "utf8",
    });
    const configPath = join(root, "config.json");
    const legacyConfig = JSON.parse(await readFile(configPath, "utf8"));
    legacyConfig.provider = {
      name: "openai_compatible",
      model: "configured-model",
      api_key_env: "PREFERENCE_MODEL_API_KEY",
    };
    await writeFile(configPath, JSON.stringify(legacyConfig), "utf8");
    const inherited = createHarness(root, {
      piModelResponses: ['{"group":"communication"}'],
      configuredAuth: false,
      thinkingLevel: "high",
    });
    await inherited.handlers.get("session_start")?.({}, inherited.ctx);
    assert.equal(inherited.statuses.at(-1), "偏好：global · 2组/0规则 · 本地");
    assert.ok(inherited.renderFooter(200)[0]?.endsWith("偏好：global · 2组/0规则 · 本地"));
    assert.equal(inherited.themeColors.at(-1), "dim");
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")).provider,
      { name: "pi", thinking_level: "inherit", timeout_seconds: 300 },
    );
    await inherited.commands.get("pref")?.handler("remember 回答保持简洁", inherited.ctx);
    assert.equal(inherited.modelCalls.length, 1);
    assert.equal(inherited.modelCalls[0]?.reasoning, "high");
    assert.equal(inherited.modelCalls[0]?.baseUrl, "https://resolved.example.test/v1");
    assert.equal(inherited.modelCalls[0]?.apiKey, "test-key");
    assert.deepEqual(inherited.modelCalls[0]?.headers, { "x-test-auth": "header" });
    assert.deepEqual(inherited.modelCalls[0]?.env, { TEST_PROVIDER_ENV: "value" });
    assert.match(inherited.modelCalls[0]?.prompt ?? "", /personal preference into one existing preference group/u);
    let groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups.find((group: any) => group.name === "communication").rules, ["回答保持简洁"]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.provider.thinking_level = "low";
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const overridden = createHarness(root, {
      piModelResponses: ['{"group":"global"}'],
      thinkingLevel: "xhigh",
    });
    await overridden.commands.get("pref")?.handler("remember 默认使用中文", overridden.ctx);
    assert.equal(overridden.modelCalls[0]?.reasoning, "low");
    groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups.find((group: any) => group.name === "global").rules, ["默认使用中文"]);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("first /pref initializes local data and opens a model-aware dashboard", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-first-run-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousCli = process.env.WIKISKILL_PREFERENCE_CLI;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  delete process.env.WIKISKILL_PREFERENCE_CLI;
  try {
    const harness = createHarness(root);
    await harness.commands.get("pref")?.handler("", harness.ctx);
    const groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups.map((group: any) => group.name), ["global"]);
    assert.equal((await readFile(join(root, "local/activations.json"), "utf8")).includes("directories"), true);
    assert.match(harness.notices[0]?.message ?? "", /已初始化/u);
    assert.match(harness.notices[1]?.message ?? "", /模型：pi pi\/current · 未就绪/u);
    assert.match(harness.notices[1]?.message ?? "", /同步：no-remote/u);
    assert.equal(harness.statuses.at(-1), "偏好：global · 1组/0规则 · 模型未就绪 · 本地");
    assert.equal(harness.uiCalls[0]?.title, "个人偏好");
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousCli === undefined) delete process.env.WIKISKILL_PREFERENCE_CLI;
    else process.env.WIKISKILL_PREFERENCE_CLI = previousCli;
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled configuration prevents prompt injection, capture, remember, and evolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-disabled-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousResponse = process.env.PREFERENCE_MODEL_RESPONSE;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    await configureFake(root);
    const captured = JSON.parse(execFileSync("python3", [CLI, "capture", "--stdin", "--data-root", root], {
      input: JSON.stringify({
        group: "global", signal: "rejection", summary: "回答太长。", task_id: "task-disabled", paths: [],
      }),
      encoding: "utf8",
    })) as { event_id: string };
    const configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config.enabled = false;
    config.auto_evolve = true;
    config.auto_evolve_after = 1;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    process.env.PREFERENCE_MODEL_RESPONSE = JSON.stringify({ changes: [{
      action: "add", group: "global", rule: "回答保持简洁。", evidence_ids: [captured.event_id],
    }] });
    const harness = createHarness(root);
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    const prompt = await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "Base prompt", systemPromptOptions: {} }, harness.ctx,
    );
    assert.equal(prompt, undefined);
    await harness.handlers.get("input")?.({ source: "interactive", text: "implement" }, harness.ctx);
    await harness.handlers.get("agent_settled")?.({}, harness.ctx);
    const groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups[0].rules, []);
    await harness.commands.get("pref")?.handler("remember --group global 不要注入", harness.ctx);
    assert.equal(harness.notices.filter((notice) => notice.level === "error").length, 1);
    assert.match(harness.notices.at(-1)?.message ?? "", /已停用/u);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousResponse === undefined) delete process.env.PREFERENCE_MODEL_RESPONSE;
    else process.env.PREFERENCE_MODEL_RESPONSE = previousResponse;
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard covers group, rule, activation, feedback, sync, rollback, and headless paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-dashboard-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const runDashboard = async (options: HarnessOptions) => {
      const harness = createHarness(root, options);
      await harness.commands.get("pref")?.handler("", harness.ctx);
      return harness;
    };

    const createCoding = await runDashboard({
      selects: ["创建偏好组"],
      inputs: ["coding", "适用于代码实现。"],
    });
    assert.match(createCoding.notices.at(-1)?.message ?? "", /coding/u);
    await runDashboard({
      selects: ["创建偏好组"],
      inputs: ["communication", "适用于回复表达。"],
    });
    const viewed = await runDashboard({ selects: ["查看偏好组", "coding"] });
    assert.match(viewed.notices.at(-1)?.message ?? "", /适用于代码实现/u);
    const menu = viewed.uiCalls[0]?.options?.join(" ") ?? "";
    assert.doesNotMatch(menu, /candidate|inactive|unclassified|domain|scope|project/iu);

    await runDashboard({ selects: ["编辑组介绍", "coding"], editors: ["适用于代码、测试和审查。"] });
    await runDashboard({
      selects: ["管理组内规则", "coding", "增加规则"],
      inputs: ["优先复用现有设计。"],
    });
    await runDashboard({
      selects: ["管理组内规则", "coding", "修改规则", "优先复用现有设计。"],
      editors: ["优先复用仓库已有设计。"],
    });
    await runDashboard({
      selects: [
        "管理组内规则", "coding", "移动到其他组", "优先复用仓库已有设计。", "communication",
      ],
    });
    const viewedRules = await runDashboard({
      selects: ["管理组内规则", "communication", "查看规则"],
    });
    assert.match(viewedRules.notices.at(-1)?.message ?? "", /优先复用仓库已有设计/u);
    await runDashboard({
      selects: ["管理组内规则", "communication", "增加规则"],
      inputs: ["回答保持简洁。"],
    });
    await runDashboard({
      selects: ["管理组内规则", "communication", "删除规则", "回答保持简洁。"],
    });

    await runDashboard({ selects: ["为当前目录启用组", "coding"] });
    let context = JSON.parse(execFileSync("python3", [CLI, "context", "--stdin", "--data-root", root], {
      input: JSON.stringify({ directory: resolve(root), session_id: "session-placeholder" }),
      encoding: "utf8",
    }));
    assert.deepEqual(context.directory_groups, ["coding"]);
    await runDashboard({ selects: ["为当前目录禁用组", "coding"] });
    await runDashboard({ selects: ["为当前会话启用组", "communication"] });
    const sessionHarness = createHarness(root);
    const sessionHashContext = await sessionHarness.handlers.get("before_agent_start")?.(
      { systemPrompt: "Base prompt", systemPromptOptions: {} }, sessionHarness.ctx,
    );
    assert.match(String((sessionHashContext as any)?.systemPrompt), /communication/u);
    await runDashboard({ selects: ["为当前会话禁用组", "communication"] });

    const good = createHarness(root);
    await good.commands.get("pref")?.handler("feedback --group communication good", good.ctx);
    assert.match(good.notices.at(-1)?.message ?? "", /满意/u);
    const menuGood = await runDashboard({ selects: ["记录反馈", "满意", "communication"] });
    assert.match(menuGood.notices.at(-1)?.message ?? "", /满意/u);
    const menuFix = await runDashboard({
      selects: ["记录反馈", "需要改进", "communication"],
      inputs: ["回答太长。"],
    });
    assert.match(menuFix.notices.at(-1)?.message ?? "", /需要改进/u);
    const beforeCancel = await readFile(join(root, "local/inbox.jsonl"), "utf8");
    await runDashboard({ selects: ["记录反馈", "返回上一级"] });
    assert.equal(await readFile(join(root, "local/inbox.jsonl"), "utf8"), beforeCancel);

    const synced = await runDashboard({ selects: ["同步偏好仓库"] });
    assert.match(synced.notices.at(-1)?.message ?? "", /同步完成/u);
    await runDashboard({
      selects: ["管理组内规则", "communication", "增加规则"],
      inputs: ["回滚测试规则。"],
    });
    await runDashboard({ selects: ["撤销最近一次变化"], confirms: [true] });
    let groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.doesNotMatch(JSON.stringify(groups), /回滚测试规则/u);

    await runDashboard({ selects: ["删除偏好组", "coding"] });
    await runDashboard({ selects: ["删除偏好组", "global"] });
    groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups.map((group: any) => group.name), ["communication"]);
    const afterDelete = createHarness(root);
    const promptAfterDelete = await afterDelete.handlers.get("before_agent_start")?.(
      { systemPrompt: "Base prompt", systemPromptOptions: {} }, afterDelete.ctx,
    );
    assert.equal(promptAfterDelete, undefined);

    const headless = createHarness(root, { hasUI: false });
    await headless.commands.get("pref")?.handler("", headless.ctx);
    assert.match(headless.notices.at(-1)?.message ?? "", /^偏好：/u);
    assert.equal(headless.uiCalls.length, 0);
    const invalid = createHarness(root);
    await invalid.commands.get("pref")?.handler("remember --group missing rule", invalid.ctx);
    assert.equal(invalid.notices.length, 1);
    assert.equal(invalid.notices[0]?.level, "error");
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard cancellation returns one menu level at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-navigation-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    for (const payload of [
      { action: "create", name: "coding", description: "代码。" },
      { action: "create", name: "communication", description: "表达。" },
      { action: "add_rule", group: "coding", rule: "保持改动聚焦。" },
    ]) {
      execFileSync("python3", [CLI, "manage-group", "--stdin", "--data-root", root], {
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
    }
    const harness = createHarness(root, {
      selects: [
        "管理组内规则",
        "coding",
        "移动到其他组",
        "保持改动聚焦。",
        undefined,
        undefined,
        undefined,
        undefined,
        "查看偏好组",
        undefined,
        undefined,
      ],
    });
    await harness.commands.get("pref")?.handler("", harness.ctx);
    assert.deepEqual(
      harness.uiCalls.filter((call) => call.method === "select").map((call) => call.title),
      [
        "个人偏好",
        "选择要管理的组",
        "管理组内规则",
        "选择规则",
        "移动到其他组",
        "选择规则",
        "管理组内规则",
        "选择要管理的组",
        "个人偏好",
        "查看偏好组",
        "个人偏好",
      ],
    );
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("auto evolves pending evidence without file collection or a current task", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-extension-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousResponse = process.env.PREFERENCE_MODEL_RESPONSE;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    await configureFake(root);
    const captured = JSON.parse(execFileSync("python3", [CLI, "capture", "--stdin", "--data-root", root], {
      input: JSON.stringify({
        group: "global", signal: "user_edit", summary: "回答保持简洁。", task_id: "task-a", paths: [],
      }),
      encoding: "utf8",
    })) as { event_id: string };
    const configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config.auto_evolve = true;
    config.auto_evolve_after = 1;
    config.capture_user_edits = false;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    process.env.PREFERENCE_MODEL_RESPONSE = JSON.stringify({ changes: [{
      action: "add", group: "global", rule: "回答保持简洁。", evidence_ids: [captured.event_id],
    }] });
    const harness = createHarness(root);
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    assert.equal(harness.statuses.at(-1), "偏好：global · 1组/0规则 · 1条待处理! · 本地");
    assert.ok(harness.renderFooter(200)[0]?.endsWith("偏好：global · 1组/0规则 · 1条待处理! · 本地"));
    assert.equal(harness.themeColors.at(-1), "dim");
    await harness.handlers.get("agent_settled")?.({}, harness.ctx);
    const groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups[0].rules, ["回答保持简洁。"]);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousResponse === undefined) delete process.env.PREFERENCE_MODEL_RESPONSE;
    else process.env.PREFERENCE_MODEL_RESPONSE = previousResponse;
    await rm(root, { recursive: true, force: true });
  }
});

test("default Pi model evolves pending evidence through the bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-pi-evolve-"));
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  process.env.PI_PREFERENCE_DATA_ROOT = root;
  try {
    init(root);
    const captured = JSON.parse(execFileSync("python3", [CLI, "capture", "--stdin", "--data-root", root], {
      input: JSON.stringify({
        group: "global", signal: "rejection", summary: "回答太长。", task_id: "task-pi", paths: [],
      }),
      encoding: "utf8",
    })) as { event_id: string };
    const configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.auto_evolve = true;
    config.auto_evolve_after = 1;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const harness = createHarness(root, {
      piModelResponses: [JSON.stringify({ changes: [{
        action: "add", group: "global", rule: "回答保持简洁。", evidence_ids: [captured.event_id],
      }] })],
      thinkingLevel: "medium",
    });
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    await harness.handlers.get("agent_settled")?.({}, harness.ctx);
    assert.equal(harness.modelCalls.length, 1);
    assert.equal(harness.modelCalls[0]?.reasoning, "medium");
    assert.match(harness.modelCalls[0]?.prompt ?? "", /update rules inside existing personal preference groups/u);
    const groups = JSON.parse(await readFile(join(root, "repo/groups.json"), "utf8"));
    assert.deepEqual(groups.groups[0].rules, ["回答保持简洁。"]);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("records only successful touched-file edits and stores a classified group event", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-personal-preferences-extension-"));
  const workspace = join(root, "workspace");
  const dataRoot = join(root, "data");
  const file = join(workspace, "example.py");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(file, "before\n", "utf8");
  const previousRoot = process.env.PI_PREFERENCE_DATA_ROOT;
  const previousFixture = process.env.PREFERENCE_MODEL_GROUP_RESPONSE;
  process.env.PI_PREFERENCE_DATA_ROOT = dataRoot;
  process.env.PREFERENCE_MODEL_GROUP_RESPONSE = '{"group":"global"}';
  try {
    init(dataRoot);
    await configureFake(dataRoot);
    const harness = createHarness(workspace);
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    await harness.handlers.get("input")?.({ source: "interactive", text: "implement this" }, harness.ctx);
    await harness.handlers.get("tool_call")?.({ toolName: "write", toolCallId: "write-1", input: { path: "example.py" } }, harness.ctx);
    await writeFile(file, "agent\n", "utf8");
    await harness.handlers.get("tool_execution_end")?.({ toolName: "write", toolCallId: "write-1", isError: false }, harness.ctx);
    await harness.handlers.get("agent_settled")?.({}, harness.ctx);
    await assert.rejects(readFile(join(dataRoot, "local/task-snapshots.json"), "utf8"));
    await writeFile(file, "user\n", "utf8");
    await harness.handlers.get("input")?.({ source: "interactive", text: "next task" }, harness.ctx);
    const inbox = await readFile(join(dataRoot, "local/inbox.jsonl"), "utf8");
    assert.match(inbox, /"group":"global"/u);
    assert.match(inbox, /user_edit/u);
    assert.match(inbox, /最小 diff/u);
    await assert.rejects(readFile(join(dataRoot, "local/unclassified.json"), "utf8"));
  } finally {
    if (previousRoot === undefined) delete process.env.PI_PREFERENCE_DATA_ROOT;
    else process.env.PI_PREFERENCE_DATA_ROOT = previousRoot;
    if (previousFixture === undefined) delete process.env.PREFERENCE_MODEL_GROUP_RESPONSE;
    else process.env.PREFERENCE_MODEL_GROUP_RESPONSE = previousFixture;
    await rm(root, { recursive: true, force: true });
  }
});
