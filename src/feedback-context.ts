import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ConversationTurn {
  user: string;
  assistant: string;
}

type Entry = { type?: unknown; message?: unknown };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_CREDENTIAL]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_CREDENTIAL]"],
  [/\b(?:api[_-]?key|access[_-]?token|password|authorization)\b\s*[:=]\s*\S+/giu, "[REDACTED_CREDENTIAL]"],
];

function clean(value: string): string {
  let result = value.replace(/\u0000/gu, "");
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result.trim();
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

/** Project only real messages from SessionManager's current branch. */
export function recentConversationTurns(ctx: Pick<ExtensionContext, "sessionManager">): ConversationTurn[] {
  const branch = ctx.sessionManager.getBranch() as Entry[];
  const turns: ConversationTurn[] = [];
  let users: string[] = [];
  let assistants: string[] = [];

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const messageRole = role(entry);
    if (messageRole === "user") {
      const text = visibleText(entry.message);
      if (text) users.push(text);
      continue;
    }
    if (messageRole !== "assistant" || users.length === 0) continue;
    const text = visibleText(entry.message);
    if (text) assistants.push(text);
    const stopReason = (entry.message as { stopReason?: unknown }).stopReason;
    if (stopReason === "toolUse" || stopReason === "pending" || stopReason === undefined) continue;
    if (stopReason === "stop" && assistants.length) {
      turns.push({ user: users.join("\n\n"), assistant: assistants.join("\n\n") });
    }
    users = [];
    assistants = [];
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
          const title = `${pointer} ${box} ${index + 1}. 用户：${preview(turn.user)}`;
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
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(null);
          return;
        }
        tui.requestRender();
      },
      invalidate(): void {},
    };
  });
}
