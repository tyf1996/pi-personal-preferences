import type { UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODEL_TIMEOUT_MS = 300_000;

export interface CurrentModelInfo {
  provider: string;
  id: string;
  thinking: string;
}

export function currentModelInfo(ctx: Pick<ExtensionContext, "model" | "thinkingLevel">): CurrentModelInfo {
  if (!ctx.model) throw new Error("Pi 当前没有可用模型");
  return {
    provider: ctx.model.provider,
    id: ctx.model.id,
    thinking: ctx.model.reasoning ? ctx.thinkingLevel ?? "off" : "off",
  };
}

async function completeCurrentModel(
  ctx: ExtensionContext,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("Pi 当前没有可用模型");
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  const response = await ctx.modelRegistry.complete(
    model,
    { messages: [userMessage] },
    {
      signal,
      reasoning: model.reasoning ? ctx.thinkingLevel : undefined,
    },
  );
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
}

export async function runCurrentPiModel(
  ctx: ExtensionCommandContext,
  label: string,
  prompt: string,
): Promise<string> {
  if (ctx.mode !== "tui") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      return await completeCurrentModel(ctx, prompt, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }
  const result = await ctx.ui.custom<{ output?: string; error?: Error } | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, label);
    const controller = new AbortController();
    let settled = false;
    const finish = (value: { output?: string; error?: Error } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      done(value);
    };
    loader.signal.addEventListener("abort", () => controller.abort(), { once: true });
    loader.onAbort = () => finish(null);
    const timeout = setTimeout(() => {
      controller.abort();
      finish({ error: new Error("Pi 模型调用超时") });
    }, MODEL_TIMEOUT_MS);
    completeCurrentModel(ctx, prompt, controller.signal)
      .then((output) => finish({ output }))
      .catch((error: unknown) => finish({ error: error instanceof Error ? error : new Error(String(error)) }));
    return loader;
  });
  if (result === null) throw new Error("Pi 模型调用已取消");
  if (result.error) throw result.error;
  if (!result.output) throw new Error("Pi 模型返回了空响应");
  return result.output;
}
