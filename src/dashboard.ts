import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type PreferenceCliInvoker = (
  args: string[],
  input?: unknown,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

export interface PreferenceGroup {
  id: string;
  revision: number;
  name: string;
  description: string;
  rules: string[];
}

export interface PreferenceStatus {
  enabled?: boolean;
  groups?: number;
  rules?: number;
  pending_feedback_count?: number;
  pending_proposal_count?: number;
  pending_evolution_count?: number;
  actionable_count?: number;
  sync_state?: string;
  [key: string]: unknown;
}

export interface DashboardActions {
  remember: (rule: string) => Promise<void>;
  feedback: () => Promise<void>;
  evidence: () => Promise<void>;
  reprocess: () => Promise<void>;
  pending: () => Promise<void>;
  sessionId: string;
}

interface ContextResult {
  effective_groups: string[];
  directory_groups: string[];
  session_groups: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseGroups(value: Record<string, unknown>): PreferenceGroup[] {
  if (!Array.isArray(value.groups)) throw new Error("groups CLI returned no groups");
  return value.groups.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("groups CLI returned an invalid group");
    const group = raw as Record<string, unknown>;
    if (typeof group.id !== "string" || typeof group.revision !== "number" || typeof group.name !== "string"
      || typeof group.description !== "string" || !Array.isArray(group.rules)) {
      throw new Error("groups CLI returned an invalid group");
    }
    const rules = group.rules.map((rule) => {
      if (typeof rule === "string") return rule;
      if (rule && typeof rule === "object" && !Array.isArray(rule) && typeof (rule as Record<string, unknown>).text === "string") {
        return String((rule as Record<string, unknown>).text);
      }
      throw new Error("groups CLI returned an invalid rule");
    });
    return { id: group.id, revision: group.revision, name: group.name, description: group.description, rules };
  });
}

async function groups(invoke: PreferenceCliInvoker): Promise<PreferenceGroup[]> {
  return parseGroups(await invoke(["groups"]));
}

async function context(ctx: ExtensionCommandContext, invoke: PreferenceCliInvoker, sessionId: string): Promise<ContextResult> {
  const value = await invoke(["context", "--stdin"], { directory: resolve(ctx.cwd), session_id: sessionId });
  return {
    effective_groups: strings(value.effective_groups),
    directory_groups: strings(value.directory_groups),
    session_groups: strings(value.session_groups),
  };
}

async function chooseGroup(ctx: ExtensionCommandContext, values: PreferenceGroup[], title: string): Promise<PreferenceGroup | undefined> {
  if (!values.length) {
    ctx.ui.notify("当前没有可选偏好组。", "info");
    return undefined;
  }
  const name = await ctx.ui.select(title, values.map((group) => group.name));
  return values.find((group) => group.name === name);
}

function syncLabel(value: unknown): string {
  const labels: Record<string, string> = { "no-remote": "本地", clean: "已同步", ahead: "待推送", behind: "待拉取", diverged: "已分叉", error: "同步异常" };
  return labels[String(value)] ?? String(value ?? "未知");
}

export function formatPreferenceSummary(
  status: PreferenceStatus,
  effective: string[] = [],
  activity: { background?: boolean; actionable?: number } = {},
): string {
  const parts = [status.enabled === false ? "偏好：停用" : `偏好：${effective.join("、") || "无"}`];
  if (activity.background) parts.push("后台处理中");
  if (Number(activity.actionable) > 0) parts.push(`待处理${Number(activity.actionable)}`);
  return parts.join(" · ");
}

function formatPreferenceDetails(status: PreferenceStatus, active: ContextResult): string {
  return [
    formatPreferenceSummary(status, status.enabled === false ? [] : active.effective_groups),
    `总量：${Number(status.groups ?? 0)} 组 / ${Number(status.rules ?? 0)} 条规则 / ${Number(status.saved_feedback_count ?? 0)} 条反馈`,
    `待处理：${Number(status.actionable_count ?? 0)}`,
    `正式规则同步：${syncLabel(status.sync_state)}`,
    `目录启用：${active.directory_groups.join("、") || "无"}`,
    `会话启用：${active.session_groups.join("、") || "无"}`,
  ].join("\n");
}

function groupDetails(group: PreferenceGroup, active: ContextResult): string {
  return [
    `组名：${group.name}`,
    `组介绍：${group.description}`,
    `当前目录：${group.name === "global" || active.directory_groups.includes(group.name) ? "已启用" : "未启用"}`,
    `当前会话：${group.name === "global" || active.session_groups.includes(group.name) ? "已启用" : "未启用"}`,
    "组内规则：",
    ...(group.rules.length ? group.rules.map((rule) => `- ${rule}`) : ["（暂无规则）"]),
  ].join("\n");
}

