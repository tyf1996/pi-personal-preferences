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
import { runPreferenceCli } from "./src/cli-client.ts";
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

const baseDir = dirname(fileURLToPath(import.meta.url));
const CLI_NAME = "wikiskill_preference.py";
const DENIED_NAMES = new Set([".env", ".env.local", ".env.production", "credentials.json", "secrets.json"]);

interface RepoLayout {
  enabled: boolean;
  captureUserEdits: boolean;
  autoEvolve: boolean;
}

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

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function readLayout(): RepoLayout | undefined {
  const dataRoot = preferenceDataRoot();
  const configPath = join(dataRoot, "config.json");
  try {
    if (!existsSync(configPath) || lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile()) return undefined;
    const value = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const configKeys = [
      "schema_version", "enabled", "repo_path", "capture_user_edits", "store_raw_diffs",
      "auto_evolve", "auto_evolve_after", "git_auto_push", "provider",
    ];
    if (
      Object.keys(value).sort().join("\u0000") !== configKeys.sort().join("\u0000")
      || typeof value.schema_version !== "number"
      || !Number.isInteger(value.schema_version)
      || value.schema_version !== 1
      || typeof value.enabled !== "boolean"
      || typeof value.repo_path !== "string"
      || typeof value.auto_evolve !== "boolean"
      || typeof value.auto_evolve_after !== "number"
      || !Number.isInteger(value.auto_evolve_after)
      || value.auto_evolve_after < 1
      || typeof value.git_auto_push !== "boolean"
      || typeof value.capture_user_edits !== "boolean"
    ) return undefined;
    const repoParts = value.repo_path.split("/");
    if (
      !value.repo_path.trim()
      || value.repo_path.startsWith("/")
      || /^[A-Za-z]:[\\/]/u.test(value.repo_path)
      || value.repo_path.includes("\\")
      || value.repo_path.includes("\x00")
      || repoParts.some((part) => !part || part === "." || part === "..")
    ) return undefined;
    const repoRoot = resolve(dataRoot, value.repo_path);
    const root = resolve(dataRoot);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (repoRoot !== root && !repoRoot.startsWith(prefix)) return undefined;
    if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) return undefined;
    return {
      enabled: value.enabled,
      captureUserEdits: value.capture_user_edits,
      autoEvolve: value.auto_evolve,
    };
  } catch {
    return undefined;
  }
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

function event(
  group: string,
  signal: "remember" | "rejection" | "user_edit" | "acceptance",
  summary: string,
  task?: string,
  paths: string[] = [],
): Record<string, unknown> {
  return {
    schema_version: 1,
    id: `evt-${randomUUID().replaceAll("-", "")}`,
    created_at: new Date().toISOString(),
    group,
    signal,
    summary,
    task_id: task ?? null,
    paths,
  };
}

