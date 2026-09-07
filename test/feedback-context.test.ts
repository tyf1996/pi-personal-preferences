import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FeedbackContext } from "../src/feedback-context.ts";

function context(session: SessionManager): any { return { sessionManager: session }; }

function assistant(
  content: Array<Record<string, unknown>>,
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "pending" = "stop",
): any {
  return { role: "assistant", content, stopReason, timestamp: Date.now() };
}

function appendTarget(session: SessionManager, userText: string, assistantText: string): { userId: string; assistantId: string } {
  const userId = session.appendMessage({ role: "user", content: userText, timestamp: Date.now() } as any);
  const assistantId = session.appendMessage(assistant([{ type: "text", text: assistantText }]));
  return { userId, assistantId };
}

test("feedback context binds a settled active branch, reuses marker identity, and excludes thinking", () => {
  const session = SessionManager.inMemory("/workspace");
  session.appendMessage({ role: "user", content: "请用中文回答", timestamp: Date.now() } as any);
  session.appendMessage(assistant([{ type: "thinking", thinking: "private" }, { type: "text", text: "好的，我会使用中文。" }]));
  const markers: Record<string, unknown>[] = [];
  const feedback = new FeedbackContext();
  const target = feedback.markSettled(context(session), (marker) => { markers.push(marker); session.appendCustomEntry("personal-preferences-feedback-target", marker); });
  assert.ok(target);
  assert.equal(markers.length, 1);
  const restored = new FeedbackContext();
  assert.equal(restored.restore(context(session)).length, 1);
  const snapshot = restored.snapshot(context(session), target!.taskKey, "ask")!;
  assert.match(snapshot.assistant_text, /使用中文/);
  assert.doesNotMatch(snapshot.assistant_text, /private/);
});

test("feedback context rejects a branch without a completed user/result target", () => {
  const session = SessionManager.inMemory("/workspace");
  session.appendMessage({ role: "user", content: "只有请求", timestamp: Date.now() } as any);
  const feedback = new FeedbackContext();
  assert.equal(feedback.markSettled(context(session), () => undefined), undefined);
  assert.equal(feedback.snapshot(context(session), "missing", "ask"), undefined);
});

test("feedback context restores markerless legacy user and final assistant messages", () => {
  const session = SessionManager.inMemory("/workspace");
  appendTarget(session, "旧会话请求", "旧会话最终结果");

  const feedback = new FeedbackContext();
  const targets = feedback.restore(context(session));
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.userText, "旧会话请求");
  assert.equal(targets[0]?.assistantText, "旧会话最终结果");
  assert.equal(feedback.snapshot(context(session), targets[0]!.taskKey, "ask")?.origin_verified, true);
});

test("feedback context treats tool-use text as intermediate and binds the final answer", () => {
  const session = SessionManager.inMemory("/workspace");
  const userId = session.appendMessage({ role: "user", content: "检查状态后给结论", timestamp: Date.now() } as any);
  session.appendMessage(assistant([
    { type: "text", text: "我先检查状态。" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "status.txt" } },
  ], "toolUse"));
  session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "raw tool output" }], isError: false, timestamp: Date.now() } as any);
  const assistantId = session.appendMessage(assistant([{ type: "text", text: "最终结论：状态正常。" }]));

  const target = new FeedbackContext().markSettled(context(session), () => undefined);
  assert.equal(target?.userEntryId, userId);
  assert.equal(target?.assistantEntryId, assistantId);
  assert.equal(target?.assistantText, "最终结论：状态正常。");
  assert.doesNotMatch(target?.assistantText ?? "", /先检查|raw tool/u);
});

test("feedback context keeps multiple tools and user supplements in one task", () => {
  const session = SessionManager.inMemory("/workspace");
  const firstUserId = session.appendMessage({ role: "user", content: "先检查实现", timestamp: Date.now() } as any);
  session.appendMessage(assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], "toolUse"));
  session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one" }], isError: false, timestamp: Date.now() } as any);
  session.appendMessage({ role: "user", content: "补充：还要检查测试", timestamp: Date.now() } as any);
  session.appendMessage(assistant([{ type: "text", text: "继续检查。" }, { type: "toolCall", id: "call-2", name: "grep", arguments: {} }], "toolUse"));
  session.appendMessage({ role: "toolResult", toolCallId: "call-2", toolName: "grep", content: [{ type: "text", text: "two" }], isError: false, timestamp: Date.now() } as any);
  const finalId = session.appendMessage(assistant([{ type: "text", text: "实现和测试均已检查。" }]));

  const target = new FeedbackContext().markSettled(context(session), () => undefined);
  assert.equal(target?.userEntryId, firstUserId);
  assert.equal(target?.assistantEntryId, finalId);
  assert.match(target?.userText ?? "", /先检查实现.*补充：还要检查测试/su);
  assert.equal(target?.assistantText, "实现和测试均已检查。");
});

