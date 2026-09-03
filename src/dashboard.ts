import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { PreferenceCliInvoker } from "./group.ts";

export interface PreferenceGroup {
  name: string;
  description: string;
  rules: string[];
}

export interface PreferenceStatus {
  enabled?: boolean;
  auto_evolve?: boolean;
  groups?: number;
  rules?: number;
  pending_evidence_count?: number;
  evolve_due?: boolean;
  model_ready?: boolean;
  model_status?: string;
  provider_source?: string;
  provider_name?: string;
  provider_model?: string;
  provider_thinking_level?: string;
  provider_timeout_seconds?: number;
  provider_base_url_ready?: boolean;
  provider_credential_env?: string;
  provider_credential_ready?: boolean;
  sync_state?: string;
  [key: string]: unknown;
}

export interface DashboardActions {
  remember: (rule: string) => Promise<void>;
  feedback: () => Promise<void>;
  sessionId: string;
}

interface ContextResult {
  effective_groups: string[];
  directory_groups: string[];
  session_groups: string[];
}

function text(value: unknown, defaultText = ""): string {
  return typeof value === "string" ? value : defaultText;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function groupList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseGroups(value: Record<string, unknown>): PreferenceGroup[] {
  if (!Array.isArray(value.groups)) throw new Error("groups CLI returned no groups");
  return value.groups.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("groups CLI returned an invalid group");
    const group = item as Record<string, unknown>;
    if (typeof group.name !== "string" || typeof group.description !== "string" || !Array.isArray(group.rules)
        || group.rules.some((rule) => typeof rule !== "string")) {
      throw new Error("groups CLI returned an invalid group");
    }
    return {
      name: group.name,
      description: group.description,
      rules: group.rules as string[],
    };
  });
}

async function loadGroups(invokeCli: PreferenceCliInvoker): Promise<PreferenceGroup[]> {
  return parseGroups(await invokeCli(["groups"]));
}

async function loadContext(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
  sessionId: string,
): Promise<ContextResult> {
  const result = await invokeCli(["context", "--stdin"], {
    directory: resolve(ctx.cwd),
    session_id: sessionId,
  });
  const effective = groupList(result.effective_groups);
  if (!Array.isArray(result.directory_groups) || !Array.isArray(result.session_groups)) {
    throw new Error("context CLI returned an invalid activation document");
  }
  return {
    effective_groups: effective,
    directory_groups: groupList(result.directory_groups),
    session_groups: groupList(result.session_groups),
  };
}

export function formatPreferenceSummary(status: PreferenceStatus, effectiveGroups: string[] = []): string {
  const visibleGroups = status.enabled === false ? [] : effectiveGroups;
  const groups = visibleGroups.length ? visibleGroups.join(", ") : "none";
  const enabled = status.enabled === false ? "disabled" : "enabled";
  const source = text(status.provider_source, "custom");
  const provider = `${text(status.provider_name, "unknown")}/${text(status.provider_model, "unknown")}`;
  const thinking = text(status.provider_thinking_level, "off");
  const timeout = number(status.provider_timeout_seconds);
  const model = status.model_ready === true
    ? `ready (${source} ${provider}, thinking ${thinking}, timeout ${timeout}s)`
    : `not ready (${source} ${provider}, thinking ${thinking}, timeout ${timeout}s: ${text(status.model_status, "not configured")})`;
  const endpoint = source === "pi"
    ? "Pi managed"
    : status.provider_base_url_ready === true ? "ready" : "missing";
  const credential = source === "pi"
    ? "Pi managed"
    : `${text(status.provider_credential_env, "unknown")} ${status.provider_credential_ready === true ? "ready" : "missing"}`;
  return `preferences: ${groups} | ${enabled} | groups ${number(status.groups)} | rules ${number(status.rules)} | model ${model} | endpoint ${endpoint} | credential ${credential} | sync ${text(status.sync_state, "error")}`;
}

