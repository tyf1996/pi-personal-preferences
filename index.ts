import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runPreferenceCli, runPreferenceCliWithModel } from "./src/cli-client.ts";
import {
  parsePrefCommand,
  preferenceCommandNames,
  type PrefCommand,
} from "./src/commands.ts";
import {
  resolvePreferenceGroup,
  type PreferenceCliInvoker,
  type PreferenceGroupDescription,
} from "./src/group.ts";
import {
  formatPreferenceSummary,
  showPreferenceDashboard,
  type PreferenceGroup,
  type PreferenceStatus,
} from "./src/dashboard.ts";
import { installPreferenceFooter } from "./src/footer.ts";
import {
  completeWithPiModel,
  piModelEnvironment,
  THINKING_LEVELS,
  type ConfiguredPiThinkingLevel,
} from "./src/pi-model.ts";
import { FeedbackContext } from "./src/feedback-context.ts";
import { FeedbackBackground, type InvokeV2, type V2Envelope } from "./src/background.ts";
import { ProposalBackground } from "./src/proposal-background.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const CLI_NAME = "wikiskill_preference.py";
const DENIED_NAMES = new Set([".env", ".env.local", ".env.production", "credentials.json", "secrets.json"]);

interface ProviderLayout {
  mode: "pi" | "custom" | "fake";
  name: "pi" | "openai_compatible" | "fake";
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  thinkingLevel: ConfiguredPiThinkingLevel;
  timeoutMs: number;
  maxTokens: number;
}

interface StageLayout {
  enabled: boolean;
  provider: ProviderLayout;
}

interface RepoLayout {
  schemaVersion: 2;
  configVersion: number;
  enabled: boolean;
  captureUserEdits: boolean;
  storeRawDiffs: boolean;
  gitAutoPush: boolean;
  provider: ProviderLayout;
  extraction: StageLayout;
  proposals: StageLayout;
  proposalTrigger: "manual" | "new_evidence";
  maxAttempts: number;
  maxRequestsPerDay: number;
  privacyContextMode: "ask" | "local_only";
  snapshotRetentionDays: number;
}

type FeedbackModelSelection = {
  provider_source: "pi" | "custom" | "fake";
  provider_id: string;
  model_id: string;
  api_type: "pi" | "openai_compatible" | "fake";
  endpoint_fingerprint: string;
  thinking_level: Exclude<ConfiguredPiThinkingLevel, "inherit">;
  max_tokens: number;
  timeout_seconds: number;
  config_version: number;
};

interface TouchedFile {
  agentHash: string;
  agentText?: string;
}

interface TaskState {
  taskId: string;
  taskSummary: string;
  touched: Map<string, TouchedFile>;
  settled: boolean;
}

function preferenceDataRoot(): string {
  const override = process.env.PI_PREFERENCE_DATA_ROOT;
  if (override) return resolve(override);
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : resolve(homedir(), ".pi", "agent");
  return join(agentDir, "personal-preferences");
}

function cliPath(): string {
  const override = process.env.WIKISKILL_PREFERENCE_CLI;
  if (override) return resolve(override);
  return resolve(baseDir, "python", CLI_NAME);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredThinking(ctx: ExtensionContext, provider: ProviderLayout): FeedbackModelSelection["thinking_level"] {
  if (provider.thinkingLevel !== "inherit") return provider.thinkingLevel;
  const inherited = ctx.model?.reasoning ? ctx.thinkingLevel : "off";
  return THINKING_LEVELS.includes(inherited as FeedbackModelSelection["thinking_level"])
    ? inherited as FeedbackModelSelection["thinking_level"]
    : "off";
}

async function currentModelSelection(ctx: ExtensionContext, layout: RepoLayout, stage: "extraction" | "proposals"): Promise<FeedbackModelSelection | undefined> {
  const provider = layout[stage].provider;
  const common = {
    thinking_level: configuredThinking(ctx, provider),
    max_tokens: provider.maxTokens,
    timeout_seconds: provider.timeoutMs / 1000,
    config_version: layout.configVersion,
  };
  if (provider.mode === "pi") {
    const model = ctx.model;
    if (!model) return undefined;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return undefined;
      const baseUrl = auth.baseUrl ?? model.baseUrl ?? "";
      return {
        provider_source: "pi", provider_id: model.provider, model_id: model.id, api_type: "pi",
        endpoint_fingerprint: `sha256:${hashText(baseUrl)}`, ...common,
      };
    } catch {
      return undefined;
    }
  }
  if (!provider.model) return undefined;
  if (provider.mode === "fake") {
    return {
      provider_source: "fake", provider_id: "fake", model_id: provider.model, api_type: "fake",
      endpoint_fingerprint: `sha256:${hashText("")}`, ...common,
    };
  }
  const baseUrl = provider.baseUrl ?? process.env.OPENAI_BASE_URL;
  if (!baseUrl || !provider.apiKeyEnv || !process.env[provider.apiKeyEnv]) return undefined;
  return {
    provider_source: "custom", provider_id: "openai_compatible", model_id: provider.model, api_type: "openai_compatible",
    endpoint_fingerprint: `sha256:${hashText(baseUrl)}`, ...common,
  };
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function configPresence(): "missing" | "ready" | "invalid" {
  const path = join(preferenceDataRoot(), "config.json");
  if (!existsSync(path)) return "missing";
  try {
    return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() ? "ready" : "invalid";
  } catch {
    return "invalid";
  }
}

function providerLayout(value: unknown): ProviderLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Python settings returned an invalid provider");
  const provider = value as Record<string, unknown>;
  const name = provider.name;
  const thinking = provider.thinking_level;
  const timeout = provider.timeout_seconds;
  const maxTokens = provider.max_tokens;
  if ((name !== "pi" && name !== "fake" && name !== "openai_compatible")
      || (thinking !== "inherit" && !THINKING_LEVELS.includes(thinking as any))
      || typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0
      || typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("Python settings returned an invalid normalized provider");
  }
  const model = typeof provider.model === "string" && provider.model ? provider.model : undefined;
  if (name !== "pi" && !model) throw new Error("Python settings returned a provider without a model");
  return {
    mode: name === "pi" ? "pi" : name === "fake" ? "fake" : "custom",
    name,
    model,
    apiKeyEnv: typeof provider.api_key_env === "string" ? provider.api_key_env : undefined,
    baseUrl: typeof provider.base_url === "string" ? provider.base_url : undefined,
    thinkingLevel: thinking as ConfiguredPiThinkingLevel,
    timeoutMs: timeout * 1000,
    maxTokens,
  };
}

function resolveStage(defaultProvider: ProviderLayout, value: unknown): StageLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Python settings returned an invalid learning stage");
  const stage = value as Record<string, unknown>;
  if (typeof stage.enabled !== "boolean") throw new Error("Python settings returned a learning stage without enabled");
  const provider = stage.provider === "inherit" ? { ...defaultProvider } : providerLayout(stage.provider);
  const thinking = stage.thinking_level;
  const timeout = stage.timeout_seconds;
  const maxTokens = stage.max_tokens;
  if (thinking !== "inherit") provider.thinkingLevel = thinking as ConfiguredPiThinkingLevel;
  if (timeout !== "inherit") provider.timeoutMs = Number(timeout) * 1000;
  if (maxTokens !== "inherit") provider.maxTokens = Number(maxTokens);
  return { enabled: stage.enabled, provider };
}

function layoutFromConfig(value: unknown, configVersion: number): RepoLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Python settings returned no normalized config");
  const config = value as Record<string, any>;
  if (config.schema_version !== 2 || typeof config.enabled !== "boolean" || typeof config.capture_user_edits !== "boolean") {
    throw new Error("Python settings returned an invalid normalized config");
  }
  const provider = providerLayout(config.provider);
  const learning = config.learning as Record<string, unknown>;
  const privacy = config.privacy as Record<string, unknown>;
  if (!learning || !privacy || (privacy.context_mode !== "ask" && privacy.context_mode !== "local_only")
      || (learning.proposal_trigger !== "manual" && learning.proposal_trigger !== "new_evidence")) {
    throw new Error("Python settings returned invalid learning or privacy settings");
  }
  return {
    schemaVersion: 2,
    configVersion,
    enabled: config.enabled,
    captureUserEdits: config.capture_user_edits,
    storeRawDiffs: Boolean(config.store_raw_diffs),
    gitAutoPush: Boolean(config.git_auto_push),
    provider,
    extraction: resolveStage(provider, learning.extraction),
    proposals: resolveStage(provider, learning.proposals),
    proposalTrigger: learning.proposal_trigger,
    maxAttempts: Number(learning.max_attempts),
    maxRequestsPerDay: Number(learning.max_requests_per_day),
    privacyContextMode: privacy.context_mode,
    snapshotRetentionDays: Number(privacy.snapshot_retention_days),
  };
}

async function loadLayout(): Promise<RepoLayout> {
  const requestId = `settings-read-${randomUUID().replaceAll("-", "")}`;
  const response = await runPreferenceCli(cliPath(), preferenceDataRoot(), ["settings", "--stdin"], {
    schema_version: 2, request_id: requestId, action: "get", expected_generation: null, payload: {},
  }) as unknown as V2Envelope;
  if (!response.ok || !response.data) throw new Error(`个人偏好配置无效：${response.error?.message ?? "settings get failed"}`);
  if (!response.cas) throw new Error("个人偏好设置缺少 CAS generation");
  return layoutFromConfig(response.data.config, response.cas.generation);
}

function safeRelativePath(cwd: string, input: unknown): { relativePath: string; absolutePath: string } | undefined {
  if (typeof input !== "string" || !input.trim() || input.includes("\x00")) return undefined;
  const absolutePath = resolve(cwd, input.replace(/^@/, ""));
  const root = resolve(cwd);
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath === ".." || relativePath.startsWith("/")) {
    return undefined;
  }
  const parts = relativePath.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..")
    || DENIED_NAMES.has(parts.at(-1) ?? "")
    || parts.includes(".git")
    || parts.includes(".ssh")
    || parts.some((part) => part.startsWith(".env"))
  ) return undefined;
  try {
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) return undefined;
    }
    return { relativePath, absolutePath };
  } catch {
    return undefined;
  }
}

const MAX_DIFF_FILE_BYTES = 256 * 1024;

