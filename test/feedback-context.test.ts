import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FeedbackContext } from "../src/feedback-context.ts";

function context(session: SessionManager): any { return { sessionManager: session }; }

test("feedback context binds a settled active branch, restores only marker references, and excludes thinking", () => {
  const session = SessionManager.inMemory("/workspace");
  session.appendMessage({ role: "user", content: "请用中文回答", timestamp: Date.now() } as any);
  session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "好的，我会使用中文。" }], timestamp: Date.now() } as any);
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