test("feedback context rejects every non-final assistant stop reason", () => {
  for (const stopReason of ["toolUse", "pending", "error", "aborted", "length"] as const) {
    const session = SessionManager.inMemory("/workspace");
    session.appendMessage({ role: "user", content: `请求-${stopReason}`, timestamp: Date.now() } as any);
    session.appendMessage(assistant([{ type: "text", text: `未完成-${stopReason}` }], stopReason));
    const feedback = new FeedbackContext();
    assert.equal(feedback.markSettled(context(session), () => undefined), undefined, stopReason);
    assert.deepEqual(feedback.restore(context(session)), [], stopReason);
  }
});

test("error, aborted, and length end failed tasks without merging their users into the next task", () => {
  for (const stopReason of ["error", "aborted", "length"] as const) {
    const session = SessionManager.inMemory("/workspace");
    session.appendMessage({ role: "user", content: `任务 A-${stopReason}`, timestamp: Date.now() } as any);
    session.appendMessage(assistant([{ type: "text", text: `失败响应-${stopReason}` }], stopReason));
    const nextUserId = session.appendMessage({ role: "user", content: `任务 B-${stopReason}`, timestamp: Date.now() } as any);
    const finalId = session.appendMessage(assistant([{ type: "text", text: `任务 B 最终结果-${stopReason}` }]));

    const target = new FeedbackContext().restore(context(session))[0];
    assert.equal(target?.userEntryId, nextUserId, stopReason);
    assert.equal(target?.assistantEntryId, finalId, stopReason);
    assert.equal(target?.userText, `任务 B-${stopReason}`, stopReason);
    assert.doesNotMatch(JSON.stringify(target), /任务 A|失败响应/u, stopReason);
  }
});

test("feedback context restores at the final node even when its marker is a child", () => {
  const session = SessionManager.inMemory("/workspace");
  const { assistantId } = appendTarget(session, "回撤请求", "可评价最终结果");
  const first = new FeedbackContext();
  const marked = first.markSettled(context(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
  assert.ok(marked);

  session.branch(assistantId);
  const restored = new FeedbackContext().restore(context(session));
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.taskKey, marked?.taskKey);
  assert.equal(restored[0]?.assistantText, "可评价最终结果");
});

test("feedback context excludes abandoned branches when the active branch changes", () => {
  const session = SessionManager.inMemory("/workspace");
  appendTarget(session, "旧分支请求", "旧分支结果");
  const feedback = new FeedbackContext();
  feedback.markSettled(context(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));

  session.resetLeaf();
  appendTarget(session, "当前分支请求", "当前分支结果");
  const targets = feedback.restore(context(session));
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.userText, "当前分支请求");
  assert.equal(targets[0]?.assistantText, "当前分支结果");
  assert.doesNotMatch(JSON.stringify(targets), /旧分支/u);
});

test("feedback context keeps markerless source identity across clone and fork session IDs", () => {
  const session = SessionManager.inMemory("/workspace");
  const { assistantId } = appendTarget(session, "同源请求", "同源结果");
  const originalSessionId = session.getSessionId();
  const original = new FeedbackContext().restore(context(session))[0];
  assert.ok(original);

  session.createBranchedSession(assistantId);
  assert.notEqual(session.getSessionId(), originalSessionId);
  const cloned = new FeedbackContext().restore(context(session))[0];
  assert.equal(cloned?.taskKey, original?.taskKey);
  assert.equal(cloned?.userEntryId, original?.userEntryId);
  assert.equal(cloned?.assistantEntryId, original?.assistantEntryId);
});

