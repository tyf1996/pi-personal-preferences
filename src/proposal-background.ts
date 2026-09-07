import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeWithFrozenPiModelResult, type ConfiguredPiThinkingLevel, type ModelUsage } from "./pi-model.ts";
import type { InvokeV2, V2Envelope } from "./background.ts";

type Selection = Record<string, unknown> & { provider_source?: string; endpoint_fingerprint?: string; timeout_seconds?: number };
type Options = { heartbeatMs?: number; leaseSeconds?: number; retryDelayMs?: number };
const PERMANENT_CLAIM_ERRORS = new Set(["invalid_config", "invalid_contract", "integrity_error", "internal_error", "unsupported_action"]);

function success(value: V2Envelope): Record<string, unknown> {
  if (!value.ok || !value.data) throw new Error(value.error?.message ?? "proposal CLI failed");
  return value.data;
}

function ready(job: Record<string, unknown>, now: number): boolean {
  return ["queued", "retry_wait"].includes(String(job.state))
    && (job.next_attempt_at === null || typeof job.next_attempt_at !== "string" || Date.parse(job.next_attempt_at) <= now);
}

/** Proposal-specific runner. Python owns its distinct contract and the shared root lease/budget. */
export class ProposalBackground {
  private readonly controllers = new Map<string, AbortController>();
  private pumpPromise?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private foregroundBusy = false;
  private readonly heartbeatMs: number;
  private readonly leaseSeconds: number;
  private readonly retryDelayMs: number;

  constructor(options: Options = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 90;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  setForegroundBusy(value: boolean): void { this.foregroundBusy = value; }

  abortActive(): void {
    [...this.controllers.values()].forEach((controller) => controller.abort());
  }

  private async current(invoke: InvokeV2): Promise<{ jobs: Array<Record<string, unknown>>; generation: number }> {
    const envelope = await invoke("proposal-job", { action: "list", expected_generation: null, payload: {} });
    const data = success(envelope);
    if (!envelope.cas) throw new Error("proposal collection CAS is missing");
    const jobs = Array.isArray(data.jobs) ? data.jobs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    return { jobs, generation: envelope.cas.generation };
  }

  private async invokeCurrent(invoke: InvokeV2, action: string, payload: Record<string, unknown>): Promise<V2Envelope> {
    let latest: V2Envelope | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.current(invoke);
      latest = await invoke("proposal-job", { action, expected_generation: current.generation, payload });
      if (latest.ok || latest.error?.code !== "generation_conflict") return latest;
    }
    return latest!;
  }

