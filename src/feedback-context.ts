import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface FileChange {
  tool: "edit" | "write";
  path: string;
  content: string;
}

export interface ConversationTurn {
  user: string;
  assistant: string;
  file_changes?: FileChange[];
}

type Entry = { type?: unknown; message?: unknown };
type ToolName = FileChange["tool"];

interface PendingChange {
  id: string;
  tool: ToolName;
  input: Record<string, unknown>;
  order: number;
  change?: FileChange;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_CREDENTIAL]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_CREDENTIAL]"],
  [/\b(?:api[_-]?key|access[_-]?token|password|authorization)\b\s*[:=]\s*\S+/giu, "[REDACTED_CREDENTIAL]"],
];

function redact(value: string): string {
  let result = value.replace(/\u0000/gu, "");
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

function clean(value: string): string {
  return redact(value).trim();
}

function role(entry: Entry): string | undefined {
  const message = entry.message;
  return message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
    ? (message as { role: string }).role
    : undefined;
}

function visibleText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return clean(content) || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => Boolean(part)
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
  return clean(text) || undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toolCalls(message: unknown, startOrder: number): PendingChange[] {
  if (!message || typeof message !== "object" || !Array.isArray((message as { content?: unknown }).content)) return [];
  const result: PendingChange[] = [];
  for (const part of (message as { content: unknown[] }).content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
    const call = part as Record<string, unknown>;
    if (typeof call.id !== "string" || (call.name !== "edit" && call.name !== "write")) continue;
    const input = record(call.arguments);
    if (!input) continue;
    result.push({ id: call.id, tool: call.name, input, order: startOrder + result.length });
  }
  return result;
}

function pathFrom(input: Record<string, unknown>): string | null {
  if (typeof input.path !== "string") return null;
  const path = clean(input.path);
  return path || null;
}

function replacementBlocks(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  let rawEdits: unknown = input.edits;
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits);
    } catch {
      rawEdits = undefined;
    }
  }
  const values = Array.isArray(rawEdits) ? rawEdits : rawEdits && typeof rawEdits === "object" ? [rawEdits] : [];
  const blocks = values.flatMap((value) => {
    const item = record(value);
    return item && typeof item.oldText === "string" && typeof item.newText === "string"
      ? [{ oldText: redact(item.oldText), newText: redact(item.newText) }]
      : [];
  });
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    blocks.push({ oldText: redact(input.oldText), newText: redact(input.newText) });
  }
  return blocks;
}

function replacementContent(blocks: Array<{ oldText: string; newText: string }>): string | null {
  if (!blocks.length) return null;
  return blocks.map((block, index) => blocks.length === 1
    ? `--- 修改前 ---\n${block.oldText}\n--- 修改后 ---\n${block.newText}`
    : `--- 第 ${index + 1} 处修改前 ---\n${block.oldText}\n--- 第 ${index + 1} 处修改后 ---\n${block.newText}`).join("\n\n");
}

function successfulChange(pending: PendingChange, message: Record<string, unknown>): FileChange | undefined {
  if (message.toolCallId !== pending.id || message.toolName !== pending.tool || message.isError !== false) return undefined;
  const path = pathFrom(pending.input);
  if (!path) return undefined;
  if (pending.tool === "write") {
    return typeof pending.input.content === "string"
      ? { tool: "write", path, content: redact(pending.input.content) }
      : undefined;
  }
  const details = record(message.details);
  const patch = details && typeof details.patch === "string" && details.patch.trim() ? redact(details.patch) : null;
  const diff = details && typeof details.diff === "string" && details.diff.trim() ? redact(details.diff) : null;
  const content = patch ?? diff ?? replacementContent(replacementBlocks(pending.input));
  return content === null ? undefined : { tool: "edit", path, content };
}

