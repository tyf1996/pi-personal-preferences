import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PreferenceGroupDescription {
  name: string;
  description: string;
}

export type PreferenceCliInvoker = (
  args: string[],
  input?: unknown,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

export interface PreferenceGroupOptions {
  explicitGroup?: string;
  preferenceText: string;
  taskSummary?: string;
  touchedPaths?: string[];
  groups: readonly PreferenceGroupDescription[];
  ctx: Pick<ExtensionContext, "hasUI" | "ui">;
  invokeCli: PreferenceCliInvoker;
}

function classificationInput(options: PreferenceGroupOptions): Record<string, unknown> {
  return {
    schema_version: 1,
    preference_text: options.preferenceText.slice(0, 2000),
    task_summary: (options.taskSummary ?? "").slice(0, 1000),
    touched_paths: (options.touchedPaths ?? []).slice(0, 64),
    groups: options.groups.map((group) => ({
      name: group.name,
      description: group.description,
    })),
  };
}

function groupNames(groups: readonly PreferenceGroupDescription[]): string[] {
  return groups.map((group) => group.name);
}

async function askForGroup(options: PreferenceGroupOptions): Promise<string> {
  if (!options.ctx.hasUI) {
    throw new Error("无法自动判断偏好组，请使用 --group 指定组");
  }
  const names = groupNames(options.groups);
  if (!names.length) throw new Error("当前没有可用偏好组");
  const selected = await options.ctx.ui.select("选择偏好组", names);
  if (!selected) throw new Error("已取消偏好组选择");
  if (!names.includes(selected)) throw new Error(`所选偏好组不存在：${selected}`);
  return selected;
}

export async function resolvePreferenceGroup(options: PreferenceGroupOptions): Promise<string> {
  const names = groupNames(options.groups);
  if (options.explicitGroup !== undefined) {
    if (!names.includes(options.explicitGroup)) {
      throw new Error(`偏好组不存在：${options.explicitGroup}`);
    }
    return options.explicitGroup;
  }
  if (!names.length) throw new Error("当前没有可用偏好组");

  let result: Record<string, unknown>;
  try {
    result = await options.invokeCli(
      ["classify-group", "--stdin"],
      classificationInput(options),
    );
  } catch {
    return askForGroup(options);
  }
  if (
    Object.keys(result).length === 1
    && typeof result.group === "string"
    && names.includes(result.group)
  ) {
    return result.group;
  }
  return askForGroup(options);
}