function groupDetails(group: PreferenceGroup, context: ContextResult): string {
  const directory = group.name === "global" || context.directory_groups.includes(group.name) ? "已启用" : "未启用";
  const session = group.name === "global" || context.session_groups.includes(group.name) ? "已启用" : "未启用";
  return [
    `组名：${group.name}`,
    `组介绍：${group.description}`,
    `当前目录：${directory}`,
    `当前会话：${session}`,
    "组内规则：",
    ...(group.rules.length ? group.rules.map((rule) => `- ${rule}`) : ["（暂无规则）"]),
  ].join("\n");
}

async function selectGroup(
  ctx: ExtensionCommandContext,
  groups: PreferenceGroup[],
  title: string,
): Promise<PreferenceGroup | undefined> {
  if (!groups.length) {
    ctx.ui.notify("当前没有偏好组。", "info");
    return undefined;
  }
  const selected = await ctx.ui.select(title, groups.map((group) => group.name));
  if (!selected) return undefined;
  return groups.find((group) => group.name === selected);
}

async function manage(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await invokeCli(["manage-group", "--stdin"], payload);
  ctx.ui.notify(`偏好组已更新：${text(result.group, "完成")}`, "info");
  return result;
}

async function viewGroups(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
  sessionId: string,
): Promise<void> {
  const groups = await loadGroups(invokeCli);
  const context = await loadContext(ctx, invokeCli, sessionId);
  const group = await selectGroup(ctx, groups, "查看偏好组");
  if (group) ctx.ui.notify(groupDetails(group, context), "info");
}

async function createGroup(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
): Promise<void> {
  const name = (await ctx.ui.input("输入组名", "例如 coding"))?.trim();
  if (!name) return;
  const description = (await ctx.ui.input("输入组介绍", "说明这个组适用什么场景"))?.trim();
  if (!description) return;
  await manage(ctx, invokeCli, { action: "create", name, description });
}

async function editDescription(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
): Promise<void> {
  const groups = await loadGroups(invokeCli);
  const group = await selectGroup(ctx, groups, "编辑组介绍");
  if (!group) return;
  const description = await ctx.ui.editor("编辑组介绍", group.description);
  if (description === undefined) return;
  if (!description.trim()) throw new Error("组介绍不能为空");
  await manage(ctx, invokeCli, {
    action: "update_description",
    group: group.name,
    description: description.trim(),
  });
}

async function deleteGroup(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
): Promise<void> {
  const groups = await loadGroups(invokeCli);
  const group = await selectGroup(ctx, groups, "删除偏好组");
  if (!group) return;
  await manage(ctx, invokeCli, { action: "delete", group: group.name });
}

async function manageRules(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
  sessionId: string,
): Promise<void> {
  const groups = await loadGroups(invokeCli);
  const context = await loadContext(ctx, invokeCli, sessionId);
  const group = await selectGroup(ctx, groups, "选择要管理的组");
  if (!group) return;
  const action = await ctx.ui.select("管理组内规则", [
    "查看规则",
    "增加规则",
    "修改规则",
    "删除规则",
    "移动到其他组",
    "取消",
  ]);
  if (!action || action === "取消") return;
  if (action === "查看规则") {
    ctx.ui.notify(groupDetails(group, context), "info");
    return;
  }
  if (action === "增加规则") {
    const rule = (await ctx.ui.input("增加规则", "输入组内规则"))?.trim();
    if (rule) await manage(ctx, invokeCli, { action: "add_rule", group: group.name, rule });
    return;
  }
  if (!group.rules.length) {
    ctx.ui.notify("当前组没有规则。", "info");
    return;
  }
  const selected = await ctx.ui.select("选择规则", group.rules);
  if (!selected) return;
  if (action === "修改规则") {
    const replacement = await ctx.ui.editor("修改规则", selected);
    if (replacement === undefined || !replacement.trim()) return;
    await manage(ctx, invokeCli, {
      action: "update_rule",
      group: group.name,
      rule: selected,
      replacement: replacement.trim(),
    });
    return;
  }
  if (action === "删除规则") {
    await manage(ctx, invokeCli, { action: "delete_rule", group: group.name, rule: selected });
    return;
  }
  const targets = groups.filter((item) => item.name !== group.name);
  const target = await selectGroup(ctx, targets, "移动到其他组");
  if (!target) return;
  await manage(ctx, invokeCli, {
    action: "move_rule",
    source_group: group.name,
    target_group: target.name,
    rule: selected,
  });
}

