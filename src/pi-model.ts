import type { UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODEL_TIMEOUT_MS = 300_000;

export interface CurrentModelInfo {
  provider: string;
  id: string;
  thinking: string;
}

export interface CapturedPiModel {
  info: CurrentModelInfo;
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}

export function currentModelInfo(ctx: Pick<ExtensionContext, "model" | "thinkingLevel">): CurrentModelInfo {
  if (!ctx.model) throw new Error("Pi 当前没有可用模型");
  return {
    provider: ctx.model.provider,
    id: ctx.model.id,
    thinking: ctx.model.reasoning ? ctx.thinkingLevel ?? "off" : "off",
  };
}

function abortError(timedOut: boolean): Error {
  return new Error(timedOut ? "Pi 模型调用超时" : "Pi 模型调用已取消");
}

export async function runCapturedPiModelBlocking(
  ctx: ExtensionCommandContext,
  model: CapturedPiModel,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (ctx.mode !== "tui") throw new Error("重新整理反馈需要交互式 TUI");
  if (signal.aborted) return null;
  const result = await ctx.ui.custom<{ output?: string; error?: Error } | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "重新整理中，Esc 取消");
    const controller = new AbortController();
    let settled = false;
    const finish = (value: { output?: string; error?: Error } | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => {
      controller.abort();
      finish(null);
    };
    signal.addEventListener("abort", abort, { once: true });
    loader.signal.addEventListener("abort", abort, { once: true });
    loader.onAbort = abort;
    model.complete(prompt, controller.signal)
      .then((output) => finish({ output }))
      .catch((error: unknown) => {
        if (controller.signal.aborted || signal.aborted) finish(null);
        else finish({ error: error instanceof Error ? error : new Error(String(error)) });
      });
    if (signal.aborted) abort();
    return loader;
  });
  if (result === null) return null;
  if (result.error) throw result.error;
  if (!result.output) throw new Error("Pi 模型返回了空响应");
  return result.output;
}

export function captureCurrentPiModel(
  ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">,
): CapturedPiModel | null {
  const model = ctx.model;
  if (!model) return null;
  const registry = ctx.modelRegistry;
  const thinking = model.reasoning ? ctx.thinkingLevel : undefined;
  const info = currentModelInfo(ctx);
  return {
    info,
    async complete(prompt: string, signal: AbortSignal): Promise<string> {
      if (signal.aborted) throw abortError(false);
      const controller = new AbortController();
      let timedOut = false;
      const relayAbort = () => controller.abort();
      signal.addEventListener("abort", relayAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, MODEL_TIMEOUT_MS);
      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      };
      const provider = registry.complete(
        model,
        { messages: [userMessage] },
        { signal: controller.signal, reasoning: thinking },
      );
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(abortError(timedOut)), { once: true });
      });
      try {
        const response = await Promise.race([provider, aborted]);
        if (["error", "aborted", "length"].includes(response.stopReason)) {
          throw new Error(response.errorMessage || `Pi 模型调用失败：${response.stopReason}`);
        }
        const text = response.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("\n")
          .trim();
        if (!text) throw new Error("Pi 模型返回了空响应");
        return text;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", relayAbort);
      }
    },
  };
}