function fileText(absolutePath: string): string | undefined {
  try {
    if (!existsSync(absolutePath)) return "";
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DIFF_FILE_BYTES) return undefined;
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

function fileHash(absolutePath: string): string {
  try {
    if (!existsSync(absolutePath)) return hashText("");
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return hashText("");
    return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  } catch {
    return hashText("");
  }
}

function minimalDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldSuffix = oldLines.length;
  let newSuffix = newLines.length;
  while (oldSuffix > prefix && newSuffix > prefix && oldLines[oldSuffix - 1] === newLines[newSuffix - 1]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }
  if (prefix === oldLines.length && prefix === newLines.length) return "";
  const contextStart = Math.max(0, prefix - 2);
  const contextEndOld = Math.min(oldLines.length, oldSuffix + 2);
  const contextEndNew = Math.min(newLines.length, newSuffix + 2);
  const body = [
    ...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldSuffix).map((line) => `-${line}`),
    ...newLines.slice(prefix, newSuffix).map((line) => `+${line}`),
    ...oldLines.slice(oldSuffix, contextEndOld).map((line) => ` ${line}`),
  ];
  const header = `@@ -${contextStart + 1},${contextEndOld - contextStart} +${contextStart + 1},${contextEndNew - contextStart} @@`;
  const diff = [header, ...body].join("\n");
  return Buffer.byteLength(diff, "utf8") <= 32 * 1024 ? diff : "";
}

function sessionId(ctx: ExtensionContext): string {
  return `session-${hashText(ctx.sessionManager.getSessionId()).slice(0, 24)}`;
}

function taskId(ctx: ExtensionContext, prompt: string, counter: number): string {
  return `task-${hashText(`${sessionId(ctx)}:${counter}:${prompt}`).slice(0, 24)}`;
}

function boundedTaskSummary(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim().slice(0, 1000);
}

const PI_MODEL_COMMANDS = new Set(["classify-group"]);

async function invoke(
  args: string[],
  input?: unknown,
  timeoutMs = 60_000,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const layout = ctx && PI_MODEL_COMMANDS.has(args[0] ?? "") ? await loadLayout() : undefined;
  if (layout?.provider.mode === "pi" && ctx) {
    return runPreferenceCliWithModel(
      cliPath(),
      preferenceDataRoot(),
      args,
      input,
      (prompt, signal) => completeWithPiModel(ctx, layout.provider.thinkingLevel, prompt, signal),
      layout.provider.timeoutMs,
      piModelEnvironment(ctx, layout.provider.thinkingLevel),
    );
  }
  return runPreferenceCli(cliPath(), preferenceDataRoot(), args, input, timeoutMs, {}, signal);
}

function parseGroups(value: Record<string, unknown>): PreferenceGroup[] {
  if (!Array.isArray(value.groups)) throw new Error("groups CLI returned no groups");
  return value.groups.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("groups CLI returned an invalid group");
    const group = item as Record<string, unknown>;
    if (
      typeof group.name !== "string"
      || typeof group.description !== "string"
      || !Array.isArray(group.rules)
      || group.rules.some((rule) => typeof rule !== "string" && (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof (rule as Record<string, unknown>).text !== "string"))
    ) throw new Error("groups CLI returned an invalid group");
    if (group.id !== undefined && typeof group.id !== "string") throw new Error("groups CLI returned an invalid group id");
    return { ...(typeof group.id === "string" ? { id: group.id } : {}), name: group.name, description: group.description, rules: group.rules.map((rule) => typeof rule === "string" ? rule : String((rule as Record<string, unknown>).text)) };
  });
}

async function readGroups(): Promise<PreferenceGroup[]> {
  return parseGroups(await invoke(["groups"]));
}