async function setActivation(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
  sessionId: string,
  target: "directory" | "session",
  enabled: boolean,
): Promise<void> {
  const groups = await loadGroups(invokeCli);
  const context = await loadContext(ctx, invokeCli, sessionId);
  const current = target === "directory" ? context.directory_groups : context.session_groups;
  const options = enabled
    ? groups.filter((group) => group.name !== "global" && !current.includes(group.name))
    : groups.filter((group) => group.name !== "global" && current.includes(group.name));
  const group = await selectGroup(ctx, options, enabled ? "为当前上下文启用组" : "为当前上下文禁用组");
  if (!group) return;
  await invokeCli(["set-activation", "--stdin"], {
    target,
    key: target === "directory" ? resolve(ctx.cwd) : sessionId,
    group: group.name,
    enabled,
  });
  ctx.ui.notify(`${enabled ? "已启用" : "已禁用"} ${group.name}`, "info");
}

export async function showPreferenceDashboard(
  ctx: ExtensionCommandContext,
  invokeCli: PreferenceCliInvoker,
  actions: DashboardActions,
): Promise<void> {
  const status = await invokeCli(["status"]) as PreferenceStatus;
  const context = await loadContext(ctx, invokeCli, actions.sessionId);
  if (!ctx.hasUI) {
    ctx.ui.notify(formatPreferenceSummary(status, context.effective_groups), "info");
    return;
  }
  const effectiveGroups = status.enabled === false ? [] : context.effective_groups;
  ctx.ui.notify([
    "个人偏好",
    `当前有效：${effectiveGroups.join("、") || "无"}`,
    formatPreferenceSummary(status, effectiveGroups),
  ].join("\n"), "info");
  const choice = await ctx.ui.select("个人偏好", [
    "查看偏好组",
    "创建偏好组",
    "编辑组介绍",
    "删除偏好组",
    "管理组内规则",
    "为当前目录启用组",
    "为当前目录禁用组",
    "为当前会话启用组",
    "为当前会话禁用组",
    "记录反馈",
    "同步偏好仓库",
    "撤销最近一次变化",
  ]);
  if (!choice) return;
  if (choice === "查看偏好组") {
    await viewGroups(ctx, invokeCli, actions.sessionId);
    return;
  }
  if (choice === "创建偏好组") {
    await createGroup(ctx, invokeCli);
    return;
  }
  if (choice === "编辑组介绍") {
    await editDescription(ctx, invokeCli);
    return;
  }
  if (choice === "删除偏好组") {
    await deleteGroup(ctx, invokeCli);
    return;
  }
  if (choice === "管理组内规则") {
    await manageRules(ctx, invokeCli, actions.sessionId);
    return;
  }
  if (choice === "为当前目录启用组") {
    await setActivation(ctx, invokeCli, actions.sessionId, "directory", true);
    return;
  }
  if (choice === "为当前目录禁用组") {
    await setActivation(ctx, invokeCli, actions.sessionId, "directory", false);
    return;
  }
  if (choice === "为当前会话启用组") {
    await setActivation(ctx, invokeCli, actions.sessionId, "session", true);
    return;
  }
  if (choice === "为当前会话禁用组") {
    await setActivation(ctx, invokeCli, actions.sessionId, "session", false);
    return;
  }
  if (choice === "记录反馈") {
    await actions.feedback();
    return;
  }
  if (choice === "同步偏好仓库") {
    const result = await invokeCli(["sync"], undefined, 120_000);
    if (typeof result.push_error === "string") {
      ctx.ui.notify(`本地偏好已提交，远端推送失败：${result.push_error}（${text(result.sync_state, "error")}）`, "warning");
    } else {
      ctx.ui.notify(`偏好同步完成：${text(result.sync_state, "unknown")}。`, "info");
    }
    return;
  }
  if (choice === "撤销最近一次变化") {
    const confirmed = await ctx.ui.confirm("撤销最近一次变化？", "将通过 Git 新提交恢复最近一次组或规则变化。");
    if (!confirmed) return;
    await invokeCli(["rollback"], undefined, 120_000);
    ctx.ui.notify("最近一次偏好变化已撤销。", "info");
  }
}
