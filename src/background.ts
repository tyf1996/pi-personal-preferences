import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeWithFrozenPiModelResult, type ConfiguredPiThinkingLevel, type ModelUsage } from "./pi-model.ts";

export interface V2Envelope { ok: boolean; data: Record<string, unknown> | null; error: { code: string; message: string; retryable: boolean } | null; cas: { generation: number } | null; }
export type InvokeV2 = (command: string, request: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) => Promise<V2Envelope>;

type Selection = Record<string, unknown> & { provider_source?: string; api_type?: string };
const PERMANENT_CLAIM_ERRORS = new Set(["invalid_config", "invalid_contract", "integrity_error", "internal_error", "unsupported_action"]);
type BackgroundOptions = {
  heartbeatMs?: number;
  leaseSeconds?: number;
  retryDelayMs?: number;
  onEvidence?: (ctx: ExtensionContext, invoke: InvokeV2, revision: Record<string, unknown>) => Promise<void>;
};

class V2InvocationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function assertSuccess(value: V2Envelope): Record<string, unknown> {
  if (!value.ok || !value.data) {
    throw new V2InvocationError(value.error?.code ?? "feedback_cli_failed", value.error?.message ?? "feedback CLI failed", value.error?.retryable ?? false);
  }
  return value.data;
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function isReady(job: Record<string, unknown>, now: number): boolean {
  return ["queued", "retry_wait"].includes(String(job.state))
    && (job.next_attempt_at === null || typeof job.next_attempt_at !== "string" || Date.parse(job.next_attempt_at) <= now);
}

/** One root worker at a time. Python owns every durable state and lease transition. */
export class FeedbackBackground {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelling = new Set<string>();
  private pumpPromise?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private foregroundBusy = false;
  private lastReportedError?: string;
  private readonly heartbeatMs: number;
  private readonly leaseSeconds: number;
  private readonly retryDelayMs: number;
  private readonly onEvidence?: BackgroundOptions["onEvidence"];

  constructor(options: BackgroundOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 90;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.onEvidence = options.onEvidence;
  }

  private jobSignature(job: Record<string, unknown> | undefined): string {
    if (!job) return "missing";
    return `${String(job.job_id)}:${String(job.generation)}:${String(job.state)}:${String(job.next_attempt_at)}:${String(job.error_code)}`;
  }

  private reportError(ctx: ExtensionContext, jobId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const signature = `${jobId}:${message}`;
    if (signature === this.lastReportedError) return;
    this.lastReportedError = signature;
    try { ctx.ui.notify(`反馈任务 ${jobId} 暂停：${message}`, "warning"); } catch { /* Headless test/runtime. */ }
  }

  setForegroundBusy(value: boolean): void { this.foregroundBusy = value; }

  abortActive(): void {
    [...this.controllers.values()].forEach((controller) => controller.abort());
  }

