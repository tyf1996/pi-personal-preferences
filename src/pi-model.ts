import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CliEnvironment } from "./cli-client.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PreferenceThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ConfiguredPiThinkingLevel = "inherit" | PreferenceThinkingLevel;

function inheritedThinkingLevel(ctx: ExtensionContext): PreferenceThinkingLevel {
  const level = ctx.thinkingLevel;
  return THINKING_LEVELS.includes(level as PreferenceThinkingLevel)
    ? level as PreferenceThinkingLevel
    : "off";
}

export function effectivePiThinkingLevel(
  ctx: ExtensionContext,
  configured: ConfiguredPiThinkingLevel,
): PreferenceThinkingLevel {
  if (!ctx.model?.reasoning) return "off";
  return configured === "inherit" ? inheritedThinkingLevel(ctx) : configured;
}

export async function piModelEnvironment(
  ctx: ExtensionContext,
  configured: ConfiguredPiThinkingLevel,
  verifyAuth = false,
): Promise<CliEnvironment> {
  const model = ctx.model;
  let authReady = Boolean(model);
  if (model && verifyAuth) {
    try {
      authReady = (await ctx.modelRegistry.getApiKeyAndHeaders(model)).ok;
    } catch {
      authReady = false;
    }
  }
  return {
    PI_PREFERENCE_PI_PROVIDER: model?.provider,
    PI_PREFERENCE_PI_MODEL: model?.id,
    PI_PREFERENCE_PI_THINKING: effectivePiThinkingLevel(ctx, configured),
    PI_PREFERENCE_PI_AUTH_READY: authReady ? "1" : "0",
  };
}

export async function completeWithPiModel(
  ctx: ExtensionContext,
  configured: ConfiguredPiThinkingLevel,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("Pi 当前没有可用模型");
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`Pi 模型 provider 不可用：${model.provider}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const thinking = effectivePiThinkingLevel(ctx, configured);
  const stream = provider.streamSimple(
    effectiveModel,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      reasoning: thinking === "off" ? undefined : thinking,
      temperature: 0,
      maxTokens: 2048,
      cacheRetention: "none",
      sessionId: randomUUID(),
    },
  );
  const response = await stream.result();
  if (response.stopReason === "error" || response.stopReason === "aborted") {
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