  private schedule(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel, delay: number): void {
    if (this.stopping || this.foregroundBusy) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.wake(ctx, invoke, thinking); }, Math.max(1, delay));
    this.retryTimer.unref?.();
  }

  wake(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel): void {
    if (this.stopping || this.foregroundBusy || this.pumpPromise) return;
    const promise = this.pump(ctx, invoke, thinking);
    this.pumpPromise = promise;
    void promise.finally(() => { if (this.pumpPromise === promise) this.pumpPromise = undefined; }).catch((error: unknown) => {
      try { ctx.ui.notify(`候选后台任务暂停：${error instanceof Error ? error.message : String(error)}`, "warning"); } catch { /* headless */ }
    });
  }

  async resume(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel, enabled: boolean): Promise<void> {
    if (!enabled || this.foregroundBusy) return;
    this.stopping = false;
    const current = await this.current(invoke);
    await invoke("proposal-job", { action: "sweep", expected_generation: current.generation, payload: {} });
    const after = await this.current(invoke);
    const now = Date.now();
    if (after.jobs.some((item) => ready(item, now))) {
      this.wake(ctx, invoke, thinking);
      return;
    }
    const next = after.jobs
      .filter((item) => ["queued", "retry_wait"].includes(String(item.state)))
      .map((item) => typeof item.next_attempt_at === "string" ? Date.parse(item.next_attempt_at) : NaN)
      .filter((item) => Number.isFinite(item) && item > now)
      .sort((a, b) => a - b)[0];
    if (next !== undefined) this.schedule(ctx, invoke, thinking, next - now);
  }

  private async pump(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel): Promise<void> {
    const attempted = new Set<string>();
    while (!this.stopping && !this.foregroundBusy) {
      const current = await this.current(invoke);
      const now = Date.now();
      const job = current.jobs.find((item) => typeof item.job_id === "string" && !attempted.has(item.job_id) && ready(item, now));
      if (!job || typeof job.job_id !== "string") {
        const next = current.jobs.filter((item) => !attempted.has(String(item.job_id)) && ["queued", "retry_wait"].includes(String(item.state)))
          .map((item) => typeof item.next_attempt_at === "string" ? Date.parse(item.next_attempt_at) : NaN)
          .filter((item) => Number.isFinite(item) && item > now).sort((a, b) => a - b)[0];
        if (next !== undefined) this.schedule(ctx, invoke, thinking, next - now);
        return;
      }
      const before = `${String(job.generation)}:${String(job.state)}:${String(job.next_attempt_at)}`;
      try { await this.run(ctx, invoke, job.job_id, thinking); } catch { /* durable state decides retry */ }
      const after = await this.current(invoke);
      const updated = after.jobs.find((item) => item.job_id === job.job_id);
      const signature = updated ? `${String(updated.generation)}:${String(updated.state)}:${String(updated.next_attempt_at)}` : "missing";
      if (signature === before) attempted.add(job.job_id);
    }
  }

  async run(ctx: ExtensionContext, invoke: InvokeV2, jobId: string, thinking: ConfiguredPiThinkingLevel): Promise<void> {
    if (this.foregroundBusy) return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let token: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewal: Promise<void> | undefined;
    let active = false;
    let stoppedDurably = false;
    const stopHeartbeat = async (): Promise<void> => {
      active = false;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (renewal) await renewal;
    };
    try {
      const current = await this.current(invoke);
      const queued = current.jobs.find((item) => item.job_id === jobId);
      if (!queued || !queued.model_selection || typeof queued.authorization_revision !== "number" || typeof queued.input_digest !== "string" || typeof queued.input_signature !== "string") return;
      if (this.foregroundBusy || controller.signal.aborted) return;
      const selection = queued.model_selection as Selection;
      const claimedEnvelope = await invoke("proposal-job", {
        action: "claim", expected_generation: current.generation,
        payload: { job_id: jobId, owner_id: `pi-proposal-${randomUUID()}`, authorization_revision: queued.authorization_revision, model_selection: selection, lease_seconds: this.leaseSeconds },
      }, controller.signal);
      if (!claimedEnvelope.ok) {
        if (!claimedEnvelope.error?.retryable && PERMANENT_CLAIM_ERRORS.has(claimedEnvelope.error?.code ?? "")) {
          await this.invokeCurrent(invoke, "reject", {
            job_id: jobId, generation: queued.generation, input_digest: queued.input_digest,
            input_signature: queued.input_signature, model_selection: selection,
            authorization_revision: queued.authorization_revision, claim_error_code: claimedEnvelope.error?.code,
          });
        } else if (claimedEnvelope.error?.retryable) this.schedule(ctx, invoke, thinking, this.retryDelayMs);
        throw new Error(claimedEnvelope.error?.message ?? "proposal claim failed");
      }
      const claimed = success(claimedEnvelope);
      const job = claimed.job as Record<string, any>;
      if (job.state !== "running" || typeof job.lease?.token !== "string") return;
      token = job.lease.token;
      if (this.foregroundBusy || controller.signal.aborted) {
        await this.invokeCurrent(invoke, "cancel", { job_id: jobId, token });
        return;
      }
      const renew = (): void => {
        if (!active || renewal || !token) return;
        renewal = this.invokeCurrent(invoke, "renew", { job_id: jobId, token, lease_seconds: this.leaseSeconds })
          .then((result) => { success(result); }).catch(() => controller.abort()).finally(() => { renewal = undefined; });
      };
      active = true;
      heartbeat = setInterval(renew, this.heartbeatMs);
      heartbeat.unref?.();
      const authorizeSend = async (endpointFingerprint: string): Promise<void> => {
        if (controller.signal.aborted || this.foregroundBusy || this.stopping) throw new Error("proposal send cancelled before authorization");
        const authorized = await this.invokeCurrent(invoke, "authorize-send", {
          job_id: jobId, token, model_selection: selection, authorization_revision: queued.authorization_revision,
          endpoint_fingerprint: endpointFingerprint,
        });
        const data = success(authorized);
        if (data.authorized !== true) { stoppedDurably = true; throw new Error("proposal send authorization changed"); }
        if (controller.signal.aborted || this.foregroundBusy || this.stopping) throw new Error("proposal send cancelled before transport");
      };
      let output: string;
      let usage: ModelUsage;
      if (selection.provider_source === "pi") {
        const completion = await completeWithFrozenPiModelResult(ctx, selection as any, thinking, String(claimed.prompt), controller.signal, authorizeSend);
        output = completion.output;
        usage = completion.usage;
      } else {
        const authorization = { job_id: jobId, token, model_selection: selection, authorization_revision: queued.authorization_revision, endpoint_fingerprint: selection.endpoint_fingerprint };
        const response = await invoke("model-call", { action: "complete", expected_generation: null, payload: { prompt: String(claimed.prompt), model_selection: selection, authorization } }, controller.signal, Number(selection.timeout_seconds ?? 60) * 1000 + 5000);
        const completion = success(response);
        output = String(completion.output ?? "");
        usage = completion.usage as unknown as ModelUsage;
      }
      await stopHeartbeat();
      if (!output.trim() || controller.signal.aborted || this.foregroundBusy || this.stopping) {
        if (token) await this.invokeCurrent(invoke, "cancel", { job_id: jobId, token });
        return;
      }
      success(await this.invokeCurrent(invoke, "complete", {
        job_id: jobId, token, input_digest: job.input_digest, input_signature: job.input_signature,
        model_selection: selection, authorization_revision: queued.authorization_revision, output, usage,
      }));
    } catch (error) {
      await stopHeartbeat();
      if (!token && this.stopping) {
        try { await this.cancelJob(invoke, jobId); } catch { /* recovery owns state */ }
      }
      if (token && !stoppedDurably) {
        try {
          if (controller.signal.aborted || this.foregroundBusy || this.stopping) await this.invokeCurrent(invoke, "cancel", { job_id: jobId, token });
          else await this.invokeCurrent(invoke, "fail", { job_id: jobId, token, code: "model_failed" });
        } catch { /* concurrent durable transition owns the state */ }
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.controllers.delete(jobId);
    }
  }

  async cancelJob(invoke: InvokeV2, jobId: string): Promise<void> {
    this.controllers.get(jobId)?.abort();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.current(invoke);
      const job = current.jobs.find((item) => item.job_id === jobId);
      if (!job || job.state === "cancelled") return;
      if (typeof job.generation !== "number") throw new Error("proposal job generation is missing");
      const result = await invoke("proposal", { action: "cancel", expected_generation: current.generation, payload: { job_id: jobId, generation: job.generation } });
      if (result.ok) return;
      if (result.error?.code !== "generation_conflict") throw new Error(result.error?.message ?? "proposal cancellation failed");
    }
    throw new Error("proposal cancellation could not acquire current CAS");
  }

  async cancelAll(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    [...this.controllers.values()].forEach((item) => item.abort());
    await Promise.allSettled(this.pumpPromise ? [this.pumpPromise] : []);
  }
}
