import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FeedbackTarget {
  taskKey: string;
  userEntryId: string;
  assistantEntryId: string;
  userText: string;
  assistantText: string;
}

export interface FeedbackSnapshot {
  session_id: string;
  task_key: string;
  user_entry_id: string;
  assistant_entry_id: string;
  user_text: string;
  assistant_text: string;
  origin_verified: true;
  storage_mode: "local_only" | "ask";
}

type Entry = { id?: unknown; type?: unknown; customType?: unknown; data?: unknown; message?: unknown };

function clean(value: string): string {
  return value.replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|password)\b\s*[:=]\s*\S+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/(?<![\w.:/-])\/(?:[^/\s]+\/)+[^/\s]+/g, "[REDACTED_PATH]")
    .replace(/\s+/g, " ").trim().slice(0, 4000);
}

function visibleText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return clean(content) || undefined;
  if (!Array.isArray(content)) return undefined;
  // Pi text blocks are user-visible. Thinking, tool calls/results, images, and
  // all other block types are intentionally excluded at the trust boundary.
  const text = content.filter((part): part is { type: "text"; text: string } => Boolean(part)
    && typeof part === "object" && (part as { type?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text).join("\n");
  return clean(text) || undefined;
}

function messageRole(entry: Entry): string | undefined {
  const message = entry.message;
  return message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
    ? (message as { role: string }).role : undefined;
}

function assistantCompleted(entry: Entry): boolean {
  if (messageRole(entry) !== "assistant") return false;
  const message = entry.message as { stopReason?: unknown } | undefined;
  return message?.stopReason !== "aborted" && message?.stopReason !== "error" && Boolean(visibleText(entry.message));
}

function validMarker(value: unknown): { task_key: string; user_entry_id: string; assistant_entry_id: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.schema_version !== 2 || typeof data.task_key !== "string" || typeof data.user_entry_id !== "string" || typeof data.assistant_entry_id !== "string") return undefined;
  return { task_key: data.task_key, user_entry_id: data.user_entry_id, assistant_entry_id: data.assistant_entry_id };
}

/**
 * Uses only SessionManager's active branch and entry APIs. Markers retain IDs,
 * never message bodies, so reload/fork/compaction cannot silently substitute a
 * synthetic prompt or transcript-derived target.
 */
export class FeedbackContext {
  private targets = new Map<string, FeedbackTarget>();

  private branch(ctx: ExtensionContext): Entry[] {
    const manager = ctx.sessionManager as unknown as { getLeafId?: () => string | null; getBranch?: (fromId?: string) => unknown[] };
    if (typeof manager.getLeafId !== "function" || typeof manager.getBranch !== "function") return [];
    const leaf = manager.getLeafId();
    return manager.getBranch(leaf ?? undefined) as Entry[];
  }

  private targetFromMarker(ctx: ExtensionContext, marker: { task_key: string; user_entry_id: string; assistant_entry_id: string }): FeedbackTarget | undefined {
    const manager = ctx.sessionManager as unknown as { getEntry?: (id: string) => unknown };
    if (typeof manager.getEntry !== "function") return undefined;
    const branch = this.branch(ctx);
    const branchIds = new Set(branch.map((entry) => typeof entry.id === "string" ? entry.id : undefined).filter((id): id is string => Boolean(id)));
    if (!branchIds.has(marker.user_entry_id) || !branchIds.has(marker.assistant_entry_id)) return undefined;
    const user = manager.getEntry(marker.user_entry_id) as Entry | undefined;
    const assistant = manager.getEntry(marker.assistant_entry_id) as Entry | undefined;
    if (!user || !assistant || messageRole(user) !== "user" || !assistantCompleted(assistant)) return undefined;
    const userIndex = branch.findIndex((entry) => entry.id === marker.user_entry_id);
    const assistantIndex = branch.findIndex((entry) => entry.id === marker.assistant_entry_id);
    if (userIndex < 0 || assistantIndex <= userIndex) return undefined;
    const userText = branch.slice(userIndex, assistantIndex)
      .filter((entry) => messageRole(entry) === "user")
      .map((entry) => visibleText(entry.message))
      .filter((text): text is string => Boolean(text))
      .join("\n");
    const assistantText = visibleText(assistant.message);
    if (!userText || !assistantText) return undefined;
    return { taskKey: marker.task_key, userEntryId: marker.user_entry_id, assistantEntryId: marker.assistant_entry_id, userText, assistantText };
  }

  restore(ctx: ExtensionContext): FeedbackTarget[] {
    this.targets.clear();
    for (const entry of this.branch(ctx)) {
      if (entry.type !== "custom" || entry.customType !== "personal-preferences-feedback-target") continue;
      const marker = validMarker(entry.data);
      if (!marker) continue;
      const target = this.targetFromMarker(ctx, marker);
      if (target) this.targets.set(target.taskKey, target);
    }
    return this.available(ctx);
  }

  markSettled(ctx: ExtensionContext, appendMarker: (data: Record<string, unknown>) => void): FeedbackTarget | undefined {
    const branch = this.branch(ctx);
    let assistant: Entry | undefined;
    let assistantIndex = -1;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (assistantCompleted(entry)) { assistant = entry; assistantIndex = index; break; }
    }
    let previousAssistantIndex = -1;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (assistantCompleted(branch[index])) { previousAssistantIndex = index; break; }
    }
    const userCandidates = branch.slice(previousAssistantIndex + 1, assistantIndex)
      .filter((entry) => messageRole(entry) === "user" && visibleText(entry.message));
    const user = userCandidates[0];
    if (!user || !assistant || typeof user.id !== "string" || typeof assistant.id !== "string") return undefined;
    const taskKey = `feedback-task-${createHash("sha256").update(`${ctx.sessionManager.getSessionId()}:${user.id}:${assistant.id}`).digest("hex").slice(0, 24)}`;
    const marker = { schema_version: 2, task_key: taskKey, user_entry_id: user.id, assistant_entry_id: assistant.id };
    const target = this.targetFromMarker(ctx, marker);
    if (!target) return undefined;
    this.targets.set(taskKey, target);
    const alreadyMarked = branch.some((entry) => entry.type === "custom" && entry.customType === "personal-preferences-feedback-target" && validMarker(entry.data)?.task_key === taskKey);
    if (alreadyMarked) return target;
    // Marker contains only immutable entry references. No user/assistant body
    // is persisted here; data is re-projected from the active branch on reload.
    appendMarker(marker);
    return target;
  }

  available(ctx: ExtensionContext): FeedbackTarget[] {
    for (const [taskKey, cached] of this.targets) {
      const live = this.targetFromMarker(ctx, { task_key: taskKey, user_entry_id: cached.userEntryId, assistant_entry_id: cached.assistantEntryId });
      if (live) this.targets.set(taskKey, live);
      else this.targets.delete(taskKey);
    }
    return [...this.targets.values()];
  }

  snapshot(ctx: ExtensionContext, taskKey: string, storageMode: "local_only" | "ask"): FeedbackSnapshot | undefined {
    const target = this.available(ctx).find((item) => item.taskKey === taskKey);
    if (!target) return undefined;
    return {
      session_id: `session-${createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex").slice(0, 24)}`,
      task_key: target.taskKey,
      user_entry_id: target.userEntryId,
      assistant_entry_id: target.assistantEntryId,
      user_text: target.userText,
      assistant_text: target.assistantText,
      origin_verified: true,
      storage_mode: storageMode,
    };
  }
}
