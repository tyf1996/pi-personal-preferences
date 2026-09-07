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

function assistantStopReason(entry: Entry): unknown {
  if (messageRole(entry) !== "assistant") return undefined;
  return (entry.message as { stopReason?: unknown } | undefined)?.stopReason;
}

function assistantEndsTask(entry: Entry): boolean {
  return ["stop", "length", "error", "aborted"].includes(String(assistantStopReason(entry)));
}

function assistantTerminal(entry: Entry): boolean {
  return assistantStopReason(entry) === "stop";
}

function assistantCompleted(entry: Entry): boolean {
  return assistantTerminal(entry) && Boolean(visibleText(entry.message));
}

function sourceKey(userEntryId: string, assistantEntryId: string): string {
  return `feedback-task-${createHash("sha256").update(`${userEntryId}:${assistantEntryId}`).digest("hex").slice(0, 24)}`;
}

function sourcePair(userEntryId: string, assistantEntryId: string): string {
  return `${userEntryId}:${assistantEntryId}`;
}

function validMarker(value: unknown): { task_key: string; user_entry_id: string; assistant_entry_id: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.schema_version !== 2 || typeof data.task_key !== "string" || !/^feedback-task-[0-9a-f]{24}$/u.test(data.task_key)
      || typeof data.user_entry_id !== "string" || !data.user_entry_id
      || typeof data.assistant_entry_id !== "string" || !data.assistant_entry_id) return undefined;
  return { task_key: data.task_key, user_entry_id: data.user_entry_id, assistant_entry_id: data.assistant_entry_id };
}

/**
 * Uses only SessionManager's active branch APIs. Real user/final-assistant
 * messages are the source; body-free markers only preserve identity and dedupe.
 * Summaries and unrelated branches cannot substitute source text.
 */
export class FeedbackContext {
  private targets = new Map<string, FeedbackTarget>();

  private branch(ctx: ExtensionContext): Entry[] {
    const manager = ctx.sessionManager as unknown as { getLeafId?: () => string | null; getBranch?: (fromId?: string) => unknown[] };
    if (typeof manager.getLeafId !== "function" || typeof manager.getBranch !== "function") return [];
    const leaf = manager.getLeafId();
    return manager.getBranch(leaf ?? undefined) as Entry[];
  }

  private targetsFromBranch(ctx: ExtensionContext): FeedbackTarget[] {
    const branch = this.branch(ctx);
    const parsed: FeedbackTarget[] = [];
    let taskStart = 0;

    for (let assistantIndex = 0; assistantIndex < branch.length; assistantIndex += 1) {
      const assistant = branch[assistantIndex];
      if (!assistantEndsTask(assistant)) continue;
      let userIndex = -1;
      for (let index = taskStart; index < assistantIndex; index += 1) {
        const entry = branch[index];
        if (messageRole(entry) === "user" && typeof entry.id === "string" && visibleText(entry.message)) {
          userIndex = index;
          break;
        }
      }
      const user = branch[userIndex];
      if (user && typeof user.id === "string" && typeof assistant.id === "string" && assistantCompleted(assistant)) {
        const userText = branch.slice(userIndex, assistantIndex)
          .filter((entry) => messageRole(entry) === "user")
          .map((entry) => visibleText(entry.message))
          .filter((text): text is string => Boolean(text))
          .join("\n");
        const assistantText = visibleText(assistant.message);
        if (userText && assistantText) {
          parsed.push({
            taskKey: sourceKey(user.id, assistant.id),
            userEntryId: user.id,
            assistantEntryId: assistant.id,
            userText,
            assistantText,
          });
        }
      }
      taskStart = assistantIndex + 1;
    }

    const parsedPairs = new Set(parsed.map((target) => sourcePair(target.userEntryId, target.assistantEntryId)));
    const markerKeys = new Map<string, string>();
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== "personal-preferences-feedback-target") continue;
      const marker = validMarker(entry.data);
      if (!marker) continue;
      const pair = sourcePair(marker.user_entry_id, marker.assistant_entry_id);
      if (parsedPairs.has(pair) && !markerKeys.has(pair)) {
        markerKeys.set(pair, marker.task_key);
      }
    }

    const manager = ctx.sessionManager as unknown as { getChildren?: (parentId: string) => unknown[] };
    if (typeof manager.getChildren === "function") {
      const traversableMetadata = new Set(["custom", "label", "session_info", "model_change", "thinking_level_change"]);
      for (const target of parsed) {
        const pair = sourcePair(target.userEntryId, target.assistantEntryId);
        if (markerKeys.has(pair)) continue;
        const pending = [...manager.getChildren(target.assistantEntryId)] as Entry[];
        const visited = new Set<string>();
        while (pending.length && visited.size < 64) {
          const entry = pending.shift()!;
          if (typeof entry.id !== "string" || visited.has(entry.id)) continue;
          visited.add(entry.id);
          if (entry.type === "custom" && entry.customType === "personal-preferences-feedback-target") {
            const marker = validMarker(entry.data);
            if (marker && sourcePair(marker.user_entry_id, marker.assistant_entry_id) === pair) {
              markerKeys.set(pair, marker.task_key);
              break;
            }
          }
          if (!traversableMetadata.has(String(entry.type))) continue;
          pending.push(...manager.getChildren(entry.id) as Entry[]);
        }
      }
    }

    const cachedKeys = new Map<string, string>();
    for (const target of this.targets.values()) {
      cachedKeys.set(sourcePair(target.userEntryId, target.assistantEntryId), target.taskKey);
    }
    const usedKeys = new Set<string>();
    return parsed.map((target) => {
      const pair = sourcePair(target.userEntryId, target.assistantEntryId);
      const preferredKey = markerKeys.get(pair) ?? cachedKeys.get(pair) ?? target.taskKey;
      const taskKey = usedKeys.has(preferredKey) ? target.taskKey : preferredKey;
      usedKeys.add(taskKey);
      return { ...target, taskKey };
    });
  }

  restore(ctx: ExtensionContext): FeedbackTarget[] {
    this.targets.clear();
    return this.available(ctx);
  }

  markSettled(ctx: ExtensionContext, appendMarker: (data: Record<string, unknown>) => void): FeedbackTarget | undefined {
    const branch = this.branch(ctx);
    const target = this.targetsFromBranch(ctx).at(-1);
    if (!target) return undefined;
    this.targets.set(target.taskKey, target);
    const alreadyMarked = branch.some((entry) => {
      if (entry.type !== "custom" || entry.customType !== "personal-preferences-feedback-target") return false;
      const marker = validMarker(entry.data);
      return marker?.task_key === target.taskKey
        && marker.user_entry_id === target.userEntryId
        && marker.assistant_entry_id === target.assistantEntryId;
    });
    if (alreadyMarked) return target;
    // Marker contains only immutable entry references. No user/assistant body
    // is persisted here; data is re-projected from the active branch on reload.
    appendMarker({
      schema_version: 2,
      task_key: target.taskKey,
      user_entry_id: target.userEntryId,
      assistant_entry_id: target.assistantEntryId,
    });
    return target;
  }

  available(ctx: ExtensionContext): FeedbackTarget[] {
    const live = this.targetsFromBranch(ctx);
    this.targets.clear();
    for (const target of live) this.targets.set(target.taskKey, target);
    return live;
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