/** Project real messages and confirmed successful edit/write calls from SessionManager's current branch. */
export function recentConversationTurns(ctx: Pick<ExtensionContext, "sessionManager">): ConversationTurn[] {
  const branch = ctx.sessionManager.getBranch() as Entry[];
  const turns: ConversationTurn[] = [];
  let users: string[] = [];
  let assistants: string[] = [];
  let pending = new Map<string, PendingChange>();
  let nextOrder = 0;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const messageRole = role(entry);
    if (messageRole === "user") {
      const text = visibleText(entry.message);
      if (text) users.push(text);
      continue;
    }
    if (messageRole === "toolResult") {
      if (!entry.message || typeof entry.message !== "object") continue;
      const result = entry.message as Record<string, unknown>;
      if (typeof result.toolCallId !== "string") continue;
      const call = pending.get(result.toolCallId);
      if (!call || result.toolName !== call.tool) continue;
      call.change = successfulChange(call, result);
      continue;
    }
    if (messageRole !== "assistant" || users.length === 0) continue;
    const text = visibleText(entry.message);
    if (text) assistants.push(text);
    for (const call of toolCalls(entry.message, nextOrder)) {
      if (!pending.has(call.id)) {
        pending.set(call.id, call);
        nextOrder += 1;
      }
    }
    const stopReason = (entry.message as { stopReason?: unknown }).stopReason;
    if (stopReason === "toolUse" || stopReason === "pending" || stopReason === undefined) continue;
    if (stopReason === "stop" && assistants.length) {
      const fileChanges = [...pending.values()]
        .filter((call): call is PendingChange & { change: FileChange } => Boolean(call.change))
        .sort((left, right) => left.order - right.order)
        .map((call) => call.change);
      turns.push({
        user: users.join("\n\n"),
        assistant: assistants.join("\n\n"),
        ...(fileChanges.length ? { file_changes: fileChanges } : {}),
      });
    }
    users = [];
    assistants = [];
    pending = new Map();
    nextOrder = 0;
  }

  return turns.slice(-10);
}

function preview(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export async function selectConversationTurns(
  ctx: ExtensionCommandContext,
  turns: ConversationTurn[],
): Promise<ConversationTurn[] | null> {
  if (ctx.mode !== "tui") throw new Error("/pref feedback 需要交互式 TUI 选择对话");
  return ctx.ui.custom<ConversationTurn[] | null>((tui, theme, _keybindings, done) => {
    let cursor = Math.max(0, turns.length - 1);
    const selected = new Set<number>();
    return {
      render(width: number): string[] {
        const lines = [
          truncateToWidth(theme.fg("accent", theme.bold("选择最近对话")), width),
          truncateToWidth(theme.fg("dim", "Space 勾选/取消 · ↑↓ 移动 · Enter 完成 · Esc 取消"), width),
          "",
        ];
        const terminalRows = Math.max(4, Number(tui.terminal?.rows) || 24);
        const visibleCount = Math.max(1, Math.floor((terminalRows - lines.length) / 3));
        const start = Math.max(0, Math.min(
          cursor - Math.floor(visibleCount / 2),
          Math.max(0, turns.length - visibleCount),
        ));
        const end = Math.min(turns.length, start + visibleCount);
        for (let index = start; index < end; index += 1) {
          const turn = turns[index]!;
          const pointer = index === cursor ? theme.fg("accent", ">") : " ";
          const box = selected.has(index) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
          const count = turn.file_changes?.length ?? 0;
          const title = `${pointer} ${box} ${index + 1}. 用户：${preview(turn.user)}${count ? ` · 成功改动 ${count}` : ""}`;
          lines.push(truncateToWidth(title, width, "…"));
          const assistant = theme.fg("muted", `      助手：${preview(turn.assistant)}`);
          lines.push(...wrapTextWithAnsi(assistant, Math.max(1, width)).slice(0, 2));
        }
        return lines;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
        else if (matchesKey(data, Key.down)) cursor = Math.min(turns.length - 1, cursor + 1);
        else if (matchesKey(data, Key.space)) {
          if (selected.has(cursor)) selected.delete(cursor);
          else selected.add(cursor);
        } else if (matchesKey(data, Key.enter)) {
          done([...selected].sort((a, b) => a - b).map((index) => turns[index]!));
          return;
        } else if (matchesKey(data, Key.left) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(null);
          return;
        }
        tui.requestRender();
      },
      invalidate(): void {},
    };
  });
}
