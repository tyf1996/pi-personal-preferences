import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface FileChange {
  tool: "edit" | "write";
  path: string;
  content: string;
}

export interface LegacyConversationTurn {
  user: string;
  assistant: string;
  file_changes?: FileChange[];
}

export type ConversationEvent =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "file_change_call"; call_id: string; tool: "edit" | "write"; path: string }
  | { type: "file_change_result"; call_id: string; content: string };

export interface EventConversationTurn {
  events: ConversationEvent[];
}

export type ConversationTurn = LegacyConversationTurn | EventConversationTurn;
export type ConversationQuoteRole = "user" | "assistant" | "both" | "tool" | "unknown";

type Entry = { type?: unknown; message?: unknown };
type ToolName = FileChange["tool"];

interface PendingChange {
  id: string;
  tool: ToolName;
  input: Record<string, unknown>;
  order: number;
  finalResultSerial?: number;
  change?: FileChange;
}

type DraftEvent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "call"; nativeId: string }
  | { kind: "result"; nativeId: string; serial: number };

const MAX_TEXT_CHARACTERS = 4 * 1024 * 1024;
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
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

function messageContent(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textBlock(part: unknown): string | undefined {
  if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text"
    || typeof (part as { text?: unknown }).text !== "string") return undefined;
  return clean((part as { text: string }).text) || undefined;
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

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}结构无效`);
  }
}

function requiredStoredText(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > MAX_TEXT_CHARACTERS) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function storedFileChange(value: unknown, label: string): FileChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}结构无效`);
  const item = value as Record<string, unknown>;
  exactKeys(item, ["tool", "path", "content"], label);
  if (item.tool !== "edit" && item.tool !== "write") throw new Error(`${label}.tool无效`);
  const path = requiredStoredText(item.path, `${label}.path`);
  if (path.length > 4096) throw new Error(`${label}.path无效`);
  return {
    tool: item.tool,
    path,
    content: requiredStoredText(item.content, `${label}.content`, item.tool === "write"),
  };
}

/** Validate one persisted legacy or ordered-event turn without converting its shape. */
export function parseConversationTurn(value: unknown): ConversationTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("反馈对话结构无效");
  const turn = value as Record<string, unknown>;
  if (Object.hasOwn(turn, "events")) {
    exactKeys(turn, ["events"], "反馈事件轮次");
    if (!Array.isArray(turn.events) || !turn.events.length) throw new Error("反馈事件数组无效");
    const events: ConversationEvent[] = [];
    const calls = new Map<string, ToolName>();
    const results = new Set<string>();
    let userCount = 0;
    let assistantCount = 0;
    for (const [index, raw] of turn.events.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`反馈事件[${index}]结构无效`);
      const event = raw as Record<string, unknown>;
      if (event.type === "user" || event.type === "assistant") {
        exactKeys(event, ["type", "text"], `反馈事件[${index}]`);
        events.push({ type: event.type, text: requiredStoredText(event.text, `反馈事件[${index}].text`) });
        if (event.type === "user") userCount += 1;
        else assistantCount += 1;
        continue;
      }
      if (event.type === "file_change_call") {
        exactKeys(event, ["type", "call_id", "tool", "path"], `反馈事件[${index}]`);
        if (typeof event.call_id !== "string" || !CALL_ID_PATTERN.test(event.call_id) || calls.has(event.call_id)) {
          throw new Error(`反馈事件[${index}].call_id无效`);
        }
        if (event.tool !== "edit" && event.tool !== "write") throw new Error(`反馈事件[${index}].tool无效`);
        const path = requiredStoredText(event.path, `反馈事件[${index}].path`);
        if (path.length > 4096) throw new Error(`反馈事件[${index}].path无效`);
        calls.set(event.call_id, event.tool);
        events.push({ type: "file_change_call", call_id: event.call_id, tool: event.tool, path });
        continue;
      }
      if (event.type === "file_change_result") {
        exactKeys(event, ["type", "call_id", "content"], `反馈事件[${index}]`);
        if (typeof event.call_id !== "string" || !CALL_ID_PATTERN.test(event.call_id)
          || !calls.has(event.call_id) || results.has(event.call_id)) {
          throw new Error(`反馈事件[${index}].call_id引用无效`);
        }
        const content = requiredStoredText(event.content, `反馈事件[${index}].content`, calls.get(event.call_id) === "write");
        results.add(event.call_id);
        events.push({ type: "file_change_result", call_id: event.call_id, content });
        continue;
      }
      throw new Error(`反馈事件[${index}].type无效`);
    }
    if (!userCount || !assistantCount || calls.size !== results.size) throw new Error("反馈事件轮次不完整");
    return { events };
  }

  const allowed = Object.hasOwn(turn, "file_changes") ? ["user", "assistant", "file_changes"] : ["user", "assistant"];
  exactKeys(turn, allowed, "旧反馈轮次");
  const result: LegacyConversationTurn = {
    user: requiredStoredText(turn.user, "旧反馈user"),
    assistant: requiredStoredText(turn.assistant, "旧反馈assistant"),
  };
  if (Object.hasOwn(turn, "file_changes")) {
    if (!Array.isArray(turn.file_changes)) throw new Error("旧反馈file_changes结构无效");
    result.file_changes = turn.file_changes.map((item, index) => storedFileChange(item, `旧反馈file_changes[${index}]`));
  }
  return result;
}

export function turnUserText(turn: ConversationTurn): string {
  return "events" in turn
    ? turn.events.filter((event): event is Extract<ConversationEvent, { type: "user" }> => event.type === "user").map((event) => event.text).join("\n\n")
    : turn.user;
}

