import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export type CliEnvironment = Record<string, string | undefined>;

export class PreferenceCliCleanupError extends Error {
  readonly primaryError: Error | undefined;

  constructor(message: string, primaryError?: Error) {
    super(message);
    this.name = "PreferenceCliCleanupError";
    this.primaryError = primaryError;
  }
}

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/giu, "[REDACTED_CREDENTIAL]")
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED_CREDENTIAL]")
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_CREDENTIAL]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function childEnvironment(overrides: CliEnvironment): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

export function runPreferenceCli(
  script: string,
  dataRoot: string,
  args: string[],
  input?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  environment: CliEnvironment = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("personal preference CLI aborted"));
      return;
    }
    const detached = process.platform !== "win32";
    const child = spawn("python3", [script, ...args, "--data-root", dataRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(environment),
      shell: false,
      detached,
    });
    const processGroupId = detached && typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputBytes = 0;
    let settled = false;
    let parentClosed = false;
    let closeCode: number | null = null;
    let primaryError: Error | undefined;
    let terminationStarted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    const commandTimer = setTimeout(() => fail(new Error("personal preference CLI timed out")), timeoutMs);
    const abort = () => fail(new Error("personal preference CLI aborted"));
    signal?.addEventListener("abort", abort, { once: true });

    function groupExists(): boolean {
      if (processGroupId === null) return false;
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }

    function signalOwnedGroup(signalName: NodeJS.Signals): void {
      try {
        if (processGroupId !== null) process.kill(-processGroupId, signalName);
        else child.kill(signalName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") primaryError ??= error as Error;
      }
    }

    function clearResources(): void {
      clearTimeout(commandTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (groupPollTimer) clearTimeout(groupPollTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.stdout.removeListener("error", fail);
      child.stderr.removeListener("error", fail);
      child.stdin.removeListener("error", fail);
      child.removeListener("error", fail);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    }

    function finishCleanupError(): void {
      if (settled) return;
      settled = true;
      if (groupExists()) signalOwnedGroup("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      clearResources();
      reject(new PreferenceCliCleanupError("personal preference CLI resources did not close within 1 second", primaryError));
    }

    function finish(): void {
      if (settled || !parentClosed || groupExists()) return;
      settled = true;
      clearResources();
      if (primaryError) {
        reject(primaryError);
        return;
      }
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch {
        reject(new Error(redact(stderr.trim() || `personal preference CLI returned invalid JSON (exit ${closeCode ?? "unknown"})`)));
        return;
      }
      if (!isRecord(value)) {
        reject(new Error("personal preference CLI result is not an object"));
        return;
      }
      if (value.ok === false) {
        const error = isRecord(value.error) && typeof value.error.message === "string"
          ? value.error.message
          : stderr.trim() || "personal preference CLI failed";
        reject(new Error(redact(error)));
        return;
      }
      if (closeCode !== 0) {
        reject(new Error(redact(stderr.trim() || `personal preference CLI exited with ${closeCode ?? "unknown"}`)));
        return;
      }
      resolve(value);
    }

    function pollForClosure(): void {
      if (settled) return;
      if (parentClosed && !groupExists()) {
        finish();
        return;
      }
      if (!groupPollTimer) {
        groupPollTimer = setTimeout(() => {
          groupPollTimer = undefined;
          pollForClosure();
        }, 10);
      }
    }

    function startTermination(): void {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      if (groupExists()) signalOwnedGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        if (groupExists()) signalOwnedGroup("SIGKILL");
        pollForClosure();
      }, 500);
      cleanupTimer = setTimeout(finishCleanupError, 1_000);
      pollForClosure();
    }

    function fail(error: Error): void {
      if (settled) return;
      primaryError ??= error;
      startTermination();
    }

    function append(kind: "stdout" | "stderr", chunk: Buffer): void {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error("personal preference CLI output exceeded 32 MiB"));
        return;
      }
      if (kind === "stdout") stdout += stdoutDecoder.write(chunk);
      else stderr += stderrDecoder.write(chunk);
    }

    function onStdout(chunk: Buffer): void { append("stdout", chunk); }
    function onStderr(chunk: Buffer): void { append("stderr", chunk); }
    function onExit(code: number | null): void {
      closeCode = code;
      startTermination();
      clearTimeout(commandTimer);
    }
    function onClose(code: number | null): void {
      parentClosed = true;
      closeCode = code;
      startTermination();
      clearTimeout(commandTimer);
      pollForClosure();
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("exit", onExit);
    child.on("close", onClose);

    try {
      if (input === undefined) child.stdin.end();
      else child.stdin.end(JSON.stringify(input));
    } catch (error) {
      fail(error as Error);
    }
  });
}