test("feedback context recovers, reanchors, and clones a legal legacy marker hidden below the final node", () => {
  const session = SessionManager.inMemory("/workspace");
  const { userId, assistantId } = appendTarget(session, "旧 marker 请求", "旧 marker 结果");
  const legacyKey = `feedback-task-${createHash("sha256").update(`${session.getSessionId()}:${userId}:${assistantId}`).digest("hex").slice(0, 24)}`;
  session.appendCustomEntry("personal-preferences-feedback-target", {
    schema_version: 2,
    task_key: legacyKey,
    user_entry_id: userId,
    assistant_entry_id: assistantId,
  });
  session.branch(assistantId);

  const reloaded = new FeedbackContext();
  assert.equal(reloaded.restore(context(session))[0]?.taskKey, legacyKey);
  const reanchored = reloaded.markSettled(context(session), (marker) => session.appendCustomEntry("personal-preferences-feedback-target", marker));
  assert.equal(reanchored?.taskKey, legacyKey);
  const activeMarker = session.getLeafId();
  assert.ok(activeMarker);

  session.createBranchedSession(activeMarker!);
  assert.equal(new FeedbackContext().restore(context(session))[0]?.taskKey, legacyKey);
});

test("feedback context does not cross a message branch to recover marker identity", () => {
  const session = SessionManager.inMemory("/workspace");
  const { userId, assistantId } = appendTarget(session, "受限查找请求", "受限查找结果");
  session.appendMessage({ role: "user", content: "无关分支消息", timestamp: Date.now() } as any);
  const unrelatedMarkerKey = "feedback-task-abcdef0123456789abcdef01";
  session.appendCustomEntry("personal-preferences-feedback-target", {
    schema_version: 2,
    task_key: unrelatedMarkerKey,
    user_entry_id: userId,
    assistant_entry_id: assistantId,
  });
  session.branch(assistantId);

  const restored = new FeedbackContext().restore(context(session))[0];
  assert.ok(restored);
  assert.notEqual(restored?.taskKey, unrelatedMarkerKey);
  assert.equal(restored?.assistantText, "受限查找结果");
});

test("feedback context reuses an existing legal marker key after reload and clone", () => {
  const session = SessionManager.inMemory("/workspace");
  const { userId, assistantId } = appendTarget(session, "已有标记请求", "已有标记结果");
  const existingKey = "feedback-task-0123456789abcdef01234567";
  session.appendCustomEntry("personal-preferences-feedback-target", {
    schema_version: 2,
    task_key: existingKey,
    user_entry_id: userId,
    assistant_entry_id: assistantId,
  });

  assert.equal(new FeedbackContext().restore(context(session))[0]?.taskKey, existingKey);
  const markerLeaf = session.getLeafId();
  assert.ok(markerLeaf);
  session.createBranchedSession(markerLeaf!);
  assert.equal(new FeedbackContext().restore(context(session))[0]?.taskKey, existingKey);
});

test("feedback context reads only the active branch API", () => {
  const session = SessionManager.inMemory("/workspace");
  appendTarget(session, "活动分支请求", "活动分支结果");
  const restrictedContext = {
    sessionManager: {
      getLeafId: () => session.getLeafId(),
      getBranch: (fromId?: string) => session.getBranch(fromId),
      getSessionId: () => session.getSessionId(),
      getEntries: () => { throw new Error("must not scan all entries"); },
    },
  } as any;

  const feedback = new FeedbackContext();
  const target = feedback.restore(restrictedContext)[0];
  assert.equal(target?.assistantText, "活动分支结果");
  assert.equal(feedback.snapshot(restrictedContext, target!.taskKey, "local_only")?.storage_mode, "local_only");
});

test("feedback context never substitutes summaries, assistants without users, or empty sessions", () => {
  const summaryOnly = SessionManager.inMemory("/workspace");
  summaryOnly.appendCompaction("用户曾要求某事，助手已完成。", "missing", 100);
  assert.deepEqual(new FeedbackContext().restore(context(summaryOnly)), []);

  const noUser = SessionManager.inMemory("/workspace");
  noUser.appendMessage(assistant([{ type: "text", text: "没有真实用户来源" }]));
  assert.equal(new FeedbackContext().markSettled(context(noUser), () => undefined), undefined);

  const empty = SessionManager.inMemory("/workspace");
  assert.deepEqual(new FeedbackContext().restore(context(empty)), []);
});