async function manageGroup(ctx: ExtensionCommandContext, invoke: PreferenceCliInvoker, sessionId: string): Promise<void> {
  const action = await ctx.ui.select("管理偏好组", ["查看", "创建", "编辑介绍", "删除", "管理规则", "返回"]);
  if (!action || action === "返回") return;
  const values = await groups(invoke);
  if (action === "查看") {
    const selected = await chooseGroup(ctx, values, "查看偏好组");
    if (selected) ctx.ui.notify(groupDetails(selected, await context(ctx, invoke, sessionId)), "info");
    return;
  }
  if (action === "创建") {
    const name = (await ctx.ui.input("组名", "例如 coding"))?.trim();
    if (!name) return;
    const description = (await ctx.ui.input("组介绍", "说明这个组适用什么场景"))?.trim();
    if (!description) return;
    await invoke(["manage-group", "--stdin"], { action: "create", name, description });
    ctx.ui.notify(`已创建偏好组：${name}`, "info");
    return;
  }
  const selected = await chooseGroup(ctx, values, "选择偏好组");
  if (!selected) return;
  if (action === "编辑介绍") {
    const description = (await ctx.ui.editor("编辑组介绍", selected.description))?.trim();
    if (!description) return;
    await invoke(["manage-group", "--stdin"], { action: "update_description", group: selected.name, description });
    return;
  }
  if (action === "删除") {
    if (!await ctx.ui.confirm("删除偏好组？", `将删除正式组 ${selected.name} 及其规则；本机历史反馈和证据继续保留。`)) return;
    await invoke(["manage-group", "--stdin"], { action: "delete", group: selected.name });
    return;
  }
  const ruleAction = await ctx.ui.select("管理组内规则", ["增加", "修改", "删除", "移动", "返回"]);
  if (!ruleAction || ruleAction === "返回") return;
  if (ruleAction === "增加") {
    const rule = (await ctx.ui.input("增加规则", "输入组内规则"))?.trim();
    if (rule) await invoke(["manage-group", "--stdin"], { action: "add_rule", group: selected.name, rule });
    return;
  }
  if (!selected.rules.length) {
    ctx.ui.notify("当前组没有规则。", "info");
    return;
  }
  const rule = await ctx.ui.select("选择规则", selected.rules);
  if (!rule) return;
  if (ruleAction === "修改") {
    const replacement = (await ctx.ui.editor("修改规则", rule))?.trim();
    if (replacement) await invoke(["manage-group", "--stdin"], { action: "update_rule", group: selected.name, rule, replacement });
  } else if (ruleAction === "删除") {
    if (await ctx.ui.confirm("删除规则？", rule)) await invoke(["manage-group", "--stdin"], { action: "delete_rule", group: selected.name, rule });
  } else {
    const target = await chooseGroup(ctx, values.filter((group) => group.id !== selected.id), "移动到其他组");
    if (target) await invoke(["manage-group", "--stdin"], { action: "move_rule", source_group: selected.name, target_group: target.name, rule });
  }
}

async function setActivation(
  ctx: ExtensionCommandContext,
  invoke: PreferenceCliInvoker,
  sessionId: string,
  target: "directory" | "session",
  enabled: boolean,
): Promise<void> {
  const values = await groups(invoke);
  const active = await context(ctx, invoke, sessionId);
  const current = target === "directory" ? active.directory_groups : active.session_groups;
  const options = values.filter((group) => group.name !== "global" && (enabled ? !current.includes(group.name) : current.includes(group.name)));
  const group = await chooseGroup(ctx, options, enabled ? "启用偏好组" : "禁用偏好组");
  if (!group) return;
  await invoke(["set-activation", "--stdin"], {
    target,
    key: target === "directory" ? resolve(ctx.cwd) : sessionId,
    group: group.name,
    enabled,
  });
}

export async function showPreferenceDashboard(
  ctx: ExtensionCommandContext,
  invoke: PreferenceCliInvoker,
  actions: DashboardActions,
): Promise<void> {
  for (;;) {
    const status = await invoke(["status"]) as PreferenceStatus;
    const active = await context(ctx, invoke, actions.sessionId);
    const summary = formatPreferenceSummary(
      status,
      status.enabled === false ? [] : active.effective_groups,
      { actionable: Number(status.actionable_count ?? 0) },
    );
    const choice = await ctx.ui.select("个人偏好", [
      "查看当前状态",
      "记录反馈",
      "反馈与证据",
      "重新整理反馈",
      "处理待办",
      "记住一条规则",
      "管理组与规则",
      "为当前目录启用组",
      "为当前目录禁用组",
      "为当前会话启用组",
      "为当前会话禁用组",
      "同步正式规则",
      "退出",
    ]);
    if (!choice || choice === "退出") return;
    if (choice === "查看当前状态") ctx.ui.notify(formatPreferenceDetails(status, active), "info");
    else if (choice === "记录反馈") {
      await actions.feedback();
      return;
    }
    else if (choice === "反馈与证据") await actions.evidence();
    else if (choice === "重新整理反馈") {
      await actions.reprocess();
      return;
    }
    else if (choice === "处理待办") await actions.pending();
    else if (choice === "记住一条规则") {
      const rule = (await ctx.ui.input("记住规则", "输入明确规则"))?.trim();
      if (rule) await actions.remember(rule);
    } else if (choice === "管理组与规则") await manageGroup(ctx, invoke, actions.sessionId);
    else if (choice === "为当前目录启用组") await setActivation(ctx, invoke, actions.sessionId, "directory", true);
    else if (choice === "为当前目录禁用组") await setActivation(ctx, invoke, actions.sessionId, "directory", false);
    else if (choice === "为当前会话启用组") await setActivation(ctx, invoke, actions.sessionId, "session", true);
    else if (choice === "为当前会话禁用组") await setActivation(ctx, invoke, actions.sessionId, "session", false);
    else if (choice === "同步正式规则") {
      const result = await invoke(["sync"], undefined, 180_000);
      ctx.ui.notify(`正式规则同步完成：${syncLabel(result.sync_state)}`, "info");
    }
  }
}
