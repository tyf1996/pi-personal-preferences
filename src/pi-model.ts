import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CliEnvironment } from "./cli-client.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PreferenceThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ConfiguredPiThinkingLevel = "inherit" | PreferenceThinkingLevel;
export type FrozenPiSelection = {
  provider_source: "pi";
  provider_id: string;
  model_id: string;
  api_type: string;
  endpoint_fingerprint: string;
  thinking_level: PreferenceThinkingLevel;
  max_tokens: number;
  timeout_seconds: number;
  config_version: number;
};

export interface ModelUsage {
  known: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_status: "known" | "unknown";
  provider_id: string;
  model_id: string;
  max_tokens: number;
}

export interface ModelCompletion {
  output: string;
  usage: ModelUsage;
}

function inheritedThinkingLevel(ctx: ExtensionContext): PreferenceThinkingLevel {
  const level = ctx.thinkingLevel;
  return THINKING_LEVELS.includes(level as PreferenceThinkingLevel) ? level as PreferenceThinkingLevel : "off";
}

export function effectivePiThinkingLevel(ctx: ExtensionContext, configured: ConfiguredPiThinkingLevel): PreferenceThinkingLevel {
  if (!ctx.model?.reasoning) return "off";
  return configured === "inherit" ? inheritedThinkingLevel(ctx) : configured;
}

export function piModelEnvironment(ctx: ExtensionContext, configured: ConfiguredPiThinkingLevel): CliEnvironment {
  const model = ctx.model;
  return {
    PI_PREFERENCE_PI_PROVIDER: model?.provider,
    PI_PREFERENCE_PI_MODEL: model?.id,
    PI_PREFERENCE_PI_THINKING: effectivePiThinkingLevel(ctx, configured),
  };
}

function fingerprint(baseUrl: string): string { return `sha256:${createHash("sha256").update(baseUrl).digest("hex")}`; }

function findFrozenModel(ctx: ExtensionContext, selection: FrozenPiSelection): any {
  const registry = ctx.modelRegistry as unknown as { find?: (provider: string, model: string) => any; getModel?: (provider: string, model: string) => any };
  const model = registry.find?.(selection.provider_id, selection.model_id) ?? registry.getModel?.(selection.provider_id, selection.model_id)
    ?? (ctx.model?.provider === selection.provider_id && ctx.model.id === selection.model_id ? ctx.model : undefined);
  if (!model) throw new Error(`冻结的 Pi 模型不可用：${selection.provider_id}/${selection.model_id}`);
  return model;
}

export async function completeWithFrozenPiModelResult(
  ctx: ExtensionContext,
  selection: FrozenPiSelection,
  _configured: ConfiguredPiThinkingLevel,
  prompt: string,
  signal: AbortSignal,
  beforeSend?: (actualEndpointFingerprint: string) => Promise<void>,
): Promise<ModelCompletion> {
  if (signal.aborted) throw new Error("Pi 模型调用已取消");
  const model = findFrozenModel(ctx, selection);
  const provider = ctx.modelRegistry.getProvider(selection.provider_id);
  if (!provider) throw new Error(`冻结的 Pi provider 不可用：${selection.provider_id}`);
  const callController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; callController.abort(); }, Math.max(1, selection.timeout_seconds * 1000));
  const abortForward = () => callController.abort();
  signal.addEventListener("abort", abortForward, { once: true });
  if (signal.aborted) abortForward();
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(new Error(timedOut ? "Pi 模型调用超时" : "Pi 模型调用已取消"));
    if (callController.signal.aborted) rejectAbort();
    else callController.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    // Credentials remain registry-only and are resolved for the frozen model at
    // actual send time. No key, header, environment value, or OAuth state is
    // returned to the durable job contract.
    const auth = await Promise.race([ctx.modelRegistry.getApiKeyAndHeaders(model), aborted]);
    if (!auth.ok) throw new Error(auth.error);
    const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const actualEndpointFingerprint = fingerprint(effectiveModel.baseUrl ?? "");
    if (actualEndpointFingerprint !== selection.endpoint_fingerprint) {
      throw new Error("冻结模型的实际 endpoint 已改变，发送被阻止");
    }
    if (beforeSend) await Promise.race([beforeSend(actualEndpointFingerprint), aborted]);
    if (callController.signal.aborted) await aborted;
    const stream = provider.streamSimple(
      effectiveModel,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: callController.signal,
        reasoning: selection.thinking_level === "off" ? undefined : selection.thinking_level,
        temperature: 0,
        maxTokens: selection.max_tokens,
        cacheRetention: "none",
        sessionId: randomUUID(),
      },
    );
    const response = await Promise.race([stream.result(), aborted]);
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
      throw new Error(response.errorMessage || `Pi 模型调用失败：${response.stopReason}`);
    }
    const text = response.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n").trim();
    if (!text) throw new Error("Pi 模型返回了空响应");
    const rawUsage = response.usage as Record<string, any> | undefined;
    const input = rawUsage?.input;
    const output = rawUsage?.output;
    const known = Number.isInteger(input) && input >= 0 && Number.isInteger(output) && output >= 0;
    const rawTotal = rawUsage?.totalTokens;
    const total = Number.isInteger(rawTotal) && rawTotal >= 0
      ? rawTotal
      : known ? input + output : null;
    const rawCost = rawUsage?.cost?.total;
    const knownCost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0;
    return {
      output: text,
      usage: {
        known,
        input_tokens: known ? input : null,
        output_tokens: known ? output : null,
        total_tokens: known ? total : null,
        cost_usd: knownCost ? rawCost : null,
        cost_status: knownCost ? "known" : "unknown",
        provider_id: selection.provider_id,
        model_id: selection.model_id,
        max_tokens: selection.max_tokens,
      },
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortForward);
  }
}

export async function completeWithFrozenPiModel(
  ctx: ExtensionContext,
  selection: FrozenPiSelection,
  configured: ConfiguredPiThinkingLevel,
  prompt: string,
  signal: AbortSignal,
  beforeSend?: (actualEndpointFingerprint: string) => Promise<void>,
): Promise<string> {
  return (await completeWithFrozenPiModelResult(ctx, selection, configured, prompt, signal, beforeSend)).output;
}

/** Classification remains a text bridge; learning stages use structured completion. */
export async function completeWithPiModel(ctx: ExtensionContext, configured: ConfiguredPiThinkingLevel, prompt: string, signal: AbortSignal): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("Pi 当前没有可用模型");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  return completeWithFrozenPiModel(ctx, {
    provider_source: "pi", provider_id: model.provider, model_id: model.id, api_type: "pi",
    endpoint_fingerprint: fingerprint(auth.baseUrl ?? model.baseUrl ?? ""),
    thinking_level: effectivePiThinkingLevel(ctx, configured), max_tokens: 2048, timeout_seconds: 300, config_version: 2,
  }, configured, prompt, signal);
}
