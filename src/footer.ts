import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUS_KEY = "personal-preferences";

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface PreferenceFooterSnapshot {
  cwd: string;
  branch?: string | null;
  sessionName?: string;
  preferenceStatus?: string;
  otherStatuses?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  contextPercent?: number | null;
  contextWindow?: number;
  model?: string;
  thinkingLevel?: string;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function formatCwd(cwd: string): string {
  const home = homedir();
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome = relativeToHome === ""
    || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function locationLine(snapshot: PreferenceFooterSnapshot, width: number): string {
  const suffix = `${snapshot.branch ? ` (${snapshot.branch})` : ""}${snapshot.sessionName ? ` • ${snapshot.sessionName}` : ""}`;
  const availableForPath = Math.max(1, width - visibleWidth(suffix));
  return `${truncateToWidth(formatCwd(snapshot.cwd), availableForPath, "…")}${suffix}`;
}

function firstLine(snapshot: PreferenceFooterSnapshot, width: number): string {
  const left = locationLine(snapshot, width);
  const right = snapshot.preferenceStatus ?? "";
  if (!right || visibleWidth(left) + 2 >= width) return truncateToWidth(left, width, "…");
  const availableRight = width - visibleWidth(left) - 2;
  const safeRight = truncateToWidth(right, availableRight, "");
  const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(safeRight)));
  return truncateToWidth(`${left}${padding}${safeRight}`, width, "");
}

function secondLine(snapshot: PreferenceFooterSnapshot, width: number): string {
  const stats: string[] = [];
  if (snapshot.inputTokens) stats.push(`↑${formatTokens(snapshot.inputTokens)}`);
  if (snapshot.outputTokens) stats.push(`↓${formatTokens(snapshot.outputTokens)}`);
  if (snapshot.cacheReadTokens) stats.push(`R${formatTokens(snapshot.cacheReadTokens)}`);
  if (snapshot.cacheWriteTokens) stats.push(`W${formatTokens(snapshot.cacheWriteTokens)}`);
  if (snapshot.cost) stats.push(`$${snapshot.cost.toFixed(3)}`);
  const context = snapshot.contextPercent === null || snapshot.contextPercent === undefined
    ? `?/${formatTokens(snapshot.contextWindow ?? 0)}`
    : `${snapshot.contextPercent.toFixed(1)}%/${formatTokens(snapshot.contextWindow ?? 0)}`;
  stats.push(context);
  const model = snapshot.model
    ? `${snapshot.model}${snapshot.thinkingLevel ? ` • ${snapshot.thinkingLevel}` : ""}`
    : "no-model";
  const left = stats.join(" ");
  if (visibleWidth(left) + 2 >= width) return truncateToWidth(left, width, "…");
  const availableRight = width - visibleWidth(left) - 2;
  const right = truncateToWidth(model, availableRight, "");
  const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
  return truncateToWidth(`${left}${padding}${right}`, width, "");
}

export function renderPreferenceFooter(snapshot: PreferenceFooterSnapshot, width: number): string[] {
  const lines = [firstLine(snapshot, width), secondLine(snapshot, width)];
  if (snapshot.otherStatuses?.length) {
    const statuses = snapshot.otherStatuses
      .map((status) => status.replace(/[\r\n\t]/gu, " ").replace(/ +/gu, " ").trim())
      .filter(Boolean)
      .join(" ");
    if (statuses) lines.push(truncateToWidth(statuses, width, "…"));
  }
  return lines;
}

function usageTotals(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const rawEntry of ctx.sessionManager.getEntries()) {
    const entry = rawEntry as unknown as Record<string, any>;
    let usage: Record<string, any> | undefined;
    if (entry.type === "message") usage = entry.message?.usage;
    else if (entry.type === "branch_summary" || entry.type === "compaction") usage = entry.usage;
    if (!usage) continue;
    totals.input += Number(usage.input) || 0;
    totals.output += Number(usage.output) || 0;
    totals.cacheRead += Number(usage.cacheRead) || 0;
    totals.cacheWrite += Number(usage.cacheWrite) || 0;
    totals.cost += Number(usage.cost?.total) || 0;
  }
  return totals;
}

export function installPreferenceFooter(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const requestRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(requestRender);
    return {
      render(width: number): string[] {
        const usage = usageTotals(ctx);
        const context = ctx.getContextUsage();
        const statuses = footerData.getExtensionStatuses();
        const snapshot: PreferenceFooterSnapshot = {
          cwd: ctx.cwd,
          branch: footerData.getGitBranch(),
          sessionName: ctx.sessionManager.getSessionName(),
          preferenceStatus: statuses.get(STATUS_KEY),
          otherStatuses: [...statuses.entries()]
            .filter(([key]) => key !== STATUS_KEY)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, status]) => status),
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          cost: usage.cost,
          contextPercent: context?.percent,
          contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
          model: ctx.model?.id,
          thinkingLevel: ctx.model?.reasoning ? ctx.thinkingLevel ?? "off" : undefined,
        };
        return renderPreferenceFooter(snapshot, width).map((line) => theme.fg("dim", line));
      },
      invalidate() {},
      dispose: unsubscribe,
    };
  });
}
