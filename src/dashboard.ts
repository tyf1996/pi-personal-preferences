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

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}

function compactGroups(groups: string[]): string {
  if (!groups.length) return "无启用组";
  const first = shorten(groups[0] ?? "无启用组", 12);
  return groups.length > 1 ? `${first} +${groups.length - 1}` : first;
}

function compactSync(value: unknown): string {
  const labels: Record<string, string> = {
    "no-remote": "本地",
    clean: "已同步",
    ahead: "待推送",
    behind: "待拉取",
    diverged: "已分叉",
    error: "同步异常",
  };
  const state = text(value, "error");
  return labels[state] ?? shorten(state, 12);
}

export function formatPreferenceSummary(status: PreferenceStatus, effectiveGroups: string[] = []): string {
  const parts = [
    status.enabled === false ? "偏好：已停用" : `偏好：${compactGroups(effectiveGroups)}`,
    `${number(status.groups)}组/${number(status.rules)}规则`,
  ];
  const pending = number(status.pending_evidence_count);
  if (pending > 0) parts.push(`${pending}条待处理${status.evolve_due === true ? "!" : ""}`);
  if (status.model_ready === false) parts.push("模型未就绪");
  parts.push(compactSync(status.sync_state));
  return parts.join(" · ");
}

function formatPreferenceDetails(status: PreferenceStatus): string {
  const source = text(status.provider_source, "custom");
  const provider = `${text(status.provider_name, "unknown")}/${text(status.provider_model, "unknown")}`;
  const thinking = text(status.provider_thinking_level, "off");
  const timeout = number(status.provider_timeout_seconds);
  const model = status.model_ready === true
    ? `${source} ${provider} · thinking ${thinking} · timeout ${timeout}s`
    : `${source} ${provider} · 未就绪：${text(status.model_status, "未配置")}`;
  return `模型：${model}\n同步：${text(status.sync_state, "error")}`;
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
  for (;;) {
    const groups = await loadGroups(invokeCli);
    const group = await selectGroup(ctx, groups, "编辑组介绍");
    if (!group) return;
    const description = await ctx.ui.editor("编辑组介绍", group.description);
    if (description === undefined) continue;
    if (!description.trim()) throw new Error("组介绍不能为空");
    await manage(ctx, invokeCli, {
      action: "update_description",
      group: group.name,
      description: description.trim(),
    });
    return;
  }
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
  for (;;) {
    const groups = await loadGroups(invokeCli);
    const context = await loadContext(ctx, invokeCli, sessionId);
    const group = await selectGroup(ctx, groups, "选择要管理的组");
    if (!group) return;

    for (;;) {
      const action = await ctx.ui.select("管理组内规则", [
        "查看规则",
        "增加规则",
        "修改规则",
        "删除规则",
        "移动到其他组",
        "返回上一级",
      ]);
      if (!action || action === "返回上一级") break;
      if (action === "查看规则") {
        ctx.ui.notify(groupDetails(group, context), "info");
        continue;
      }
      if (action === "增加规则") {
        const rule = (await ctx.ui.input("增加规则", "输入组内规则"))?.trim();
        if (!rule) continue;
        await manage(ctx, invokeCli, { action: "add_rule", group: group.name, rule });
        return;
      }
      if (!group.rules.length) {
        ctx.ui.notify("当前组没有规则。", "info");
        continue;
      }

      for (;;) {
        const selected = await ctx.ui.select("选择规则", group.rules);
        if (!selected) break;
        if (action === "修改规则") {
          const replacement = await ctx.ui.editor("修改规则", selected);
          if (replacement === undefined) continue;
          if (!replacement.trim()) throw new Error("规则不能为空");
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
        if (!target) continue;
        await manage(ctx, invokeCli, {
          action: "move_rule",
          source_group: group.name,
          target_group: target.name,
          rule: selected,
        });
        return;
      }
    }
  }
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
  let introShown = false;
  for (;;) {
    const status = await invokeCli(["status"]) as PreferenceStatus;
    const context = await loadContext(ctx, invokeCli, actions.sessionId);
    const effectiveGroups = status.enabled === false ? [] : context.effective_groups;
    const summary = formatPreferenceSummary(status, effectiveGroups);
    if (!ctx.hasUI) {
      ctx.ui.notify(summary, "info");
      return;
    }
    ctx.ui.setStatus("personal-preferences", summary);
    if (!introShown) {
      ctx.ui.notify([
        "个人偏好",
        `当前有效：${effectiveGroups.join("、") || "无"}`,
        formatPreferenceDetails(status),
      ].join("\n"), "info");
      introShown = true;
    }

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
      continue;
    }
    if (choice === "创建偏好组") {
      await createGroup(ctx, invokeCli);
      continue;
    }
    if (choice === "编辑组介绍") {
      await editDescription(ctx, invokeCli);
      continue;
    }
    if (choice === "删除偏好组") {
      await deleteGroup(ctx, invokeCli);
      continue;
    }
    if (choice === "管理组内规则") {
      await manageRules(ctx, invokeCli, actions.sessionId);
      continue;
    }
    if (choice === "为当前目录启用组") {
      await setActivation(ctx, invokeCli, actions.sessionId, "directory", true);
      continue;
    }
    if (choice === "为当前目录禁用组") {
      await setActivation(ctx, invokeCli, actions.sessionId, "directory", false);
      continue;
    }
    if (choice === "为当前会话启用组") {
      await setActivation(ctx, invokeCli, actions.sessionId, "session", true);
      continue;
    }
    if (choice === "为当前会话禁用组") {
      await setActivation(ctx, invokeCli, actions.sessionId, "session", false);
      continue;
    }
    if (choice === "记录反馈") {
      await actions.feedback();
      continue;
    }
    if (choice === "同步偏好仓库") {
      const result = await invokeCli(["sync"], undefined, 120_000);
      if (typeof result.push_error === "string") {
        ctx.ui.notify(`本地偏好已提交，远端推送失败：${result.push_error}（${text(result.sync_state, "error")}）`, "warning");
      } else {
        ctx.ui.notify(`偏好同步完成：${text(result.sync_state, "unknown")}。`, "info");
      }
      continue;
    }
    const confirmed = await ctx.ui.confirm("撤销最近一次变化？", "将通过 Git 新提交恢复最近一次组或规则变化。");
    if (!confirmed) continue;
    await invokeCli(["rollback"], undefined, 120_000);
    ctx.ui.notify("最近一次偏好变化已撤销。", "info");
  }
}