async function invoke(
  args: string[],
  input?: unknown,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  return runPreferenceCli(cliPath(), preferenceDataRoot(), args, input, timeoutMs);
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
      || group.rules.some((rule) => typeof rule !== "string")
    ) throw new Error("groups CLI returned an invalid group");
    return { name: group.name, description: group.description, rules: group.rules as string[] };
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
  let diagnostic = "preference data is not initialized";
  let taskCounter = 0;
  let task: TaskState | undefined;
  let evolving = false;
  let autoEvolveBlocked = false;
  let lastPendingEvidenceCount: number | undefined;
  const pendingWrites = new Map<string, string>();

  const invokeCli: PreferenceCliInvoker = (args, input, timeoutMs) => invoke(args, input, timeoutMs);

  async function updateStatus(ctx: ExtensionContext): Promise<PreferenceStatus | undefined> {
    try {
      const result = await invoke(["status"]);
      let effectiveGroups: string[] = [];
      try {
        const context = await invoke(["context", "--stdin"], {
          directory: resolve(ctx.cwd),
          session_id: sessionId(ctx),
        });
        if (Array.isArray(context.effective_groups)) {
          effectiveGroups = context.effective_groups.filter((name): name is string => typeof name === "string");
        }
      } catch {
        effectiveGroups = [];
      }
      ctx.ui.setStatus("personal-preferences", formatPreferenceSummary(result as PreferenceStatus, effectiveGroups));
      return result as PreferenceStatus;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("personal-preferences", `preferences: ${diagnostic}`);
      return undefined;
    }
  }

  async function maybeAutoEvolve(ctx: ExtensionContext): Promise<void> {
    const layout = readLayout();
    if (!layout?.enabled || !layout.autoEvolve || evolving || ctx.hasPendingMessages()) return;
    evolving = true;
    try {
      const status = await updateStatus(ctx);
      if (
        typeof status?.pending_evidence_count === "number"
        && status.pending_evidence_count !== lastPendingEvidenceCount
      ) {
        lastPendingEvidenceCount = status.pending_evidence_count;
        autoEvolveBlocked = false;
      }
      if (!status?.evolve_due || autoEvolveBlocked || ctx.hasPendingMessages()) return;
      await invoke(["evolve"], undefined, 15 * 60 * 1000);
      await updateStatus(ctx);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      autoEvolveBlocked = true;
      await updateStatus(ctx);
    } finally {
      evolving = false;
    }
  }

  async function settleUserEdits(ctx: ExtensionContext, paths?: string[]): Promise<Record<string, unknown> | undefined> {
    if (!collecting || !task?.settled || !task.touched.size) return undefined;
    const state = currentFileState(task, ctx.cwd, paths);
    if (!state.selected.length) return undefined;
    try {
      return await invoke(["changed", "--stdin"], {
        task_id: task.taskId,
        task_summary: task.taskSummary,
        paths: state.selected,
        agent_hashes: state.agentHashes,
        current_hashes: state.currentHashes,
        diffs: state.diffs,
      });
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      return undefined;
    }
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
    task = undefined;
    evolving = false;
    autoEvolveBlocked = false;
    lastPendingEvidenceCount = undefined;
    pendingWrites.clear();
    const layout = readLayout();
    collecting = Boolean(layout?.enabled && layout.captureUserEdits);
    diagnostic = !layout
      ? "preference data is not initialized"
      : !layout.enabled
        ? "preference collection paused"
        : layout.captureUserEdits ? "preference collection active" : "file-edit capture disabled by config";
    ctx.ui.setStatus(
      "personal-preferences",
      collecting ? "preferences: collecting touched-file evidence" : `preferences: ${diagnostic}`,
    );
    if (layout) await updateStatus(ctx);
  });

  pi.on("input", async (input, ctx) => {
    if (input.source === "extension") return { action: "continue" as const };
    const layout = readLayout();
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
    await maybeAutoEvolve(ctx);
  });

  pi.on("before_agent_start", async (start, ctx) => {
    const layout = readLayout();
    if (!layout?.enabled) return undefined;
    try {
      const groups = await readGroups();
      const context = await invoke(["context", "--stdin"], {
        directory: resolve(ctx.cwd),
        session_id: sessionId(ctx),
      });
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

  pi.on("resources_discover", () => ({}));

  async function handleRemember(
    command: Extract<PrefCommand, { action: "remember" }>,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const groups = await readGroups();
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
    });
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
  ): Promise<void> {
    let sentiment = command.sentiment;
    let reason = command.reason;
    if (!sentiment) {
      if (!ctx.hasUI) throw new Error("feedback 在无 UI 模式下需要使用 good 或 fix");
      const choice = await ctx.ui.select("评价当前结果", ["满意", "需要改进", "取消"]);
      if (!choice || choice === "取消") return;
      sentiment = choice === "满意" ? "good" : "fix";
      if (sentiment === "fix") {
        reason = (await ctx.ui.input("需要改进的原因", "请说明原因"))?.trim();
        if (!reason) throw new Error("需要改进的反馈必须有原因");
      }
    }
    if (sentiment === "fix" && !reason?.trim()) throw new Error("feedback fix requires a reason");
    const taskRef = task?.taskId ?? `task-${hashText(sessionId(ctx)).slice(0, 24)}`;
    const summary = reason?.trim() || "用户对当前结果表示满意";
    const groups = await readGroups();
    const group = await resolvePreferenceGroup({
      explicitGroup: command.group,
      preferenceText: summary,
      taskSummary: task?.taskSummary,
      touchedPaths: task ? [...task.touched.keys()] : [],
      groups: groupDescriptions(groups),
      ctx,
      invokeCli,
    });
    const signal = sentiment === "good" ? "acceptance" : "rejection";
    const result = await invoke(["capture", "--stdin"], event(group, signal, summary, taskRef));
    safeNotify(ctx, `反馈：${sentiment === "good" ? "满意" : "需要改进"} · ${group} · ${result.stored === false ? "duplicate" : "stored"}`, "info");
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
        let layout = readLayout();
        if (!layout) {
          await invoke(["init"]);
          layout = readLayout();
          if (!layout) throw new Error("personal preference data initialization did not produce a valid layout");
          safeNotify(ctx, "个人偏好已初始化，默认 global 组已创建。", "info");
        }
        collecting = Boolean(layout.enabled && layout.captureUserEdits);
        if (!layout.enabled && command.action !== "dashboard") {
          throw new Error("个人偏好系统已停用；仍可使用 /pref 查看和管理偏好组");
        }
        if (command.action === "dashboard") {
          await showPreferenceDashboard(ctx, invokeCli, {
            remember: async (rule) => handleRemember({ action: "remember", rule }, ctx),
            feedback: async () => handleFeedback({ action: "feedback" }, ctx),
            sessionId: sessionId(ctx),
          });
          const updatedLayout = readLayout();
          collecting = Boolean(updatedLayout?.enabled && updatedLayout.captureUserEdits);
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