function renderGroupPrompt(groups: PreferenceGroup[], effectiveNames: string[]): string {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const name of effectiveNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const group = byName.get(name);
    if (!group) continue;
    lines.push(`## Personal Preference Group: ${group.name}`, "", group.description);
    if (group.rules.length) lines.push("", ...group.rules.map((rule) => `- ${rule}`));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function currentFileState(task: TaskState, cwd: string, paths?: string[]): {
  agentHashes: Record<string, string>;
  currentHashes: Record<string, string>;
  diffs: Record<string, string>;
  selected: string[];
} {
  const requested = paths?.length ? new Set(paths) : undefined;
  const selected: string[] = [];
  const agentHashes: Record<string, string> = {};
  const currentHashes: Record<string, string> = {};
  const diffs: Record<string, string> = {};
  for (const [path, item] of [...task.touched.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (requested && !requested.has(path)) continue;
    selected.push(path);
    agentHashes[path] = item.agentHash;
    const absolutePath = resolve(cwd, path);
    currentHashes[path] = fileHash(absolutePath);
    if (item.agentText !== undefined) {
      const currentText = fileText(absolutePath);
      if (currentText !== undefined) {
        const diff = minimalDiff(item.agentText, currentText);
        if (diff) diffs[path] = diff;
      }
    }
  }
  return { agentHashes, currentHashes, diffs, selected };
}

function groupDescriptions(groups: PreferenceGroup[]): PreferenceGroupDescription[] {
  return groups.map(({ name, description }) => ({ name, description }));
}

export function preferenceExtension(pi: ExtensionAPI): void {
  let collecting = false;
  const feedbackContext = new FeedbackContext();
  const proposalBackground = new ProposalBackground();
  const triggerProposalForEvidence = async (
    ctx: ExtensionContext,
    invokeV2: InvokeV2,
    revision: Record<string, unknown>,
  ): Promise<void> => {
    if (typeof revision.group_id !== "string" || typeof revision.evidence_id !== "string" || typeof revision.revision_id !== "string") return;
    const layout = await loadLayout();
    if (!layout.enabled || !layout.proposals.enabled || layout.proposalTrigger !== "new_evidence") return;
    const listed = await invokeV2("proposal-job", { action: "list", expected_generation: null, payload: {} });
    if (!listed.ok || !listed.cas) throw new Error(listed.error?.message ?? "无法读取候选队列状态");
    const result = await invokeV2("proposal", {
      action: "trigger",
      expected_generation: listed.cas.generation,
      payload: {
        group_id: revision.group_id,
        evidence_ref: { evidence_id: revision.evidence_id, revision_id: revision.revision_id },
      },
    });
    if (!result.ok) throw new Error(result.error?.message ?? "自动候选触发失败");
    if (result.data?.pending_authorization === true) {
      safeNotify(ctx, "已有有效新证据，候选待授权生成；当前零模型请求。", "info");
    } else if (result.data?.triggered === true && result.data.job) {
      proposalBackground.wake(ctx, invokeV2, layout.proposals.provider.thinkingLevel);
    }
  };
  const feedbackBackground = new FeedbackBackground({
    onEvidence: triggerProposalForEvidence,
  });
  let diagnostic = "preference data is not initialized";
  let taskCounter = 0;
  let task: TaskState | undefined;
  const pendingWrites = new Map<string, string>();

  const invokeFor = (ctx: ExtensionContext): PreferenceCliInvoker =>
    (args, input, timeoutMs) => invoke(args, input, timeoutMs, ctx);

  const invokeV2For = (ctx: ExtensionContext): InvokeV2 => async (name, request, signal, timeoutMs = 60_000) => {
    const response = await invoke([name, "--stdin"], { schema_version: 2, request_id: `background-${randomUUID().replaceAll("-", "")}`, ...request }, timeoutMs, ctx, signal);
    return response as unknown as V2Envelope;
  };

  async function updateStatus(ctx: ExtensionContext): Promise<PreferenceStatus | undefined> {
    try {
      const result = await invoke(["status"], undefined, 60_000, ctx);
      let effectiveGroups: string[] = [];
      try {
        const context = await invoke(["context", "--stdin"], {
          directory: resolve(ctx.cwd),
          session_id: sessionId(ctx),
        }, 60_000, ctx);
        if (Array.isArray(context.effective_groups)) {
          effectiveGroups = context.effective_groups.filter((name): name is string => typeof name === "string");
        }
      } catch {
        effectiveGroups = [];
      }
      const status = result as PreferenceStatus;
      const summary = formatPreferenceSummary(status, effectiveGroups);
      ctx.ui.setStatus("personal-preferences", summary);
      return status;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("personal-preferences", "偏好：状态异常");
      return undefined;
    }
  }

  async function settleUserEdits(ctx: ExtensionContext, paths?: string[]): Promise<Record<string, unknown> | undefined> {
    if (!collecting || !task?.settled || !task.touched.size) return undefined;
    const state = currentFileState(task, ctx.cwd, paths);
    const changed = state.selected.filter((path) => state.agentHashes[path] !== state.currentHashes[path]);
    if (!changed.length) return undefined;
    const diffs = Object.fromEntries(
      changed.filter((path) => typeof state.diffs[path] === "string" && state.diffs[path].length > 0)
        .map((path) => [path, state.diffs[path]]),
    );
    const listed = await invokeV2For(ctx)("feedback", {
      action: "list",
      expected_generation: null,
      payload: {},
    });
    if (!listed.ok || !listed.cas) throw new Error(listed.error?.message ?? "无法读取用户修改记录状态");
    const requestId = `user-edit-${hashText(`${task.taskId}:${JSON.stringify(state.currentHashes)}`).slice(0, 40)}`;
    const result = await invoke(["feedback", "--stdin"], {
      schema_version: 2,
      request_id: requestId,
      action: "create-user-edit",
      expected_generation: listed.cas.generation,
      payload: {
        task_key: task.taskId,
        task_summary: task.taskSummary,
        paths: changed,
        diffs,
        reason: null,
        group_id: null,
      },
    }, 60_000, ctx) as unknown as V2Envelope;
    if (!result.ok || !result.data) throw new Error(result.error?.message ?? "无法保存用户修改记录");
    return result.data;
  }

  async function groupCompletion(prefix: string): Promise<Array<{ value: string; label: string }> | null> {
    const match = /(?:^|\s)--group(?:\s+([^\s]*))?$/u.exec(prefix);
    if (!match) return null;
    const partial = match[1] ?? "";
    try {
      const groups = await readGroups();
      const values = groups.map((group) => group.name).filter((name) => name.startsWith(partial));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    } catch {
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    installPreferenceFooter(ctx);
    task = undefined;
    pendingWrites.clear();
    feedbackBackground.setForegroundBusy(false);
    proposalBackground.setForegroundBusy(false);
    feedbackContext.restore(ctx);
    if (configPresence() === "missing") {
      collecting = false;
      diagnostic = "preference data is not initialized";
      ctx.ui.setStatus("personal-preferences", "偏好：未初始化");
      return;
    }
    let layout: RepoLayout;
    try {
      layout = await loadLayout();
    } catch (error) {
      collecting = false;
      diagnostic = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("personal-preferences", "偏好：配置错误");
      return;
    }
    collecting = Boolean(layout.enabled && layout.captureUserEdits);
    diagnostic = !layout.enabled
      ? "preference collection paused"
      : layout.captureUserEdits ? "preference collection active" : "file-edit capture disabled by config";
    ctx.ui.setStatus("personal-preferences", collecting ? "偏好：采集中" : "偏好：已暂停");
    await updateStatus(ctx);
    if (layout.enabled && layout.extraction.enabled) {
      void feedbackBackground.resume(ctx, invokeV2For(ctx), layout.extraction.provider.thinkingLevel, true)
        .then(() => updateStatus(ctx)).catch((error: unknown) => { diagnostic = error instanceof Error ? error.message : String(error); });
    }
    if (layout.enabled && layout.proposals.enabled) {
      void proposalBackground.resume(ctx, invokeV2For(ctx), layout.proposals.provider.thinkingLevel, true)
        .then(() => updateStatus(ctx)).catch((error: unknown) => { diagnostic = error instanceof Error ? error.message : String(error); });
    }
  });

  pi.on("input", async (input, ctx) => {
    if (input.source === "extension") return { action: "continue" as const };
    feedbackBackground.setForegroundBusy(true);
    proposalBackground.setForegroundBusy(true);
    let layout: RepoLayout | undefined;
    try { if (configPresence() === "ready") layout = await loadLayout(); } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
    collecting = Boolean(layout?.enabled && layout.captureUserEdits);
    if (!collecting || (input.source !== "interactive" && input.source !== "rpc")) {
      return { action: "continue" as const };
    }
    const settled = await settleUserEdits(ctx, undefined);
    if (settled) await updateStatus(ctx);
    taskCounter += 1;
    task = {
      taskId: taskId(ctx, input.text, taskCounter),
      taskSummary: boundedTaskSummary(input.text),
      touched: new Map(),
      settled: false,
    };
    return { action: "continue" as const };
  });

  pi.on("tool_call", (toolCall, ctx) => {
    if (!collecting || !task || (toolCall.toolName !== "write" && toolCall.toolName !== "edit")) return undefined;
    const input = toolCall.input as Record<string, unknown>;
    const path = safeRelativePath(ctx.cwd, input.path);
    if (!path) return undefined;
    pendingWrites.set(toolCall.toolCallId, path.relativePath);
    return undefined;
  });

  pi.on("tool_execution_end", (toolEnd, ctx) => {
    if (!collecting || !task) return;
    if (toolEnd.isError) {
      pendingWrites.delete(toolEnd.toolCallId);
      return;
    }
    const pending = pendingWrites.get(toolEnd.toolCallId);
    if (!pending) return;
    pendingWrites.delete(toolEnd.toolCallId);
    const absolutePath = resolve(ctx.cwd, pending);
    task.touched.set(pending, {
      agentHash: fileHash(absolutePath),
      agentText: fileText(absolutePath),
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (collecting && task && task.touched.size) task.settled = true;
    feedbackBackground.setForegroundBusy(false);
    proposalBackground.setForegroundBusy(false);
    feedbackContext.markSettled(ctx, (data) => {
      const append = (pi as unknown as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry;
      if (typeof append === "function") append("personal-preferences-feedback-target", data);
    });
    let layout: RepoLayout | undefined;
    try { if (configPresence() === "ready") layout = await loadLayout(); } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
    if (layout?.enabled && layout.extraction.enabled) feedbackBackground.wake(ctx, invokeV2For(ctx), layout.extraction.provider.thinkingLevel);
    if (layout?.enabled && layout.proposals.enabled) proposalBackground.wake(ctx, invokeV2For(ctx), layout.proposals.provider.thinkingLevel);
    await updateStatus(ctx);
  });

  pi.on("before_agent_start", async (start, ctx) => {
    if (configPresence() === "missing") return undefined;
    let layout: RepoLayout;
    try {
      layout = await loadLayout();
      if (!layout.enabled) return undefined;
      const groups = await readGroups();
      const context = await invoke(["context", "--stdin"], {
        directory: resolve(ctx.cwd),
        session_id: sessionId(ctx),
      }, 60_000, ctx);
      const effective = Array.isArray(context.effective_groups)
        ? context.effective_groups.filter((name): name is string => typeof name === "string")
        : [];
      const rendered = renderGroupPrompt(groups, effective);
      if (!rendered) return undefined;
      return {
        systemPrompt: `${start.systemPrompt}\n\n## Personal Preferences\nThese preferences have lower priority than safety, correctness, the user's current request, and AGENTS.md.\n\n${rendered}`,
      };
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) safeNotify(ctx, diagnostic, "warning");
      return undefined;
    }
  });

  pi.on("session_shutdown", async () => { await Promise.all([feedbackBackground.cancelAll(), proposalBackground.cancelAll()]); });
  pi.on("resources_discover", () => ({}));

  async function handleSettings(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("学习设置与隐私需要 UI");
    const v2 = invokeV2For(ctx);
    for (;;) {
      const envelope = await v2("settings", { action: "get", expected_generation: null, payload: {} });
      if (!envelope.ok || !envelope.data || !envelope.cas) throw new Error(envelope.error?.message ?? "无法读取设置");
      const config = envelope.data.config as Record<string, any>;
      const learning = config.learning as Record<string, any>;
      const privacy = config.privacy as Record<string, any>;
      const extraction = learning.extraction as Record<string, any>;
      const proposals = learning.proposals as Record<string, any>;
      safeNotify(ctx, [
        `系统：${config.enabled ? "启用" : "停用"} · 文件修改采集=${String(config.capture_user_edits)}`,
        `反馈整理：${extraction.enabled ? "启用" : "停用"} · provider=${typeof extraction.provider === "string" ? extraction.provider : extraction.provider?.name} · thinking=${String(extraction.thinking_level)} · timeout=${String(extraction.timeout_seconds)} · max_tokens=${String(extraction.max_tokens)}`,
        `候选提案：${proposals.enabled ? "启用" : "停用"} · trigger=${String(learning.proposal_trigger)} · provider=${typeof proposals.provider === "string" ? proposals.provider : proposals.provider?.name} · thinking=${String(proposals.thinking_level)} · timeout=${String(proposals.timeout_seconds)} · max_tokens=${String(proposals.max_tokens)}`,
        `限制：max_attempts=${String(learning.max_attempts)} · 每日请求预算=${String(learning.max_requests_per_day)}`,
        `隐私：context=${String(privacy.context_mode)} · snapshot 保留=${String(privacy.snapshot_retention_days)}天 · snapshot=${String(envelope.data.snapshot_count ?? 0)}`,
        `发送授权：反馈=${(envelope.data.feedback_authorization as any)?.allowed === true ? "已授权" : "无"} · 候选=${(envelope.data.proposal_authorization as any)?.allowed === true ? "已授权" : "无"}`,
        "所有候选 apply 固定为人工审核；设置不会开启自动 apply。",
      ].join("\n"), "info");
      const action = await ctx.ui.select("学习设置与隐私", [
        config.enabled ? "停用个人偏好" : "启用个人偏好",
        config.capture_user_edits ? "关闭文件修改采集" : "开启文件修改采集",
        extraction.enabled ? "关闭反馈整理" : "开启反馈整理",
        proposals.enabled ? "关闭候选提案" : "开启候选提案",
        "设置候选触发策略",
        "授权有效新证据自动生成候选",
        "设置默认模型",
        "设置反馈整理模型",
        "设置候选提案模型",
        "设置反馈整理参数",
        "设置候选提案参数",
        "设置重试与每日预算",
        "设置上下文发送策略",
        "设置快照保留天数",
        "撤回反馈发送授权",
        "撤回候选发送授权",
        "立即清理反馈快照",
        "返回上一级",
      ]);
      if (!action || action === "返回上一级") return;
      let patch: Record<string, unknown> = {};
      let revokeFeedback = false;
      let revokeProposal = false;
      let clearSnapshots = false;
      if (action === "停用个人偏好" || action === "启用个人偏好") {
        patch = { enabled: !config.enabled };
      } else if (action === "关闭文件修改采集" || action === "开启文件修改采集") {
        patch = { capture_user_edits: !config.capture_user_edits };
      } else if (action === "关闭反馈整理" || action === "开启反馈整理") {
        patch = { learning: { extraction: { enabled: !extraction.enabled } } };
      } else if (action === "关闭候选提案" || action === "开启候选提案") {
        patch = { learning: { proposals: { enabled: !proposals.enabled } } };
      } else if (action === "设置候选触发策略") {
        const selected = await ctx.ui.select("候选触发策略", ["仅手工生成", "有效新证据时准备候选"]);
        if (!selected) continue;
        patch = { learning: { proposal_trigger: selected === "仅手工生成" ? "manual" : "new_evidence" } };
      } else if (action === "授权有效新证据自动生成候选") {
        const groups = await readGroups();
        const selectedGroup = await ctx.ui.select("授权自动候选的组", groups.map((item) => item.name));
        const groupId = groups.find((item) => item.name === selectedGroup)?.id;
        if (!groupId) continue;
        const layout = await loadLayout();
        const selection = await currentModelSelection(ctx, layout, "proposals");
        if (!selection) throw new Error("候选阶段没有可验证的模型、凭据与 endpoint；授权未写入");
        selection.config_version = envelope.cas.generation + 1;
        const approved = await ctx.ui.confirm("授权未来有效新证据自动生成候选？", [
          `范围：仅组 ${selectedGroup} 的后续有效新 EvidenceRevision；单次精确签名授权不会扩大为此范围。`,
          "发送类别：该组正式规则、经用户保留的结构化证据正文与引用、当前 heads、相关最小决定与来源历史。",
          `提供方/模型：${selection.provider_id}/${selection.model_id}`,
          `冻结 endpoint：${selection.endpoint_fingerprint}`,
          `阶段参数：thinking=${selection.thinking_level} · timeout=${selection.timeout_seconds}s · max_tokens=${selection.max_tokens}`,
          `本机保留：候选与任务保留在本机；反馈快照最多 ${String(privacy.snapshot_retention_days)} 天；Evidence 发布仍逐次显式批准。`,
          "触发：只在该组出现有效新证据时；相同 input_signature 去重；无授权只提示待生成且零费用。",
          "权限：模型只生成本机候选，所有 apply 永远需要人工审核；可在此页随时撤回并立即中止已有候选 transport。",
        ].join("\n"));
        if (!approved) continue;
        patch = { learning: { proposals: { enabled: true }, proposal_trigger: "new_evidence" } };
        const currentConfig = await v2("settings", { action: "get", expected_generation: null, payload: {} });
        if (!currentConfig.ok || !currentConfig.cas) throw new Error(currentConfig.error?.message ?? "无法读取设置 CAS");
        const updatedSettings = await v2("settings", {
          action: "update",
          expected_generation: currentConfig.cas.generation,
          payload: { patch, revoke_feedback_authorization: false, revoke_proposal_authorization: false, clear_snapshots: false },
        });
        if (!updatedSettings.ok) throw new Error(updatedSettings.error?.message ?? "无法保存候选设置");
        const currentProposals = await v2("proposal", { action: "list", expected_generation: null, payload: {} });
        if (!currentProposals.ok || !currentProposals.cas) throw new Error(currentProposals.error?.message ?? "无法读取候选授权状态");
        const authorized = await v2("proposal", {
          action: "authorize",
          expected_generation: currentProposals.cas.generation,
          payload: {
            revision: Date.now() * 1000 + Math.floor(Math.random() * 1000),
            allowed: true,
            stage: "proposals",
            scope: "new_evidence",
            group_ids: [groupId],
            input_signature: null,
            model_selection: selection,
          },
        });
        if (!authorized.ok) throw new Error(authorized.error?.message ?? "无法保存持续候选授权");
        continue;
      } else if (action === "设置上下文发送策略") {
        const selected = await ctx.ui.select("反馈上下文策略", ["每次询问后发送", "只在本机保存"]);
        if (!selected) continue;
        patch = { privacy: { context_mode: selected === "每次询问后发送" ? "ask" : "local_only" } };
      } else if (action === "设置快照保留天数") {
        const value = (await ctx.ui.input("快照保留天数", "1..365"))?.trim();
        if (!value) continue;
        patch = { privacy: { snapshot_retention_days: Number(value) } };
      } else if (action === "设置重试与每日预算") {
        const attempts = (await ctx.ui.input("最大尝试次数", "1..3"))?.trim();
        if (!attempts) continue;
        const budget = (await ctx.ui.input("每日模型请求硬预算", "1..1000"))?.trim();
        if (!budget) continue;
        patch = { learning: { max_attempts: Number(attempts), max_requests_per_day: Number(budget) } };
      } else if (action === "设置反馈整理参数" || action === "设置候选提案参数") {
        const stage = action === "设置反馈整理参数" ? "extraction" : "proposals";
        const thinking = await ctx.ui.select("阶段 thinking", ["inherit", ...THINKING_LEVELS]);
        if (!thinking) continue;
        const timeout = (await ctx.ui.input("阶段 timeout_seconds", "输入 0..1800 内正数，或 inherit"))?.trim();
        if (!timeout) continue;
        const maxTokens = (await ctx.ui.input("阶段 max_tokens", "输入正整数，或 inherit"))?.trim();
        if (!maxTokens) continue;
        patch = { learning: { [stage]: { thinking_level: thinking, timeout_seconds: timeout === "inherit" ? "inherit" : Number(timeout), max_tokens: maxTokens === "inherit" ? "inherit" : Number(maxTokens) } } };
      } else if (action === "撤回反馈发送授权") {
        if (!await ctx.ui.confirm("撤回反馈发送授权？", "立即中止已有反馈整理 transport；反馈、快照、证据和反馈状态继续保留。")) continue;
        revokeFeedback = true;
      } else if (action === "撤回候选发送授权") {
        if (!await ctx.ui.confirm("撤回候选发送授权？", "立即中止已有候选 transport；现有 evidence、候选和审核结果继续保留。")) continue;
        revokeProposal = true;
      } else if (action === "立即清理反馈快照") {
        if (!await ctx.ui.confirm("立即清理全部反馈快照？", "快照正文将从本机删除；反馈任务保留并转为需要补充，已形成的 EvidenceRevision 保留。")) continue;
        clearSnapshots = true;
      } else {
        const stage = action === "设置反馈整理模型" ? "extraction" : action === "设置候选提案模型" ? "proposals" : undefined;
        const choices = stage ? ["继承默认模型", "Pi 当前模型", "自定义 OpenAI-compatible 模型"] : ["Pi 当前模型", "自定义 OpenAI-compatible 模型"];
        const selected = await ctx.ui.select(stage ? `${stage} 模型` : "默认模型", choices);
        if (!selected) continue;
        let provider: Record<string, unknown> | "inherit";
        if (selected === "继承默认模型") {
          provider = "inherit";
        } else if (selected === "Pi 当前模型") {
          provider = { name: "pi", thinking_level: "inherit", timeout_seconds: 300, max_tokens: 2048 };
        } else {
          const model = (await ctx.ui.input("模型 ID", "例如 provider-model"))?.trim();
          if (!model) continue;
          const apiKeyEnv = (await ctx.ui.input("凭据环境变量名", "例如 PREFERENCE_MODEL_API_KEY"))?.trim();
          if (!apiKeyEnv) continue;
          const baseUrl = (await ctx.ui.input("HTTPS endpoint", "https://provider.example/v1"))?.trim();
          if (!baseUrl) continue;
          provider = { name: "openai_compatible", model, api_key_env: apiKeyEnv, base_url: baseUrl, thinking_level: "off", timeout_seconds: 60, max_tokens: 2048 };
        }
        if (stage) {
          patch = { learning: { [stage]: { provider } } };
          revokeFeedback = stage === "extraction";
          revokeProposal = stage === "proposals";
        } else {
          patch = { provider };
          revokeFeedback = true;
          revokeProposal = true;
        }
      }
      const disablesSystem = patch.enabled === false;
      const learningPatch = patch.learning as Record<string, any> | undefined;
      const disablesFeedback = disablesSystem || learningPatch?.extraction?.enabled === false;
      const disablesProposal = disablesSystem || learningPatch?.proposals?.enabled === false;
      if (disablesFeedback || revokeFeedback || clearSnapshots) feedbackBackground.abortActive();
      if (disablesProposal || revokeProposal) proposalBackground.abortActive();
      const updated = await v2("settings", {
        action: "update",
        expected_generation: envelope.cas.generation,
        payload: { patch, revoke_feedback_authorization: revokeFeedback, revoke_proposal_authorization: revokeProposal, clear_snapshots: clearSnapshots },
      });
      if (!updated.ok) throw new Error(updated.error?.message ?? "设置更新失败");
      const layout = await loadLayout();
      collecting = layout.enabled && layout.captureUserEdits;
      if (layout.enabled && layout.extraction.enabled) feedbackBackground.wake(ctx, v2, layout.extraction.provider.thinkingLevel);
      if (layout.enabled && layout.proposals.enabled) proposalBackground.wake(ctx, v2, layout.proposals.provider.thinkingLevel);
      safeNotify(ctx, "设置已通过 CAS 原子更新。", "info");
    }
  }

  async function handleFeedbackJobs(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("反馈任务管理需要 UI");
    const v2 = invokeV2For(ctx);
    const listed = await v2("feedback", { action: "list", expected_generation: null, payload: {} });
    if (!listed.ok || !listed.data || !listed.cas) throw new Error(listed.error?.message ?? "无法读取反馈任务");
    const jobs = Array.isArray(listed.data.jobs) ? listed.data.jobs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    if (!jobs.length) { safeNotify(ctx, "当前没有本机反馈任务。", "info"); return; }
    const choice = await ctx.ui.select("选择反馈任务", jobs.map((job) => `${String(job.job_id)} · ${String(job.state)} · ${String(job.feedback).slice(0, 60)}`));
    if (!choice) return;
    const job = jobs.find((item) => choice.startsWith(String(item.job_id)));
    if (!job || typeof job.job_id !== "string" || typeof job.generation !== "number") return;
    const current = await v2("feedback", { action: "get", expected_generation: null, payload: { job_id: job.job_id } });
    if (!current.ok || !current.data || !current.cas) throw new Error(current.error?.message ?? "无法读取反馈任务详情");
    const currentJob = current.data.job as Record<string, unknown>;
    const currentSnapshot = current.data.snapshot && typeof current.data.snapshot === "object" ? current.data.snapshot as Record<string, unknown> : undefined;
    safeNotify(ctx, [
      `原始反馈：${String(currentJob.feedback ?? "")}`,
      `状态：${String(currentJob.state ?? "")} · attempts=${String(currentJob.attempts ?? 0)} · generation=${String(currentJob.generation ?? "")}`,
      `目标组：${String(currentJob.group_id ?? "")} · snapshot=${currentJob.snapshot_ref ? "保留" : "已清理"}`,
      `任务：${String(currentSnapshot?.task_key ?? "不可用")}`,
      `请求：${String(currentSnapshot?.user_text ?? "不可用")}`,
      `结果：${String(currentSnapshot?.assistant_text ?? "不可用")}`,
      `模型：${currentJob.model_selection ? JSON.stringify(currentJob.model_selection) : "未绑定"} · consent=${String(currentJob.consent_revision ?? "")}`,
      `错误：${String(currentJob.error_code ?? "无")} · result=${String(currentJob.result_ref ?? "无")}`,
      ...(currentJob.source_kind === "user_edit" && currentJob.source_context && typeof currentJob.source_context === "object"
        ? [`用户修改：${JSON.stringify(currentJob.source_context)}`]
        : []),
    ].join("\n"), "info");
    const state = String(currentJob.state);
    const isUserEdit = currentJob.source_kind === "user_edit";
    const canBind = ["blocked_model", "blocked_consent", "blocked_config", "failed", "cancelled"].includes(state);
    const canRetry = Boolean(currentJob.model_selection) && ["failed", "blocked_config", "blocked_model", "blocked_budget", "retry_wait", "cancelled"].includes(state);
    const canCancel = !["completed", "needs_review", "cancelled"].includes(state);
    const canDelete = state !== "running";
    const actions = [isUserEdit ? "补充用户修改原因与片段" : "修改反馈", ...(!isUserEdit && canBind ? ["绑定当前模型并发送"] : []), ...(!isUserEdit && canRetry ? ["重试"] : []), ...(canCancel ? ["取消"] : []), ...(canDelete ? ["删除"] : []), "返回"];
    const action = await ctx.ui.select("管理反馈任务", actions);
    if (!action || action === "返回") return;
    const generation = typeof currentJob.generation === "number" ? currentJob.generation : job.generation;
    if (action === "取消") {
      if (!await ctx.ui.confirm("取消反馈任务？", `任务 ${job.job_id} 将停止整理；原始反馈和现有快照继续保留在本机。`)) return;
      await feedbackBackground.cancelJob(v2, job.job_id);
    } else if (action === "绑定当前模型并发送") {
      const layout = await loadLayout();
      if (!layout.enabled || !layout.extraction.enabled) throw new Error("反馈整理未启用，无法绑定并发送");
      const selection = await currentModelSelection(ctx, layout, "extraction");
      if (!selection) throw new Error("当前没有可验证授权与实际 endpoint 的模型，反馈继续保留为未绑定状态");
      if (!currentSnapshot) throw new Error("反馈快照已清理，无法授权发送");
      const sendSnapshot = { ...currentSnapshot, storage_mode: "ask" };
      const preview = await v2("feedback", {
        action: "preview", expected_generation: null,
        payload: { feedback: currentJob.feedback, snapshot: sendSnapshot, model_selection: selection },
      });
      if (!preview.ok || !preview.data || !preview.cas) throw new Error(preview.error?.message ?? "无法生成反馈发送预览");
      if (!await ctx.ui.confirm("绑定当前模型并发送反馈快照？", [
        `input_signature=${String(preview.data.input_signature)}`,
        `模型：${selection.provider_id}/${selection.model_id} · endpoint=${selection.endpoint_fingerprint}`,
        `阶段参数：thinking=${selection.thinking_level} · timeout=${selection.timeout_seconds}s · max_tokens=${selection.max_tokens}`,
        JSON.stringify(preview.data.send_preview, null, 2),
      ].join("\n"))) return;
      const consentRevision = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const authorized = await v2("feedback", { action: "authorize", expected_generation: preview.cas.generation, payload: { revision: consentRevision, allowed: true, scope: "single", input_signature: preview.data.input_signature, model_selection: selection } });
      if (!authorized.ok || !authorized.cas) throw new Error(authorized.error?.message ?? "无法保存反馈授权");
      const bound = await v2("feedback", { action: "bind", expected_generation: authorized.cas.generation, payload: { job_id: job.job_id, generation, model_selection: selection, consent_revision: consentRevision } });
      if (!bound.ok) throw new Error(bound.error?.message ?? "无法绑定反馈模型");
    } else {
      if (action === "删除" && !await ctx.ui.confirm("删除反馈任务？", `任务 ${job.job_id}、原始反馈和本机快照将被永久删除；未发布派生证据会删除，已发布派生证据会生成“撤回待发布”修订，普通同步不会传播，需在证据页显式发布。`)) return;
      let request: Record<string, unknown>;
      if (action === "修改反馈") {
        const feedback = (await ctx.ui.input("修改原始反馈", String(currentJob.feedback ?? "")))?.trim();
        if (!feedback) return;
        request = { action: "update", expected_generation: current.cas.generation, payload: { job_id: job.job_id, generation, feedback } };
      } else if (action === "补充用户修改原因与片段") {
        const reason = (await ctx.ui.input("补充修改原因", "说明这次修改体现的偏好；不要只描述行数或路径"))?.trim();
        if (!reason) return;
        const source = currentJob.source_context as Record<string, unknown>;
        const paths = Array.isArray(source.paths) ? source.paths.filter((item): item is string => typeof item === "string") : [];
        const selectedPath = await ctx.ui.select("选择必要的最小修改片段", [...paths, "保留全部安全片段"]);
        if (!selectedPath) return;
        const groups = await readGroups();
        const selectedGroup = await ctx.ui.select("选择用户修改所属组", groups.map((item) => item.name));
        const groupId = groups.find((item) => item.name === selectedGroup)?.id;
        if (!groupId) return;
        request = { action: "update-user-edit", expected_generation: current.cas.generation, payload: { job_id: job.job_id, generation, reason, group_id: groupId, paths: selectedPath === "保留全部安全片段" ? paths : [selectedPath] } };
      } else {
        const actionMap: Record<string, string> = { "重试": "retry", "删除": "delete" };
        request = { action: actionMap[action], expected_generation: current.cas.generation, payload: { job_id: job.job_id, generation } };
      }
      const result = await v2("feedback", request);
      if (!result.ok) throw new Error(result.error?.message ?? "反馈任务操作失败");
    }
    const layout = await loadLayout();
    if (layout.enabled && layout.extraction.enabled) feedbackBackground.wake(ctx, v2, layout.extraction.provider.thinkingLevel);
    safeNotify(ctx, `反馈任务已${action}：${job.job_id}`, "info");
  }

  async function handleEvidence(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("学习证据管理需要 UI");
    const v2 = invokeV2For(ctx);
    evidenceLoop: for (;;) {
      const listed = await v2("evidence", { action: "list", expected_generation: null, payload: {} });
      if (!listed.ok || !listed.data || !listed.cas) throw new Error(listed.error?.message ?? "无法读取学习证据");
      const rows = Array.isArray(listed.data.evidence)
        ? listed.data.evidence.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
      if (!rows.length) { safeNotify(ctx, "当前没有学习证据。", "info"); return; }
      const selected = await ctx.ui.select("选择学习证据", rows.map((row) => {
        const revision = row.revision && typeof row.revision === "object" ? row.revision as Record<string, unknown> : undefined;
        const content = revision?.content && typeof revision.content === "object" ? revision.content as Record<string, unknown> : undefined;
        const publication = row.withdrawal_pending_publish ? "撤回待发布" : String(row.publish_state ?? "");
        return `${String(row.evidence_id)} · ${String(row.status)} · ${publication} · ${String(content?.evidence_summary ?? row.group_id ?? "")}`;
      }));
      if (!selected) return;
      const row = rows.find((item) => selected.startsWith(String(item.evidence_id)));
      if (!row || typeof row.evidence_id !== "string") continue;
      const current = await v2("evidence", { action: "get", expected_generation: null, payload: { evidence_id: row.evidence_id } });
      if (!current.ok || !current.data || !current.cas) throw new Error(current.error?.message ?? "无法读取证据详情");
      const detail = current.data;
      const heads = Array.isArray(detail.heads) ? detail.heads.filter((item): item is string => typeof item === "string") : [];
      const revisions = Array.isArray(detail.revisions)
        ? detail.revisions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
      const activeRevision = revisions.find((item) => item.revision_id === detail.active_revision_id)
        ?? revisions.find((item) => heads.includes(String(item.revision_id)) && item.content && typeof item.content === "object")
        ?? revisions.find((item) => item.content && typeof item.content === "object");
      const content = activeRevision?.content && typeof activeRevision.content === "object" ? activeRevision.content as Record<string, unknown> : undefined;
      const target = content?.feedback_target && typeof content.feedback_target === "object" ? content.feedback_target as Record<string, unknown> : undefined;
      const quote = target?.quote && typeof target.quote === "object" ? target.quote as Record<string, unknown> : undefined;
      const publicationStatus = detail.withdrawal_pending_publish
        ? "撤回待发布（普通同步不会传播）"
        : detail.publish_state === "changes_pending_publish"
          ? "新修订待显式发布"
          : detail.published ? "已发布" : "仅本机";
      safeNotify(ctx, [
        `证据：${row.evidence_id}`,
        `状态：${String(detail.status)} · heads=${heads.join("、") || "无"} · ${publicationStatus}`,
        `组：${String(detail.group_id ?? activeRevision?.group_id ?? "无")}`,
        `原始反馈：${String(content?.raw_feedback ?? "不可用")}`,
        `来源对象：${String(target?.description ?? "不可用")}`,
        `来源片段：${String(quote?.text ?? "未提供")}`,
        `实际行为：${String(content?.actual_behavior ?? "未提供")}`,
        `用户期望：${String(content?.expected_behavior ?? "未提供")}`,
        `适用场景：${String(content?.applicability ?? "未提供")}`,
        `上下文：${String(content?.context_completeness ?? "不可用")} · needs_review=${String(content?.needs_review ?? "不可用")}`,
      ].join("\n"), "info");
      const status = String(detail.status);
      const actions = [
        ...(status !== "withdrawn" ? ["修订来源片段", "修订用户期望", "更换归组", "撤回"] : ["恢复"]),
        ...(!detail.published ? ["删除本机证据"] : []),
        "查看影响",
        "发布",
        "返回上一级",
      ];
      const action = await ctx.ui.select("管理学习证据", actions);
      if (!action || action === "返回上一级") continue;
      if (action === "查看影响") {
        const impact = await v2("evidence", { action: "impact", expected_generation: null, payload: { evidence_id: row.evidence_id } });
        if (!impact.ok || !impact.data) throw new Error(impact.error?.message ?? "无法查询证据影响");
        safeNotify(ctx, [
          `关联反馈任务：${Array.isArray(impact.data.feedback_jobs) ? impact.data.feedback_jobs.join("、") || "无" : "无"}`,
          `候选影响：${Array.isArray(impact.data.candidates) ? JSON.stringify(impact.data.candidates) : "无"}`,
          `正式规则影响：${Array.isArray(impact.data.formal_rules) ? JSON.stringify(impact.data.formal_rules) : "无"}`,
          "当前设备缺少私有 EvidenceRevision 正文时只显示来源仅原设备可见，不补造支持。",
        ].join("\n"), "info");
        continue;
      }
      if (action === "发布") {
        const preview = await v2("evidence", {
          action: "publish",
          expected_generation: current.cas.generation,
          payload: { mode: "preview", evidence_id: row.evidence_id, expected_heads: heads },
        });
        if (!preview.ok || !preview.data || !preview.cas) throw new Error(preview.error?.message ?? "无法预览证据发布集合");
        const entries = Array.isArray(preview.data.entries) ? preview.data.entries as Array<Record<string, unknown>> : [];
        if (!entries.length) { safeNotify(ctx, "当前必要修订闭包均已发布。", "info"); continue; }
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          if (!entry.revision || typeof entry.revision !== "object" || Array.isArray(entry.revision)) {
            throw new Error("证据发布预览缺少完整修订正文");
          }
          const viewed = await ctx.ui.confirm(
            `查看待发布修订 ${index + 1}/${entries.length}`,
            [
              `revision=${String(entry.revision_id)} · operation=${String(entry.operation)}`,
              `parents=${Array.isArray(entry.parents) ? entry.parents.join(",") || "无" : "无"}`,
              `content_digest=${String(entry.content_digest)}`,
              "",
              "完整待导出正文：",
              JSON.stringify(entry.revision, null, 2),
              "",
              index + 1 < entries.length ? "继续查看下一条修订。" : "继续进入完整集合批准页。",
            ].join("\n"),
          );
          if (!viewed) {
            safeNotify(ctx, "已取消证据发布预览；没有修订被导出。", "info");
            continue evidenceLoop;
          }
        }
        const approvalBody = entries.map((entry) => `${String(entry.revision_id)} · ${String(entry.content_digest)}`).join("\n");
        if (!await ctx.ui.confirm("批准发布完整证据修订闭包？", `已逐条展示全部待导出正文。以下精确集合将进入私有 Git 仓库：\n\n${approvalBody}`)) {
          safeNotify(ctx, "未批准证据发布；没有修订被导出。", "info");
          continue;
        }
        const applied = await v2("evidence", {
          action: "publish",
          expected_generation: preview.cas.generation,
          payload: {
            mode: "apply",
            evidence_id: row.evidence_id,
            expected_heads: heads,
            preview_digest: preview.data.preview_digest,
            revision_ids: preview.data.revision_ids,
          },
        }, undefined, 120_000);
        if (!applied.ok) throw new Error(applied.error?.message ?? "证据发布失败");
        safeNotify(ctx, "证据修订闭包已提交到本机私有偏好仓库。", "info");
        continue;
      }
      if (action === "撤回") {
        if (!await ctx.ui.confirm("撤回这条学习证据？", `证据 ${row.evidence_id} 将产生逻辑撤回修订；Git 历史、其他设备已有副本和已发送给模型提供方的数据不会自动清除。`)) continue;
        const result = await v2("evidence", { action: "withdraw", expected_generation: current.cas.generation, payload: { evidence_id: row.evidence_id, expected_heads: heads } });
        if (!result.ok) throw new Error(result.error?.message ?? "证据撤回失败");
        if (detail.published) safeNotify(ctx, "撤回已保存在本机，当前为“撤回待发布”；普通同步不会传播到其他设备，请显式发布撤回闭包。", "warning");
        continue;
      }
      if (action === "删除本机证据") {
        if (!await ctx.ui.confirm("永久删除本机证据？", `证据 ${row.evidence_id} 的全部未发布本机修订将永久删除；已发布证据只能逻辑撤回。`)) continue;
        const result = await v2("evidence", { action: "delete-local", expected_generation: current.cas.generation, payload: { evidence_id: row.evidence_id, expected_heads: heads } });
        if (!result.ok) throw new Error(result.error?.message ?? "本机证据删除失败");
        continue;
      }
      if (action === "恢复") {
        const contentRevisions = revisions.filter((item) => item.content && typeof item.content === "object");
        const chosen = await ctx.ui.select("选择恢复正文", contentRevisions.map((item) => `${String(item.revision_id)} · ${String((item.content as Record<string, unknown>).evidence_summary ?? "")}`));
        if (!chosen) continue;
        const revisionId = chosen.split(" · ", 1)[0];
        if (!await ctx.ui.confirm("恢复这条学习证据？", `恢复修订将显式引用当前全部 heads：${heads.join("、")}`)) continue;
        const result = await v2("evidence", { action: "restore", expected_generation: current.cas.generation, payload: { evidence_id: row.evidence_id, expected_heads: heads, content_revision_id: revisionId } });
        if (!result.ok) throw new Error(result.error?.message ?? "证据恢复失败");
        const restoredRevision = result.data?.evidence_revision;
        if (restoredRevision && typeof restoredRevision === "object" && !Array.isArray(restoredRevision)) {
          await triggerProposalForEvidence(ctx, v2, restoredRevision as Record<string, unknown>);
        }
        const layout = await loadLayout();
        if (layout.enabled && layout.extraction.enabled) feedbackBackground.wake(ctx, v2, layout.extraction.provider.thinkingLevel);
        continue;
      }
      let baseRevisionId: string | undefined;
      if (status === "conflict") {
        const choices = revisions.filter((item) => item.content && typeof item.content === "object");
        const chosen = await ctx.ui.select("选择修订基线", choices.map((item) => `${String(item.revision_id)} · ${String((item.content as Record<string, unknown>).evidence_summary ?? "")}`));
        if (!chosen) continue;
        baseRevisionId = chosen.split(" · ", 1)[0];
      } else if (activeRevision && typeof activeRevision.revision_id === "string") {
        baseRevisionId = activeRevision.revision_id;
      }
      if (action === "更换归组") {
        const groups = await readGroups();
        const selectedGroup = await ctx.ui.select("选择新的证据归组", groups.map((group) => group.name));
        const group = groups.find((item) => item.name === selectedGroup);
        if (!group?.id) continue;
        const result = await v2("evidence", { action: "revise", expected_generation: current.cas.generation, payload: { evidence_id: row.evidence_id, expected_heads: heads, base_revision_id: baseRevisionId, group_id: group.id, patch: {} } });
        if (!result.ok) throw new Error(result.error?.message ?? "证据归组修订失败");
        const revisedRevision = result.data?.evidence_revision;
        if (revisedRevision && typeof revisedRevision === "object" && !Array.isArray(revisedRevision)) {
          await triggerProposalForEvidence(ctx, v2, revisedRevision as Record<string, unknown>);
        }
        continue;
      }
      let patch: Record<string, unknown>;
      if (action === "修订用户期望") {
        const expected = (await ctx.ui.editor("修订用户期望", String(content?.expected_behavior ?? "")))?.trim();
        if (!expected) continue;
        patch = { expected_behavior: expected };
      } else {
        const sourceText = (await ctx.ui.editor("修订来源片段", String(quote?.text ?? "")))?.trim();
        if (!sourceText) continue;
        patch = {
          feedback_target: {
            type: String(target?.type ?? "user_selected"),
            description: String(target?.description ?? "用户选择的必要片段"),
            quote: { source_alias: "feedback", text: sourceText },
          },
        };
      }
      const result = await v2("evidence", { action: "revise", expected_generation: current.cas.generation, payload: { evidence_id: row.evidence_id, expected_heads: heads, base_revision_id: baseRevisionId, patch } });
      if (!result.ok) throw new Error(result.error?.message ?? "证据修订失败");
      const revisedRevision = result.data?.evidence_revision;
      if (revisedRevision && typeof revisedRevision === "object" && !Array.isArray(revisedRevision)) {
        await triggerProposalForEvidence(ctx, v2, revisedRevision as Record<string, unknown>);
      }
    }
  }

  async function handleProposals(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("候选规则管理需要 UI");
    const v2 = invokeV2For(ctx);
    for (;;) {
      const listed = await v2("proposal", { action: "list", expected_generation: null, payload: {} });
      if (!listed.ok || !listed.data || !listed.cas) throw new Error(listed.error?.message ?? "无法读取候选规则");
      const proposals = Array.isArray(listed.data.proposals) ? listed.data.proposals.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
      const jobs = Array.isArray(listed.data.jobs) ? listed.data.jobs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
      const choice = await ctx.ui.select("候选规则", [
        "生成新候选",
        ...(proposals.length ? ["审核候选"] : []),
        ...(jobs.some((item) => !["completed", "cancelled", "failed"].includes(String(item.state))) ? ["取消候选任务"] : []),
        "返回上一级",
      ]);
      if (!choice || choice === "返回上一级") return;
      if (choice === "生成新候选") {
        const layout = await loadLayout();
        if (!layout.enabled || !layout.proposals.enabled) throw new Error("候选生成开关未启用；当前操作不会发送任何证据");
        const selection = await currentModelSelection(ctx, layout, "proposals");
        if (!selection) throw new Error("当前没有可验证授权、模型与实际 endpoint；没有证据被发送");
        const groups = await readGroups();
        const groupName = await ctx.ui.select("选择候选目标组", groups.map((item) => item.name));
        const groupId = groups.find((item) => item.name === groupName)?.id;
        if (!groupId) continue;
        const preview = await v2("proposal", { action: "preview", expected_generation: null, payload: { group_id: groupId, model_selection: selection } });
        if (!preview.ok || !preview.data || !preview.cas) throw new Error(preview.error?.message ?? "无法准备候选输入");
        const coverage = preview.data.coverage as Record<string, unknown> | undefined;
        const approved = await ctx.ui.confirm("授权发送本次候选输入？", [
          `模型：${selection.provider_id}/${selection.model_id}`,
          `input_signature=${String(preview.data.input_signature)}`,
          `coverage=${String(coverage?.status ?? "unknown")} · included=${String(coverage?.included_evidence_count ?? 0)} · omitted=${String(coverage?.omitted_evidence_count ?? 0)}`,
          "本授权只覆盖下方确切规则、EvidenceRevision、heads 与历史，不复用 feedback 快照授权：",
          JSON.stringify(preview.data.send_preview, null, 2),
        ].join("\n"));
        if (!approved) { safeNotify(ctx, "已拒绝候选发送授权；零模型请求。", "info"); continue; }
        const authorizationRevision = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        const authorized = await v2("proposal", { action: "authorize", expected_generation: preview.cas.generation, payload: { revision: authorizationRevision, allowed: true, stage: "proposals", scope: "single", group_ids: [groupId], input_signature: preview.data.input_signature, model_selection: selection } });
        if (!authorized.ok || !authorized.cas) throw new Error(authorized.error?.message ?? "无法保存候选发送授权");
        const generated = await v2("proposal", { action: "generate", expected_generation: authorized.cas.generation, payload: { group_id: groupId, model_selection: selection, authorization_revision: authorizationRevision, explicit_retry: false } });
        if (!generated.ok) throw new Error(generated.error?.message ?? "无法创建候选任务");
        proposalBackground.wake(ctx, v2, layout.proposals.provider.thinkingLevel);
        safeNotify(ctx, `候选任务已入队：${String((generated.data?.job as Record<string, unknown> | undefined)?.job_id ?? "已存在")}`, "info");
        continue;
      }
      if (choice === "取消候选任务") {
        const cancellable = jobs.filter((item) => !["completed", "cancelled", "failed"].includes(String(item.state)));
        const selected = await ctx.ui.select("选择候选任务", cancellable.map((item) => `${String(item.job_id)} · ${String(item.state)}`));
        const job = cancellable.find((item) => selected?.startsWith(String(item.job_id)));
        if (!job || typeof job.job_id !== "string") continue;
        if (!await ctx.ui.confirm("取消候选任务？", `任务 ${job.job_id} 将停止；已保存的 evidence 与正式规则不变。`)) continue;
        await proposalBackground.cancelJob(v2, job.job_id);
        safeNotify(ctx, `候选任务已取消：${job.job_id}`, "info");
        continue;
      }
      const selected = await ctx.ui.select("选择候选", proposals.map((item) => `${String(item.proposal_id)} · ${String(item.state)} · ${String(item.group_id)}`));
      const summary = proposals.find((item) => selected?.startsWith(String(item.proposal_id)));
      if (!summary || typeof summary.proposal_id !== "string") continue;
      const detailEnvelope = await v2("proposal", { action: "get", expected_generation: null, payload: { proposal_id: summary.proposal_id } });
      if (!detailEnvelope.ok || !detailEnvelope.data || !detailEnvelope.cas) throw new Error(detailEnvelope.error?.message ?? "无法读取候选详情");
      const proposal = detailEnvelope.data.proposal as Record<string, any>;
      const changes = Array.isArray(proposal.changes) ? proposal.changes as Array<Record<string, any>> : [];
      const evidenceDetails = Array.isArray(detailEnvelope.data.evidence_details) ? detailEnvelope.data.evidence_details as Array<Record<string, any>> : [];
      const deleteConfirmations = Array.isArray(detailEnvelope.data.delete_opposition_confirmations) ? detailEnvelope.data.delete_opposition_confirmations as Array<Record<string, any>> : [];
      safeNotify(ctx, [
        `候选：${String(proposal.proposal_id)} · generation=${String(proposal.generation)} · ${String(proposal.state)}`,
        `目标组：${String(proposal.group_id)} · coverage=${String(proposal.coverage?.status ?? "unknown")}`,
        ...changes.map((item) => [
          `${String(item.change_id)} · ${String(item.action)} · ${String(item.state)}`,
          `diff: ${String(item.rule_ref?.text ?? "∅")} → ${String(item.proposed_text ?? "∅")}`,
          `支持任务=${String(item.gate_result?.support_task_count ?? 0)} · 模型标记反向任务=${String(item.gate_result?.opposition_task_count ?? 0)} · 用户确认反对任务=${String(item.gate_result?.explicit_opposition_count ?? 0)}`,
          `Gate=${String(item.gate_result?.classification)} · ${Array.isArray(item.gate_result?.reasons) ? item.gate_result.reasons.join("、") || "无机械阻塞" : ""}`,
          `理由：${String(item.rationale)} · 边界：${String(item.applicability)} · 不确定：${String(item.uncertainty ?? "无")}`,
          `support refs=${JSON.stringify(item.evidence_refs)} · opposing refs=${JSON.stringify(item.opposing_evidence_refs)}`,
        ].join("\n")),
        "Gate 与模型 confidence 只说明审核条件，不证明偏好正确；最终语义由用户判断。",
      ].join("\n\n"), "info");
      const action = await ctx.ui.select("审核候选", ["逐项审核", "接受全部符合 Gate 项", "重新核验", "返回上一级"]);
      if (!action || action === "返回上一级") continue;
      if (action === "重新核验") {
        const result = await v2("proposal", { action: "revalidate", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation } });
        if (!result.ok) throw new Error(result.error?.message ?? "候选重新核验失败");
        safeNotify(ctx, result.data?.valid === true ? "候选输入仍精确有效。" : "候选已过期，需重新展示并生成。", result.data?.valid === true ? "info" : "warning");
        continue;
      }
      let selectedChanges: Array<Record<string, any>>;
      if (action === "接受全部符合 Gate 项") {
        selectedChanges = changes.filter((item) => item.state === "pending_review" && item.gate_result?.classification === "eligible_for_review");
        if (!selectedChanges.length) { safeNotify(ctx, "当前没有可通过普通接受的候选项。", "warning"); continue; }
      } else {
        const selectedChange = await ctx.ui.select("选择候选项", changes.map((item) => `${String(item.change_id)} · ${String(item.action)} · ${String(item.state)}`));
        const change = changes.find((item) => selectedChange?.startsWith(String(item.change_id)));
        if (!change) continue;
        selectedChanges = [change];
        const itemAction = await ctx.ui.select("处理候选项", [
          ...(change.state === "pending_review" && change.gate_result?.classification === "eligible_for_review" ? ["接受", ...(change.action === "add" || change.action === "replace" ? ["修改后接受"] : [])] : []),
          ...(change.action === "delete" && ["pending_review", "blocked", "deferred"].includes(String(change.state)) ? ["核对删除反对证据"] : []),
          ...(["pending_review", "blocked", "deferred"].includes(String(change.state)) ? ["拒绝"] : []),
          ...(change.state === "pending_review" ? ["暂不处理"] : []),
          ...(change.state === "deferred" ? ["继续审核"] : []),
          "返回上一级",
        ]);
        if (!itemAction || itemAction === "返回上一级") continue;
        if (itemAction === "继续审核") {
          const result = await v2("proposal", { action: "resume", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation, change_ids: [change.change_id] } });
          if (!result.ok) throw new Error(result.error?.message ?? "候选继续审核失败");
          safeNotify(ctx, "候选已恢复为待审核；原暂存决定不会令本批候选自我过期。", "info");
          continue;
        }
        if (itemAction === "核对删除反对证据") {
          const confirmedRefs = new Set(deleteConfirmations.filter((item) => item.change_id === change.change_id).map((item) => `${String(item.evidence_ref?.evidence_id)}:${String(item.evidence_ref?.revision_id)}`));
          const opposing = Array.isArray(change.opposing_evidence_refs) ? change.opposing_evidence_refs as Array<Record<string, unknown>> : [];
          const candidates = opposing.map((ref) => {
            const detail = evidenceDetails.find((item) => item.evidence_id === ref.evidence_id && item.revision_id === ref.revision_id);
            const content = detail?.content as Record<string, unknown> | undefined;
            const key = `${String(ref.evidence_id)}:${String(ref.revision_id)}`;
            return { ref, detail, content, key, label: `${confirmedRefs.has(key) ? "已确认" : "待确认"} · ${key} · ${String(content?.raw_feedback ?? "正文仅原设备可见")}` };
          });
          const picked = await ctx.ui.select("选择要核对的明确反对来源", candidates.map((item) => item.label));
          const candidate = candidates.find((item) => item.label === picked);
          if (!candidate || confirmedRefs.has(candidate.key)) continue;
          if (!candidate.detail || !candidate.content) {
            safeNotify(ctx, "该 EvidenceRevision 正文当前设备不可见，不能确认其明确反对关系。", "warning");
            continue;
          }
          const confirmed = await ctx.ui.confirm("确认这条证据明确反对具体旧规则？", [
            `旧规则：${String(change.rule_ref?.text)} (rule=${String(change.rule_ref?.rule_id)} revision=${String(change.rule_ref?.revision)} digest=${String(change.rule_ref?.digest)})`,
            `EvidenceRevision：${candidate.key}`,
            `原始反馈：${String(candidate.content.raw_feedback)}`,
            `证据摘要：${String(candidate.content.evidence_summary)}`,
            `用户期望：${String(candidate.content.expected_behavior)}`,
            "仅在你判断这条具体反馈明确反对上面的确切旧规则时确认。该确认不会直接删除规则，仍需之后正式接受候选。",
          ].join("\n"));
          if (!confirmed) continue;
          const result = await v2("proposal", { action: "confirm-delete-opposition", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation, change_id: change.change_id, rule_ref: change.rule_ref, evidence_ref: candidate.ref } });
          if (!result.ok) throw new Error(result.error?.message ?? "删除反对证据确认失败");
          safeNotify(ctx, `已保存确切关联确认；当前去重确认任务数=${String(result.data?.confirmed_task_count ?? 0)}，仍需正式接受才能删除规则。`, "info");
          continue;
        }
        if (itemAction === "拒绝") {
          const reason = (await ctx.ui.input("记录本机拒绝原因", "说明为何不采纳；私有理由不会同步"))?.trim();
          if (!reason) continue;
          const result = await v2("proposal", { action: "reject", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation, change_ids: [change.change_id], reason } }, undefined, 120_000);
          if (!result.ok) throw new Error(result.error?.message ?? "候选拒绝失败");
          safeNotify(ctx, "候选已拒绝；私有理由仅保存在本机，仓库只记录抑制 fingerprint。", "info");
          continue;
        }
        if (itemAction === "暂不处理") {
          const result = await v2("proposal", { action: "defer", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation, change_ids: [change.change_id] } });
          if (!result.ok) throw new Error(result.error?.message ?? "候选暂存失败");
          continue;
        }
        const editedTexts: Record<string, string> = {};
        if (itemAction === "修改后接受") {
          const edited = (await ctx.ui.editor("修改后接受", String(change.proposed_text ?? "")))?.trim();
          if (!edited) continue;
          editedTexts[String(change.change_id)] = edited;
        }
        if (!await ctx.ui.confirm("应用候选规则？", `将重新核对 group/rule revision、digest、EvidenceRevision heads 与新反向证据，并在同一 Git commit 写入 groups.json 和 operation。`)) continue;
        const result = await v2("proposal", { action: "accept", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation, input_signature: proposal.input_signature, change_ids: [change.change_id], edited_texts: editedTexts } }, undefined, 120_000);
        if (!result.ok) throw new Error(result.error?.message ?? "候选应用失败");
        safeNotify(ctx, `候选已审核应用：${String(result.data?.operation_id ?? "本机 noop")}`, "info");
        continue;
      }
      if (!await ctx.ui.confirm("原子应用全部所选候选？", `共 ${selectedChanges.length} 项；同批逐项核验并写入一个 Git transaction，未选项会因 base 改变而 stale。`)) continue;
      const result = await v2("proposal", { action: "accept", expected_generation: detailEnvelope.cas.generation, payload: { proposal_id: proposal.proposal_id, generation: proposal.generation, input_signature: proposal.input_signature, change_ids: selectedChanges.map((item) => item.change_id), edited_texts: {} } }, undefined, 120_000);
      if (!result.ok) throw new Error(result.error?.message ?? "多项候选应用失败");
      safeNotify(ctx, `候选已原子应用：${String(result.data?.operation_id)}`, "info");
    }
  }

  async function handleHistory(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("规则来源查看需要 UI");
    const raw = await invoke(["groups"], undefined, 60_000, ctx);
    const groups = Array.isArray(raw.groups) ? raw.groups.filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object") : [];
    const groupName = await ctx.ui.select("选择规则来源组", groups.map((item) => String(item.name)));
    const group = groups.find((item) => item.name === groupName);
    const rules = Array.isArray(group?.rules) ? group.rules.filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object") : [];
    if (!rules.length) { safeNotify(ctx, "当前组没有正式规则。", "info"); return; }
    const selected = await ctx.ui.select("选择正式规则", rules.map((item) => `${String(item.id)} · ${String(item.text)}`));
    const rule = rules.find((item) => selected?.startsWith(String(item.id)));
    if (!rule) return;
    const v2 = invokeV2For(ctx);
    const history = await v2("history", { action: "rule", expected_generation: null, payload: { rule_id: rule.id } });
    if (!history.ok || !history.data) throw new Error(history.error?.message ?? "无法读取规则来源");
    const operations = Array.isArray(history.data.operations) ? history.data.operations as Array<Record<string, any>> : [];
    if (!operations.length) { safeNotify(ctx, "该规则没有可验证的最新 operation 来源；旧来源仅原设备可见或尚未记录。", "warning"); return; }
    const lines: string[] = [`规则：${String(rule.text)}`];
    for (const operation of operations) {
      const effect = Array.isArray(operation.effects) ? operation.effects.find((item: Record<string, unknown>) => item.rule_id === rule.id) : undefined;
      const refs = Array.isArray(effect?.evidence_refs) ? effect.evidence_refs : [];
      let unavailable = 0;
      for (const ref of refs) {
        const found = await v2("evidence", { action: "get", expected_generation: null, payload: { evidence_id: ref.evidence_id } });
        if (!found.ok) unavailable += 1;
      }
      lines.push(`${String(operation.created_at)} · ${String(operation.source_kind)} · operation=${String(operation.operation_id)}${operation.reverts_operation_id ? ` · reverts=${String(operation.reverts_operation_id)}` : ""}`);
      lines.push(`before=${JSON.stringify(effect?.before_rule ?? null)} → after=${JSON.stringify(effect?.after_rule ?? null)}`);
      lines.push(refs.length ? `EvidenceRevision：${JSON.stringify(refs)}${unavailable ? `；${unavailable} 条私有来源仅原设备可见，当前设备不把它们当作支持` : ""}` : "来源：用户明确 remember/人工组管理，无模型证据计数");
    }
    safeNotify(ctx, lines.join("\n"), "info");
  }

  async function handleRemember(
    command: Extract<PrefCommand, { action: "remember" }>,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const groups = await readGroups();
    const invokeCli = invokeFor(ctx);
    const group = await resolvePreferenceGroup({
      explicitGroup: command.group,
      preferenceText: command.rule,
      taskSummary: task?.taskSummary,
      touchedPaths: task ? [...task.touched.keys()] : [],
      groups: groupDescriptions(groups),
      ctx,
      invokeCli,
    });
    const result = await invoke(["remember", "--stdin"], {
      group,
      rule: command.rule,
      task_id: null,
    }, 60_000, ctx);
    const message = result.duplicate === true
      ? `规则已存在于 ${group}：`
      : result.restored === true
        ? `已恢复到 ${group}：`
        : `已记住到 ${group}：`;
    safeNotify(ctx, `${message}\n${String(result.rule ?? command.rule)}`, "info");
  }

  async function handleFeedback(
    command: Extract<PrefCommand, { action: "feedback" }>,
    ctx: ExtensionCommandContext,
    forcedStorageMode?: "local_only" | "ask",
  ): Promise<void> {
    let sentiment = command.sentiment;
    let reason = command.reason;
    if (!sentiment) {
      if (!ctx.hasUI) throw new Error("feedback 在无 UI 模式下需要使用 good 或 fix");
      for (;;) {
        const choice = await ctx.ui.select("评价当前结果", ["满意", "需要改进", "返回上一级"]);
        if (!choice || choice === "返回上一级") return;
        if (choice === "满意") { sentiment = "good"; break; }
        reason = (await ctx.ui.input("需要改进的原因", "请说明原因"))?.trim();
        if (reason) { sentiment = "fix"; break; }
      }
    }
    if (sentiment === "fix" && !reason?.trim()) throw new Error("feedback fix requires a reason");
    const layout = await loadLayout();
    if (!layout.enabled) throw new Error("个人偏好未启用");
    const feedback = reason?.trim() ? `${sentiment}: ${reason.trim()}` : sentiment;
    const groups = await readGroups();
    let group: string | undefined = command.group;
    if (!group) {
      if (!ctx.hasUI) throw new Error("feedback 在无 UI 模式下需要使用 --group");
      group = await ctx.ui.select("选择反馈所属组", groups.map((item) => item.name));
      if (!group) return;
    }
    if (!groups.some((item) => item.name === group)) throw new Error(`unknown preference group: ${group}`);
    const v2: InvokeV2 = async (name, request, signal, timeoutMs = 60_000) => {
      const response = await invoke([name, "--stdin"], { schema_version: 2, request_id: `feedback-${randomUUID().replaceAll("-", "")}`, ...request }, timeoutMs, ctx, signal) as unknown as V2Envelope;
      if (response.data && response.cas) (response.data as Record<string, unknown>).__cas_generation = response.cas.generation;
      return response;
    };
    let targets = feedbackContext.available(ctx);
    if (!targets.length) targets = feedbackContext.restore(ctx);
    if (!targets.length) { safeNotify(ctx, "当前分支没有已完成且可引用的用户与助手消息；请先选择完成的会话结果。", "warning"); return; }
    let selected = targets.at(-1)!;
    if (targets.length > 1 && ctx.hasUI) {
      const choice = await ctx.ui.select("选择要评价的会话结果", targets.map((target) => `${target.taskKey} · ${target.userText.slice(0, 80)}`));
      if (!choice) return;
      selected = targets.find((target) => choice.startsWith(target.taskKey)) ?? selected;
    }
    let storageMode = forcedStorageMode ?? layout.privacyContextMode;
    if (!ctx.hasUI && storageMode === "ask") storageMode = "local_only";
    let snapshot = feedbackContext.snapshot(ctx, selected.taskKey, storageMode);
    if (!snapshot) { safeNotify(ctx, "选择的反馈目标已不在当前会话分支，需重新选择。", "warning"); return; }
    let selection: FeedbackModelSelection | undefined;
    let consentRevision = 0;
    if (storageMode === "ask") {
      selection = await currentModelSelection(ctx, layout, "extraction");
      if (selection) {
        const preview = await v2("feedback", {
          action: "preview", expected_generation: null,
          payload: { feedback, snapshot, model_selection: selection },
        });
        if (!preview.ok || !preview.data || !preview.cas) throw new Error(preview.error?.message ?? "无法生成反馈发送预览");
        const approved = ctx.hasUI && await ctx.ui.confirm("确认发送受限反馈快照", [
          `input_signature=${String(preview.data.input_signature)}`,
          `模型：${selection.provider_id}/${selection.model_id} · endpoint=${selection.endpoint_fingerprint}`,
          `阶段参数：thinking=${selection.thinking_level} · timeout=${selection.timeout_seconds}s · max_tokens=${selection.max_tokens}`,
          "内容类别：本次原始反馈、当前任务请求与助手可见最终文本；不含 thinking、系统提示、AGENTS 或工具原始输出。",
          `本机快照保留：最多 ${layout.snapshotRetentionDays} 天；可在学习设置与隐私页撤权或立即清理。`,
          JSON.stringify(preview.data.send_preview, null, 2),
        ].join("\n"));
        if (!approved) {
          storageMode = "local_only";
          snapshot = { ...snapshot, storage_mode: "local_only" };
          selection = undefined;
        } else {
          consentRevision = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          const authorized = await v2("feedback", { action: "authorize", expected_generation: preview.cas.generation, payload: { revision: consentRevision, allowed: true, scope: "single", input_signature: preview.data.input_signature, model_selection: selection } });
          if (!authorized.ok) throw new Error(authorized.error?.message ?? "无法保存反馈授权");
        }
      }
    }
    const groupId = groups.find((candidate) => candidate.name === group)?.id;
    if (!groupId) throw new Error("当前配置未提供稳定 group ID");
    const jobId = await feedbackBackground.enqueueAndRun(ctx, v2, {
      feedback,
      group_id: groupId,
      snapshot,
      model_selection: selection ?? null,
      consent_revision: consentRevision,
    }, layout.extraction.provider.thinkingLevel, layout.extraction.enabled && Boolean(selection && consentRevision));
    const message = storageMode === "local_only"
      ? `反馈已仅保存在本机且未发送：${jobId}`
      : selection
        ? `反馈已本机入队：${jobId}`
        : `反馈已本机保存且未绑定模型：${jobId}`;
    safeNotify(ctx, message, "info");
  }

  pi.registerCommand("pref", {
    description: "Manage personal preference groups, remember a rule, or give feedback",
    getArgumentCompletions: async (prefix) => {
      const groups = await groupCompletion(prefix);
      if (groups) return groups;
      if (/\s/u.test(prefix)) return null;
      const values = preferenceCommandNames.filter((value) => value.startsWith(prefix));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      try {
        const command = parsePrefCommand(args);
        await ctx.waitForIdle();
        let layout: RepoLayout;
        if (configPresence() === "missing") {
          await invoke(["init"]);
          layout = await loadLayout();
          safeNotify(ctx, "个人偏好已初始化，默认 global 组已创建。", "info");
        } else {
          layout = await loadLayout();
        }
        collecting = Boolean(layout.enabled && layout.captureUserEdits);
        if (!layout.enabled && command.action !== "dashboard") {
          throw new Error("个人偏好系统已停用；仍可使用 /pref 查看和管理偏好组");
        }
        if (command.action === "dashboard") {
          await showPreferenceDashboard(ctx, invokeFor(ctx), {
            remember: async (rule) => handleRemember({ action: "remember", rule }, ctx),
            feedback: async () => handleFeedback({ action: "feedback" }, ctx),
            feedbackLocalOnly: async () => handleFeedback({ action: "feedback" }, ctx, "local_only"),
            manageFeedback: async () => handleFeedbackJobs(ctx),
            manageEvidence: async () => handleEvidence(ctx),
            manageProposals: async () => handleProposals(ctx),
            manageHistory: async () => handleHistory(ctx),
            manageSettings: async () => handleSettings(ctx),
            sessionId: sessionId(ctx),
          });
          const updatedLayout = await loadLayout();
          collecting = Boolean(updatedLayout.enabled && updatedLayout.captureUserEdits);
          if (!collecting) {
            task = undefined;
            pendingWrites.clear();
          }
          return;
        }
        if (command.action === "remember") {
          await handleRemember(command, ctx);
          return;
        }
        await handleFeedback(command, ctx);
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error);
        safeNotify(ctx, diagnostic, "error");
      }
    },
  });
}

export default preferenceExtension;