export function turnAssistantText(turn: ConversationTurn): string {
  return "events" in turn
    ? turn.events.filter((event): event is Extract<ConversationEvent, { type: "assistant" }> => event.type === "assistant").map((event) => event.text).join("\n\n")
    : turn.assistant;
}

export function turnFileChanges(turn: ConversationTurn): FileChange[] {
  if (!("events" in turn)) return turn.file_changes ?? [];
  const results = new Map<string, string>();
  for (const event of turn.events) {
    if (event.type === "file_change_result") results.set(event.call_id, event.content);
  }
  return turn.events.flatMap((event) => event.type === "file_change_call" && results.has(event.call_id)
    ? [{ tool: event.tool, path: event.path, content: results.get(event.call_id)! }]
    : []);
}

export function conversationQuoteRole(turns: ConversationTurn[], quote: string): ConversationQuoteRole {
  let inUser = false;
  let inAssistant = false;
  let inTool = false;
  for (const turn of turns) {
    if ("events" in turn) {
      inUser ||= turn.events.some((event) => event.type === "user" && event.text.includes(quote));
      inAssistant ||= turn.events.some((event) => event.type === "assistant" && event.text.includes(quote));
      inTool ||= turn.events.some((event) => event.type === "file_change_result" && event.content.includes(quote));
    } else {
      inUser ||= turn.user.includes(quote);
      inAssistant ||= turn.assistant.includes(quote);
      inTool ||= (turn.file_changes ?? []).some((change) => change.content.includes(quote));
    }
  }
  return inUser && inAssistant ? "both" : inUser ? "user" : inAssistant ? "assistant" : inTool ? "tool" : "unknown";
}

function completeTurn(drafts: DraftEvent[], pending: Map<string, PendingChange>): EventConversationTurn | null {
  const successful = [...pending.values()]
    .filter((call): call is PendingChange & { finalResultSerial: number; change: FileChange } =>
      call.finalResultSerial !== undefined && Boolean(call.change))
    .sort((left, right) => left.order - right.order);
  const localIds = new Map(successful.map((call, index) => [call.id, `change-${index + 1}`]));
  const events = drafts.flatMap<ConversationEvent>((draft) => {
    if (draft.kind === "user" || draft.kind === "assistant") return [{ type: draft.kind, text: draft.text }];
    const call = pending.get(draft.nativeId);
    const callId = localIds.get(draft.nativeId);
    if (!call || !callId || !call.change) return [];
    if (draft.kind === "call") {
      return [{ type: "file_change_call", call_id: callId, tool: call.change.tool, path: call.change.path }];
    }
    return draft.serial === call.finalResultSerial
      ? [{ type: "file_change_result", call_id: callId, content: call.change.content }]
      : [];
  });
  const hasUser = events.some((event) => event.type === "user");
  const hasAssistant = events.some((event) => event.type === "assistant");
  return hasUser && hasAssistant ? { events } : null;
}

/** Project complete real messages and final successful edit/write events from the current branch. */
export function recentConversationTurns(ctx: Pick<ExtensionContext, "sessionManager">): ConversationTurn[] {
  const branch = ctx.sessionManager.getBranch() as Entry[];
  const turns: ConversationTurn[] = [];
  let drafts: DraftEvent[] = [];
  let pending = new Map<string, PendingChange>();
  let nextCallOrder = 0;
  let nextResultSerial = 0;
  let hasUser = false;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const messageRole = role(entry);
    if (messageRole === "user") {
      for (const part of messageContent(entry.message)) {
        const text = textBlock(part);
        if (text) {
          drafts.push({ kind: "user", text });
          hasUser = true;
        }
      }
      continue;
    }
    if (messageRole === "toolResult") {
      if (!entry.message || typeof entry.message !== "object") continue;
      const result = entry.message as Record<string, unknown>;
      if (typeof result.toolCallId !== "string") continue;
      const call = pending.get(result.toolCallId);
      if (!call || result.toolName !== call.tool) continue;
      const serial = nextResultSerial++;
      drafts.push({ kind: "result", nativeId: call.id, serial });
      call.finalResultSerial = serial;
      call.change = successfulChange(call, result);
      continue;
    }
    if (messageRole !== "assistant" || !hasUser) continue;
    for (const part of messageContent(entry.message)) {
      const text = textBlock(part);
      if (text) {
        drafts.push({ kind: "assistant", text });
        continue;
      }
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
      const raw = part as Record<string, unknown>;
      if (typeof raw.id !== "string" || (raw.name !== "edit" && raw.name !== "write") || pending.has(raw.id)) continue;
      const input = record(raw.arguments);
      if (!input) continue;
      pending.set(raw.id, { id: raw.id, tool: raw.name, input, order: nextCallOrder++ });
      drafts.push({ kind: "call", nativeId: raw.id });
    }
    const stopReason = (entry.message as { stopReason?: unknown }).stopReason;
    if (stopReason === "toolUse" || stopReason === "pending" || stopReason === undefined) continue;
    if (stopReason === "stop") {
      const completed = completeTurn(drafts, pending);
      if (completed) turns.push(completed);
    }
    drafts = [];
    pending = new Map();
    nextCallOrder = 0;
    nextResultSerial = 0;
    hasUser = false;
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
          const count = turnFileChanges(turn).length;
          const title = `${pointer} ${box} ${index + 1}. 用户：${preview(turnUserText(turn))}${count ? ` · 成功改动 ${count}` : ""}`;
          lines.push(truncateToWidth(title, width, "…"));
          const assistant = theme.fg("muted", `      助手：${preview(turnAssistantText(turn))}`);
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