  private schedulePump(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel, delayMs: number): void {
    if (this.stopping || this.foregroundBusy) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.startPump(ctx, invoke, thinking); }, Math.max(1, delayMs));
    this.retryTimer.unref?.();
  }

  private startPump(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel): void {
    if (this.stopping || this.foregroundBusy || this.pumpPromise) return;
    const promise = this.pump(ctx, invoke, thinking);
    this.pumpPromise = promise;
    void promise.finally(() => { if (this.pumpPromise === promise) this.pumpPromise = undefined; }).catch((error: unknown) => {
      this.reportError(ctx, "worker", error);
    });
  }

  private async currentJobs(invoke: InvokeV2): Promise<{ jobs: Array<Record<string, unknown>>; generation: number }> {
    const listedEnvelope = await invoke("feedback", { action: "list", expected_generation: null, payload: {} });
    const listed = assertSuccess(listedEnvelope);
    const generation = listedEnvelope.cas?.generation ?? (listed as { __cas_generation?: number }).__cas_generation;
    if (generation === undefined) throw new Error("feedback collection CAS is missing");
    const jobs = ((listed.jobs as unknown[]) ?? []).filter((item) => Boolean(item) && typeof item === "object") as Array<Record<string, unknown>>;
    return { jobs, generation };
  }

  private async invokeCurrent(invoke: InvokeV2, action: string, payload: Record<string, unknown>): Promise<V2Envelope> {
    let last: V2Envelope | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.currentJobs(invoke);
      const response = await invoke("learning-job", { action, expected_generation: current.generation, payload });
      last = response;
      if (response.ok || !["generation_conflict", "stale_generation"].includes(response.error?.code ?? "")) return response;
    }
    return last!;
  }

  private async rejectPermanentClaim(invoke: InvokeV2, queued: Record<string, unknown>, error: V2InvocationError): Promise<boolean> {
    if (error.retryable || !PERMANENT_CLAIM_ERRORS.has(error.code)
        || typeof queued.job_id !== "string" || typeof queued.generation !== "number"
        || typeof queued.input_digest !== "string" || typeof queued.consent_revision !== "number"
        || !queued.model_selection) return false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.currentJobs(invoke);
      const response = await invoke("learning-job", {
        action: "reject",
        expected_generation: current.generation,
        payload: {
          job_id: queued.job_id,
          generation: queued.generation,
          input_digest: queued.input_digest,
          model_selection: queued.model_selection,
          consent_revision: queued.consent_revision,
          claim_error_code: error.code,
        },
      });
      if (response.ok) return true;
      if (["generation_conflict"].includes(response.error?.code ?? "")) continue;
      if (["stale_generation", "invalid_contract"].includes(response.error?.code ?? "")) return false;
      return false;
    }
    return false;
  }

  private async pump(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel): Promise<void> {
    const attemptedUnchanged = new Set<string>();
    let retryUnchanged = false;
    while (!this.stopping && !this.foregroundBusy) {
      const { jobs } = await this.currentJobs(invoke);
      const now = Date.now();
      const ready = jobs.find((job) => typeof job.job_id === "string" && !attemptedUnchanged.has(job.job_id) && isReady(job, now));
      if (!ready || typeof ready.job_id !== "string") {
        const next = jobs
          .filter((job) => ["queued", "retry_wait"].includes(String(job.state)) && !attemptedUnchanged.has(String(job.job_id)))
          .map((job) => typeof job.next_attempt_at === "string" ? Date.parse(job.next_attempt_at) : NaN)
          .filter((value) => Number.isFinite(value) && value > now)
          .sort((a, b) => a - b)[0];
        if (retryUnchanged) this.schedulePump(ctx, invoke, thinking, this.retryDelayMs);
        else if (next !== undefined) this.schedulePump(ctx, invoke, thinking, next - now);
        return;
      }
      const before = this.jobSignature(ready);
      let runError: unknown;
      try {
        await this.run(ctx, invoke, ready.job_id, thinking);
      } catch (error) {
        if (this.stopping) return;
        runError = error;
        this.reportError(ctx, ready.job_id, error);
      }
      if (this.stopping) return;
      const { jobs: afterJobs } = await this.currentJobs(invoke);
      const afterJob = afterJobs.find((item) => item.job_id === ready.job_id);
      if (this.jobSignature(afterJob) === before) {
        attemptedUnchanged.add(ready.job_id);
        retryUnchanged ||= !(runError instanceof V2InvocationError) || runError.retryable;
      }
      // A durable transition immediately frees the loop to select the next job.
      // An unchanged job is skipped for this pass so it cannot starve later jobs.
    }
  }

  async enqueueAndRun(
    ctx: ExtensionContext,
    invoke: InvokeV2,
    payload: Record<string, unknown>,
    thinking: ConfiguredPiThinkingLevel,
    extractionEnabled: boolean,
  ): Promise<string> {
    const listedEnvelope = await invoke("feedback", { action: "list", expected_generation: null, payload: {} });
    const listed = assertSuccess(listedEnvelope);
    const generation = listedEnvelope.cas?.generation ?? (listed as { __cas_generation?: number }).__cas_generation;
    if (generation === undefined) throw new Error("feedback collection CAS is missing");
    const created = assertSuccess(await invoke("feedback", { action: "create", expected_generation: generation, payload }));
    const job = created.job as Record<string, unknown>;
    const jobId = String(job.job_id);
    const snapshot = payload.snapshot as { storage_mode?: unknown } | undefined;
    if (extractionEnabled && snapshot?.storage_mode !== "local_only" && payload.model_selection) {
      this.stopping = false;
      this.startPump(ctx, invoke, thinking);
    }
    return jobId;
  }

  wake(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel): void { this.stopping = false; this.startPump(ctx, invoke, thinking); }

  async resume(ctx: ExtensionContext, invoke: InvokeV2, thinking: ConfiguredPiThinkingLevel, extractionEnabled: boolean): Promise<void> {
    if (!extractionEnabled || this.foregroundBusy) return;
    this.stopping = false;
    const current = await this.currentJobs(invoke);
    await invoke("learning-job", { action: "sweep", expected_generation: current.generation, payload: {} });
    const after = await this.currentJobs(invoke);
    if (after.jobs.some((job) => isReady(job, Date.now()))) this.startPump(ctx, invoke, thinking);
  }

  private async cancelLease(invoke: InvokeV2, jobId: string, token: string): Promise<void> {
    const response = await this.invokeCurrent(invoke, "cancel", { job_id: jobId, token });
    if (response.ok) return;
    const current = await this.currentJobs(invoke);
    const job = current.jobs.find((item) => item.job_id === jobId);
    if (job?.state !== "cancelled") assertSuccess(response);
  }

  async run(ctx: ExtensionContext, invoke: InvokeV2, jobId: string, thinking: ConfiguredPiThinkingLevel): Promise<void> {
    if (this.foregroundBusy) return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    if (this.stopping || this.cancelling.has(jobId)) controller.abort();
    let token: string | undefined;
    let job: Record<string, any> | undefined;
    let active = false;
    let renewal: Promise<void> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let durablyStopped = false;

    const stopHeartbeat = async (): Promise<void> => {
      active = false;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (renewal) await renewal;
    };

    try {
      const listed = await this.currentJobs(invoke);
      const queued = listed.jobs.find((item) => item.job_id === jobId);
      if (!queued || typeof queued.consent_revision !== "number" || !queued.model_selection || typeof queued.input_digest !== "string") {
        throw new Error("feedback job is unavailable for dispatch");
      }
      if (controller.signal.aborted || this.foregroundBusy) return;
      const selection = queued.model_selection as Selection;
      const consentRevision = queued.consent_revision;
      const ownerId = `pi-${randomUUID()}`;
      const claimedEnvelope = await invoke("learning-job", {
        action: "claim",
        expected_generation: listed.generation,
        payload: { job_id: jobId, owner_id: ownerId, consent_revision: consentRevision, model_selection: selection, lease_seconds: this.leaseSeconds },
      }, controller.signal);
      if (!claimedEnvelope.ok) {
        const claimError = new V2InvocationError(claimedEnvelope.error?.code ?? "feedback_cli_failed", claimedEnvelope.error?.message ?? "feedback CLI failed", claimedEnvelope.error?.retryable ?? false);
        await this.rejectPermanentClaim(invoke, queued, claimError);
        throw claimError;
      }
      const claimed = assertSuccess(claimedEnvelope);
      job = claimed.job as Record<string, any>;
      if (job.state !== "running" || !job.lease || typeof job.lease.token !== "string") return;
      token = String(job.lease.token);
      if (controller.signal.aborted || this.stopping || this.cancelling.has(jobId)) {
        if (this.stopping && !this.cancelling.has(jobId)) await this.cancelLease(invoke, jobId, token);
        return;
      }

      const renew = (): void => {
        if (!active || renewal || !token) return;
        renewal = this.invokeCurrent(invoke, "renew", { job_id: jobId, token, lease_seconds: this.leaseSeconds })
          .then((response) => { assertSuccess(response); })
          .catch(() => controller.abort())
          .finally(() => { renewal = undefined; });
      };
      active = true;
      heartbeat = setInterval(renew, this.heartbeatMs);
      heartbeat.unref?.();

      const authorizeSend = async (actualEndpointFingerprint: string): Promise<void> => {
        if (controller.signal.aborted || this.stopping || this.cancelling.has(jobId)) throw new Error("feedback dispatch was cancelled before send");
        const response = await this.invokeCurrent(invoke, "authorize-send", {
          job_id: jobId,
          token,
          model_selection: selection,
          consent_revision: consentRevision,
          endpoint_fingerprint: actualEndpointFingerprint,
        });
        const authorized = assertSuccess(response);
        if (authorized.authorized !== true) {
          durablyStopped = true;
          throw new Error(`feedback dispatch blocked: ${String((authorized.job as Record<string, unknown> | undefined)?.error_code ?? "authorization_changed")}`);
        }
        if (controller.signal.aborted || this.stopping || this.cancelling.has(jobId)) throw new Error("feedback dispatch was cancelled before send");
      };

      let output: string;
      let usage: ModelUsage;
      if (selection.provider_source === "pi") {
        const completion = await completeWithFrozenPiModelResult(ctx, selection as any, thinking, String(claimed.prompt), controller.signal, authorizeSend);
        output = completion.output;
        usage = completion.usage;
      } else {
        const authorization = { job_id: jobId, token, model_selection: selection, consent_revision: consentRevision, endpoint_fingerprint: selection.endpoint_fingerprint };
        const response = await invoke(
          "model-call",
          { action: "complete", expected_generation: null, payload: { prompt: String(claimed.prompt), model_selection: selection, authorization } },
          controller.signal,
          Number(selection.timeout_seconds) * 1000 + 5000,
        );
        const completion = assertSuccess(response);
        output = String(completion.output ?? "");
        usage = completion.usage as unknown as ModelUsage;
      }
      if (!output.trim()) throw new Error("model returned an empty response");
      await stopHeartbeat();
      if (controller.signal.aborted || this.stopping || this.cancelling.has(jobId)) {
        if (this.stopping && token && !this.cancelling.has(jobId)) await this.cancelLease(invoke, jobId, token);
        return;
      }
      const completed = await this.invokeCurrent(invoke, "complete", {
        job_id: jobId,
        token,
        input_digest: job.input_digest,
        model_selection: selection,
        consent_revision: consentRevision,
        output,
        usage,
      });
      const completedData = assertSuccess(completed);
      const revision = completedData.evidence_revision;
      if (this.onEvidence && revision && typeof revision === "object" && !Array.isArray(revision)) {
        try { await this.onEvidence(ctx, invoke, revision as Record<string, unknown>); }
        catch (error) { this.reportError(ctx, jobId, error); }
      }
    } catch (error) {
      await stopHeartbeat();
      if (!token && this.stopping && !this.cancelling.has(jobId)) {
        try { await this.cancelJob(invoke, jobId); } catch { /* Recovery or a concurrent user transition owns the state. */ }
      }
      if (token && !durablyStopped && !this.cancelling.has(jobId)) {
        try {
          if (controller.signal.aborted || this.stopping) await this.cancelLease(invoke, jobId, token);
          else {
            const code = error instanceof V2InvocationError ? error.code : "model_failed";
            assertSuccess(await this.invokeCurrent(invoke, "fail", { job_id: jobId, token, code }));
          }
        } catch {
          // A durable user edit/cancel, authorization block, or expired lease owns the final state.
        }
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.controllers.delete(jobId);
      this.cancelling.delete(jobId);
    }
  }

  async cancelJob(invoke: InvokeV2, jobId: string): Promise<Record<string, unknown>> {
    this.cancelling.add(jobId);
    this.controllers.get(jobId)?.abort();
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await this.currentJobs(invoke);
        const job = current.jobs.find((item) => item.job_id === jobId);
        if (!job) throw new Error("feedback job does not exist");
        if (job.state === "cancelled") return job;
        if (typeof job.generation !== "number") throw new Error("feedback job generation is missing");
        const response = await invoke("feedback", { action: "cancel", expected_generation: current.generation, payload: { job_id: jobId, generation: job.generation } });
        if (response.ok) return (assertSuccess(response).job as Record<string, unknown>);
        if (!["generation_conflict", "stale_generation"].includes(response.error?.code ?? "")) {
          const latest = await this.currentJobs(invoke);
          const latestJob = latest.jobs.find((item) => item.job_id === jobId);
          if (latestJob?.state === "cancelled") return latestJob;
          assertSuccess(response);
        }
      }
      throw new Error("feedback cancellation could not acquire a current CAS generation");
    } finally {
      if (!this.controllers.has(jobId)) this.cancelling.delete(jobId);
    }
  }

  async cancelAll(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    [...this.controllers.values()].forEach((controller) => controller.abort());
    await Promise.allSettled(this.pumpPromise ? [this.pumpPromise] : []);
  }
}

export function endpointFingerprint(baseUrl: string): string { return digest(baseUrl); }
